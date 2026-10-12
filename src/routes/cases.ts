import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import type { Vars } from '../auth'
import { TONES, TONE_META } from '../tone'

export const casesApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

// Columns returned to the agent UI. PII columns (last name, email, phone,
// address) are returned here because agents need them, but they are NEVER
// included in anything sent to OpenAI (see the draft generation step).
const CASE_COLUMNS = `
  id, case_ref, subject, status,
  customer_first_name, customer_last_name, customer_email, customer_phone, customer_address,
  order_id, device_model, delivery_date, refund_issued, a_to_z_open, in_stock,
  approved_repair_price, repair_quote_accepted, tracking_number, carrier,
  chargeback_open, battery_flag, tone, assigned_to, internal_notes, source,
  last_customer_message_at,
  (last_customer_message_at + INTERVAL '24 hours') AS reply_deadline,
  created_at, updated_at
`
// Same columns, qualified for joins
const CASE_COLUMNS_Q = `
  cases.id, cases.case_ref, cases.subject, cases.status,
  cases.customer_first_name, cases.customer_last_name, cases.customer_email, cases.customer_phone, cases.customer_address,
  cases.order_id, cases.device_model, cases.delivery_date, cases.refund_issued, cases.a_to_z_open, cases.in_stock,
  cases.approved_repair_price, cases.repair_quote_accepted, cases.tracking_number, cases.carrier,
  cases.chargeback_open, cases.battery_flag, cases.tone, cases.assigned_to, cases.internal_notes, cases.source,
  cases.last_customer_message_at,
  (cases.last_customer_message_at + INTERVAL '24 hours') AS reply_deadline,
  cases.created_at, cases.updated_at
`
// Effective deadline: the 24h customer-reply deadline (only when a real customer message exists on the case)
// or the earliest open Amazon event deadline, whichever is sooner.
const DEADLINE_EXPR = `LEAST(
  CASE WHEN EXISTS (SELECT 1 FROM messages m WHERE m.case_id = cases.id AND m.direction = 'inbound' AND m.kind <> 'event')
       THEN cases.last_customer_message_at + INTERVAL '24 hours' END,
  (SELECT MIN(e.deadline_at) FROM amazon_events e WHERE e.case_id = cases.id AND e.status IN ('open','info_requested')))`
// Open Amazon events per case (for tabs + queue badges)
const EVENT_FLAGS = `
  (SELECT COUNT(*) FROM amazon_events e WHERE e.case_id = cases.id AND e.kind LIKE 'atoz%' AND e.status NOT IN ('won','lost','closed'))::int AS open_atoz,
  (SELECT COUNT(*) FROM amazon_events e WHERE e.case_id = cases.id AND e.kind = 'return_request' AND e.status NOT IN ('refunded','closed'))::int AS open_returns,
  (SELECT COUNT(*) FROM amazon_events e WHERE e.case_id = cases.id AND e.kind = 'chargeback' AND e.status NOT IN ('won','lost','closed'))::int AS open_chargebacks,
  (SELECT MIN(e.deadline_at) FROM amazon_events e WHERE e.case_id = cases.id AND e.deadline_at IS NOT NULL AND e.status IN ('open','info_requested'))::timestamptz AS event_deadline
`

// GET /api/cases?status=open|awaiting_customer|resolved|all  (default: not resolved)
casesApi.get('/', async (c) => {
  const sql = getDb(c.env)
  const status = c.req.query('status') ?? 'active'
  try {
    // Queue order (agreed with Saigates): overdue first, then Red (angry) / Purple (dispute), then everyone else by deadline.
    // "Deadline" is the earlier of the 24h customer-reply deadline and any open Amazon event deadline.
    const rows = await sql.unsafe(
      `SELECT ${CASE_COLUMNS_Q}, u.name AS assigned_to_name, ${EVENT_FLAGS},
              (SELECT COUNT(*) FROM messages m WHERE m.case_id = cases.id AND m.kind <> 'event')::int AS message_count,
              (SELECT status FROM drafts d WHERE d.case_id = cases.id AND d.status <> 'discarded' ORDER BY created_at DESC LIMIT 1) AS latest_draft_status,
              (SELECT needs_manager FROM drafts d WHERE d.case_id = cases.id AND d.status <> 'discarded' ORDER BY created_at DESC LIMIT 1) AS latest_draft_needs_manager,
              ${DEADLINE_EXPR} AS effective_deadline
       FROM cases LEFT JOIN users u ON u.id = cases.assigned_to
       WHERE CASE WHEN $1 = 'all' THEN TRUE
                  WHEN $1 = 'active' THEN cases.status <> 'resolved'
                  ELSE cases.status = $1 END
       ORDER BY
         CASE WHEN cases.status <> 'resolved' AND ${DEADLINE_EXPR} < now() THEN 0 ELSE 1 END,
         CASE WHEN cases.tone IN ('angry','dispute') THEN 0 ELSE 1 END,
         ${DEADLINE_EXPR} ASC NULLS LAST`,
      [status]
    )
    return c.json({ cases: rows, now: new Date().toISOString() })
  } finally {
    await sql.end()
  }
})

