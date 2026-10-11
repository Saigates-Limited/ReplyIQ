import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'

export const casesApi = new Hono<{ Bindings: Bindings }>()

// Columns returned to the agent UI. PII columns (last name, email, phone,
// address) are returned here because agents need them, but they are NEVER
// included in anything sent to OpenAI (see the draft generation step).
const CASE_COLUMNS = `
  id, case_ref, subject, status,
  customer_first_name, customer_last_name, customer_email, customer_phone, customer_address,
  order_id, device_model, delivery_date, refund_issued, a_to_z_open, in_stock,
  approved_repair_price, tracking_number, carrier,
  last_customer_message_at,
  (last_customer_message_at + INTERVAL '24 hours') AS reply_deadline,
  created_at, updated_at
`

// GET /api/cases?status=open|awaiting_customer|resolved|all  (default: not resolved)
casesApi.get('/', async (c) => {
  const sql = getDb(c.env)
  const status = c.req.query('status') ?? 'active'
  try {
    const rows = await sql.unsafe(
      `SELECT ${CASE_COLUMNS},
              (SELECT COUNT(*) FROM messages m WHERE m.case_id = cases.id)::int AS message_count,
              (SELECT status FROM drafts d WHERE d.case_id = cases.id ORDER BY created_at DESC LIMIT 1) AS latest_draft_status
       FROM cases
       WHERE CASE WHEN $1 = 'all' THEN TRUE
                  WHEN $1 = 'active' THEN status <> 'resolved'
                  ELSE status = $1 END
       ORDER BY (last_customer_message_at + INTERVAL '24 hours') ASC`,
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
    const [kase] = await sql.unsafe(`SELECT ${CASE_COLUMNS} FROM cases WHERE id = $1`, [id])
    if (!kase) return c.json({ error: 'Case not found' }, 404)
    const messages = await sql`SELECT id, direction, sender, body, sent_at FROM messages WHERE case_id = ${id} ORDER BY sent_at ASC`
    const drafts = await sql`SELECT * FROM drafts WHERE case_id = ${id} ORDER BY created_at DESC`
    return c.json({ case: kase, messages, drafts, now: new Date().toISOString() })
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
  tracking_number: 'text',
  carrier: 'text',
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
    return c.json({ case: row })
  } finally {
    await sql.end()
  }
})
