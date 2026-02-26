import { registerTool } from "./registry";
import {
  createReminder,
  createRecurringReminder,
  listReminders,
  cancelReminder,
} from "../memory/reminders";

registerTool({
  name: "set_reminder",
  description: "Set a one-time reminder that will be sent as a WhatsApp message at the specified time",
  parameters: {
    message: { type: "string", description: "Reminder message to send", required: true },
    datetime: {
      type: "string",
      description: "When to trigger (ISO 8601 format, e.g., '2026-02-27T09:00:00')",
      required: true,
    },
  },
  async execute(args, chatId) {
    const reminder = createReminder(chatId, args.message, args.datetime);
    const date = new Date(args.datetime);
    const formatted = date.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `Reminder set for ${formatted}: "${args.message}" (ID: ${reminder.id.slice(0, 8)})`;
  },
});

registerTool({
  name: "set_recurring_reminder",
  description: "Set a recurring reminder (daily, weekdays, weekly, monthly, or weekly on a specific day)",
  parameters: {
    message: { type: "string", description: "Reminder message", required: true },
    time: {
      type: "string",
      description: "Time of day in ISO format for the first trigger (e.g., '2026-02-27T09:00:00')",
      required: true,
    },
    recurrence: {
      type: "string",
      description: "Recurrence pattern",
      required: true,
      enum: ["daily", "weekdays", "weekly", "monthly", "weekly:monday", "weekly:tuesday", "weekly:wednesday", "weekly:thursday", "weekly:friday", "weekly:saturday", "weekly:sunday"],
    },
  },
  async execute(args, chatId) {
    const reminder = createRecurringReminder(chatId, args.message, args.time, args.recurrence);
    return `Recurring reminder set (${args.recurrence}): "${args.message}" — starting at ${args.time} (ID: ${reminder.id.slice(0, 8)})`;
  },
});

registerTool({
  name: "list_reminders",
  description: "List all active reminders",
  parameters: {},
  async execute(_args, chatId) {
    const reminders = listReminders(chatId);
    if (reminders.length === 0) return "No active reminders.";

    const lines = reminders.map((r) => {
      const date = new Date(r.trigger_at).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const recur = r.recurrence ? ` (${r.recurrence})` : " (one-time)";
      return `• [${r.id.slice(0, 8)}] ${date}${recur}: ${r.message}`;
    });

    return `Active reminders (${reminders.length}):\n${lines.join("\n")}`;
  },
});

registerTool({
  name: "cancel_reminder",
  description: "Cancel an active reminder by its ID (first 8 characters are enough)",
  parameters: {
    id: { type: "string", description: "Reminder ID or first 8 characters of it", required: true },
  },
  async execute(args, chatId) {
    // Support partial IDs — find the full ID from active reminders
    const reminders = listReminders(chatId);
    const match = reminders.find((r) => r.id.startsWith(args.id));

    if (!match) return `Reminder "${args.id}" not found. Use list_reminders to see active ones.`;

    cancelReminder(match.id);
    return `Reminder cancelled: "${match.message}"`;
  },
});
