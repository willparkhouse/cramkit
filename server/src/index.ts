import 'dotenv/config'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { serve } from '@hono/node-server'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import ingestionRoutes from './routes/ingestion.js'
import sourceRoutes from './routes/sources.js'
import adminRoutes from './routes/admin.js'
import billingRoutes from './routes/billing.js'
import stripeWebhookRoutes from './routes/stripeWebhook.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = new Hono()

const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',')

app.use('/api/*', cors({
  origin: corsOrigins,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// Health check — used by Docker HEALTHCHECK and load balancers.
// Flips to 503 once SIGTERM is received so the orchestrator stops sending traffic.
let shuttingDown = false
app.get('/api/health', (c) => {
  if (shuttingDown) return c.json({ status: 'shutting_down' }, 503)
  return c.json({ status: 'ok' })
})

// API routes
app.route('/api', ingestionRoutes)
app.route('/api', sourceRoutes)
app.route('/api', adminRoutes)
app.route('/api', billingRoutes)
app.route('/api', stripeWebhookRoutes)

// Serve static client (for production deployment)
const staticDir = join(__dirname, '..', 'public')
if (existsSync(staticDir)) {
  console.log(`Serving static client from ${staticDir}`)
  app.use('/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p }))

  // SPA fallback: serve index.html for any non-API route
  const indexHtmlPath = join(staticDir, 'index.html')
  if (existsSync(indexHtmlPath)) {
    const indexHtml = readFileSync(indexHtmlPath, 'utf-8')
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api/')) {
        return c.notFound()
      }
      return c.html(indexHtml)
    })
  }
}

const port = parseInt(process.env.PORT || '3001')

console.log(`cramkit server running on http://localhost:${port}`)
const server = serve({ fetch: app.fetch, port })

// Graceful shutdown: drain in-flight requests, then exit. Forced exit after 25s
// (orchestrators typically SIGKILL at 30s).
function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received — draining connections`)
  server.close((err) => {
    if (err) {
      console.error('error during shutdown:', err)
      process.exit(1)
    }
    console.log('shutdown complete')
    process.exit(0)
  })
  setTimeout(() => {
    console.error('shutdown timed out — forcing exit')
    process.exit(1)
  }, 25_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
