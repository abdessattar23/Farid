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
