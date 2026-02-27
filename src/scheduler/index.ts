import cron from "node-cron";
import { config } from "../config";
import { getDueReminders, markReminderFired } from "../memory/reminders";
import { getExpiredFocusSessions, completeFocusSession } from "../tools/productivity";
import { resetBrokenStreaks } from "../tools/habits";
import { sendProactiveMessage, sendSmartProactiveMessage } from "../agent";
import { autonomousTick, triggerAutonomousCheck } from "../autonomy";
import { buildMorningPlannerPrompt } from "../prompt";

const OWNER = config.agent.ownerNumber;
const TZ = config.agent.timezone;

export function startScheduler(): void {
  console.log(`[Scheduler] Starting with timezone: ${TZ}`);

  // ── Check reminders every minute ──
  cron.schedule("* * * * *", async () => {
    try {
      const due = getDueReminders();
      for (const reminder of due) {
        console.log(`[Scheduler] Firing reminder: ${reminder.message}`);
        await sendProactiveMessage(reminder.chat_id, `⏰ *Reminder*: ${reminder.message}`);
        markReminderFired(reminder);
      }
    } catch (err) {
      console.error("[Scheduler] Error checking reminders:", err);
    }
  }, { timezone: TZ });

  // ── Check expired focus sessions every minute ──
  cron.schedule("* * * * *", async () => {
    try {
      const expired = getExpiredFocusSessions();
      for (const session of expired) {
        completeFocusSession(session.id);
        await sendProactiveMessage(
          session.chat_id,
          `🎯 *Focus time is up!* You just did ${session.duration_minutes} minutes on "${session.project}". Great work!`
        );
        // Post-action intelligence: suggest what's next
        triggerAutonomousCheck(`Focus session on "${session.project}" just ended (${session.duration_minutes} min). Suggest the next task based on time of day and priorities.`).catch(() => {});
      }
    } catch (err) {
      console.error("[Scheduler] Error checking focus sessions:", err);
    }
  }, { timezone: TZ });

  // ── Morning Auto-Planner — 8:00 AM weekdays ──
  cron.schedule("0 8 * * 1-5", async () => {
    console.log("[Scheduler] Morning auto-planner");
    try {
      await sendSmartProactiveMessage(OWNER, buildMorningPlannerPrompt());
    } catch (err) {
      console.error("[Scheduler] Error:", err);
    }
  }, { timezone: TZ });

  // ── Weekend Morning — 9:00 AM Sat/Sun ──
  cron.schedule("0 9 * * 0,6", async () => {
    console.log("[Scheduler] Weekend check-in");
    try {
      await sendSmartProactiveMessage(
        OWNER,
        `[SYSTEM] Weekend morning. Use get_task_summary to check for urgent items and habit_status for streaks. Create a lighter weekend plan using plan_my_day with 2-3 blocks focused on personal projects, YouCode, or learning. Keep it chill.`
      );
    } catch (err) {
      console.error("[Scheduler] Error:", err);
    }
  }, { timezone: TZ });

  // ── EOD Review — 7:00 PM weekdays ──
  cron.schedule("0 19 * * 1-5", async () => {
    console.log("[Scheduler] EOD review");
    try {
      await sendSmartProactiveMessage(
        OWNER,
        `[SYSTEM] End of day. Use habit_status to check unchecked habits. Use get_stats with period "today" to see today's focus time. Ask what they accomplished. If habits aren't done, firmly remind them. Suggest logging a journal entry with log_journal. Be encouraging but direct.`
      );
    } catch (err) {
      console.error("[Scheduler] Error:", err);
    }
  }, { timezone: TZ });

  // ── Weekly Planning — Sunday 8:00 PM ──
  cron.schedule("0 20 * * 0", async () => {
    console.log("[Scheduler] Weekly planning");
    try {
      await sendSmartProactiveMessage(
        OWNER,
        `[SYSTEM] Sunday evening — weekly planning. Use get_task_summary for task overview, get_journal with period "week" for reflections, and productivity_score for the score. Present: score trend, key journal takeaways, top priorities for next week. Be direct about what matters most.`
      );
    } catch (err) {
      console.error("[Scheduler] Error:", err);
    }
  }, { timezone: TZ });

  // ── Autonomous Thinking Loop — every 5 min during work hours (8-21) ──
  cron.schedule("*/5 8-21 * * *", async () => {
    try {
      await autonomousTick();
    } catch (err) {
      console.error("[Scheduler] Autonomy error:", err);
    }
  }, { timezone: TZ });

  // ── Reset broken habit streaks — midnight daily ──
  cron.schedule("5 0 * * *", () => {
    try {
      const broken = resetBrokenStreaks();
      if (broken > 0) console.log(`[Scheduler] Reset ${broken} broken habit streak(s)`);
    } catch (err) {
      console.error("[Scheduler] Error resetting streaks:", err);
    }
  }, { timezone: TZ });

  console.log("[Scheduler] All jobs scheduled:");
  console.log("  - Reminders: every minute");
  console.log("  - Focus sessions: every minute");
  console.log("  - Morning auto-planner: 8:00 AM (Mon-Fri)");
  console.log("  - EOD review: 7:00 PM (Mon-Fri)");
  console.log("  - Weekend check-in: 9:00 AM (Sat-Sun)");
  console.log("  - Weekly planning: 8:00 PM (Sunday)");
  console.log("  - Autonomous brain: every 5 min (8-21)");
  console.log("  - Habit streak reset: 00:05 daily");
}
