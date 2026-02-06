import { getDatabase } from './index.js'

export interface RequestEvent {
  userId: string
  eventType: 'colorise'
  createdAt: string
  processingTime?: number
  modelUsed?: string
  ipAddress?: string
  success: boolean
}

export function logEvent(event: RequestEvent): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO request_events
    (user_id, event_type, created_at, processing_time, model_used, ip_address, success)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.userId,
    event.eventType,
    event.createdAt,
    event.processingTime || null,
    event.modelUsed || null,
    event.ipAddress || null,
    event.success ? 1 : 0
  )
}

export function cleanOldEvents(olderThan: Date): number {
  const db = getDatabase()
  const result = db.prepare(`DELETE FROM request_events WHERE created_at < ?`).run(olderThan.toISOString())
  return result.changes
}
