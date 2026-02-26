import cron from "node-cron";
import { config } from "../config";
import { getDueReminders, markReminderFired } from "../memory/reminders";
import { getExpiredFocusSessions, completeFocusSession } from "../tools/productivity";
import { sendProactiveMessage, sendSmartProactiveMessage } from "../agent";

const OWNER = config.agent.ownerNumber;
const TZ = config.agent.timezone;

/**
 * Starts all scheduled jobs.
 */
export function startScheduler(): void {
  console.log(`[Scheduler] Starting with timezone: ${TZ}`);

  // ── Check reminders every minute ──
  cron.schedule("* * * * *", async () => {
    try {
      const due = getDueReminders();
      for (const reminder of due) {
        console.log(`[Scheduler] Firing reminder: ${reminder.message}`);
        await sendProactiveMessage(
          reminder.chat_id,
          `⏰ *Reminder*: ${reminder.message}`
        );
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
        console.log(`[Scheduler] Focus session expired: ${session.project}`);
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
    console.log("[Scheduler] Sending morning brief");
    try {
      await sendSmartProactiveMessage(
        OWNER,
        `[SYSTEM] It's morning. Send a morning brief to the user. Use get_task_summary to fetch their current tasks, then present a concise daily plan. Prioritize by urgency. Be energetic and motivating. Suggest what to focus on first based on the day of the week (weekdays = Sofrecom priority).`
      );
    } catch (err) {
      console.error("[Scheduler] Error sending morning brief:", err);
    }
  }, { timezone: TZ });

  // ── End-of-Day Review — 7:00 PM weekdays ──
  cron.schedule("0 19 * * 1-5", async () => {
    console.log("[Scheduler] Sending EOD review");
    try {
      await sendSmartProactiveMessage(
        OWNER,
        `[SYSTEM] It's end of day. Send an end-of-day check-in. Ask what they accomplished today. Be encouraging but also ask about tomorrow's plan. Keep it short and friendly.`
      );
    } catch (err) {
      console.error("[Scheduler] Error sending EOD review:", err);
    }
  }, { timezone: TZ });

  // ── Weekend Morning — 9:00 AM Sat/Sun (lighter tone) ──
  cron.schedule("0 9 * * 0,6", async () => {
    console.log("[Scheduler] Sending weekend check-in");
    try {
      await sendSmartProactiveMessage(
        OWNER,
        `[SYSTEM] It's the weekend. Send a gentle check-in. Use get_task_summary to see if there are urgent items. If there are urgent/overdue tasks, mention them lightly. Otherwise, suggest this is a good time for YouCode projects or learning. Keep it chill.`
      );
    } catch (err) {
      console.error("[Scheduler] Error sending weekend check-in:", err);
    }
  }, { timezone: TZ });

  // ── Weekly Planning — Sunday 8:00 PM ──
  cron.schedule("0 20 * * 0", async () => {
    console.log("[Scheduler] Sending weekly planning");
    try {
      await sendSmartProactiveMessage(
        OWNER,
        `[SYSTEM] It's Sunday evening — time for weekly planning. Use get_task_summary to get an overview. Then present a week-ahead plan: what are the top priorities across all 5 workstreams? Any deadlines coming up? Suggest a realistic plan. Be direct about what matters most.`
      );
    } catch (err) {
      console.error("[Scheduler] Error sending weekly planning:", err);
    }
  }, { timezone: TZ });

  // ── Afternoon nudge — 2:30 PM weekdays ──
  // Gentle check-in if no messages sent in a while
  cron.schedule("30 14 * * 1-5", async () => {
    console.log("[Scheduler] Sending afternoon nudge");
    try {
      await sendProactiveMessage(
        OWNER,
        `Hey, afternoon check — you still locked in? 💪 What are you working on right now?`
      );
    } catch (err) {
      console.error("[Scheduler] Error sending afternoon nudge:", err);
    }
  }, { timezone: TZ });

  console.log("[Scheduler] All jobs scheduled:");
  console.log("  - Reminders check: every minute");
  console.log("  - Focus session check: every minute");
  console.log("  - Morning brief: 8:00 AM (Mon-Fri)");
  console.log("  - Afternoon nudge: 2:30 PM (Mon-Fri)");
  console.log("  - EOD review: 7:00 PM (Mon-Fri)");
  console.log("  - Weekend check-in: 9:00 AM (Sat-Sun)");
  console.log("  - Weekly planning: 8:00 PM (Sunday)");
}
