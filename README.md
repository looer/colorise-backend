# Colorise Proxy API

A Node.js API server built with Hono that provides anonymous authentication and AI image processing through Replicate's image restoration models.

## 🚀 Features

- **Anonymous Authentication**: JWT-based auth without requiring personal information
- **Rate Limiting**: Per-user daily and hourly limits to prevent abuse
- **AI Image Processing**: Restore and enhance images using Replicate's models
- **Development Tools**: Test endpoint for quick iteration
- **Health Monitoring**: Built-in health checks and user statistics

## 🏗️ Architecture Flow

```
Client Request → Authentication → Rate Limiting → Replicate Processing → Response
```

1. **Authentication**: Users authenticate with device fingerprint to get JWT token
2. **Rate Limiting**: Each user has daily/hourly processing limits
3. **Image Processing**: Images are sent directly to Replicate for AI processing
4. **Response**: Processed image URL returned to client

## 📋 API Endpoints

### 🔓 Public Endpoints

#### `GET /health`

Health check endpoint showing server status and metrics.

**Response:**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "users": 42,
  "uptime": 3600,
  "memory": { "rss": 67108864, "heapTotal": 20971520, "heapUsed": 18874368 },
  "version": "1.0.0"
}
```

#### `GET /stats`

Get comprehensive public statistics about API usage across multiple time periods. No authentication required.

**Response:**

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "periods": {
    "24h": {
      "totalRequests": 156,
      "uniqueUsers": 23,
      "averageRequestsPerUser": 6.78
    },
    "7d": {
      "totalRequests": 1247,
      "uniqueUsers": 89,
      "averageRequestsPerUser": 14.01
    },
    "30d": {
      "totalRequests": 4567,
      "uniqueUsers": 234,
      "averageRequestsPerUser": 19.52
    }
  },
  "histogram": {
    "type": "daily",
    "period": "7d",
    "data": [
      {
        "date": "2024-01-09",
        "requests": 45,
        "users": 12
      },
      {
        "date": "2024-01-10",
        "requests": 67,
        "users": 18
      },
      {
        "date": "2024-01-11",
        "requests": 89,
        "users": 23
      },
      {
        "date": "2024-01-12",
        "requests": 123,
        "users": 31
      },
      {
        "date": "2024-01-13",
        "requests": 156,
        "users": 28
      },
      {
        "date": "2024-01-14",
        "requests": 134,
        "users": 25
      },
      {
        "date": "2024-01-15",
        "requests": 156,
        "users": 23
      }
    ]
  },
  "totals": {
    "totalUsers": 234
  }
}
```

**Notes:**

- **Multiple time periods**: 24h, 7d, and 30d statistics
- **Daily histogram**: Breakdown of requests and users by day for the last 7 days
- **Extensible structure**: Easy to add new time periods or histogram types
- **Real-time data**: All statistics are calculated in real-time
- **No authentication required**: Public endpoint for monitoring API usage

### 🔐 Authentication

#### `POST /api/auth/anonymous`

Create an anonymous user session and get JWT token.

**Input:**

```json
{
  "device_info": "unique-device-fingerprint-string",
  "app_version": "1.0.0"
}
```

