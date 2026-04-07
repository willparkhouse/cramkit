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

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = new Hono()

const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',')

app.use('/api/*', cors({
  origin: corsOrigins,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }))

// API routes
app.route('/api', ingestionRoutes)
app.route('/api', sourceRoutes)

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

console.log(`Cramkit server running on http://localhost:${port}`)
serve({ fetch: app.fetch, port })
