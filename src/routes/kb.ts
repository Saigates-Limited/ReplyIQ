// Knowledge base API — staff-added rules for the drafting model.
//   GET    /api/kb                 list (status filter), everyone
//   GET    /api/kb/preview         the exact prompt block active rules produce (manager)
//   POST   /api/kb                 propose a rule (agent → draft; manager may set active directly)
//   PATCH  /api/kb/:id             edit text/meta (author while draft, or manager). Editing an ACTIVE rule
//                                  puts it back to draft unless a manager does it.
//   POST   /api/kb/:id/activate    manager
//   POST   /api/kb/:id/reject      manager {note}
//   POST   /api/kb/:id/retire      manager {note}
//   POST   /api/kb/:id/reorder     manager {sort_order}
// No DELETE route; the database refuses deletes (migration 0011). Audit: drafts.kb_rule_ids.
import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { validateRuleText, loadActiveRules, kbPromptBlock, KB_KINDS, KB_MODES, KB_STATUSES, KB_CATEGORIES, KB_MAX_ACTIVE, KB_MAX_CHARS, type KbKind, type KbModes } from '../kb'

export const kbApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()

const SELECT = `
  r.id, r.kind, r.category, r.title, r.rule_text, r.modes, r.status, r.sort_order, r.review_note,
  r.created_at, r.updated_at, r.approved_at, r.retired_at, r.created_by, r.approved_by,
  cu.name AS created_by_name, au.name AS approved_by_name,
  (SELECT COUNT(*) FROM drafts d WHERE d.kb_rule_ids @> ARRAY[r.id])::int AS used_in_drafts
`
const FROM = `FROM kb_rules r LEFT JOIN users cu ON cu.id = r.created_by LEFT JOIN users au ON au.id = r.approved_by`

const missingTable = (e: any) => /relation "kb_rules" does not exist/i.test(String(e?.message))

kbApi.get('/', async (c) => {
  const status = c.req.query('status') || 'all'
  const sql = getDb(c.env)
  try {
    const where = status === 'all' ? 'TRUE' : status === 'live' ? `r.status IN ('draft','active')` : `r.status = '${KB_STATUSES.includes(status as any) ? status : 'active'}'`
    const rules = await sql.unsafe(`SELECT ${SELECT} ${FROM} WHERE ${where} ORDER BY CASE r.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, r.sort_order ASC, r.id ASC`).catch((e) => {
      if (missingTable(e)) return null
      throw e
    })
    if (rules === null) return c.json({ rules: [], migration_needed: '0011_knowledge_base.sql', meta: meta() })
    return c.json({ rules, meta: meta() })
  } finally {
    await sql.end()
  }
})

const meta = () => ({ kinds: KB_KINDS, modes: KB_MODES, statuses: KB_STATUSES, categories: KB_CATEGORIES, max_active: KB_MAX_ACTIVE, max_chars: KB_MAX_CHARS })

kbApi.get('/preview', requireManager, async (c) => {
  const sql = getDb(c.env)
  try {
    const customer = await loadActiveRules(sql, 'customer')
    const amazon = await loadActiveRules(sql, 'seller_central_atoz')
    return c.json({ customer: kbPromptBlock(customer), amazon: kbPromptBlock(amazon), counts: { customer: customer.length, amazon: amazon.length } })
  } finally {
    await sql.end()
  }
})

// Validate text as the user types (no save)
kbApi.post('/check', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { rule_text?: string }
  return c.json({ problems: validateRuleText(body.rule_text || '') })
})

type Body = { kind?: string; category?: string; title?: string; rule_text?: string; modes?: string; status?: string; sort_order?: number }
function clean(body: Body) {
  const kind = KB_KINDS.includes(body.kind as KbKind) ? (body.kind as KbKind) : 'rule'
  const modes = KB_MODES.includes(body.modes as KbModes) ? (body.modes as KbModes) : 'all'
  const category = (KB_CATEGORIES as readonly string[]).includes(body.category || '') ? body.category! : 'general'
  const title = String(body.title || '').trim().replace(/\s+/g, ' ').slice(0, 120)
  const rule_text = String(body.rule_text || '').trim()
  return { kind, modes, category, title, rule_text }
}

