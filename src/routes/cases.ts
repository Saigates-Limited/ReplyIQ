import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { TONES, TONE_META } from '../tone'

export const casesApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

// Until migration 0008 (archived_at) is applied in production, fall back to non-archive SQL.
let archiveColsKnown: boolean | null = null
async function hasArchiveCols(sql: ReturnType<typeof getDb>) {
  if (archiveColsKnown !== null) return archiveColsKnown
  const [r] = await sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'cases' AND column_name = 'archived_at'`
  archiveColsKnown = !!r
  return archiveColsKnown
}
let spapiColsKnown: boolean | null = null
async function hasSpapiCols(sql: ReturnType<typeof getDb>) {
  if (spapiColsKnown !== null) return spapiColsKnown
  const [r] = await sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'cases' AND column_name = 'spapi_synced_at'`
  spapiColsKnown = !!r
  return spapiColsKnown
}
const spapiExpr = (has: boolean, expr: string) => (has ? expr : expr.replace(/cases\.delivery_date_source, cases\.spapi_synced_at,/g, 'NULL::text AS delivery_date_source, NULL::timestamptz AS spapi_synced_at,').replace(/(?<!cases\.)\bdelivery_date_source, spapi_synced_at,/g, 'NULL::text AS delivery_date_source, NULL::timestamptz AS spapi_synced_at,'))
const archExpr = (has: boolean, expr: string) => (has ? expr : expr.replace(/cases\.archived_at IS NULL/g, 'TRUE').replace(/cases\.archived_at IS NOT NULL/g, 'FALSE').replace(/cases\.archived_at,/g, 'NULL::timestamptz AS archived_at,'))

