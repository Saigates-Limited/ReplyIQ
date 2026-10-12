// Amazon events: A-to-Z claims, return requests, chargebacks.
// Each row is parsed from an Amazon notice email during sync and linked to the order's case.
import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import type { Vars } from '../auth'
import { TONES } from '../tone'

export const eventsApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

// Allowed status transitions per tracker (agreed with Saigates)
const STATUSES: Record<string, string[]> = {
  atoz: ['open', 'info_requested', 'response_sent', 'won', 'lost', 'closed'],
  return: ['requested', 'received', 'inspected', 'refunded', 'closed'],
  chargeback: ['open', 'response_sent', 'won', 'lost', 'closed'],
}
const KIND_FILTER: Record<string, string[]> = {
  atoz: ['atoz_claim', 'atoz_info_request', 'atoz_decision'],
  return: ['return_request'],
  chargeback: ['chargeback'],
}
const trackerOf = (kind: string) => (kind.startsWith('atoz') ? 'atoz' : kind === 'chargeback' ? 'chargeback' : 'return')

const EVENT_SELECT = `
  e.id, e.case_id, e.order_id, e.kind, e.status, e.amount, e.currency, e.received_at, e.deadline_at,
  e.return_request_date, e.policy_check, e.authorisation, e.asin, e.sku, e.quantity, e.return_reason, e.customer_comment,
  e.order_date, e.item_description, e.reply_to, e.product, e.raw_excerpt, e.response_text, e.responded_at,
  ru.name AS responded_by_name,
  c.case_ref, c.customer_first_name, c.customer_last_name, c.tone AS case_tone, c.battery_flag, c.assigned_to,
  u.name AS assigned_to_name,
  (SELECT status FROM drafts d WHERE d.case_id = e.case_id AND d.status <> 'discarded' ORDER BY d.created_at DESC LIMIT 1) AS latest_draft_status
`
const EVENT_FROM = `
  FROM amazon_events e
  LEFT JOIN cases c ON c.id = e.case_id
  LEFT JOIN users u ON u.id = c.assigned_to
  LEFT JOIN users ru ON ru.id = e.responded_by
`

// GET /api/events?kind=atoz|return|chargeback&status=open|all
// One row per order for the A-to-Z tracker (latest notice wins), one per notice otherwise.
eventsApi.get('/', async (c) => {
  const kind = c.req.query('kind') ?? 'atoz'
  const show = c.req.query('status') ?? 'open'
  const kinds = KIND_FILTER[kind]
  if (!kinds) return c.json({ error: 'kind must be atoz, return or chargeback' }, 400)
  const closed = kind === 'return' ? ['refunded', 'closed'] : ['won', 'lost', 'closed']
  const sql = getDb(c.env)
  try {
    const rows = await sql.unsafe(
      `SELECT ${EVENT_SELECT} ${EVENT_FROM}
       WHERE e.kind = ANY(string_to_array($1, ',')) AND (c.archived_at IS NULL)
         AND ($2 = 'all' OR NOT (e.status = ANY(string_to_array($3, ','))))
       ORDER BY
         CASE WHEN e.deadline_at IS NOT NULL AND e.deadline_at < now() AND NOT (e.status = ANY(string_to_array($3, ','))) THEN 0 ELSE 1 END,
         e.deadline_at ASC NULLS LAST, e.received_at DESC`,
      [kinds.join(','), show, closed.join(',')]
    )
    return c.json({ events: rows, statuses: STATUSES[kind], now: new Date().toISOString() })
  } finally {
    await sql.end()
  }
})

