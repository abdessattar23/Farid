import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, "..", "..", "farid.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initTables(db);
  }
  return db;
}

function initTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_chat
      ON conversations(chat_id, created_at);

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message TEXT NOT NULL,
      trigger_at TEXT NOT NULL,
      recurrence TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_trigger
      ON reminders(active, trigger_at);

    CREATE TABLE IF NOT EXISTS focus_sessions (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      project TEXT,
      duration_minutes INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ends_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS productivity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      project TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_productivity_log_chat
      ON productivity_log(chat_id, created_at);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
