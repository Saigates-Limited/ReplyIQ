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
import { promptApi } from './routes/prompt'
import { templatesApi } from './routes/templates'
import { carrierApi } from './routes/carrier'
import { returnsApi } from './routes/returns'
import { refundsApi } from './routes/refunds'
import { dailyRefundCheck, isSevenAmLondon, alreadyRanToday } from './returns/refunds'
import { syncCarrierMail, prepareDueDrafts } from './carrier/service'
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
app.route('/api/returns', returnsApi) // Physical returns desk (Part 1)
app.route('/api/refunds', refundsApi) // Refunds without return (Part 2)
app.route('/api/messages', messagesApi) // tone override
app.route('/api/kb', kbApi) // knowledge base rules for the drafting model
app.route('/api/prompt', promptApi) // custom system prompt (manager only)
app.route('/api/templates', templatesApi) // ready-to-use reply templates
app.route('/api/carrier', carrierApi) // carrier desk: Royal Mail / DPD / FedEx / Evri investigations and claims

// SPA pages
app.get('/', (c) => c.html(page(c.get('user'))))
app.get('/cases/:id', (c) => c.html(page(c.get('user'))))
app.get('/staff', (c) => c.html(page(c.get('user'))))
app.get('/gmail', (c) => c.html(page(c.get('user'))))
app.get('/inbox', (c) => c.html(page(c.get('user'))))
app.get('/inbox/:folder', (c) => c.html(page(c.get('user'))))
app.get('/policy', (c) => c.html(page(c.get('user'))))
app.get('/settings', (c) => c.html(page(c.get('user'))))
app.get('/decision-trees', (c) => c.html(page(c.get('user'))))
app.get('/knowledge', (c) => c.html(page(c.get('user'))))
app.get('/settings/prompt', (c) => c.html(page(c.get('user'))))
app.get('/templates', (c) => c.html(page(c.get('user'))))
app.get('/api/policy', (c) => c.json({ markdown: instructions, model: MODEL, tone_model: TONE_MODEL }))
// GET /api/settings/migrations (manager) — which db/migrations files have been applied, by checking each one's marker object.
app.get('/api/settings/migrations', async (c) => {
  if (c.get('user').role !== 'manager') return c.json({ error: 'Managers only' }, 403)
  const sql = getDb(c.env)
  try {
    const MARKERS: [string, 'table' | 'column' | 'trigger', string, string?][] = [
      ['0002_repair_quote_accepted', 'column', 'cases', 'repair_quote_accepted'], ['0003_draft_urgency', 'column', 'drafts', 'urgency'],
      ['0004_gmail', 'table', 'gmail_connection'], ['0005_thread_not_unique', 'table', 'gmail_threads_seen'], ['0006_events_tickets_tone', 'table', 'amazon_events'],
      ['0007_draft_mode', 'column', 'drafts', 'mode'], ['0008_hardening', 'trigger', 'trg_cases_no_delete'], ['0008b_archive_columns', 'column', 'cases', 'archived_at'],
      ['0009_attachments_replyto', 'table', 'attachments'], ['0009b_attachments_checked', 'column', 'messages', 'attachments_checked_at'], ['0010_spapi', 'table', 'amazon_orders'],
      ['0011_knowledge_base', 'table', 'kb_rules'], ['0012_system_prompt', 'table', 'system_prompt_versions'], ['0013_multi_mailbox', 'column', 'gmail_connection', 'label'],
      ['0014_templates_and_kb_seed', 'table', 'reply_templates'], ['0015_carrier_desk', 'table', 'carrier_cases'], ['0016_draft_revisions', 'column', 'drafts', 'revision_of'],
      ['0017_returns_and_refunds', 'table', 'returns'], ['0018_returns_archive_guard', 'trigger', 'trg_returns_no_delete'],
      ['0019_draft_approval_requests', 'column', 'drafts', 'approval_requested_by'], ['0020_staff_routine_send', 'column', 'drafts', 'sent_without_manager_approval'],
    ]
    const tables = new Set((await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`).map((r: any) => r.table_name))
    const cols = new Set((await sql`SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = 'public'`).map((r: any) => r.k))
    const trgs = new Set((await sql`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`).map((r: any) => r.tgname))
    const migrations = MARKERS.map(([file, kind, a, b]) => ({ file, applied: kind === 'table' ? tables.has(a) : kind === 'column' ? cols.has(`${a}.${b}`) : trgs.has(a), marker: kind === 'column' ? `${a}.${b}` : a }))
    return c.json({ migrations })
  } finally { await sql.end() }
})
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
app.get('/returns/:rest', (c) => c.html(page(c.get('user'))))
app.get('/chargebacks', (c) => c.html(page(c.get('user'))))
app.get('/carriers', (c) => c.html(page(c.get('user'))))
app.get('/carrier', (c) => c.redirect('/carriers', 301))
app.get('/carriers/:id', (c) => c.html(page(c.get('user'))))

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
          const conn = await sql`SELECT 1 FROM gmail_connection LIMIT 1`
          if (!conn.length) return
          try {
            const r = await runSync(env, sql, 'cron')
            console.log('gmail sync', JSON.stringify(r))
          } catch (e) {
            console.error('gmail sync failed', e)
          }
          // Carrier desk: read carrier mail, update parcel statuses, prepare (never send) due chases / claim packs.
          try {
            const cr = await syncCarrierMail(env, sql)
            const pr = await prepareDueDrafts(sql)
            console.log('carrier sync', JSON.stringify({ ...cr, ...pr }))
          } catch (e) {
            if (!/relation "(carrier_|app_settings)/.test(String((e as Error)?.message))) console.error('carrier sync failed', e)
          }
          // Daily "refund without return" check at 07:00 Europe/London. Cron fires 06:00 and 07:00 UTC (see wrangler.jsonc);
          // only the one that is 07:00 in London runs, and only once a day. Read-only towards Gmail; sends nothing.
          try {
            if (_event.cron !== '*/15 * * * *' && isSevenAmLondon() && !(await alreadyRanToday(sql, 'refund_check'))) {
              const rr = await dailyRefundCheck(sql, env, 'cron')
              console.log('refund check', JSON.stringify(rr))
            }
          } catch (e) {
            if (!/column|relation/.test(String((e as Error)?.message))) console.error('refund check failed', e)
          }
        } catch (e) {
          console.error('scheduled run failed', e)
        } finally {
          await sql.end()
        }
      })()
    )
  },
}