// GET /api/events/counts → badges for the tabs
eventsApi.get('/counts', async (c) => {
  const sql = getDb(c.env)
  try {
    const [r] = await sql`
      SELECT
        (SELECT COUNT(*) FROM amazon_events e JOIN cases c ON c.id = e.case_id WHERE c.archived_at IS NULL AND e.kind LIKE 'atoz%' AND e.status NOT IN ('won','lost','closed'))::int AS atoz,
        (SELECT COUNT(*) FROM amazon_events e JOIN cases c ON c.id = e.case_id WHERE c.archived_at IS NULL AND e.kind = 'return_request' AND e.status NOT IN ('refunded','closed'))::int AS returns,
        (SELECT COUNT(*) FROM amazon_events e JOIN cases c ON c.id = e.case_id WHERE c.archived_at IS NULL AND e.kind = 'chargeback' AND e.status NOT IN ('won','lost','closed'))::int AS chargebacks,
        (SELECT COUNT(*) FROM cases WHERE status <> 'resolved' AND archived_at IS NULL)::int AS messages`
    return c.json(r)
  } finally {
    await sql.end()
  }
})

// PATCH /api/events/:id {status?, response_text?}
eventsApi.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'Invalid id' }, 400)
  const body = (await c.req.json().catch(() => ({}))) as { status?: string; response_text?: string }
  const user = c.get('user')
  const sql = getDb(c.env)
  try {
    const [e] = await sql`SELECT * FROM amazon_events WHERE id = ${id}`
    if (!e) return c.json({ error: 'Event not found' }, 404)
    const allowed = STATUSES[trackerOf(e.kind)]
    if (body.status !== undefined && !allowed.includes(body.status)) return c.json({ error: `Status must be one of: ${allowed.join(', ')}` }, 422)
    const status = body.status ?? e.status
    const response = typeof body.response_text === 'string' ? body.response_text.slice(0, 10000) : e.response_text
    await sql.begin(async (tx) => {
      await tx`UPDATE amazon_events SET status = ${status}, response_text = ${response},
                 responded_by = CASE WHEN ${status} = 'response_sent' AND responded_by IS NULL THEN ${user.id} ELSE responded_by END,
                 responded_at = CASE WHEN ${status} = 'response_sent' AND responded_at IS NULL THEN now() ELSE responded_at END,
                 updated_at = now() WHERE id = ${id}`
      // Keep the case flags in step with the tracker
      if (e.case_id) {
        if (e.kind.startsWith('atoz')) {
          const stillOpen = !['won', 'lost', 'closed'].includes(status)
          await tx`UPDATE cases SET a_to_z_open = ${stillOpen}, updated_at = now() WHERE id = ${e.case_id}`
        } else if (e.kind === 'chargeback') {
          const stillOpen = !['won', 'lost', 'closed'].includes(status)
          await tx`UPDATE cases SET chargeback_open = ${stillOpen}, updated_at = now() WHERE id = ${e.case_id}`
        } else if (e.kind === 'return_request' && status === 'refunded') {
          await tx`UPDATE cases SET refund_issued = TRUE, updated_at = now() WHERE id = ${e.case_id}`
        }
      }
    })
    const [row] = await sql.unsafe(`SELECT ${EVENT_SELECT} ${EVENT_FROM} WHERE e.id = $1`, [id])
    return c.json({ event: row })
  } finally {
    await sql.end()
  }
})

// PATCH /api/messages/:id/tone {tone}  → staff override on one message
export const messagesApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()
messagesApi.patch('/:id/tone', async (c) => {
  const id = Number(c.req.param('id'))
  const body = (await c.req.json().catch(() => ({}))) as { tone?: string }
  if (!body.tone || !(TONES as readonly string[]).includes(body.tone)) return c.json({ error: 'Invalid tone' }, 422)
  const sql = getDb(c.env)
  try {
    const [m] = await sql`UPDATE messages SET tone = ${body.tone}, tone_source = 'staff' WHERE id = ${id} RETURNING id, case_id, tone, tone_source, sent_at`
    if (!m) return c.json({ error: 'Message not found' }, 404)
    // If this is the latest customer message, the case label follows it
    await sql`UPDATE cases SET tone = ${body.tone}, updated_at = now() WHERE id = ${m.case_id}
              AND ${m.id} = (SELECT id FROM messages WHERE case_id = ${m.case_id} AND direction = 'inbound' AND kind <> 'event' ORDER BY sent_at DESC LIMIT 1)`
    return c.json({ message: m })
  } finally {
    await sql.end()
  }
})
