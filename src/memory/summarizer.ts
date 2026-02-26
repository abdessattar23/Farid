import { config } from "../config";
import { getDb } from "./db";

/**
 * Retrieves the latest session summary for a chat.
 * This provides long-term context beyond the 10-message history window.
 */
export function getLatestSummary(chatId: string): string | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT summary FROM session_summaries WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(chatId) as any;
  return row?.summary || null;
}

/**
 * Summarizes old conversation messages and stores the summary.
 * Called periodically or when conversation history gets long.
 */
export async function summarizeOldMessages(chatId: string): Promise<void> {
  const db = getDb();

  // Get messages older than the latest 10 that haven't been summarized
  const lastSummary = db.prepare(
    "SELECT created_at FROM session_summaries WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(chatId) as any;

  const sinceDate = lastSummary?.created_at || "2000-01-01";

  const oldMessages = db.prepare(
    `SELECT role, content, created_at FROM conversations 
     WHERE chat_id = ? AND created_at > ? 
     ORDER BY created_at ASC`
  ).all(chatId, sinceDate) as any[];

  // Only summarize if there are enough messages to warrant it
  if (oldMessages.length < 20) return;

  // Take everything except the most recent 10
  const toSummarize = oldMessages.slice(0, oldMessages.length - 10);
  if (toSummarize.length < 5) return;

  const transcript = toSummarize
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(0, 6000);

  try {
    const resp = await fetch(`${config.hackclub.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.hackclub.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.hackclub.model,
        messages: [
          {
            role: "system",
            content: "Summarize this conversation between a user and their AI assistant Farid. Extract: key decisions made, tasks discussed, preferences learned, commitments, and any important context. Be concise (max 300 words). Format as bullet points.",
          },
          { role: "user", content: transcript },
        ],
        temperature: 0.3,
        max_tokens: 512,
      }),
    });

    if (!resp.ok) return;

    const data = (await resp.json()) as any;
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary) return;

    db.prepare(
      "INSERT INTO session_summaries (chat_id, summary, message_count) VALUES (?, ?, ?)"
    ).run(chatId, summary, toSummarize.length);

    console.log(`[Summarizer] Stored summary for ${chatId} (${toSummarize.length} messages)`);
  } catch (err) {
    console.error("[Summarizer] Error:", err);
  }
}
