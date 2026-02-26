import { v4 as uuidv4 } from "uuid";
import { getDb } from "../memory/db";
import { registerTool } from "./registry";

interface FocusSession {
  id: string;
  chat_id: string;
  project: string | null;
  duration_minutes: number;
  started_at: string;
  ends_at: string;
  active: number;
}

// ─── Focus Mode ───

registerTool({
  name: "start_focus",
  description: "Start a focus session — Farid will remind you when time is up and gently block distractions",
  parameters: {
    project: { type: "string", description: "What you're focusing on (e.g., 'Sofrecom', 'YouCode')", required: true },
    duration: { type: "number", description: "Duration in minutes (default 60)", required: true },
  },
  async execute(args, chatId) {
    const db = getDb();

    // Check for existing active session
    const existing = db
      .prepare("SELECT * FROM focus_sessions WHERE chat_id = ? AND active = 1")
      .get(chatId) as FocusSession | undefined;

    if (existing) {
      const remaining = Math.max(
        0,
        Math.round((new Date(existing.ends_at).getTime() - Date.now()) / 60000)
      );
      return `You're already in focus mode for "${existing.project}"! ${remaining} minutes remaining. Finish this first or use end_focus to stop.`;
    }

    const duration = Number(args.duration) || 60;
    const now = new Date();
    const endsAt = new Date(now.getTime() + duration * 60000);
    const id = uuidv4();

    db.prepare(
      "INSERT INTO focus_sessions (id, chat_id, project, duration_minutes, started_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, chatId, args.project, duration, now.toISOString(), endsAt.toISOString());

    // Log productivity event
    db.prepare(
      "INSERT INTO productivity_log (chat_id, event_type, project, details) VALUES (?, 'focus_start', ?, ?)"
    ).run(chatId, args.project, `${duration} minutes`);

    const endTime = endsAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    return `Focus mode ACTIVATED for "${args.project}" — ${duration} minutes until ${endTime}. I'll let you know when time's up. Now go crush it!`;
  },
});

registerTool({
  name: "end_focus",
  description: "End the current focus session early",
  parameters: {},
  async execute(_args, chatId) {
    const db = getDb();
    const session = db
      .prepare("SELECT * FROM focus_sessions WHERE chat_id = ? AND active = 1")
      .get(chatId) as FocusSession | undefined;

    if (!session) return "No active focus session to end.";

    const elapsed = Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000);
    db.prepare("UPDATE focus_sessions SET active = 0 WHERE id = ?").run(session.id);

    // Log
    db.prepare(
      "INSERT INTO productivity_log (chat_id, event_type, project, details) VALUES (?, 'focus_end', ?, ?)"
    ).run(chatId, session.project, `${elapsed} of ${session.duration_minutes} minutes`);

    return `Focus session ended. You focused on "${session.project}" for ${elapsed} minutes out of ${session.duration_minutes} planned. ${elapsed >= session.duration_minutes ? "Full session completed!" : "Ended early, but progress is progress!"}`;
  },
});

