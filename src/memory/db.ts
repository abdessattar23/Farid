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

    -- Long-term memory / knowledge base
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      content TEXT NOT NULL,
      project TEXT,
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_notes_chat
      ON notes(chat_id, created_at);

    -- Daily accountability journal
    CREATE TABLE IF NOT EXISTS journal (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      wins TEXT,
      blockers TEXT,
      mood TEXT,
      rating INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_journal_chat
      ON journal(chat_id, created_at);

    -- Conversation session summaries
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_session_summaries_chat
      ON session_summaries(chat_id, created_at);

    -- Habit definitions
    CREATE TABLE IF NOT EXISTS habits (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      name TEXT NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'daily',
      current_streak INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_habits_chat
      ON habits(chat_id, active);

    -- Habit completion log
    CREATE TABLE IF NOT EXISTS habit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id TEXT NOT NULL,
      completed_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(habit_id, completed_date)
    );

    -- Last message timestamp for silence detection
    CREATE TABLE IF NOT EXISTS chat_meta (
      chat_id TEXT PRIMARY KEY,
      last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
