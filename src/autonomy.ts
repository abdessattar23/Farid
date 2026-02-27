import { config } from "./config";
import { getDb } from "./memory/db";
import { getLastMessageTime, getLastAutonomousAction, recordAutonomousAction, saveMessage } from "./memory/conversation";
import { getActiveFocusSession } from "./tools/productivity";
import { listReminders } from "./memory/reminders";
import { buildAutonomousPrompt } from "./prompt";
import { sendSmartProactiveMessage } from "./agent";

const OWNER = config.agent.ownerNumber;
const COOLDOWN_MS = 45 * 60 * 1000; // 45 minutes between autonomous messages

// ── Context Snapshot ──

interface ContextSnapshot {
  time: string;
  dayOfWeek: string;
  isWorkHours: boolean;
  isWeekend: boolean;
  silenceMinutes: number;
  inFocusSession: boolean;
  focusProject: string | null;
  focusMinutesLeft: number;
  uncheckedHabits: number;
  totalHabits: number;
  upcomingReminders: number;
  minutesSinceLastAutonomous: number;
  triggers: string[];
}

function buildSnapshot(): ContextSnapshot {
  const db = getDb();
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();
  const isWeekend = day === 0 || day === 6;
  const isWorkHours = hour >= 8 && hour <= 21;

  // Silence duration
  const lastMsg = getLastMessageTime(OWNER);
  const silenceMinutes = lastMsg ? Math.round((Date.now() - lastMsg.getTime()) / 60000) : 9999;

  // Focus session
  const focus = getActiveFocusSession(OWNER);
  const focusMinutesLeft = focus
    ? Math.max(0, Math.round((new Date(focus.ends_at).getTime() - Date.now()) / 60000))
    : 0;

  // Habits not checked today
  const today = now.toISOString().split("T")[0];
  const totalHabits = (db.prepare(
    "SELECT COUNT(*) as cnt FROM habits WHERE chat_id = ? AND active = 1"
  ).get(OWNER) as any)?.cnt || 0;

  const checkedToday = (db.prepare(
    `SELECT COUNT(DISTINCT hl.habit_id) as cnt FROM habit_log hl
     JOIN habits h ON hl.habit_id = h.id
     WHERE h.chat_id = ? AND h.active = 1 AND hl.completed_date = ?`
  ).get(OWNER, today) as any)?.cnt || 0;

  const uncheckedHabits = totalHabits - checkedToday;

  // Upcoming reminders in the next 2 hours
  const twoHoursFromNow = new Date(Date.now() + 2 * 3600000).toISOString();
  const upcomingReminders = (db.prepare(
    "SELECT COUNT(*) as cnt FROM reminders WHERE chat_id = ? AND active = 1 AND trigger_at <= ?"
  ).get(OWNER, twoHoursFromNow) as any)?.cnt || 0;

  // Cooldown
  const lastAutonomous = getLastAutonomousAction(OWNER);
  const minutesSinceLastAutonomous = lastAutonomous
    ? Math.round((Date.now() - lastAutonomous.getTime()) / 60000)
    : 9999;

  // Evaluate triggers
  const triggers: string[] = [];

  if (silenceMinutes >= 120 && isWorkHours && !focus) {
    triggers.push(`User has been silent for ${Math.round(silenceMinutes / 60)} hours during work hours`);
  }

  if (uncheckedHabits > 0 && hour >= 18) {
    triggers.push(`${uncheckedHabits} habit(s) not checked off today and it's evening`);
  }

  if (hour === 17 && !isWeekend) {
    triggers.push("Workstream transition: Sofrecom hours ending, time to switch to side projects");
  }

  if (upcomingReminders === 0 && isWorkHours && hour >= 9 && hour <= 16) {
    triggers.push("No reminders set for the next 2 hours — day might be unplanned");
  }

  if (isWorkHours && silenceMinutes >= 180 && !focus) {
    triggers.push("Extended silence — might be procrastinating or stuck");
  }

  return {
    time: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
    dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long" }),
    isWorkHours,
    isWeekend,
    silenceMinutes,
    inFocusSession: !!focus,
    focusProject: focus?.project || null,
    focusMinutesLeft,
    uncheckedHabits,
    totalHabits,
    upcomingReminders,
    minutesSinceLastAutonomous,
    triggers,
  };
}

