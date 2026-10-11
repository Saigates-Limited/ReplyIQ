import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { casesApi } from './routes/cases'
import type { Bindings } from './db'
import { page } from './page'

const app = new Hono<{ Bindings: Bindings }>()

app.use('/static/*', serveStatic({ root: './public' }))

app.get('/api/health', async (c) => {
  return c.json({ ok: true, db: Boolean(c.env.DATABASE_URL), time: new Date().toISOString() })
})

app.route('/api/cases', casesApi)

// Single-page UI: list at "/", case screen at "/cases/:id" (client-side routed)
app.get('/', (c) => c.html(page()))
app.get('/cases/:id', (c) => c.html(page()))

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message || 'Internal error' }, 500)
})

export default app
