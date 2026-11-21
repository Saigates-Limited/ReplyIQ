// Settings → Closed-day replies (weekends and UK bank holidays). Everyone can see it; only a manager can change it or preview.
import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { getAutoReplySettings, saveAutoReplySettings, closedCalendar, runAutoReplies, CHANNELS, CONNECTED_CHANNELS } from '../autoReply'

export const autoReplyApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

autoReplyApi.get('/', async (c) => {
  const sql = getDb(c.env)
  try {
    const settings = await getAutoReplySettings(sql)
    const recent = await sql`SELECT a.id, a.case_id, c.case_ref, a.kind, a.detail, a.closed_reason, a.created_at, d.draft_text
                             FROM auto_replies a JOIN cases c ON c.id = a.case_id LEFT JOIN drafts d ON d.id = a.draft_id
                             ORDER BY a.created_at DESC LIMIT 30`.catch(() => null)
    return c.json({ settings, calendar: await closedCalendar(sql, settings), channels: CHANNELS.map((ch) => ({ id: ch, connected: CONNECTED_CHANNELS.includes(ch) })),
      recent: recent ?? [], migration_needed: recent === null ? '0027_auto_replies.sql' : null })
  } finally {
    await sql.end()
  }
})

autoReplyApi.put('/', requireManager, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as any
  const sql = getDb(c.env)
  try {
    return c.json({ settings: await saveAutoReplySettings(sql, body, c.get('user').id) })
  } finally {
    await sql.end()
  }
})

// What would be sent right now if it were switched on. Writes the replies, saves and sends nothing.
autoReplyApi.post('/preview', requireManager, async (c) => {
  const sql = getDb(c.env)
  try {
    return c.json(await runAutoReplies(c.env, sql, { dryRun: true }))
  } finally {
    await sql.end()
  }
})
