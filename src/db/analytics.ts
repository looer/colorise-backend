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
