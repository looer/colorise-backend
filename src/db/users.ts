import { getDatabase } from './index.js'

export interface UserRecord {
  userId: string
  deviceFingerprint: string
  createdAt: string
  lastSeen: string
  requestCount: number
  totalProcessingTime: number
  averageProcessingTime: number
  ipAddresses: Set<string>
}

export function getUser(userId: string): UserRecord | null {
  const db = getDatabase()
  const row = db.prepare(`
    SELECT user_id, device_fingerprint, created_at, last_seen,
           request_count, total_processing_time, average_processing_time
    FROM users WHERE user_id = ?
  `).get(userId) as any

  if (!row) return null

  // Get IP addresses
  const ipRows = db.prepare(`SELECT ip_address FROM user_ips WHERE user_id = ?`).all(userId) as any[]
  const ipAddresses = new Set(ipRows.map(r => r.ip_address))

  return {
    userId: row.user_id,
    deviceFingerprint: row.device_fingerprint,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    requestCount: row.request_count,
    totalProcessingTime: row.total_processing_time,
    averageProcessingTime: row.average_processing_time,
    ipAddresses
  }
}

export function createUser(user: { userId: string; deviceFingerprint: string; createdAt: string; lastSeen: string; requestCount: number }): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO users (user_id, device_fingerprint, created_at, last_seen, request_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(user.userId, user.deviceFingerprint, user.createdAt, user.lastSeen, user.requestCount)
}

export function updateUserAfterRequest(userId: string, processingTime: number): void {
  const db = getDatabase()
  db.prepare(`
    UPDATE users
    SET request_count = request_count + 1,
        last_seen = ?,
        total_processing_time = total_processing_time + ?,
        average_processing_time = (total_processing_time + ?) * 1.0 / (request_count + 1)
    WHERE user_id = ?
  `).run(new Date().toISOString(), processingTime, processingTime, userId)
}

export function updateUserLastSeen(userId: string): void {
  const db = getDatabase()
  db.prepare(`UPDATE users SET last_seen = ? WHERE user_id = ?`)
    .run(new Date().toISOString(), userId)
}

export function addUserIp(userId: string, ipAddress: string): void {
  const db = getDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO user_ips (user_id, ip_address, first_seen)
    VALUES (?, ?, ?)
  `).run(userId, ipAddress, new Date().toISOString())
}

export function getTotalUserCount(): number {
  const db = getDatabase()
  const row = db.prepare(`SELECT COUNT(*) as count FROM users`).get() as any
  return row.count
}

export function getAllUsers(): UserRecord[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT user_id, device_fingerprint, created_at, last_seen,
           request_count, total_processing_time, average_processing_time
    FROM users
  `).all() as any[]

  return rows.map(row => {
    const ipRows = db.prepare(`SELECT ip_address FROM user_ips WHERE user_id = ?`).all(row.user_id) as any[]
    return {
      userId: row.user_id,
      deviceFingerprint: row.device_fingerprint,
      createdAt: row.created_at,
      lastSeen: row.last_seen,
      requestCount: row.request_count,
      totalProcessingTime: row.total_processing_time,
      averageProcessingTime: row.average_processing_time,
      ipAddresses: new Set(ipRows.map(r => r.ip_address))
    }
  })
}
