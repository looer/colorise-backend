// server.js
import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { rateLimiter } from 'hono-rate-limiter'
import { jwt, sign, verify } from 'hono/jwt'
import Replicate from 'replicate'
import type { Context, Next } from 'hono'

// Types
interface UserPayload {
  userId: string
  sessionId: string
  type: 'anonymous'
  iat: number
  exp: number
  [key: string]: any
}

interface UserRecord {
  userId: string
  deviceFingerprint: string
  createdAt: string
  lastSeen: string
  requestCount: number
  sessions: Session[]
  ipAddresses: Set<string>
  totalProcessingTime?: number
  averageProcessingTime?: number
}

interface Session {
  sessionId: string
  createdAt: string
  ipAddress: string
  userAgent: string
  appVersion: string
}

interface RateLimit {
  dailyRequests: number
  lastResetDate: string
  hourlyRequests: number
  lastResetHour: number
}

type Variables = {
  user: UserPayload
  jwtPayload: UserPayload
}

const app = new Hono<{ Variables: Variables }>()

// Validate environment variables
const JWT_SECRET = process.env.JWT_SECRET
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN

if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET environment variable is required')
  process.exit(1)
}

if (!REPLICATE_API_TOKEN) {
  console.error('❌ REPLICATE_API_TOKEN environment variable is required')
  process.exit(1)
}

// Middleware
app.use('*', logger())
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// Global rate limiting
app.use('/api/*', rateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minuti
  limit: 100, // 100 richieste per IP
  message: { error: 'Too many requests from this IP' },
  keyGenerator: (c) => c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown'
}))

// Replicate client
const replicate = new Replicate({
  auth: REPLICATE_API_TOKEN,
})

// In-memory storage (Railway mantiene il container)
const anonymousUsers = new Map<string, UserRecord>()
const rateLimits = new Map<string, RateLimit>()

// Routes

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    users: anonymousUsers.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: '1.0.0'
  })
})

// Anonymous authentication
app.post('/api/auth/anonymous', async (c) => {
  try {
    const body = await c.req.json()
    const { device_info, app_version } = body

    if (!device_info) {
      return c.json({ error: 'Missing required fields' }, 400)
    }
    const user_id = device_info
    const clientIP = c.req.header('x-forwarded-for') ||
      c.req.header('x-real-ip') ||
      'unknown'

    console.log(`🔐 Auth request: ${user_id.substring(0, 8)}... from ${clientIP}`)

    // Check or create user
    let userRecord = anonymousUsers.get(user_id)

    if (!userRecord) {
      // New anonymous user
      userRecord = {
        userId: user_id,
        deviceFingerprint: device_info,
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        requestCount: 0,
        sessions: [],
        ipAddresses: new Set([clientIP])
      }

      console.log(`✨ New user: ${user_id.substring(0, 8)}...`)
    } else {
      // Existing user
      userRecord.lastSeen = new Date().toISOString()
      userRecord.ipAddresses.add(clientIP)

      // Security: device fingerprint check
      if (userRecord.deviceFingerprint !== device_info) {
        console.warn(`⚠️  Device mismatch: ${user_id.substring(0, 8)}...`)
      }
    }

    // Create session
    const sessionId = crypto.randomUUID()
    const session: Session = {
      sessionId,
      createdAt: new Date().toISOString(),
      ipAddress: clientIP,
      userAgent: c.req.header('user-agent') || 'unknown',
      appVersion: app_version || 'unknown'
    }

    userRecord.sessions.push(session)

    // Keep only last 5 sessions
    if (userRecord.sessions.length > 5) {
      userRecord.sessions = userRecord.sessions.slice(-5)
    }

    // Save user
    anonymousUsers.set(user_id, userRecord)

    // Initialize rate limiting
    initializeRateLimit(user_id)

    // Generate JWT
    const payload: UserPayload = {
      userId: user_id,
      sessionId,
      type: 'anonymous',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24h
    }

    const token = await sign(payload, JWT_SECRET)

    const userLimits = rateLimits.get(user_id)
    const dailyLimit = getDailyLimit(user_id)

    return c.json({
      success: true,
      token,
      userId: user_id,
      session_id: sessionId,
      limits: {
        daily: dailyLimit,
        remaining: dailyLimit - (userLimits?.dailyRequests || 0),
        resetAt: getNextResetTime()
      }
    })

  } catch (error) {
    console.error('❌ Auth error:', error)
    return c.json({ error: 'Authentication failed' }, 500)
  }
})

// JWT middleware
const jwtMiddleware = jwt({
  secret: JWT_SECRET,
})

