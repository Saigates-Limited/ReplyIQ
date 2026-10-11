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
const notConfigured = (c: any) =>
  c.html(
    `<!DOCTYPE html><html lang="en-GB"><head><meta charset="UTF-8"><title>ReplyIQ — not configured</title><script src="https://cdn.tailwindcss.com"></script></head>
     <body class="bg-slate-900 min-h-screen flex items-center justify-center p-4"><main class="max-w-md bg-white rounded-2xl p-8 shadow-xl">
     <h1 class="font-bold text-xl mb-2">ReplyIQ is deployed but not configured</h1>
     <p class="text-sm text-slate-600 mb-3">The <code>DATABASE_URL</code> secret is missing or the database is unreachable.</p>
     <ol class="text-sm text-slate-700 list-decimal pl-5 space-y-1">
       <li>Run <code>db/schema.sql</code> in the Supabase SQL Editor.</li>
       <li>Cloudflare Dashboard → Workers &amp; Pages → <strong>replyiq</strong> → Settings → Environment variables → Production → add <code>DATABASE_URL</code> and <code>OPENAI_API_KEY</code> (Encrypt).</li>
       <li>Redeploy, then reload this page.</li>
     </ol></main></body></html>`,
    503
  )

app.get('/login', async (c) => {
  if (!c.env.DATABASE_URL) return notConfigured(c)
  try {
    if (await getSessionUser(c)) return c.redirect('/')
    if ((await userCount(c.env)) === 0) return c.redirect('/setup')
  } catch (e) {
    console.error(e)
    return notConfigured(c)
  }
  return c.html(loginPage())
})
app.get('/setup', async (c) => {
  if (!c.env.DATABASE_URL) return notConfigured(c)
  try {
    if ((await userCount(c.env)) > 0) return c.redirect('/login')
  } catch (e) {
    console.error(e)
    return notConfigured(c)
  }
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
