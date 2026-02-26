import { v4 as uuidv4 } from "uuid";
import { getDb } from "../memory/db";
import { registerTool } from "./registry";

registerTool({
  name: "create_habit",
  description: "Create a new habit to track daily (e.g., 'Code for 2 hours', 'Review tasks every morning')",
  parameters: {
    name: { type: "string", description: "Habit name/description", required: true },
    frequency: { type: "string", description: "How often (default: daily)", enum: ["daily", "weekdays", "weekly"] },
  },
  async execute(args, chatId) {
    const db = getDb();
    const id = uuidv4();
    const frequency = args.frequency || "daily";
    db.prepare(
      "INSERT INTO habits (id, chat_id, name, frequency) VALUES (?, ?, ?, ?)"
    ).run(id, chatId, args.name, frequency);
    return `Habit created: "${args.name}" (${frequency}). Use check_habit to mark it done each day!`;
  },
});

registerTool({
  name: "check_habit",
  description: "Mark a habit as completed for today. Maintains your streak!",
  parameters: {
    name: { type: "string", description: "Habit name (partial match works)", required: true },
  },
  async execute(args, chatId) {
    const db = getDb();
    const habit = db.prepare(
      "SELECT * FROM habits WHERE chat_id = ? AND active = 1 AND name LIKE ? LIMIT 1"
    ).get(chatId, `%${args.name}%`) as any;

    if (!habit) return `No active habit matching "${args.name}". Use create_habit to start one.`;

    const today = new Date().toISOString().split("T")[0];

    const existing = db.prepare(
      "SELECT 1 FROM habit_log WHERE habit_id = ? AND completed_date = ?"
    ).get(habit.id, today);

    if (existing) return `Already checked off "${habit.name}" today! Current streak: ${habit.current_streak} days.`;

    db.prepare(
      "INSERT INTO habit_log (habit_id, completed_date) VALUES (?, ?)"
    ).run(habit.id, today);

    // Calculate streak
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    const hadYesterday = db.prepare(
      "SELECT 1 FROM habit_log WHERE habit_id = ? AND completed_date = ?"
    ).get(habit.id, yesterday);

    const newStreak = hadYesterday ? habit.current_streak + 1 : 1;
    const bestStreak = Math.max(newStreak, habit.best_streak);

    db.prepare(
      "UPDATE habits SET current_streak = ?, best_streak = ? WHERE id = ?"
    ).run(newStreak, bestStreak, habit.id);

    let msg = `"${habit.name}" checked off! Streak: ${newStreak} day${newStreak > 1 ? "s" : ""}`;
    if (newStreak === bestStreak && newStreak > 1) msg += " (new personal best!)";
    if (newStreak === 7) msg += " -- 1 week straight!";
    if (newStreak === 30) msg += " -- 30 DAYS. LEGEND.";
    return msg;
  },
});

registerTool({
  name: "habit_status",
  description: "Show all active habits with current streaks and today's completion status",
  parameters: {},
  async execute(_args, chatId) {
    const db = getDb();
    const habits = db.prepare(
      "SELECT * FROM habits WHERE chat_id = ? AND active = 1 ORDER BY created_at"
    ).all(chatId) as any[];

    if (habits.length === 0) return "No habits being tracked. Use create_habit to start.";

    const today = new Date().toISOString().split("T")[0];

    const lines = habits.map((h) => {
      const doneToday = db.prepare(
        "SELECT 1 FROM habit_log WHERE habit_id = ? AND completed_date = ?"
      ).get(h.id, today);

      const check = doneToday ? "✅" : "⬜";
      return `${check} ${h.name} | Streak: ${h.current_streak}d | Best: ${h.best_streak}d | ${h.frequency}`;
    });

    const doneCount = lines.filter((l) => l.startsWith("✅")).length;
    return `Habits (${doneCount}/${habits.length} done today):\n${lines.join("\n")}`;
  },
});

registerTool({
  name: "delete_habit",
  description: "Deactivate a habit (stops tracking)",
  parameters: {
    name: { type: "string", description: "Habit name (partial match works)", required: true },
  },
  async execute(args, chatId) {
    const db = getDb();
    const habit = db.prepare(
      "SELECT * FROM habits WHERE chat_id = ? AND active = 1 AND name LIKE ? LIMIT 1"
    ).get(chatId, `%${args.name}%`) as any;

    if (!habit) return `No active habit matching "${args.name}".`;

    db.prepare("UPDATE habits SET active = 0 WHERE id = ?").run(habit.id);
    return `Stopped tracking "${habit.name}" (${habit.current_streak}-day streak). You can always create it again.`;
  },
});

// Exported for scheduler
export function getHabitsForChat(chatId: string): any[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM habits WHERE chat_id = ? AND active = 1"
  ).all(chatId) as any[];
}

export function resetBrokenStreaks(): number {
  const db = getDb();
  const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

  const activeHabits = db.prepare(
    "SELECT id, current_streak FROM habits WHERE active = 1 AND current_streak > 0"
  ).all() as any[];

  let broken = 0;
  for (const habit of activeHabits) {
    const hadYesterday = db.prepare(
      "SELECT 1 FROM habit_log WHERE habit_id = ? AND completed_date = ?"
    ).get(habit.id, yesterday);

    if (!hadYesterday) {
      db.prepare("UPDATE habits SET current_streak = 0 WHERE id = ?").run(habit.id);
      broken++;
    }
  }
  return broken;
}