// GET /api/cases/:id  -> case + thread + drafts
casesApi.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'Invalid id' }, 400)
  const sql = getDb(c.env)
  try {
    const [kase] = await sql.unsafe(
      `SELECT ${CASE_COLUMNS_Q}, u.name AS assigned_to_name, ${EVENT_FLAGS} FROM cases LEFT JOIN users u ON u.id = cases.assigned_to WHERE cases.id = $1`,
      [id]
    )
    if (!kase) return c.json({ error: 'Case not found' }, 404)
    const messages = await sql`SELECT id, direction, sender, body, sent_at, kind, event_id, tone, tone_source FROM messages WHERE case_id = ${id} ORDER BY sent_at ASC`
    const events = await sql`
      SELECT e.*, ru.name AS responded_by_name FROM amazon_events e LEFT JOIN users ru ON ru.id = e.responded_by
      WHERE e.case_id = ${id} ORDER BY e.received_at ASC`
    const staff = await sql`SELECT id, name, role FROM users WHERE is_active = TRUE ORDER BY name`
    const drafts = await sql`
      SELECT d.*, cu.name AS created_by_name, eu.name AS edited_by_name, au.name AS approved_by_name, su.name AS sent_recorded_by_name
      FROM drafts d
      LEFT JOIN users cu ON cu.id = d.created_by
      LEFT JOIN users eu ON eu.id = d.edited_by
      LEFT JOIN users au ON au.id = d.approved_by
      LEFT JOIN users su ON su.id = d.sent_recorded_by
      WHERE d.case_id = ${id} ORDER BY d.created_at DESC`
    return c.json({ case: kase, messages, events, drafts, staff, tone_meta: TONE_META, now: new Date().toISOString() })
  } finally {
    await sql.end()
  }
})

// Fields an agent may edit, with simple type coercion/validation.
const EDITABLE = {
  status: 'status',
  order_id: 'text',
  device_model: 'text',
  delivery_date: 'date',
  refund_issued: 'bool',
  a_to_z_open: 'bool',
  in_stock: 'bool',
  approved_repair_price: 'money',
  repair_quote_accepted: 'bool',
  tracking_number: 'text',
  carrier: 'text',
  // Ticket fields
  assigned_to: 'user',
  internal_notes: 'notes', // never sent to the customer or to OpenAI
  tone: 'tone', // staff override of the AI label
  chargeback_open: 'bool',
  battery_flag: 'bool',
} as const

function coerce(kind: string, v: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (v === '' || v === null || v === undefined) return { ok: true, value: null }
  switch (kind) {
    case 'text':
      return { ok: true, value: String(v).trim().slice(0, 200) }
    case 'status':
      return ['open', 'awaiting_customer', 'resolved'].includes(String(v))
        ? { ok: true, value: v }
        : { ok: false, error: 'Invalid status' }
    case 'bool':
      if (typeof v === 'boolean') return { ok: true, value: v }
      if (v === 'true' || v === 'yes') return { ok: true, value: true }
      if (v === 'false' || v === 'no') return { ok: true, value: false }
      return { ok: false, error: 'Expected yes/no' }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? { ok: true, value: v } : { ok: false, error: 'Expected YYYY-MM-DD' }
    case 'money': {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? { ok: true, value: n.toFixed(2) } : { ok: false, error: 'Expected a positive amount' }
    }
    case 'user': {
      const n = Number(v)
      return Number.isInteger(n) && n > 0 ? { ok: true, value: n } : { ok: false, error: 'Expected a staff id' }
    }
    case 'notes':
      return { ok: true, value: String(v).slice(0, 5000) }
    case 'tone':
      return (TONES as readonly string[]).includes(String(v)) ? { ok: true, value: v } : { ok: false, error: 'Invalid tone' }
  }
  return { ok: false, error: 'Unknown field' }
}

// PATCH /api/cases/:id  -> update agent fields
casesApi.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'Invalid id' }, 400)
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON body' }, 400)

  const updates: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const [key, kind] of Object.entries(EDITABLE)) {
    if (!(key in body)) continue
    const r = coerce(kind, body[key])
    if (r.ok) updates[key] = r.value
    else errors[key] = r.error
  }
  if (Object.keys(errors).length) return c.json({ error: 'Validation failed', fields: errors }, 422)
  if (!Object.keys(updates).length) return c.json({ error: 'No editable fields supplied' }, 400)

  const sql = getDb(c.env)
  try {
    const cols = Object.keys(updates)
    const [row] = await sql.unsafe(
      `UPDATE cases SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
       WHERE id = $1 RETURNING ${CASE_COLUMNS}`,
      [id, ...cols.map((k) => updates[k])] as any[]
    )
    if (!row) return c.json({ error: 'Case not found' }, 404)
    if ('tone' in updates) {
      // Staff override: record it on the latest customer message so the AI label never re-overrides it
      await sql`UPDATE messages SET tone = ${updates.tone as string}, tone_source = 'staff'
                WHERE id = (SELECT id FROM messages WHERE case_id = ${id} AND direction = 'inbound' AND kind <> 'event' ORDER BY sent_at DESC LIMIT 1)`
    }
    const [full] = await sql.unsafe(
      `SELECT ${CASE_COLUMNS_Q}, u.name AS assigned_to_name, ${EVENT_FLAGS} FROM cases LEFT JOIN users u ON u.id = cases.assigned_to WHERE cases.id = $1`,
      [id]
    )
    return c.json({ case: full ?? row })
  } finally {
    await sql.end()
  }
})
