import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { initializeSchema } from './schema.js'

const DB_PATH = process.env.DB_PATH || './data/colorise.db'

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) {
    // Ensure directory exists
    const dir = path.dirname(DB_PATH)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    initializeSchema(db)
    console.log(`📦 Database initialized at ${DB_PATH}`)
  }
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
    console.log('📦 Database connection closed')
  }
}
