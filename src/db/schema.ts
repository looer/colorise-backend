import type Database from 'better-sqlite3'

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      device_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      request_count INTEGER DEFAULT 0,
      total_processing_time INTEGER DEFAULT 0,
      average_processing_time REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      user_agent TEXT,
      app_version TEXT
    );

    CREATE TABLE IF NOT EXISTS user_ips (
      user_id TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      PRIMARY KEY (user_id, ip_address)
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      user_id TEXT PRIMARY KEY,
      daily_requests INTEGER DEFAULT 0,
      last_reset_date TEXT NOT NULL,
      hourly_requests INTEGER DEFAULT 0,
      last_reset_hour INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS request_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      processing_time INTEGER,
      model_used TEXT,
      ip_address TEXT,
      success INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_request_events_created_at ON request_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_request_events_event_type ON request_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_user_ips_user_id ON user_ips(user_id);
  `)
}