function formatSnapshot(snap: ContextSnapshot): string {
  const lines: string[] = [];
  lines.push(`Time: ${snap.time} (${snap.dayOfWeek})`);
  lines.push(`Work hours: ${snap.isWorkHours ? "yes" : "no"}`);
  lines.push(`User silence: ${snap.silenceMinutes} minutes`);

  if (snap.inFocusSession) {
    lines.push(`Focus session: "${snap.focusProject}" (${snap.focusMinutesLeft} min left)`);
  }

  if (snap.totalHabits > 0) {
    lines.push(`Habits: ${snap.uncheckedHabits}/${snap.totalHabits} unchecked today`);
  }

  lines.push(`Upcoming reminders (next 2h): ${snap.upcomingReminders}`);
  lines.push(`Minutes since last autonomous message: ${snap.minutesSinceLastAutonomous}`);

  if (snap.triggers.length > 0) {
    lines.push(`\nTriggers detected:`);
    for (const t of snap.triggers) lines.push(`  - ${t}`);
  } else {
    lines.push(`\nNo triggers detected.`);
  }

  return lines.join("\n");
}

// ── Autonomous Tick ──

export async function autonomousTick(): Promise<void> {
  const snap = buildSnapshot();

  // Only run during work hours
  if (!snap.isWorkHours) return;

  // Don't disturb during focus sessions
  if (snap.inFocusSession) return;

  // No triggers = nothing to think about (save LLM credits)
  if (snap.triggers.length === 0) return;

  // Cooldown check (45 min between autonomous actions)
  if (snap.minutesSinceLastAutonomous < 45) {
    console.log(`[Autonomy] Skipping: cooldown (${snap.minutesSinceLastAutonomous}min since last action)`);
    return;
  }

  console.log(`[Autonomy] Triggers: ${snap.triggers.join("; ")}`);

  const contextStr = formatSnapshot(snap);
  const prompt = buildAutonomousPrompt(contextStr);

  try {
    // Use sendSmartProactiveMessage which handles tool calls
    // But first check if LLM says [NO_ACTION]
    const result = await autonomousLLMCheck(prompt);

    if (!result || result.includes("[NO_ACTION]")) {
      console.log("[Autonomy] LLM decided: no action needed");
      return;
    }

    console.log(`[Autonomy] Acting: ${result.slice(0, 100)}`);
    recordAutonomousAction(OWNER);
    saveMessage(OWNER, "assistant", result);
    const { sendMessage } = await import("./whatsapp");
    await sendMessage(OWNER, result);
  } catch (err) {
    console.error("[Autonomy] Error:", err);
  }
}

/**
 * Event-driven autonomous check. Called after specific events
 * (focus session ends, task completed) to suggest what's next.
 */
export async function triggerAutonomousCheck(reason: string): Promise<void> {
  const snap = buildSnapshot();

  // Respect cooldown even for event-driven checks (but shorter: 15 min)
  if (snap.minutesSinceLastAutonomous < 15) return;

  console.log(`[Autonomy] Event trigger: ${reason}`);

  const contextStr = formatSnapshot(snap) + `\n\nEvent: ${reason}`;
  const prompt = buildAutonomousPrompt(contextStr);

  try {
    await sendSmartProactiveMessage(OWNER, `[SYSTEM] ${reason}. Check tasks with list_my_tasks, consider the time of day, and suggest the specific next task Mohammed should work on. Be direct and actionable.`);
    recordAutonomousAction(OWNER);
  } catch (err) {
    console.error("[Autonomy] Event trigger error:", err);
  }
}

// ── Lightweight LLM check (no tool calling, just decision) ──

async function autonomousLLMCheck(systemPrompt: string): Promise<string | null> {
  try {
    const { generateToolsParam } = await import("./tools");

    const body: Record<string, any> = {
      model: config.hackclub.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "[AUTONOMOUS TICK] Evaluate the context and decide whether to act." },
      ],
      temperature: 0.7,
      max_tokens: 1024,
      tools: generateToolsParam(),
    };

    const response = await fetch(`${config.hackclub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.hackclub.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as any;
    const msg = data.choices?.[0]?.message;
    if (!msg) return null;

    // If the LLM wants to call tools, use the full smart proactive flow instead
    if (msg.tool_calls?.length) {
      console.log("[Autonomy] LLM wants to use tools, delegating to smart proactive flow");
      const snap = buildSnapshot();
      await sendSmartProactiveMessage(OWNER,
        `[SYSTEM] Autonomous check detected something worth acting on. Context:\n${formatSnapshot(snap)}\n\nUse tools to gather info and send Mohammed a useful, concise message.`
      );
      return "__HANDLED__";
    }

    const content = msg.content?.trim();
    if (!content) return null;

    // Clean thinking artifacts
    const cleaned = content
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^(analysis|assistantcommentary|commentary|reasoning)[\s\S]*?(?=\n[A-Z]|\n\n|$)/gim, "")
      .trim();

    return cleaned || null;
  } catch (err) {
    console.error("[Autonomy] LLM check error:", err);
    return null;
  }
}