kbApi.post('/', async (c) => {
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as Body
  const v = clean(body)
  if (v.title.length < 3) return c.json({ error: 'Title must be at least 3 characters' }, 400)
  const problems = validateRuleText(v.rule_text)
  if (problems.length) return c.json({ error: problems[0], problems }, 400)
  // Managers may publish straight away; agents always propose (draft).
  const status = user.role === 'manager' && body.status === 'active' ? 'active' : 'draft'
  const sql = getDb(c.env)
  try {
    if (status === 'active') {
      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM kb_rules WHERE status = 'active'`
      if (n >= KB_MAX_ACTIVE) return c.json({ error: `Maximum ${KB_MAX_ACTIVE} active rules. Retire one first.` }, 400)
    }
    const [r] = await sql`
      INSERT INTO kb_rules (kind, category, title, rule_text, modes, status, sort_order, created_by, approved_by, approved_at)
      VALUES (${v.kind}, ${v.category}, ${v.title}, ${v.rule_text}, ${v.modes}, ${status}, ${Number(body.sort_order) || 100}, ${user.id},
              ${status === 'active' ? user.id : null}, ${status === 'active' ? sql`now()` : null})
      RETURNING id`
    const [rule] = await sql.unsafe(`SELECT ${SELECT} ${FROM} WHERE r.id = ${Number(r.id)}`)
    return c.json({ rule }, 201)
  } catch (e: any) {
    if (missingTable(e)) return c.json({ error: 'Knowledge base table missing — run db/migrations/0011_knowledge_base.sql in Supabase first.' }, 503)
    throw e
  } finally {
    await sql.end()
  }
})

kbApi.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'Invalid id' }, 400)
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as Body
  const sql = getDb(c.env)
  try {
    const [cur] = await sql`SELECT id, status, created_by FROM kb_rules WHERE id = ${id}`
    if (!cur) return c.json({ error: 'Rule not found' }, 404)
    const isMgr = user.role === 'manager'
    if (!isMgr && !(cur.status === 'draft' && cur.created_by === user.id)) return c.json({ error: 'Only the author (while in draft) or a manager can edit this rule' }, 403)
    const v = clean(body)
    if (v.title.length < 3) return c.json({ error: 'Title must be at least 3 characters' }, 400)
    const problems = validateRuleText(v.rule_text)
    if (problems.length) return c.json({ error: problems[0], problems }, 400)
    // An agent editing text cannot keep it live; a manager's edit stays in its current status.
    const newStatus = isMgr ? cur.status : 'draft'
    await sql`
      UPDATE kb_rules SET kind = ${v.kind}, category = ${v.category}, title = ${v.title}, rule_text = ${v.rule_text}, modes = ${v.modes},
             status = ${newStatus}, sort_order = ${Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : sql`sort_order`}
      WHERE id = ${id}`
    const [rule] = await sql.unsafe(`SELECT ${SELECT} ${FROM} WHERE r.id = ${id}`)
    return c.json({ rule })
  } finally {
    await sql.end()
  }
})

async function setStatus(c: any, status: 'active' | 'rejected' | 'retired') {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'Invalid id' }, 400)
  const user = c.get('user')
  const body = (await c.req.json().catch(() => ({}))) as { note?: string }
  const note = String(body.note || '').trim().slice(0, 300) || null
  const sql = getDb(c.env)
  try {
    const [cur] = await sql`SELECT id, status, rule_text FROM kb_rules WHERE id = ${id}`
    if (!cur) return c.json({ error: 'Rule not found' }, 404)
    if (status === 'active') {
      const problems = validateRuleText(cur.rule_text) // re-check at activation time with current rules
      if (problems.length) return c.json({ error: problems[0], problems }, 400)
      const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM kb_rules WHERE status = 'active' AND id <> ${id}`
      if (n >= KB_MAX_ACTIVE) return c.json({ error: `Maximum ${KB_MAX_ACTIVE} active rules. Retire one first.` }, 400)
      await sql`UPDATE kb_rules SET status = 'active', approved_by = ${user.id}, approved_at = now(), retired_at = NULL, review_note = ${note} WHERE id = ${id}`
    } else if (status === 'rejected') {
      await sql`UPDATE kb_rules SET status = 'rejected', review_note = ${note} WHERE id = ${id}`
    } else {
      await sql`UPDATE kb_rules SET status = 'retired', retired_at = now(), review_note = ${note} WHERE id = ${id}`
    }
    const [rule] = await sql.unsafe(`SELECT ${SELECT} ${FROM} WHERE r.id = ${id}`)
    return c.json({ rule })
  } finally {
    await sql.end()
  }
}
kbApi.post('/:id/activate', requireManager, (c) => setStatus(c, 'active'))
kbApi.post('/:id/reject', requireManager, (c) => setStatus(c, 'rejected'))
kbApi.post('/:id/retire', requireManager, (c) => setStatus(c, 'retired'))
kbApi.post('/:id/reorder', requireManager, async (c) => {
  const id = Number(c.req.param('id'))
  const body = (await c.req.json().catch(() => ({}))) as { sort_order?: number }
  const so = Number(body.sort_order)
  if (!Number.isInteger(id) || !Number.isFinite(so)) return c.json({ error: 'Invalid input' }, 400)
  const sql = getDb(c.env)
  try {
    await sql`UPDATE kb_rules SET sort_order = ${so} WHERE id = ${id}`
    return c.json({ ok: true })
  } finally {
    await sql.end()
  }
})
