import { getDatabase } from './index.js'

export interface PeriodStats {
  totalRequests: number
  uniqueUsers: number
  averageRequestsPerUser: number
}

export function getStatsForPeriod(startDate: Date, endDate: Date): PeriodStats {
  const db = getDatabase()

  const row = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      COUNT(DISTINCT user_id) as unique_users
    FROM request_events
    WHERE event_type = 'colorise'
      AND created_at >= ?
      AND created_at <= ?
      AND success = 1
  `).get(startDate.toISOString(), endDate.toISOString()) as any

  const totalRequests = row.total_requests || 0
  const uniqueUsers = row.unique_users || 0
  const averageRequestsPerUser = uniqueUsers > 0
    ? Math.round((totalRequests / uniqueUsers) * 100) / 100
    : 0

  return { totalRequests, uniqueUsers, averageRequestsPerUser }
}

export interface DailyHistogramEntry {
  date: string
  requests: number
  users: number
}

export function getDailyHistogram(days: number): DailyHistogramEntry[] {
  const db = getDatabase()
  const now = new Date()
  const histogram: DailyHistogramEntry[] = []

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)

    const row = db.prepare(`
      SELECT
        COUNT(*) as requests,
        COUNT(DISTINCT user_id) as users
      FROM request_events
      WHERE event_type = 'colorise'
        AND created_at >= ?
        AND created_at < ?
        AND success = 1
    `).get(dayStart.toISOString(), dayEnd.toISOString()) as any

    histogram.push({
      date: dayStart.toISOString().split('T')[0],
      requests: row.requests || 0,
      users: row.users || 0
    })
  }

  return histogram
}

export function getTotalUsers(): number {
  const db = getDatabase()
  const row = db.prepare(`SELECT COUNT(*) as count FROM users`).get() as any
  return row.count
}

export interface UserActivity {
  userId: string
  requestCount: number
  sessionsCount: number
  ipCount: number
  createdAt: string
  lastSeen: string
  isNew: boolean // created in last 24h
}

export function getUsersActivity(): UserActivity[] {
  const db = getDatabase()
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const rows = db.prepare(`
    SELECT
      u.user_id,
      u.request_count,
      u.created_at,
      u.last_seen,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.user_id) as sessions_count,
      (SELECT COUNT(*) FROM user_ips ip WHERE ip.user_id = u.user_id) as ip_count
    FROM users u
    ORDER BY u.request_count DESC
  `).all() as any[]

  return rows.map(row => ({
    userId: row.user_id,
    requestCount: row.request_count,
    sessionsCount: row.sessions_count,
    ipCount: row.ip_count,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    isNew: row.created_at >= twentyFourHoursAgo
  }))
}

export function getNewVsReturningStats(): { newUsers: number; returningUsers: number } {
  const db = getDatabase()
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as new_users,
      SUM(CASE WHEN created_at < ? AND last_seen >= ? THEN 1 ELSE 0 END) as returning_users
    FROM users
  `).get(twentyFourHoursAgo, twentyFourHoursAgo, twentyFourHoursAgo) as any

  return {
    newUsers: row.new_users || 0,
    returningUsers: row.returning_users || 0
  }
}

export function getAverageProcessingTime(days: number): number {
  const db = getDatabase()
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const row = db.prepare(`
    SELECT AVG(processing_time) as avg_time
    FROM request_events
    WHERE event_type = 'colorise'
      AND created_at >= ?
      AND success = 1
      AND processing_time IS NOT NULL
  `).get(since.toISOString()) as any

  return Math.round(row.avg_time || 0)
}
