import { getDb } from "./db";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const MAX_HISTORY = 20;

/**
 * Appends a message to the conversation history for a given chat.
 */
export function saveMessage(chatId: string, role: ChatMessage["role"], content: string): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO conversations (chat_id, role, content) VALUES (?, ?, ?)"
  ).run(chatId, role, content);
}

/**
 * Retrieves the last N messages for a chat, ordered chronologically.
 */
export function getHistory(chatId: string, limit: number = MAX_HISTORY): ChatMessage[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT role, content FROM conversations
       WHERE chat_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(chatId, limit) as ChatMessage[];

  return rows.reverse();
}

/**
 * Clears all conversation history for a chat.
 */
export function clearHistory(chatId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM conversations WHERE chat_id = ?").run(chatId);
}
