import { getDatabase } from './index.js'

export interface Session {
  sessionId: string
  userId: string
  createdAt: string
  ipAddress: string
  userAgent: string
  appVersion: string
}

export function createSession(session: Session): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO sessions (user_id, session_id, created_at, ip_address, user_agent, app_version)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(session.userId, session.sessionId, session.createdAt, session.ipAddress, session.userAgent, session.appVersion)
}

export function getUserSessions(userId: string, limit = 5): Session[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT session_id, user_id, created_at, ip_address, user_agent, app_version
    FROM sessions WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, limit) as any[]

  return rows.map(row => ({
    sessionId: row.session_id,
    userId: row.user_id,
    createdAt: row.created_at,
    ipAddress: row.ip_address,
    userAgent: row.user_agent || '',
    appVersion: row.app_version || ''
  }))
}

export function getSessionCount(userId: string): number {
  const db = getDatabase()
  const row = db.prepare(`SELECT COUNT(*) as count FROM sessions WHERE user_id = ?`).get(userId) as any
  return row.count
}

export function cleanOldSessions(olderThan: Date): number {
  const db = getDatabase()
  const result = db.prepare(`DELETE FROM sessions WHERE created_at < ?`).run(olderThan.toISOString())
  return result.changes
}
