import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db";

export interface Reminder {
  id: string;
  chat_id: string;
  message: string;
  trigger_at: string;
  recurrence: string | null;
  active: number;
  created_at: string;
}

/**
 * Creates a one-time reminder.
 * @param triggerAt - ISO 8601 datetime string (e.g., "2026-02-27T09:00:00")
 */
export function createReminder(chatId: string, message: string, triggerAt: string): Reminder {
  const db = getDb();
  const id = uuidv4();
  db.prepare(
    "INSERT INTO reminders (id, chat_id, message, trigger_at, recurrence) VALUES (?, ?, ?, ?, NULL)"
  ).run(id, chatId, message, triggerAt);

  return { id, chat_id: chatId, message, trigger_at: triggerAt, recurrence: null, active: 1, created_at: new Date().toISOString() };
}

/**
 * Creates a recurring reminder.
 * @param recurrence - Cron-like pattern description, e.g., "daily", "weekdays", "weekly:monday"
 */
export function createRecurringReminder(
  chatId: string,
  message: string,
  triggerAt: string,
  recurrence: string
): Reminder {
  const db = getDb();
  const id = uuidv4();
  db.prepare(
    "INSERT INTO reminders (id, chat_id, message, trigger_at, recurrence) VALUES (?, ?, ?, ?, ?)"
  ).run(id, chatId, message, triggerAt, recurrence);

  return { id, chat_id: chatId, message, trigger_at: triggerAt, recurrence, active: 1, created_at: new Date().toISOString() };
}

/**
 * Returns all reminders that should fire now (trigger_at <= now and active).
 */
export function getDueReminders(): Reminder[] {
  const db = getDb();
  const now = new Date().toISOString();
  return db
    .prepare(
      "SELECT * FROM reminders WHERE active = 1 AND trigger_at <= ?"
    )
    .all(now) as Reminder[];
}

/**
 * Deactivates a one-time reminder after it fires.
 * For recurring reminders, updates trigger_at to the next occurrence.
 */
export function markReminderFired(reminder: Reminder): void {
  const db = getDb();

  if (reminder.recurrence) {
    const nextTrigger = computeNextTrigger(reminder.trigger_at, reminder.recurrence);
    db.prepare("UPDATE reminders SET trigger_at = ? WHERE id = ?").run(nextTrigger, reminder.id);
  } else {
    db.prepare("UPDATE reminders SET active = 0 WHERE id = ?").run(reminder.id);
  }
}

/**
 * Lists all active reminders for a chat.
 */
export function listReminders(chatId: string): Reminder[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM reminders WHERE chat_id = ? AND active = 1 ORDER BY trigger_at")
    .all(chatId) as Reminder[];
}

/**
 * Cancels (deactivates) a reminder by ID.
 */
export function cancelReminder(reminderId: string): boolean {
  const db = getDb();
  const result = db.prepare("UPDATE reminders SET active = 0 WHERE id = ?").run(reminderId);
  return result.changes > 0;
}

/**
 * Computes the next trigger time based on the recurrence pattern.
 */
function computeNextTrigger(currentTrigger: string, recurrence: string): string {
  const current = new Date(currentTrigger);

  switch (recurrence) {
    case "daily":
      current.setDate(current.getDate() + 1);
      break;
    case "weekdays": {
      do {
        current.setDate(current.getDate() + 1);
      } while (current.getDay() === 0 || current.getDay() === 6);
      break;
    }
    case "weekly":
      current.setDate(current.getDate() + 7);
      break;
    case "monthly":
      current.setMonth(current.getMonth() + 1);
      break;
    default:
      // Handle "weekly:monday", "weekly:friday", etc.
      if (recurrence.startsWith("weekly:")) {
        const dayName = recurrence.split(":")[1].toLowerCase();
        const dayMap: Record<string, number> = {
          sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
          thursday: 4, friday: 5, saturday: 6,
        };
        const targetDay = dayMap[dayName] ?? 1;
        do {
          current.setDate(current.getDate() + 1);
        } while (current.getDay() !== targetDay);
      } else {
        current.setDate(current.getDate() + 1);
      }
  }

  return current.toISOString();
}
