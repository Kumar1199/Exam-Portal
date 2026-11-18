import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import proxyHandler from './api/proxy.js'
import { getDb } from './api/mongoBackend.mjs'
import { emailConfigured, sendActivations } from './api/activation.mjs'

function localApi() {
  return {
    name: 'student360-local-api',
    configureServer(server) {
      let processing = false
      const timer = setInterval(async () => {
        if (processing || !emailConfigured()) return
        processing = true
        try { await sendActivations(await getDb()) } catch { console.warn('Activation queue processing failed; pending emails remain queued.') }
        finally { processing = false }
      }, 60000)
      timer.unref()
      server.httpServer?.once('close', () => clearInterval(timer))
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/proxy')) return next()
        const url = new URL(req.url, 'http://localhost')
        req.query = Object.fromEntries(url.searchParams)
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
          let body = ''
          for await (const chunk of req) body += chunk
          try { req.body = body ? JSON.parse(body) : {} } catch { res.statusCode = 400; return res.end('Invalid JSON body.') }
        }
        res.status = code => { res.statusCode = code; return res }
        res.json = data => { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(data)) }
        res.send = data => res.end(data)
        try { await proxyHandler(req, res) } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })) }
      })
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of ['MONGODB_URI', 'MONGODB_DB_NAME', 'JWT_SECRET', 'ADMIN_BOOTSTRAP_TOKEN', 'BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_SENDER_NAME', 'APP_BASE_URL', 'ACTIVATION_DAILY_LIMIT', 'CRON_SECRET', 'COMPILER_PYTHON_URL', 'COMPILER_C_URL', 'COMPILER_CPP_URL', 'COMPILER_JAVA_URL', 'JUDGE0_URL', 'JUDGE0_API_KEY', 'JUDGE0_HOST']) {
    if (env[key]) process.env[key] = env[key]
  }
  return {
  plugins: [react(), tailwindcss(), localApi()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  }
})
