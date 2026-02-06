import { getDatabase } from './index.js'

export interface RateLimit {
  dailyRequests: number
  lastResetDate: string
  hourlyRequests: number
  lastResetHour: number
}

export function getRateLimit(userId: string): RateLimit | null {
  const db = getDatabase()
  const row = db.prepare(`
    SELECT daily_requests, last_reset_date, hourly_requests, last_reset_hour
    FROM rate_limits WHERE user_id = ?
  `).get(userId) as any

  if (!row) return null

  return {
    dailyRequests: row.daily_requests,
    lastResetDate: row.last_reset_date,
    hourlyRequests: row.hourly_requests,
    lastResetHour: row.last_reset_hour
  }
}

export function initializeRateLimit(userId: string): void {
  const db = getDatabase()
  const now = new Date()
  db.prepare(`
    INSERT OR IGNORE INTO rate_limits (user_id, daily_requests, last_reset_date, hourly_requests, last_reset_hour)
    VALUES (?, 0, ?, 0, ?)
  `).run(userId, now.toDateString(), now.getHours())
}

export function incrementRateLimit(userId: string): void {
  const db = getDatabase()
  db.prepare(`
    UPDATE rate_limits
    SET daily_requests = daily_requests + 1, hourly_requests = hourly_requests + 1
    WHERE user_id = ?
  `).run(userId)
}

export function resetDailyRateLimit(userId: string): void {
  const db = getDatabase()
  const now = new Date()
  db.prepare(`
    UPDATE rate_limits
    SET daily_requests = 0, last_reset_date = ?
    WHERE user_id = ?
  `).run(now.toDateString(), userId)
}

export function resetHourlyRateLimit(userId: string): void {
  const db = getDatabase()
  db.prepare(`
    UPDATE rate_limits SET hourly_requests = 0, last_reset_hour = ?
    WHERE user_id = ?
  `).run(new Date().getHours(), userId)
}