// Custom auth middleware
const authenticateAnonymous = async (c: Context<{ Variables: Variables }>, next: Next) => {
  try {
    await jwtMiddleware(c, async () => { })

    const payload = c.get('jwtPayload') as UserPayload

    if (payload.type !== 'anonymous') {
      return c.json({ error: 'Invalid token type' }, 401)
    }

    c.set('user', payload)
    await next()
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error('🔒 JWT error:', errorMessage)
    return c.json({ error: 'Invalid or expired token' }, 401)
  }
}

// Rate limit middleware
const checkRateLimit = async (c: Context<{ Variables: Variables }>, next: Next) => {
  const user = c.get('user')
  const rateLimitResult = checkUserRateLimit(user.userId)

  if (!rateLimitResult.allowed) {
    return c.json({
      error: rateLimitResult.message,
      limits: rateLimitResult.limits
    }, 429)
  }

  await next()
}

/// Replicate processing endpoint
app.post('/api/replicate/colorise',
  authenticateAnonymous,
  checkRateLimit,
  async (c) => {
    const startTime = Date.now()
    const user = c.get('user')

    try {
      const formData = await c.req.formData();
      const image = formData.get('image') as File;

      if (!image) {
        return c.json({ error: 'Image required' }, 400)
      }

      const { result, processingTime, totalTime } = await processImageWithReplicate(image)

      // Update counters
      incrementRequestCount(user.userId)
      updateUserStats(user.userId, totalTime)

      const userLimits = rateLimits.get(user.userId)
      const dailyLimit = getDailyLimit(user.userId)

      console.log(`🎉 Completed: ${user.userId.substring(0, 8)}... in ${totalTime}ms`)

      // Return the output URL(s)
      return c.json({
        success: true,
        result: result,
        requestId: crypto.randomUUID(),
        processingTime: totalTime,
        limits: {
          daily: dailyLimit,
          remaining: dailyLimit - (userLimits?.dailyRequests || 0),
          resetAt: getNextResetTime()
        }
      })

    } catch (error) {
      console.error('💥 Processing error:', error)

      const errorMessage = error instanceof Error ? error.message?.toLowerCase() : ''

      if (errorMessage?.includes('rate limit') || errorMessage?.includes('quota')) {
        return c.json({
          error: 'Service temporarily busy. Please try again in a few minutes.'
        }, 429)
      }

      if (errorMessage?.includes('invalid') || errorMessage?.includes('format')) {
        return c.json({
          error: 'Invalid image format. Please use JPEG or PNG.'
        }, 400)
      }

      if (errorMessage?.includes('timeout') || errorMessage?.includes('timed out')) {
        return c.json({
          error: 'Request timed out. Please try with a smaller image or try again later.'
        }, 408)
      }

      const errorDetails = error instanceof Error ? error.message : 'Unknown error'
      return c.json({
        error: 'Processing failed. Please try again.',
        details: process.env.NODE_ENV === 'development' ? errorDetails : undefined
      }, 500)
    }
  }
)


// User stats endpoint
app.get('/api/stats', authenticateAnonymous, (c) => {
  const user = c.get('user')
  const userRecord = anonymousUsers.get(user.userId)
  const userLimits = rateLimits.get(user.userId)

  if (!userRecord) {
    return c.json({ error: 'User not found' }, 404)
  }

  const dailyLimit = getDailyLimit(user.userId)

  return c.json({
    success: true,
    stats: {
      userId: user.userId.substring(0, 8) + '...',
      sessionId: user.sessionId.substring(0, 8) + '...',
      memberSince: userRecord.createdAt,
      totalRequests: userRecord.requestCount,
      averageProcessingTime: Math.round(userRecord.averageProcessingTime || 0),
      sessionsCount: userRecord.sessions.length,
      lastSeen: userRecord.lastSeen,
      limits: {
        daily: dailyLimit,
        used: userLimits?.dailyRequests || 0,
        remaining: dailyLimit - (userLimits?.dailyRequests || 0),
        resetAt: getNextResetTime()
      }
    }
  })
})

