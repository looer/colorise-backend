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

// Database imports
import { getDatabase, closeDatabase } from './db/index.js'
import * as dbUsers from './db/users.js'
import * as dbSessions from './db/sessions.js'
import * as dbRateLimits from './db/rate-limits.js'
import * as dbEvents from './db/events.js'
import * as analytics from './db/analytics.js'

// Types
interface UserPayload {
  userId: string
  sessionId: string
  type: 'anonymous'
  iat: number
  exp: number
  [key: string]: any
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

// Initialize database on startup
getDatabase()

// Routes

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    users: analytics.getTotalUsers(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: '1.1.0'
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

    // Check or create user in database
    let userRecord = dbUsers.getUser(user_id)

    if (!userRecord) {
      // New anonymous user
      dbUsers.createUser({
        userId: user_id,
        deviceFingerprint: device_info,
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        requestCount: 0
      })
      dbUsers.addUserIp(user_id, clientIP)
      console.log(`✨ New user: ${user_id.substring(0, 8)}...`)
      userRecord = dbUsers.getUser(user_id)!
    } else {
      // Existing user
      dbUsers.updateUserLastSeen(user_id)
      dbUsers.addUserIp(user_id, clientIP)

      // Security: device fingerprint check
      if (userRecord.deviceFingerprint !== device_info) {
        console.warn(`⚠️  Device mismatch: ${user_id.substring(0, 8)}...`)
      }
    }

    // Create session in database
    const sessionId = crypto.randomUUID()
    dbSessions.createSession({
      sessionId,
      userId: user_id,
      createdAt: new Date().toISOString(),
      ipAddress: clientIP,
      userAgent: c.req.header('user-agent') || 'unknown',
      appVersion: app_version || 'unknown'
    })

    // Initialize rate limiting in database
    dbRateLimits.initializeRateLimit(user_id)

    // Generate JWT
    const payload: UserPayload = {
      userId: user_id,
      sessionId,
      type: 'anonymous',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24h
    }

    const token = await sign(payload, JWT_SECRET)

    const userLimits = dbRateLimits.getRateLimit(user_id)
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

      const { result, processingTime, totalTime, modelUsed } = await processImageWithReplicate(image)

      // Update user stats and counters
      updateUserAfterRequest(user.userId, totalTime)

      // Log the event for analytics
      dbEvents.logEvent({
        userId: user.userId,
        eventType: 'colorise',
        createdAt: new Date().toISOString(),
        processingTime: totalTime,
        modelUsed,
        ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown',
        success: true
      })

      const userLimits = dbRateLimits.getRateLimit(user.userId)
      const dailyLimit = getDailyLimit(user.userId)

      console.log(`🎉 Completed: ${user.userId.substring(0, 8)}... in ${totalTime}ms using ${modelUsed}`)

      // Return the output URL(s)
      return c.json({
        success: true,
        result: result,
        requestId: crypto.randomUUID(),
        processingTime: totalTime,
        modelUsed,
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


// Public stats endpoint (no authentication required)
app.get('/stats', (c) => {
  const now = new Date()
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  return c.json({
    timestamp: now.toISOString(),
    periods: {
      '24h': analytics.getStatsForPeriod(twentyFourHoursAgo, now),
      '7d': analytics.getStatsForPeriod(sevenDaysAgo, now),
      '30d': analytics.getStatsForPeriod(thirtyDaysAgo, now)
    },
    histogram: {
      type: 'daily',
      period: '7d',
      data: analytics.getDailyHistogram(7)
    },
    totals: {
      totalUsers: analytics.getTotalUsers()
    }
  })
})

// Dashboard with charts
app.get('/dashboard', (c) => {
  const now = new Date()
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const stats24h = analytics.getStatsForPeriod(twentyFourHoursAgo, now)
  const stats7d = analytics.getStatsForPeriod(sevenDaysAgo, now)
  const stats30d = analytics.getStatsForPeriod(thirtyDaysAgo, now)
  const histogram = analytics.getDailyHistogram(14) // 14 days for better chart
  const totalUsers = analytics.getTotalUsers()
  const usersActivity = analytics.getUsersActivity()
  const newVsReturning = analytics.getNewVsReturningStats()

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Colorise API Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 24px; }
    h1 { font-size: 1.5rem; margin-bottom: 24px; color: #fff; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .stat-card { background: #1a1a1a; border-radius: 12px; padding: 20px; border: 1px solid #2a2a2a; }
    .stat-label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    .stat-value { font-size: 2rem; font-weight: 600; color: #fff; }
    .stat-sub { font-size: 0.875rem; color: #666; margin-top: 4px; }
    .chart-container { background: #1a1a1a; border-radius: 12px; padding: 24px; border: 1px solid #2a2a2a; margin-bottom: 32px; }
    .chart-title { font-size: 1rem; margin-bottom: 16px; color: #fff; }
    canvas { max-height: 300px; }
    .users-table { width: 100%; border-collapse: collapse; }
    .users-table th { text-align: left; font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.5px; padding: 12px 16px; border-bottom: 1px solid #2a2a2a; }
    .users-table td { padding: 12px 16px; border-bottom: 1px solid #1f1f1f; font-size: 0.875rem; }
    .users-table tr:hover { background: #222; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; }
    .badge-new { background: #064e3b; color: #6ee7b7; }
    .badge-returning { background: #1e1b4b; color: #a5b4fc; }
    .badge-warning { background: #451a03; color: #fbbf24; }
    .section-title { font-size: 1.1rem; margin-bottom: 16px; color: #fff; }
  </style>
</head>
<body>
  <h1>Colorise API</h1>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Last 24 hours</div>
      <div class="stat-value">${stats24h.totalRequests}</div>
      <div class="stat-sub">${stats24h.uniqueUsers} users</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Last 7 days</div>
      <div class="stat-value">${stats7d.totalRequests}</div>
      <div class="stat-sub">${stats7d.uniqueUsers} users</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Last 30 days</div>
      <div class="stat-value">${stats30d.totalRequests}</div>
      <div class="stat-sub">${stats30d.uniqueUsers} users</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Users</div>
      <div class="stat-value">${totalUsers}</div>
      <div class="stat-sub">all time</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Cost (7d)</div>
      <div class="stat-value">$${(stats7d.totalRequests * 0.04).toFixed(2)}</div>
      <div class="stat-sub">$${(stats30d.totalRequests * 0.04).toFixed(2)} last 30d</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">New (24h)</div>
      <div class="stat-value">${newVsReturning.newUsers}</div>
      <div class="stat-sub">first time users</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Returning (24h)</div>
      <div class="stat-value">${newVsReturning.returningUsers}</div>
      <div class="stat-sub">came back today</div>
    </div>
  </div>

  <div class="chart-container">
    <div class="chart-title">Activity (last 14 days)</div>
    <canvas id="requestsChart"></canvas>
  </div>

  <div class="chart-container">
    <div class="chart-title">Users Activity</div>
    <table class="users-table">
      <thead>
        <tr>
          <th>User</th>
          <th>Status</th>
          <th>Requests</th>
          <th>Sessions</th>
          <th>IPs</th>
          <th>Cost</th>
          <th>First Seen</th>
          <th>Last Seen</th>
        </tr>
      </thead>
      <tbody>
        ${usersActivity.map(u => {
          const reqPerSession = u.sessionsCount > 0 ? (u.requestCount / u.sessionsCount).toFixed(1) : '0'
          const suspicious = u.requestCount > 50 || u.ipCount > 5
          return `<tr>
            <td><code>${u.userId.substring(0, 12)}...</code></td>
            <td>${u.isNew ? '<span class="badge badge-new">NEW</span>' : '<span class="badge badge-returning">RETURNING</span>'}${suspicious ? ' <span class="badge badge-warning">SUSPICIOUS</span>' : ''}</td>
            <td>${u.requestCount}</td>
            <td>${u.sessionsCount} <span style="color:#666">(${reqPerSession} req/sess)</span></td>
            <td>${u.ipCount}</td>
            <td>$${(u.requestCount * 0.04).toFixed(2)}</td>
            <td>${new Date(u.createdAt).toLocaleDateString()}</td>
            <td>${new Date(u.lastSeen).toLocaleDateString()}</td>
          </tr>`
        }).join('')}
      </tbody>
    </table>
  </div>

  <script>
    const data = ${JSON.stringify(histogram)};
    const ctx = document.getElementById('requestsChart').getContext('2d');

    new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(d => d.date.slice(5)), // MM-DD format
        datasets: [{
          label: 'Requests',
          data: data.map(d => d.requests),
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: '#6366f1'
        }, {
          label: 'Users',
          data: data.map(d => d.users),
          borderColor: '#f97316',
          backgroundColor: 'rgba(249, 115, 22, 0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: '#f97316'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            labels: { color: '#888' }
          }
        },
        scales: {
          x: {
            grid: { color: '#2a2a2a' },
            ticks: { color: '#888' }
          },
          y: {
            beginAtZero: true,
            grid: { color: '#2a2a2a' },
            ticks: { color: '#888', stepSize: 1 }
          }
        }
      }
    });
  </script>
</body>
</html>`

  return c.html(html)
})

// User stats endpoint
app.get('/api/stats', authenticateAnonymous, (c) => {
  const user = c.get('user')
  const userRecord = dbUsers.getUser(user.userId)
  const userLimits = dbRateLimits.getRateLimit(user.userId)

  if (!userRecord) {
    return c.json({ error: 'User not found' }, 404)
  }

  const dailyLimit = getDailyLimit(user.userId)
  const sessionsCount = dbSessions.getSessionCount(user.userId)

  return c.json({
    success: true,
    stats: {
      userId: user.userId.substring(0, 8) + '...',
      sessionId: user.sessionId.substring(0, 8) + '...',
      memberSince: userRecord.createdAt,
      totalRequests: userRecord.requestCount,
      averageProcessingTime: Math.round(userRecord.averageProcessingTime || 0),
      sessionsCount,
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

      const { result, processingTime, totalTime, modelUsed } = await processImageWithReplicate(imageBuffer)

      console.log(`🎉 Test completed in ${totalTime}ms using ${modelUsed}`)

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
            modelUsed,
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
            modelUsed,
            saveError: saveError instanceof Error ? saveError.message : 'Unknown save error'
          })
        }
      }

      return c.json({
        success: true,
        result: result,
        processingTime,
        modelUsed
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
    const allUsers = dbUsers.getAllUsers()
    const users = allUsers.map(user => ({
      userId: user.userId.substring(0, 8) + '...',
      createdAt: user.createdAt,
      requestCount: user.requestCount,
      sessionsCount: dbSessions.getSessionCount(user.userId),
      lastSeen: user.lastSeen
    }))

    return c.json({
      success: true,
      totalUsers: allUsers.length,
      users: users.slice(0, 20) // Show first 20
    })
  })

  app.get('/api/admin/reset/:userId', (c) => {
    const userId = c.req.param('userId')
    const user = dbUsers.getUser(userId)

    if (user) {
      dbRateLimits.resetDailyRateLimit(userId)
      return c.json({ success: true, message: 'Rate limit reset' })
    }

    return c.json({ error: 'User not found' }, 404)
  })
}

// 404 handler
app.notFound((c) => {
  const endpoints = [
    'GET /health',
    'GET /stats',
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

  const models = [
    { id: "google/nano-banana", input: { image_input: [image], output_format: "png", prompt: "restore the original natural colors of this picture, also restore the parts of the image that are ruined." } },
    { id: "flux-kontext-apps/restore-image", input: { input_image: image, safety_tolerance: 2 } }
  ]

  let lastError: Error | null = null

  for (const model of models) {
    try {
      console.log(`🎨 Trying ${model.id}...`)
      const output: any = await replicate.run(model.id as any, { input: model.input })
      const result = output.url()
      const totalTime = Date.now() - startTime

      console.log(`✅ ${model.id} succeeded in ${totalTime}ms`)
      return { result, totalTime, processingTime: totalTime, modelUsed: model.id }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error')
      console.warn(`⚠️ ${model.id} failed: ${lastError.message}`)
    }
  }

  throw lastError || new Error('All models failed')
}

function checkUserRateLimit(userId: string) {
  const now = new Date()
  const currentDate = now.toDateString()
  const currentHour = now.getHours()

  let userLimits = dbRateLimits.getRateLimit(userId)

  if (!userLimits) {
    dbRateLimits.initializeRateLimit(userId)
    userLimits = dbRateLimits.getRateLimit(userId)!
  }

  // Reset counters if needed
  if (userLimits.lastResetDate !== currentDate) {
    dbRateLimits.resetDailyRateLimit(userId)
    userLimits = dbRateLimits.getRateLimit(userId)!
  } else if (userLimits.lastResetHour !== currentHour) {
    dbRateLimits.resetHourlyRateLimit(userId)
    userLimits = dbRateLimits.getRateLimit(userId)!
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

function updateUserAfterRequest(userId: string, processingTime: number): void {
  // Update rate limits in database
  dbRateLimits.incrementRateLimit(userId)

  // Update user stats in database
  dbUsers.updateUserAfterRequest(userId, processingTime)
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


// Cleanup job - remove old sessions and events
setInterval(() => {
  // Clean sessions older than 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const cleanedSessions = dbSessions.cleanOldSessions(sevenDaysAgo)

  // Clean events older than 90 days
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const cleanedEvents = dbEvents.cleanOldEvents(ninetyDaysAgo)

  if (cleanedSessions > 0 || cleanedEvents > 0) {
    console.log(`🧹 Cleaned ${cleanedSessions} old sessions, ${cleanedEvents} old events. Active users: ${analytics.getTotalUsers()}`)
  }
}, 60 * 60 * 1000) // Every hour

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Server received SIGTERM, cleaning up...')
  console.log(`📊 Final stats: ${analytics.getTotalUsers()} users`)
  closeDatabase()
  // Don't call process.exit() — let Railway manage the process lifecycle.
  // During deployments, Railway will replace this process with the new one.
  // Calling exit(0) causes Railway to mark the service as "completed" and stop it.
})

process.on('SIGINT', () => {
  console.log('\n👋 Server interrupted, shutting down...')
  closeDatabase()
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
  console.log(`Node version: ${process.version}`)
  console.log(`🔒 JWT Secret: ${JWT_SECRET ? '✅ Set' : '❌ Missing'}`)
  console.log(`🤖 Replicate Token: ${REPLICATE_API_TOKEN ? '✅ Set' : '❌ Missing'}`)
})