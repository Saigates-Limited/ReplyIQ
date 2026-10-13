import { Hono } from 'hono'
import instructions from '../reply_instructions.md?raw'
import { MODEL } from './ai'
import { TONE_MODEL } from './tone'
import { casesApi } from './routes/cases'
import { authApi, authPublic } from './routes/auth'
import { draftsApi } from './routes/drafts'
import { gmailApi, gmailCallback, sendApi } from './routes/gmail'
import { eventsApi, messagesApi } from './routes/events'
import { spapiApi } from './routes/spapi'
import { kbApi } from './routes/kb'
import { runSync } from './sync'
import { getDb, dbConfigured, type Bindings } from './db'
import { requireAuth, getSessionUser, type Vars } from './auth'
import { page, loginPage, setupPage, privacyPage } from './page'

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
app.get('/static/*', (c) => c.env.ASSETS.fetch(c.req.raw))
app.get('/privacy', (c) => c.html(privacyPage()))
app.get('/api/health', (c) => c.json({ ok: true, db: dbConfigured(c.env), via: c.env.HYPERDRIVE ? 'hyperdrive' : c.env.DATABASE_URL ? 'direct' : 'none', ai: Boolean(c.env.OPENAI_API_KEY), time: new Date().toISOString() }))
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
  if (!dbConfigured(c.env)) return notConfigured(c)
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
  if (!dbConfigured(c.env)) return notConfigured(c)
  try {
    if ((await userCount(c.env)) > 0) return c.redirect('/login')
  } catch (e) {
    console.error(e)
    return notConfigured(c)
  }
  return c.html(setupPage())
})
app.route('/api/auth', authPublic)

// Gmail OAuth callback (public URL; validated via one-time state tied to a logged-in manager)
app.route('/', gmailCallback)

// ── Everything below requires a staff session ───────────────────
app.use('*', requireAuth)

app.route('/api/auth', authApi)
app.route('/api/cases', casesApi)
app.route('/api', draftsApi)
app.route('/api/gmail', gmailApi)
app.route('/api', sendApi) // POST /api/drafts/:id/send
app.route('/api/spapi', spapiApi) // status/test
app.route('/api', spapiApi) // /cases/:id/fetch-order, /cases/:id/review-request
app.route('/api/events', eventsApi) // A-to-Z / Returns / Chargebacks trackers
app.route('/api/messages', messagesApi) // tone override
app.route('/api/kb', kbApi) // knowledge base rules for the drafting model

// SPA pages
app.get('/', (c) => c.html(page(c.get('user'))))
app.get('/cases/:id', (c) => c.html(page(c.get('user'))))
app.get('/staff', (c) => c.html(page(c.get('user'))))
app.get('/gmail', (c) => c.html(page(c.get('user'))))
app.get('/inbox', (c) => c.html(page(c.get('user'))))
app.get('/policy', (c) => c.html(page(c.get('user'))))
app.get('/settings', (c) => c.html(page(c.get('user'))))
app.get('/decision-trees', (c) => c.html(page(c.get('user'))))
app.get('/knowledge', (c) => c.html(page(c.get('user'))))
app.get('/api/policy', (c) => c.json({ markdown: instructions, model: MODEL, tone_model: TONE_MODEL }))
app.get('/api/settings', (c) =>
  c.json({
    draft_model: MODEL,
    tone_model: TONE_MODEL,
    openai_configured: !!c.env.OPENAI_API_KEY,
    openai_store: false,
    database: 'Supabase PostgreSQL (London) via Cloudflare Hyperdrive',
    hosting: 'Cloudflare Worker · cron */15 * * * *',
    attachments: { types: ['PDF', 'JPG/JPEG', 'PNG', 'XML'], max_files: 5, max_message_mb: 10 },
    auto_send: false,
  })
)
app.get('/atoz', (c) => c.html(page(c.get('user'))))
app.get('/returns', (c) => c.html(page(c.get('user'))))
app.get('/chargebacks', (c) => c.html(page(c.get('user'))))

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: err.message || 'Internal error' }, 500)
})

// Worker entry: HTTP + cron. The scheduled handler is the ONLY automated path and it is read-only (sync).
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const sql = getDb(env)
        try {
          const conn = await sql`SELECT 1 FROM gmail_connection WHERE id = 1`
          if (!conn.length) return
          const r = await runSync(env, sql, 'cron')
          console.log('gmail sync', JSON.stringify(r))
        } catch (e) {
          console.error('gmail sync failed', e)
        } finally {
          await sql.end()
        }
      })()
    )
  },
}