registerTool({
  name: "get_stats",
  description: "Get your productivity statistics — focus time, task completion, activity per project",
  parameters: {
    period: {
      type: "string",
      description: "Time period to analyze",
      enum: ["today", "week", "month"],
    },
  },
  async execute(args, chatId) {
    const db = getDb();
    const period = args.period || "week";

    let dateFilter: string;
    const now = new Date();
    if (period === "today") {
      dateFilter = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    } else if (period === "week") {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      dateFilter = weekAgo.toISOString();
    } else {
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      dateFilter = monthAgo.toISOString();
    }

    // Focus sessions in period
    const sessions = db
      .prepare(
        "SELECT project, duration_minutes FROM focus_sessions WHERE chat_id = ? AND started_at >= ? AND active = 0"
      )
      .all(chatId, dateFilter) as { project: string | null; duration_minutes: number }[];

    const totalFocusMin = sessions.reduce((s, r) => s + r.duration_minutes, 0);
    const focusByProject: Record<string, number> = {};
    for (const s of sessions) {
      const proj = s.project || "Other";
      focusByProject[proj] = (focusByProject[proj] || 0) + s.duration_minutes;
    }

    // Activity log counts
    const events = db
      .prepare(
        "SELECT event_type, COUNT(*) as count FROM productivity_log WHERE chat_id = ? AND created_at >= ? GROUP BY event_type"
      )
      .all(chatId, dateFilter) as { event_type: string; count: number }[];

    const eventMap: Record<string, number> = {};
    for (const e of events) eventMap[e.event_type] = e.count;

    // Build stats report
    const lines: string[] = [];
    lines.push(`Productivity Stats (${period}):`);
    lines.push(`─────────────────────`);
    lines.push(`Total focus time: ${Math.floor(totalFocusMin / 60)}h ${totalFocusMin % 60}m`);
    lines.push(`Focus sessions: ${sessions.length}`);

    if (Object.keys(focusByProject).length > 0) {
      lines.push(`\nFocus by project:`);
      for (const [proj, mins] of Object.entries(focusByProject).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${proj}: ${Math.floor(mins / 60)}h ${mins % 60}m`);
      }
    }

    if (Object.keys(eventMap).length > 0) {
      lines.push(`\nActivity:`);
      for (const [event, count] of Object.entries(eventMap)) {
        lines.push(`  ${event.replace(/_/g, " ")}: ${count}`);
      }
    }

    return lines.join("\n");
  },
});

registerTool({
  name: "productivity_score",
  description: "Calculate a productivity score (0-100) based on focus time, habits, journal entries, and activity this week. Shows trend.",
  parameters: {},
  async execute(_args, chatId) {
    const db = getDb();
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const prevWeekStart = new Date(Date.now() - 14 * 86400000).toISOString();

    function weekScore(from: string, to: string): number {
      let score = 0;

      // Focus time (max 40 points: 10h = 40pts)
      const focus = db.prepare(
        "SELECT SUM(duration_minutes) as total FROM focus_sessions WHERE chat_id = ? AND started_at >= ? AND started_at < ? AND active = 0"
      ).get(chatId, from, to) as any;
      const focusMin = focus?.total || 0;
      score += Math.min(40, Math.round((focusMin / 600) * 40));

      // Habits completed (max 25 points: 7 days all habits = 25pts)
      const habitDays = db.prepare(
        "SELECT COUNT(DISTINCT completed_date) as days FROM habit_log hl JOIN habits h ON hl.habit_id = h.id WHERE h.chat_id = ? AND hl.completed_date >= ? AND hl.completed_date < ?"
      ).get(chatId, from.split("T")[0], to.split("T")[0]) as any;
      score += Math.min(25, Math.round(((habitDays?.days || 0) / 7) * 25));

      // Journal entries (max 15 points: 5 entries = 15pts)
      const journals = db.prepare(
        "SELECT COUNT(*) as cnt FROM journal WHERE chat_id = ? AND created_at >= ? AND created_at < ?"
      ).get(chatId, from, to) as any;
      score += Math.min(15, Math.round(((journals?.cnt || 0) / 5) * 15));

      // Focus sessions count (max 20 points: 10 sessions = 20pts)
      const sessionCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM focus_sessions WHERE chat_id = ? AND started_at >= ? AND started_at < ? AND active = 0"
      ).get(chatId, from, to) as any;
      score += Math.min(20, Math.round(((sessionCount?.cnt || 0) / 10) * 20));

      return Math.min(100, score);
    }

    const now = new Date().toISOString();
    const current = weekScore(weekAgo, now);
    const previous = weekScore(prevWeekStart, weekAgo);
    const diff = current - previous;
    const trend = diff > 0 ? `+${diff} from last week` : diff < 0 ? `${diff} from last week` : "same as last week";

    let emoji = "📊";
    if (current >= 80) emoji = "🔥";
    else if (current >= 60) emoji = "💪";
    else if (current >= 40) emoji = "📈";
    else emoji = "🐌";

    return `${emoji} Productivity Score: ${current}/100 (${trend})\n\nBreakdown: Focus time (40pts), Habits (25pts), Journal (15pts), Sessions (20pts)`;
  },
});

registerTool({
  name: "start_sprint",
  description: "Start a 5-minute anti-procrastination sprint. Do ONE small thing, then Farid checks back.",
  parameters: {
    task: { type: "string", description: "What to work on for 5 minutes", required: true },
  },
  async execute(args, chatId) {
    const db = getDb();
    const { v4: uuidv4Sprint } = await import("uuid");
    const id = uuidv4Sprint();
    const triggerAt = new Date(Date.now() + 5 * 60000).toISOString();

    db.prepare(
      "INSERT INTO reminders (id, chat_id, message, trigger_at) VALUES (?, ?, ?, ?)"
    ).run(id, chatId, `⚡ Sprint check-in: How did 5 minutes on "${args.task}" go? Did you get started?`, triggerAt);

    db.prepare(
      "INSERT INTO productivity_log (chat_id, event_type, project, details) VALUES (?, 'sprint_start', NULL, ?)"
    ).run(chatId, args.task);

    return `⚡ *5-MINUTE SPRINT STARTED*\n\nTask: "${args.task}"\n\nJust do ONE thing. Don't think, don't plan, just start. I'll check back in 5 minutes. Go!`;
  },
});

// ─── Exported helpers for the scheduler ───

/**
 * Returns the active focus session for a chat, if any.
 */
export function getActiveFocusSession(chatId: string): FocusSession | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM focus_sessions WHERE chat_id = ? AND active = 1")
    .get(chatId) as FocusSession | undefined;
}

/**
 * Returns all expired focus sessions (active but past ends_at).
 */
export function getExpiredFocusSessions(): FocusSession[] {
  const db = getDb();
  const now = new Date().toISOString();
  return db
    .prepare("SELECT * FROM focus_sessions WHERE active = 1 AND ends_at <= ?")
    .all(now) as FocusSession[];
}

/**
 * Marks a focus session as complete.
 */
export function completeFocusSession(sessionId: string): void {
  const db = getDb();
  db.prepare("UPDATE focus_sessions SET active = 0 WHERE id = ?").run(sessionId);
}
