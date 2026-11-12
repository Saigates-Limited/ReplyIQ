// Reply templates — ready-to-use short replies staff insert into the draft editor (then edit, check, approve as normal).
//   GET   /api/templates             active templates (everyone); ?all=1 includes retired (manager)
//   POST  /api/templates             manager: create {slug?, category, title, body}
//   PATCH /api/templates/:id         manager: edit / retire / restore
// Templates are plain text with [Name]-style placeholders; the server does NOT fill them — the agent does, and the
// usual guardrail checks run when the draft is saved. Same content validation as the knowledge base.
import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { validateRuleText } from '../kb'

export const templatesApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()
const missing = (e: any) => /relation "reply_templates" does not exist/i.test(String(e?.message))
// Production's reply_templates table pre-dates migration 0014 and lacks created_by / updated_by, so the audit columns are optional here:
// the page keeps working without them and any other missing column becomes a "run migration 0021" banner instead of a 500.
const MIGRATION = '0021_template_columns_and_kb_cleanup.sql'
const undefinedColumn = (e: any) => e?.code === '42703' || /column .* does not exist/i.test(String(e?.message))
async function auditCols(sql: ReturnType<typeof getDb>) {
  const rows = await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reply_templates' AND column_name IN ('created_by','updated_by')`
  const has = new Set(rows.map((r: any) => r.column_name))
  return { created: has.has('created_by'), updated: has.has('updated_by') }
}
export const TEMPLATE_CATEGORIES = ['general', 'faults', 'returns', 'refunds', 'delivery', 'battery', 'accessories'] as const

templatesApi.get('/', async (c) => {
  const all = c.req.query('all') === '1' && c.get('user').role === 'manager'
  const sql = getDb(c.env)
  try {
    const a = await auditCols(sql)
    const who = a.updated && a.created ? sql`COALESCE(t.updated_by, t.created_by)` : a.updated ? sql`t.updated_by` : a.created ? sql`t.created_by` : null
    const rows = await (who
      ? sql`SELECT t.id, t.slug, t.category, t.title, t.body, t.status, t.sort_order, t.updated_at, u.name AS updated_by_name
              FROM reply_templates t LEFT JOIN users u ON u.id = ${who}
              WHERE ${all ? sql`TRUE` : sql`t.status = 'active'`} ORDER BY t.category, t.sort_order, t.id`
      : sql`SELECT t.id, t.slug, t.category, t.title, t.body, t.status, t.sort_order, t.updated_at, NULL::text AS updated_by_name
              FROM reply_templates t
              WHERE ${all ? sql`TRUE` : sql`t.status = 'active'`} ORDER BY t.category, t.sort_order, t.id`).catch((e) => {
      if (missing(e)) return null
      if (undefinedColumn(e)) return 'schema' as const
      throw e
    })
    if (rows === null) return c.json({ templates: [], migration_needed: '0014_templates_and_kb_seed.sql', categories: TEMPLATE_CATEGORIES })
    if (rows === 'schema') return c.json({ templates: [], migration_needed: MIGRATION, categories: TEMPLATE_CATEGORIES })
    return c.json({ templates: rows, categories: TEMPLATE_CATEGORIES, migration_needed: a.created && a.updated ? undefined : MIGRATION })
  } finally {
    await sql.end()
  }
})

function validateTemplate(body: string) {
  const problems = validateRuleText(body).filter((p) => !p.startsWith('Rule is too long'))
  if (body.length > 4000) problems.unshift('Template is over 4,000 characters')
  if (!/customer support team/i.test(body)) problems.push('Template should end with "Kind regards, Customer Support Team"')
  return problems
}

templatesApi.post('/', requireManager, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { slug?: string; category?: string; title?: string; body?: string; sort_order?: number }
  const title = String(b.title || '').trim().slice(0, 120)
  const body = String(b.body || '').trim()
  const category = (TEMPLATE_CATEGORIES as readonly string[]).includes(b.category || '') ? b.category! : 'general'
  const slug = (String(b.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `t-${Date.now()}`).slice(0, 60)
  if (title.length < 3) return c.json({ error: 'Title must be at least 3 characters' }, 400)
  const problems = validateTemplate(body)
  if (problems.length) return c.json({ error: problems[0], problems }, 400)
  const sql = getDb(c.env)
  try {
    const a = await auditCols(sql)
    const uid = c.get('user').id
    const so = Number(b.sort_order) || 100
    const [t] = a.created && a.updated
      ? await sql`INSERT INTO reply_templates (slug, category, title, body, sort_order, created_by, updated_by)
                  VALUES (${slug}, ${category}, ${title}, ${body}, ${so}, ${uid}, ${uid})
                  ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, category = EXCLUDED.category, status = 'active', updated_by = EXCLUDED.updated_by
                  RETURNING *`
      : await sql`INSERT INTO reply_templates (slug, category, title, body, sort_order)
                  VALUES (${slug}, ${category}, ${title}, ${body}, ${so})
                  ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, category = EXCLUDED.category, status = 'active'
                  RETURNING *`
    return c.json({ template: t }, 201)
  } catch (e: any) {
    if (missing(e)) return c.json({ error: 'Run db/migrations/0014_templates_and_kb_seed.sql in Supabase first.' }, 503)
    if (undefinedColumn(e)) return c.json({ error: `The reply_templates table is missing a column. Run db/migrations/${MIGRATION} in Supabase first.` }, 503)
    throw e
  } finally {
    await sql.end()
  }
})

templatesApi.patch('/:id', requireManager, async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as { category?: string; title?: string; body?: string; status?: string; sort_order?: number }
  const sql = getDb(c.env)
  try {
    const [cur] = await sql`SELECT * FROM reply_templates WHERE id = ${id}`
    if (!cur) return c.json({ error: 'Template not found' }, 404)
    const title = b.title !== undefined ? String(b.title).trim().slice(0, 120) : cur.title
    const body = b.body !== undefined ? String(b.body).trim() : cur.body
    const category = b.category !== undefined && (TEMPLATE_CATEGORIES as readonly string[]).includes(b.category) ? b.category : cur.category
    const status = b.status === 'retired' || b.status === 'active' ? b.status : cur.status
    if (b.body !== undefined) { const problems = validateTemplate(body); if (problems.length) return c.json({ error: problems[0], problems }, 400) }
    const a = await auditCols(sql)
    const so = Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : cur.sort_order
    const [t] = a.updated
      ? await sql`UPDATE reply_templates SET title = ${title}, body = ${body}, category = ${category}, status = ${status}, sort_order = ${so}, updated_by = ${c.get('user').id}
                  WHERE id = ${id} RETURNING *`
      : await sql`UPDATE reply_templates SET title = ${title}, body = ${body}, category = ${category}, status = ${status}, sort_order = ${so}
                  WHERE id = ${id} RETURNING *`
    return c.json({ template: t })
  } catch (e: any) {
    if (undefinedColumn(e)) return c.json({ error: `The reply_templates table is missing a column. Run db/migrations/${MIGRATION} in Supabase first.` }, 503)
    throw e
  } finally {
    await sql.end()
  }
})
