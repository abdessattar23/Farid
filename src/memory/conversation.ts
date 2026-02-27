import { getDb } from "./db";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const MAX_HISTORY = 10;

export function saveMessage(chatId: string, role: ChatMessage["role"], content: string): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO conversations (chat_id, role, content) VALUES (?, ?, ?)"
  ).run(chatId, role, content);

  // Track last message timestamp for silence detection
  if (role === "user") {
    db.prepare(
      "INSERT INTO chat_meta (chat_id, last_message_at) VALUES (?, datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET last_message_at = datetime('now')"
    ).run(chatId);
  }
}

export function getLastMessageTime(chatId: string): Date | null {
  const db = getDb();
  const row = db.prepare("SELECT last_message_at FROM chat_meta WHERE chat_id = ?").get(chatId) as any;
  return row ? new Date(row.last_message_at) : null;
}

export function getLastAutonomousAction(chatId: string): Date | null {
  const db = getDb();
  const row = db.prepare("SELECT last_autonomous_at FROM chat_meta WHERE chat_id = ?").get(chatId) as any;
  return row?.last_autonomous_at ? new Date(row.last_autonomous_at) : null;
}

export function recordAutonomousAction(chatId: string): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO chat_meta (chat_id, last_message_at, last_autonomous_at) VALUES (?, datetime('now'), datetime('now')) ON CONFLICT(chat_id) DO UPDATE SET last_autonomous_at = datetime('now')"
  ).run(chatId);
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
