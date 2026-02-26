import cron from "node-cron";
import { config } from "../config";
import { getDueReminders, markReminderFired } from "../memory/reminders";
import { getLastMessageTime } from "../memory/conversation";
import { getExpiredFocusSessions, completeFocusSession } from "../tools/productivity";
import { resetBrokenStreaks } from "../tools/habits";
import { sendProactiveMessage, sendSmartProactiveMessage } from "../agent";

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
          `🎯 *Focus time is up!* You just did ${session.duration_minutes} minutes on "${session.project}". Great work! What's next?`
        );
      }
    } catch (err) {
      console.error("[Scheduler] Error checking focus sessions:", err);
    }
  }, { timezone: TZ });

  // ── Morning Brief — 8:00 AM weekdays ──
  cron.schedule("0 8 * * 1-5", async () => {
    console.log("[Scheduler] Morning brief");
    try {
      await sendSmartProactiveMessage(
        OWNER,
        `[SYSTEM] It's morning. Send a morning brief. Use get_task_summary for current tasks and habit_status for habit streaks. Present a concise daily plan. Today's priority workstream is Sofrecom. Include habit streak status. Be energetic.`
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
        `[SYSTEM] It's end of day. Send an EOD check-in. Use habit_status to check if habits are done today. Ask what they accomplished. If habits aren't checked off, gently remind them. Suggest logging a journal entry with log_journal. Be encouraging.`
      );
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
        `[SYSTEM] Weekend morning. Use get_task_summary to check for urgent items and habit_status for streaks. If urgent tasks exist, mention them lightly. Otherwise suggest YouCode/Learning. Keep it chill. Don't forget habit streaks.`
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
        `[SYSTEM] Sunday evening — weekly planning. Use get_task_summary for task overview, get_journal with period "week" for this week's reflections, and productivity_score for the score. Present: top priorities for next week across all 5 workstreams, score trend, and key takeaways from journal. Be direct.`
      );
    } catch (err) {
      console.error("[Scheduler] Error:", err);
    }
  }, { timezone: TZ });

  // ── Afternoon nudge — 2:30 PM weekdays (context-aware) ──
  cron.schedule("30 14 * * 1-5", async () => {
    try {
      await sendSmartProactiveMessage(
        OWNER,
        `[SYSTEM] Afternoon check-in. Use list_my_tasks to see current tasks. The user should be working on Sofrecom right now. Ask specifically about their current Sofrecom task. Be direct but friendly.`
      );
    } catch (err) {
      console.error("[Scheduler] Error:", err);
    }
  }, { timezone: TZ });

  // ── Stale Task Watchdog — 10:00 AM weekdays ──
  cron.schedule("0 10 * * 1-5", async () => {
    console.log("[Scheduler] Stale task check");
    try {
      await sendSmartProactiveMessage(
        OWNER,
        `[SYSTEM] Check for stale tasks. Use list_my_tasks to find tasks. If any tasks have been mentioned or worked on before but seem stuck, point them out. Ask if they need to be broken down into smaller pieces or if priorities have changed. Be helpful, not nagging.`
      );
    } catch (err) {
      console.error("[Scheduler] Error:", err);
    }
  }, { timezone: TZ });

  // ── Silence Detection — every 30 min during work hours (9-18) weekdays ──
  cron.schedule("*/30 9-17 * * 1-5", async () => {
    try {
      const lastMsg = getLastMessageTime(OWNER);
      if (!lastMsg) return;

      const silenceHours = (Date.now() - lastMsg.getTime()) / 3600000;
      if (silenceHours < 3) return;

      console.log(`[Scheduler] Silence detected: ${silenceHours.toFixed(1)}h`);
      await sendSmartProactiveMessage(
        OWNER,
        `[SYSTEM] The user hasn't messaged in ${Math.round(silenceHours)} hours during work hours. This could mean they're deep in work (good) or stuck/procrastinating (bad). Send a SHORT contextual check-in. Use list_my_tasks to reference their current tasks. Don't be annoying — just one casual message. If they're in a focus session, don't interrupt.`
      );
    } catch (err) {
      console.error("[Scheduler] Error:", err);
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
  console.log("  - Morning brief: 8:00 AM (Mon-Fri)");
  console.log("  - Stale task watchdog: 10:00 AM (Mon-Fri)");
  console.log("  - Afternoon nudge: 2:30 PM (Mon-Fri)");
  console.log("  - EOD review: 7:00 PM (Mon-Fri)");
  console.log("  - Weekend check-in: 9:00 AM (Sat-Sun)");
  console.log("  - Weekly planning: 8:00 PM (Sunday)");
  console.log("  - Silence detection: every 30min (9-18 Mon-Fri)");
  console.log("  - Habit streak reset: 00:05 daily");
}
