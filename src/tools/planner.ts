import { getDb } from "../memory/db";
import { registerTool } from "./registry";
import { createReminder } from "../memory/reminders";
import { config } from "../config";

registerTool({
  name: "plan_my_day",
  description: "Create a time-blocked daily plan and automatically set reminders for each block. Call this in the morning or when the user asks what to work on.",
  parameters: {
    blocks: {
      type: "string",
      description: 'JSON array of time blocks. Each block: {"time":"HH:MM","task":"description","project":"optional project name"}. Example: [{"time":"09:00","task":"API migration","project":"Sofrecom"},{"time":"11:00","task":"Code review"}]',
      required: true,
    },
  },
  async execute(args, chatId) {
    let blocks: Array<{ time: string; task: string; project?: string }>;
    try {
      blocks = JSON.parse(args.blocks);
    } catch {
      return "Invalid blocks format. Pass a JSON array of {time, task, project?} objects.";
    }

    if (!Array.isArray(blocks) || blocks.length === 0) {
      return "No time blocks provided. Pass at least one block.";
    }

    const today = new Date();
    const dateStr = today.toISOString().split("T")[0];
    const results: string[] = [];

    for (const block of blocks) {
      if (!block.time || !block.task) continue;

      const triggerAt = `${dateStr}T${block.time}:00`;
      const label = block.project ? `[${block.project}] ${block.task}` : block.task;

      createReminder(chatId, `📋 Time to work on: ${label}`, triggerAt);
      results.push(`⏰ ${block.time} — ${label}`);
    }

    if (results.length === 0) return "No valid blocks to schedule.";

    // Log the planning event
    const db = getDb();
    db.prepare(
      "INSERT INTO productivity_log (chat_id, event_type, details) VALUES (?, 'day_planned', ?)"
    ).run(chatId, `${results.length} blocks`);

    return `Daily plan set with ${results.length} time blocks:\n${results.join("\n")}\n\nReminders are armed. I'll ping you at each transition.`;
  },
});