// Admin endpoints (development only)
if (process.env.NODE_ENV === 'development') {
  // Test endpoint that skips auth for development
  app.post('/api/test/replicate', async (c) => {
    const startTime = Date.now()

    try {
      console.log('🧪 Test endpoint called - processing henri-cartier-bresson.jpg')

      // Read the test image file
      const fs = await import('fs/promises')
      const path = await import('path')

      const imagePath = path.join(process.cwd(), 'henri-cartier-bresson.jpg')

      let imageBuffer: Buffer
      try {
        imageBuffer = await fs.readFile(imagePath)
        console.log(`📷 Loaded image: ${Math.round(imageBuffer.length / 1024)}KB`)
      } catch (error) {
        return c.json({
          error: 'Image file not found',
          path: imagePath,
          hint: 'Make sure henri-cartier-bresson.jpg is in the project root'
        }, 404)
      }

      // Validate image size
      const maxSize = 10 * 1024 * 1024 // 10MB
      if (imageBuffer.length > maxSize) {
        return c.json({
          error: 'Image too large (max 10MB)',
          received: Math.round(imageBuffer.length / 1024 / 1024) + 'MB'
        }, 400)
      }

      console.log(`🎨 Processing test image... (${Math.round(imageBuffer.length / 1024)}KB)`)

      const { result, processingTime, totalTime } = await processImageWithReplicate(imageBuffer)

      console.log(`🎉 Test completed in ${totalTime}ms`)

      // Save the result image locally (development only)
      if (result) {
        try {
          const outputUrl = result as unknown as string
          console.log(`💾 Downloading result from: ${outputUrl}`)

          const response = await fetch(outputUrl)
          if (!response.ok) {
            throw new Error(`Failed to download: ${response.statusText}`)
          }

          const resultBuffer = Buffer.from(await response.arrayBuffer())
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
          const outputPath = path.join(process.cwd(), `henri-cartier-bresson-restored-${timestamp}.jpg`)

          await fs.writeFile(outputPath, resultBuffer)
          console.log(`💾 Saved result to: ${outputPath}`)

          return c.json({
            success: true,
            result: result,
            processingTime,
            savedTo: outputPath,
            originalSize: `${Math.round(imageBuffer.length / 1024)}KB`,
            resultSize: `${Math.round(resultBuffer.length / 1024)}KB`
          })
        } catch (saveError) {
          console.error('❌ Failed to save result:', saveError)
          return c.json({
            success: true,
            result: result,
            processingTime,
            saveError: saveError instanceof Error ? saveError.message : 'Unknown save error'
          })
        }
      }

      return c.json({
        success: true,
        result: result,
        processingTime
      })

    } catch (error) {
      console.error('💥 Test processing error:', error)

      const errorMessage = error instanceof Error ? error.message?.toLowerCase() : ''

      if (errorMessage?.includes('rate limit') || errorMessage?.includes('quota')) {
        return c.json({
          error: 'Service temporarily busy. Please try again in a few minutes.'
        }, 429)
      }

      if (errorMessage?.includes('timeout') || errorMessage?.includes('timed out')) {
        return c.json({
          error: 'Request timed out. Please try with a smaller image or try again later.'
        }, 408)
      }

      const errorDetails = error instanceof Error ? error.message : 'Unknown error'
      return c.json({
        error: 'Test processing failed',
        details: errorDetails,
        processingTime: Date.now() - startTime
      }, 500)
    }
  })

  app.get('/api/admin/users', (c) => {
    const users = Array.from(anonymousUsers.values()).map(user => ({
      userId: user.userId.substring(0, 8) + '...',
      createdAt: user.createdAt,
      requestCount: user.requestCount,
      sessionsCount: user.sessions.length,
      lastSeen: user.lastSeen
    }))

    return c.json({
      success: true,
      totalUsers: anonymousUsers.size,
      users: users.slice(0, 20) // Show first 20
    })
  })

  app.get('/api/admin/reset/:userId', (c) => {
    const userId = c.req.param('userId')

    if (anonymousUsers.has(userId)) {
      const today = new Date().toDateString()
      rateLimits.set(userId, {
        dailyRequests: 0,
        lastResetDate: today,
        hourlyRequests: 0,
        lastResetHour: new Date().getHours()
      })

      return c.json({ success: true, message: 'Rate limit reset' })
    }

    return c.json({ error: 'User not found' }, 404)
  })
}

// 404 handler
app.notFound((c) => {
  const endpoints = [
    'GET /health',
    'POST /api/auth/anonymous',
    'POST /api/replicate/colorise',
    'GET /api/stats'
  ]

  if (process.env.NODE_ENV === 'development') {
    endpoints.push('POST /api/test/replicate (dev only)')
  }

  return c.json({
    error: 'Endpoint not found',
    availableEndpoints: endpoints
  }, 404)
})

// Error handler
app.onError((err, c) => {
  console.error('💥 Unhandled error:', err)

  return c.json({
    error: 'Internal server error',
    timestamp: new Date().toISOString(),
    requestId: crypto.randomUUID()
  }, 500)
})

// Helper functions
async function processImageWithReplicate(image: Buffer | Blob | File) {
  const startTime = Date.now()

  const size = image instanceof File ? image.size : image instanceof Blob ? image.size : image.length
  console.log(`🎨 Starting Replicate processing... (${Math.round(size / 1024)}KB)`)

  // Use replicate.run() to await the result directly (no polling needed)
  const modelId = "flux-kontext-apps/restore-image"
  const output: any = await replicate.run(modelId, {
    input: {
      input_image: image, // Replicate will handle the image
      safety_tolerance: 2,
    }
  })
  const result = output.url()

  const totalTime = Date.now() - startTime
  console.log(`✅ Processing completed in ${totalTime}ms (${(totalTime / 1000).toFixed(1)}s). Result: ${result}`)


  const response = {
    result,
    totalTime,
    processingTime: totalTime // For backward compatibility
  }

  return response
}