**Output:**

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "userId": "device-fingerprint-string",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "limits": {
    "daily": 20,
    "remaining": 20,
    "resetAt": "2024-01-16T00:00:00.000Z"
  }
}
```

**Notes:**

- `device_info` is used as both device fingerprint and user ID
- JWT token expires in 24 hours
- Each device gets 20 requests per day

### 🎨 Image Processing

#### `POST /api/replicate/colorise`

Process an image using AI restoration models.

**Headers:**

```
Authorization: Bearer <jwt-token>
Content-Type: application/json
```

**Input:**

```json
multipart/form-data
image: <image-file>
```

**Output:**

```json
{
  "success": true,
  "result": "https://replicate.delivery/xezq/abc123.png",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "processingTime": 6234,
  "limits": {
    "daily": 20,
    "remaining": 19,
    "resetAt": "2024-01-16T00:00:00.000Z"
  }
}
```

**Notes:**

- Images must be under 10MB
- Processing typically takes 5-7 seconds
- Result is a URL to the processed image
- Rate limits are enforced per user

### 📊 User Statistics

#### `GET /api/stats`

Get current user's usage statistics and limits.

**Headers:**

```
Authorization: Bearer <jwt-token>
```

**Output:**

```json
{
  "success": true,
  "stats": {
    "userId": "device12...",
    "sessionId": "550e840...",
    "memberSince": "2024-01-15T10:00:00.000Z",
    "totalRequests": 5,
    "averageProcessingTime": 6234,
    "sessionsCount": 3,
    "lastSeen": "2024-01-15T10:30:00.000Z",
    "limits": {
      "daily": 20,
      "used": 5,
      "remaining": 15,
      "resetAt": "2024-01-16T00:00:00.000Z"
    }
  }
}
```

### 🧪 Development Endpoints

#### `POST /api/test/replicate` _(Development Only)_

Test image processing without authentication using a local image file.

**Requirements:**

- `NODE_ENV=development`
- `henri-cartier-bresson.jpg` file in project root

**Output:**

```json
{
  "success": true,
  "result": "https://replicate.delivery/xezq/abc123.png",
  "processingTime": 6234,
  "savedTo": "/path/to/henri-cartier-bresson-restored-2024-01-15T10-30-00-000Z.jpg",
  "originalSize": "42KB",
  "resultSize": "156KB"
}
```

**Notes:**

- Automatically saves processed image locally
- No authentication required
- Perfect for testing and development

## ⚙️ Environment Variables

Create a `.env` file with:

```bash
# Required
JWT_SECRET=your-super-secret-jwt-key-make-it-very-long-and-random
REPLICATE_API_TOKEN=r8_your_replicate_token_here

# Optional
PORT=3500
NODE_ENV=development
```

## 🔒 Rate Limiting

- **Daily Limit**: 20 requests per user per day
- **Hourly Limit**: 5 requests per user per hour (25% of daily)
- **Global Limit**: 100 requests per IP per 15 minutes
- **Resets**: Daily limits reset at midnight UTC

## 🚀 Getting Started

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Set up environment:**

   ```bash
   cp .env.example .env
   # Edit .env with your API tokens
   ```

3. **Start development server:**

   ```bash
   npm run dev
   ```

4. **Test the API:**

   ```bash
   # Health check
   curl http://localhost:3500/health

   # Get auth token
   curl -X POST http://localhost:3500/api/auth/anonymous \
     -H "Content-Type: application/json" \
     -d '{"device_info":"my-unique-device-id","app_version":"1.0.0"}'
   ```

## 🎯 Typical Usage Flow

1. **Authenticate**: POST to `/api/auth/anonymous` with device info
2. **Get Token**: Receive JWT token for subsequent requests
3. **Process Image**: POST to `/api/replicate/colorise` with image data
4. **Monitor Usage**: GET `/api/stats` to check remaining limits
5. **Handle Result**: Download processed image from returned URL

## 📝 Error Handling

All endpoints return consistent error formats:

```json
{
  "error": "Description of what went wrong",
  "details": "Additional technical details (development only)"
}
```

Common HTTP status codes:

- `400`: Bad request (missing fields, invalid image)
- `401`: Unauthorized (invalid/expired token)
- `404`: Endpoint not found
- `408`: Request timeout
- `429`: Rate limit exceeded
- `500`: Internal server error

## 🚀 Deployment

### Railway (Recommended)

1. **Connect your repository** to [Railway](https://railway.com?referralCode=Lorenzo)
2. **Set environment variables:**
   - `JWT_SECRET`: Generate a secure random string
   - `REPLICATE_API_TOKEN`: Your Replicate API token
3. **Deploy**: Railway will automatically build and deploy

### Other Platforms

This is a standard Node application that can be deployed to any platform that supports Node.js.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Hono](https://hono.dev/) - Fast, lightweight web framework
- [Replicate](https://replicate.com/) - AI model hosting platform
- [Railway](https://railway.app/) - Simple cloud deployment platform