// Columns returned to the agent UI. PII columns (last name, email, phone,
// address) are returned here because agents need them, but they are NEVER
// included in anything sent to OpenAI (see the draft generation step).
const CASE_COLUMNS = `
  id, case_ref, subject, status,
  customer_first_name, customer_last_name, customer_email, customer_phone, customer_address,
  order_id, device_model, delivery_date, refund_issued, a_to_z_open, in_stock,
  approved_repair_price, repair_quote_accepted, tracking_number, carrier,
  chargeback_open, battery_flag, tone, assigned_to, internal_notes, source, archived_at, delivery_date_source, spapi_synced_at,
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
  cases.chargeback_open, cases.battery_flag, cases.tone, cases.assigned_to, cases.internal_notes, cases.source, cases.archived_at, cases.delivery_date_source, cases.spapi_synced_at,
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
    const has = await hasArchiveCols(sql)
    const rows = await sql.unsafe(
      spapiExpr(await hasSpapiCols(sql), archExpr(has, `SELECT ${CASE_COLUMNS_Q}, u.name AS assigned_to_name, ${EVENT_FLAGS},
              (SELECT COUNT(*) FROM messages m WHERE m.case_id = cases.id AND m.kind <> 'event')::int AS message_count,
              (SELECT status FROM drafts d WHERE d.case_id = cases.id AND d.status <> 'discarded' ORDER BY created_at DESC LIMIT 1) AS latest_draft_status,
              (SELECT needs_manager FROM drafts d WHERE d.case_id = cases.id AND d.status <> 'discarded' ORDER BY created_at DESC LIMIT 1) AS latest_draft_needs_manager,
              ${DEADLINE_EXPR} AS effective_deadline
       FROM cases LEFT JOIN users u ON u.id = cases.assigned_to
       WHERE CASE WHEN $1 = 'archived' THEN cases.archived_at IS NOT NULL
                  WHEN $1 = 'all' THEN cases.archived_at IS NULL
                  WHEN $1 = 'active' THEN cases.status <> 'resolved' AND cases.archived_at IS NULL
                  ELSE cases.status = $1 AND cases.archived_at IS NULL END
       ORDER BY
         CASE WHEN cases.status <> 'resolved' AND ${DEADLINE_EXPR} < now() THEN 0 ELSE 1 END,
         CASE WHEN cases.tone IN ('angry','dispute') THEN 0 ELSE 1 END,
         ${DEADLINE_EXPR} ASC NULLS LAST`)),
      [status]
    )
    return c.json({ cases: rows, now: new Date().toISOString() })
  } finally {
    await sql.end()
  }
})


// POST /api/cases/bulk  { ids:number[], action:'resolve'|'status'|'assign'|'tone'|'archive', value? }
// → { done:number[], skipped:[{id, case_ref, reason}] }
// Bulk RESOLVE skips: open A-to-Z, open chargeback, battery_flag, or a draft awaiting manager approval.
// There is deliberately NO bulk send: email leaves only via POST /api/drafts/:id/send and its gates.
const BULK_ACTIONS = ['resolve', 'status', 'assign', 'tone', 'archive'] as const
casesApi.post('/bulk', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown; action?: string; value?: unknown }
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : []
  const action = body.action as (typeof BULK_ACTIONS)[number]
  if (!ids.length) return c.json({ error: 'No cases selected' }, 400)
  if (ids.length > 200) return c.json({ error: 'Select at most 200 cases at a time' }, 400)
  if (!BULK_ACTIONS.includes(action)) return c.json({ error: 'Unknown action' }, 400)
  if (action === 'archive' && user.role !== 'manager') return c.json({ error: 'Only a manager can archive cases' }, 403)

  let value: unknown = null
  if (action === 'status') {
    const r = coerce('status', body.value)
    if (!r.ok || r.value === 'resolved') return c.json({ error: 'Status must be open or awaiting_customer (use Mark resolved for resolved)' }, 422)
    value = r.value
  } else if (action === 'assign') {
    if (body.value !== null && body.value !== '' && body.value !== undefined) {
      const r = coerce('user', body.value)
      if (!r.ok) return c.json({ error: r.error }, 422)
      value = r.value
    }
  } else if (action === 'tone') {
    const r = coerce('tone', body.value)
    if (!r.ok) return c.json({ error: r.error }, 422)
    value = r.value
  }

  const sql = getDb(c.env)
  try {
    const list = ids.join(',')
    const rows = await sql<any[]>`
      SELECT c.id, c.case_ref, c.battery_flag, c.archived_at,
        EXISTS (SELECT 1 FROM amazon_events e WHERE e.case_id = c.id AND e.kind LIKE 'atoz%' AND e.status NOT IN ('won','lost','closed')) AS open_atoz,
        EXISTS (SELECT 1 FROM amazon_events e WHERE e.case_id = c.id AND e.kind = 'chargeback' AND e.status NOT IN ('won','lost','closed')) AS open_chargeback,
        EXISTS (SELECT 1 FROM drafts d WHERE d.case_id = c.id AND d.status = 'draft' AND d.needs_manager = TRUE) AS manager_draft
      FROM cases c WHERE c.id = ANY(string_to_array(${list}, ',')::int[])`
    const found = new Map(rows.map((r) => [r.id, r]))
    const done: number[] = []
    const skipped: { id: number; case_ref: string | null; reason: string }[] = []
    const todo: number[] = []
    for (const id of ids) {
      const r = found.get(id)
      if (!r) { skipped.push({ id, case_ref: null, reason: 'not found' }); continue }
      if (action === 'resolve') {
        const why: string[] = []
        if (r.open_atoz) why.push('open A-to-Z claim')
        if (r.open_chargeback) why.push('open chargeback')
        if (r.battery_flag) why.push('battery/heat flag')
        if (r.manager_draft) why.push('draft awaiting manager')
        if (why.length) { skipped.push({ id, case_ref: r.case_ref, reason: why.join(', ') }); continue }
      }
      if (action === 'archive' && r.archived_at) { skipped.push({ id, case_ref: r.case_ref, reason: 'already archived' }); continue }
      todo.push(id)
    }
    if (todo.length) {
      const tl = todo.join(',')
      await sql.begin(async (tx) => {
        if (action === 'resolve') await tx`UPDATE cases SET status = 'resolved' WHERE id = ANY(string_to_array(${tl}, ',')::int[])`
        else if (action === 'status') await tx`UPDATE cases SET status = ${value as string} WHERE id = ANY(string_to_array(${tl}, ',')::int[])`
        else if (action === 'assign') await tx`UPDATE cases SET assigned_to = ${value as number | null} WHERE id = ANY(string_to_array(${tl}, ',')::int[])`
        else if (action === 'tone') {
          await tx`UPDATE cases SET tone = ${value as string} WHERE id = ANY(string_to_array(${tl}, ',')::int[])`
          await tx`UPDATE messages SET tone = ${value as string}, tone_source = 'staff'
                   WHERE id IN (SELECT DISTINCT ON (case_id) id FROM messages WHERE case_id = ANY(string_to_array(${tl}, ',')::int[]) AND direction = 'inbound' AND kind <> 'event' ORDER BY case_id, sent_at DESC)`
        } else if (action === 'archive') await tx`UPDATE cases SET archived_at = now(), archived_by = ${user.id} WHERE id = ANY(string_to_array(${tl}, ',')::int[])`
      })
      done.push(...todo)
    }
    return c.json({ done, skipped, action })
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
      spapiExpr(await hasSpapiCols(sql), archExpr(await hasArchiveCols(sql), `SELECT ${CASE_COLUMNS_Q}, u.name AS assigned_to_name, ${EVENT_FLAGS} FROM cases LEFT JOIN users u ON u.id = cases.assigned_to WHERE cases.id = $1`)),
      [id]
    )
    if (!kase) return c.json({ error: 'Case not found' }, 404)
    const messages = await sql`SELECT id, direction, sender, body, sent_at, kind, event_id, tone, tone_source FROM messages WHERE case_id = ${id} ORDER BY sent_at ASC`
    const events = await sql`
      SELECT e.*, ru.name AS responded_by_name FROM amazon_events e LEFT JOIN users ru ON ru.id = e.responded_by
      WHERE e.case_id = ${id} ORDER BY e.received_at ASC`
    const staff = await sql`SELECT id, name, role FROM users WHERE is_active = TRUE ORDER BY name`
    const attachments = await sql`SELECT id, message_id, filename, mime_type, size_bytes, inline, source, amazon_allowed, created_at FROM attachments WHERE case_id = ${id} ORDER BY id`.catch(() => [] as any[])
    const drafts = await sql`
      SELECT d.*, cu.name AS created_by_name, eu.name AS edited_by_name, au.name AS approved_by_name, su.name AS sent_recorded_by_name
      FROM drafts d
      LEFT JOIN users cu ON cu.id = d.created_by
      LEFT JOIN users eu ON eu.id = d.edited_by
      LEFT JOIN users au ON au.id = d.approved_by
      LEFT JOIN users su ON su.id = d.sent_recorded_by
      WHERE d.case_id = ${id} ORDER BY d.created_at DESC`
    return c.json({ case: kase, messages, events, drafts, staff, attachments, tone_meta: TONE_META, now: new Date().toISOString() })
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
    const hasSp = await hasSpapiCols(sql)
    if ('delivery_date' in updates && hasSp) updates.delivery_date_source = updates.delivery_date ? 'staff' : null
    const cols = Object.keys(updates)
    const has = await hasArchiveCols(sql)
    const [row] = await sql.unsafe(
      `UPDATE cases SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
       WHERE id = $1 RETURNING ${spapiExpr(hasSp, has ? CASE_COLUMNS : CASE_COLUMNS.replace('archived_at,', 'NULL::timestamptz AS archived_at,'))}`,
      [id, ...cols.map((k) => updates[k])] as any[]
    )
    if (!row) return c.json({ error: 'Case not found' }, 404)
    if ('tone' in updates) {
      // Staff override: record it on the latest customer message so the AI label never re-overrides it
      await sql`UPDATE messages SET tone = ${updates.tone as string}, tone_source = 'staff'
                WHERE id = (SELECT id FROM messages WHERE case_id = ${id} AND direction = 'inbound' AND kind <> 'event' ORDER BY sent_at DESC LIMIT 1)`
    }
    const [full] = await sql.unsafe(
      spapiExpr(await hasSpapiCols(sql), archExpr(has, `SELECT ${CASE_COLUMNS_Q}, u.name AS assigned_to_name, ${EVENT_FLAGS} FROM cases LEFT JOIN users u ON u.id = cases.assigned_to WHERE cases.id = $1`)),
      [id]
    )
    return c.json({ case: full ?? row })
  } finally {
    await sql.end()
  }
})

// POST /api/cases/:id/archive  (manager) -> soft-archive; nothing is ever deleted
casesApi.post('/:id/archive', requireManager, async (c) => {
  const id = Number(c.req.param('id'))
  const sql = getDb(c.env)
  try {
    if (!(await hasArchiveCols(sql))) return c.json({ error: 'Archiving needs migration 0008b (archived_at column) to be run in Supabase first.' }, 503)
    const [row] = await sql`UPDATE cases SET archived_at = now(), archived_by = ${c.get('user').id} WHERE id = ${id} AND archived_at IS NULL RETURNING id`
    if (!row) return c.json({ error: 'Case not found or already archived' }, 404)
    return c.json({ ok: true })
  } finally {
    await sql.end()
  }
})
// POST /api/cases/:id/unarchive  (manager)
casesApi.post('/:id/unarchive', requireManager, async (c) => {
  const id = Number(c.req.param('id'))
  const sql = getDb(c.env)
  try {
    const [row] = await sql`UPDATE cases SET archived_at = NULL, archived_by = NULL WHERE id = ${id} RETURNING id`
    if (!row) return c.json({ error: 'Case not found' }, 404)
    return c.json({ ok: true })
  } finally {
    await sql.end()
  }
})