function initializeRateLimit(userId: string): void {
  if (!rateLimits.has(userId)) {
    rateLimits.set(userId, {
      dailyRequests: 0,
      lastResetDate: new Date().toDateString(),
      hourlyRequests: 0,
      lastResetHour: new Date().getHours()
    })
  }
}

function checkUserRateLimit(userId: string) {
  const now = new Date()
  const currentDate = now.toDateString()
  const currentHour = now.getHours()

  let userLimits = rateLimits.get(userId)

  if (!userLimits) {
    initializeRateLimit(userId)
    userLimits = rateLimits.get(userId)!
  }

  // Reset counters if needed
  if (userLimits.lastResetDate !== currentDate) {
    userLimits.dailyRequests = 0
    userLimits.lastResetDate = currentDate
    userLimits.hourlyRequests = 0
    userLimits.lastResetHour = currentHour
  } else if (userLimits.lastResetHour !== currentHour) {
    userLimits.hourlyRequests = 0
    userLimits.lastResetHour = currentHour
  }

  const dailyLimit = getDailyLimit(userId)
  const hourlyLimit = Math.max(Math.floor(dailyLimit / 4), 3) // 1/4 of daily per hour

  if (userLimits.dailyRequests >= dailyLimit) {
    return {
      allowed: false,
      message: `Daily limit of ${dailyLimit} requests exceeded. Resets at midnight.`,
      limits: {
        daily: dailyLimit,
        remaining: 0,
        resetAt: getNextResetTime()
      }
    }
  }

  if (userLimits.hourlyRequests >= hourlyLimit) {
    return {
      allowed: false,
      message: `Hourly limit of ${hourlyLimit} requests exceeded. Try again in an hour.`,
      limits: {
        hourly: hourlyLimit,
        remaining: 0,
        resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
      }
    }
  }

  return { allowed: true }
}

function incrementRequestCount(userId: string): void {
  const userLimits = rateLimits.get(userId)
  if (userLimits) {
    userLimits.dailyRequests++
    userLimits.hourlyRequests++
  }
}

function updateUserStats(userId: string, processingTime: number): void {
  const userRecord = anonymousUsers.get(userId)
  if (userRecord) {
    userRecord.requestCount++
    userRecord.lastSeen = new Date().toISOString()
    userRecord.totalProcessingTime = (userRecord.totalProcessingTime || 0) + processingTime
    userRecord.averageProcessingTime = userRecord.totalProcessingTime / userRecord.requestCount
  }
}

function getDailyLimit(userId: string): number {
  // Could implement more sophisticated logic here
  // e.g., premium users, time-based limits, etc.
  return 20
}

function getNextResetTime(): string {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)
  return tomorrow.toISOString()
}

function sanitizePrompt(prompt: string): string {
  return prompt
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 500) // Max 500 characters
}

// Cleanup job - remove old sessions
setInterval(() => {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  let cleanedSessions = 0

  for (const [userId, userRecord] of anonymousUsers.entries()) {
    const originalLength = userRecord.sessions.length
    userRecord.sessions = userRecord.sessions.filter(
      (session: Session) => new Date(session.createdAt) > oneDayAgo
    )
    cleanedSessions += originalLength - userRecord.sessions.length
  }

  if (cleanedSessions > 0) {
    console.log(`🧹 Cleaned ${cleanedSessions} old sessions. Active users: ${anonymousUsers.size}`)
  }
}, 60 * 60 * 1000) // Every hour

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Server shutting down gracefully...')

  // Save stats before shutdown (optional)
  console.log(`📊 Final stats: ${anonymousUsers.size} users, ${Array.from(anonymousUsers.values()).reduce((sum, u) => sum + u.requestCount, 0)} total requests`)

  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('\n👋 Server interrupted, shutting down...')
  process.exit(0)
})

// Start server
const port = parseInt(process.env.PORT || '3500')

console.log('🚀 Starting server...')

serve({
  fetch: app.fetch,
  port: port
}, (info) => {
  console.log(`🎉 Server running on http://localhost:${info.port}`)
  console.log(`📊 Health check: http://localhost:${info.port}/health`)
  console.log(`🔒 JWT Secret: ${JWT_SECRET ? '✅ Set' : '❌ Missing'}`)
  console.log(`🤖 Replicate Token: ${REPLICATE_API_TOKEN ? '✅ Set' : '❌ Missing'}`)
})