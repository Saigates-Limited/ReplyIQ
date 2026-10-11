import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { casesApi } from './routes/cases'
import { authApi, authPublic } from './routes/auth'
import { draftsApi } from './routes/drafts'
import { getDb, type Bindings } from './db'
import { requireAuth, getSessionUser, type Vars } from './auth'
import { page, loginPage, setupPage } from './page'

const app = new Hono<{ Bindings: Bindings; Variables: Vars }>()

// Security headers on everything
app.use('*', async (c, next) => {
  await next()
  c.header('X-Frame-Options', 'DENY')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'same-origin')
  if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store')
})

// ── Public (no login) ───────────────────────────────────────────
app.use('/static/*', serveStatic({ root: './public' }))
app.get('/api/health', (c) => c.json({ ok: true, db: Boolean(c.env.DATABASE_URL), ai: Boolean(c.env.OPENAI_API_KEY), time: new Date().toISOString() }))
async function userCount(env: Bindings) {
  const sql = getDb(env)
  try {
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM users`
    return n as number
  } finally {
    await sql.end()
  }
}
app.get('/login', async (c) => {
  if (await getSessionUser(c)) return c.redirect('/')
  if ((await userCount(c.env)) === 0) return c.redirect('/setup')
  return c.html(loginPage())
})
app.get('/setup', async (c) => {
  if ((await userCount(c.env)) > 0) return c.redirect('/login')
  return c.html(setupPage())
})
app.route('/api/auth', authPublic)

// Gmail OAuth callback — reserved for the Gmail integration phase.
// Redirect URI to register in Google Cloud: https://<your-domain>/auth/google/callback
app.get('/auth/google/callback', (c) =>
  c.text('Gmail integration is not enabled yet. This redirect URI is reserved for ReplyIQ.', 501)
)

// ── Everything below requires a staff session ───────────────────
app.use('*', requireAuth)

app.route('/api/auth', authApi)
app.route('/api/cases', casesApi)
app.route('/api', draftsApi)

// SPA pages
app.get('/', (c) => c.html(page(c.get('user'))))
app.get('/cases/:id', (c) => c.html(page(c.get('user'))))
app.get('/staff', (c) => c.html(page(c.get('user'))))

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message || 'Internal error' }, 500)
})

export default app
