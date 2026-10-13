// Custom system prompt API — MANAGER ONLY (agents get 403 on every route, including reads).
//   GET  /api/prompt                 current version + history (bodies included for roll-back preview)
//   POST /api/prompt/check           validate text without saving
//   POST /api/prompt                 save a new version {body, note}
//   POST /api/prompt/rollback/:v     save a new version whose body is version v's text
//   GET  /api/prompt/preview?body=   exact assembled system message (policy + custom + KB) for the given/current text
//   POST /api/prompt/test            {body, case_id, mode} → generates a THROWAWAY draft with the unsaved text.
//                                    Nothing is stored; the result is returned to the browser only.
import { Hono } from 'hono'
import { getDb, type Bindings } from '../db'
import { requireManager, type Vars } from '../auth'
import { generateDraft, serverChecks, assembleSystemPrompt, DRAFT_MODES, type CaseRow, type MessageRow, type EventRow, type DraftMode } from '../ai'
import { loadActiveRules } from '../kb'
import { loadCurrentPrompt, validateSystemPrompt, SYSTEM_PROMPT_MAX, type PromptVersion } from '../systemPrompt'
import { decideManager } from './drafts'

export const promptApi = new Hono<{ Bindings: Bindings; Variables: Vars }>()
promptApi.use('*', requireManager)

const missingTable = (e: any) => /relation "system_prompt_versions" does not exist/i.test(String(e?.message))

promptApi.get('/', async (c) => {
  const sql = getDb(c.env)
  try {
    const history = await sql<PromptVersion[]>`
      SELECT v.version, v.body, v.note, v.restored_from, v.created_by, v.created_at, u.name AS created_by_name
      FROM system_prompt_versions v LEFT JOIN users u ON u.id = v.created_by
      ORDER BY v.version DESC LIMIT 50`.catch((e) => {
      if (missingTable(e)) return null
      throw e
    })
    if (history === null) return c.json({ current: null, history: [], migration_needed: '0012_system_prompt.sql', max_chars: SYSTEM_PROMPT_MAX })
    const current = history[0] ?? null
    // How many drafts used each version (audit)
    const usage = await sql<{ v: number; n: number }[]>`SELECT system_prompt_version AS v, COUNT(*)::int AS n FROM drafts WHERE system_prompt_version IS NOT NULL GROUP BY 1`.catch(() => [])
    const used: Record<number, number> = {}
    for (const u of usage) used[u.v] = u.n
    return c.json({ current, history: history.map((h) => ({ ...h, used_in_drafts: used[h.version] || 0 })), max_chars: SYSTEM_PROMPT_MAX })
  } finally {
    await sql.end()
  }
})

promptApi.post('/check', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { body?: string }
  return c.json({ problems: validateSystemPrompt(body.body || ''), length: (body.body || '').trim().length, max_chars: SYSTEM_PROMPT_MAX })
})

promptApi.post('/', async (c) => {
  const user = c.get('user')
  const req = (await c.req.json().catch(() => ({}))) as { body?: string; note?: string }
  const text = String(req.body || '').trim()
  const problems = validateSystemPrompt(text)
  if (problems.length) return c.json({ error: problems[0], problems }, 400)
  const note = String(req.note || '').trim().slice(0, 300) || null
  const sql = getDb(c.env)
  try {
    const cur = await loadCurrentPrompt(sql)
    if (cur && cur.body.trim() === text) return c.json({ error: 'No change — the text is identical to the current version' }, 400)
    const [v] = await sql`INSERT INTO system_prompt_versions (body, note, created_by) VALUES (${text}, ${note}, ${user.id}) RETURNING version`
    return c.json({ version: v.version, body: text }, 201)
  } catch (e: any) {
    if (missingTable(e)) return c.json({ error: 'Run db/migrations/0012_system_prompt.sql in Supabase first.' }, 503)
    throw e
  } finally {
    await sql.end()
  }
})

promptApi.post('/rollback/:v', async (c) => {
  const user = c.get('user')
  const target = Number(c.req.param('v'))
  if (!Number.isInteger(target)) return c.json({ error: 'Invalid version' }, 400)
  const sql = getDb(c.env)
  try {
    const [old] = await sql<PromptVersion[]>`SELECT version, body FROM system_prompt_versions WHERE version = ${target}`
    if (!old) return c.json({ error: 'Version not found' }, 404)
    const cur = await loadCurrentPrompt(sql)
    if (cur && cur.body === old.body) return c.json({ error: `Version ${target} has the same text as the current version` }, 400)
    const problems = validateSystemPrompt(old.body) // re-check with today's rules
    if (problems.length) return c.json({ error: `Version ${target} no longer passes the checks: ${problems[0]}`, problems }, 400)
    const [v] = await sql`INSERT INTO system_prompt_versions (body, note, restored_from, created_by) VALUES (${old.body}, ${`Rolled back to v${target}`}, ${target}, ${user.id}) RETURNING version`
    return c.json({ version: v.version, body: old.body }, 201)
  } finally {
    await sql.end()
  }
})

promptApi.get('/preview', async (c) => {
  const sql = getDb(c.env)
  try {
    const modeQ = c.req.query('mode') === 'amazon' ? 'seller_central_atoz' : 'customer'
    const given = c.req.query('body')
    const text = given !== undefined ? given : (await loadCurrentPrompt(sql))?.body ?? ''
    const kb = await loadActiveRules(sql, modeQ as DraftMode)
    const full = assembleSystemPrompt(text, kb)
    return c.json({ system_prompt: full, chars: full.length, parts: { policy_file: 'reply_instructions.md', custom_prompt_chars: text.trim().length, kb_rules: kb.length } })
  } finally {
    await sql.end()
  }
})

// Throwaway draft with UNSAVED prompt text. Not written to drafts; not marked on the case; returned to the browser only.
promptApi.post('/test', async (c) => {
  const req = (await c.req.json().catch(() => ({}))) as { body?: string; case_id?: number; mode?: string }
  const text = String(req.body || '').trim()
  const problems = validateSystemPrompt(text)
  if (problems.length) return c.json({ error: problems[0], problems }, 400)
  const caseId = Number(req.case_id)
  if (!Number.isInteger(caseId)) return c.json({ error: 'Pick a case to test on' }, 400)
  const mode: DraftMode = DRAFT_MODES.includes(req.mode as DraftMode) ? (req.mode as DraftMode) : 'customer'
  const sql = getDb(c.env)
  try {
    const [kase] = await sql<CaseRow[]>`SELECT * FROM cases WHERE id = ${caseId}`
    if (!kase) return c.json({ error: 'Case not found' }, 404)
    const messages = await sql<MessageRow[]>`SELECT direction, body, sent_at, sender, kind, id FROM messages WHERE case_id = ${caseId} ORDER BY sent_at ASC`
    const atts = await sql<{ message_id: number; filename: string; mime_type: string; size_bytes: number }[]>`SELECT message_id, filename, mime_type, size_bytes FROM attachments WHERE case_id = ${caseId}`.catch(() => [] as any[])
    for (const m of messages as any[]) m.attachments = atts.filter((a) => a.message_id === m.id)
    const events = await sql<EventRow[]>`
      SELECT kind, status, amount, currency, received_at, deadline_at, return_reason, customer_comment, authorisation, policy_check, item_description
      FROM amazon_events WHERE case_id = ${caseId} ORDER BY received_at ASC`
    if (mode === 'customer' && !messages.some((m) => m.direction === 'inbound' && m.kind !== 'event')) return c.json({ error: 'That case has no customer message to reply to' }, 400)
    const kbRules = await loadActiveRules(sql, mode)
    const current = await loadCurrentPrompt(sql)

    // Generate with the NEW text, and (for comparison) note what the current version is.
    const { result, kbRuleIds } = await generateDraft(c.env, kase, messages, { events, mode, kbRules, customPrompt: text })
    const findings = serverChecks(result.draft, kase, mode)
    const { needsManager, reasons, urgency } = decideManager(result, kase, messages, findings, mode)
    return c.json({
      test: true,
      stored: false,
      case: { id: kase.id, case_ref: kase.case_ref, subject: kase.subject, customer_first_name: kase.customer_first_name },
      mode,
      draft_text: result.draft,
      lane: result.lane,
      staff_notes: result.staff_notes,
      needs_manager: needsManager,
      needs_manager_reason: reasons.join('; '),
      urgency,
      check_result: findings.some((f) => f.severity === 'fail') ? 'FAIL' : 'PASS',
      server_findings: findings,
      kb_rule_ids: kbRuleIds,
      compared_to_version: current?.version ?? null,
    })
  } finally {
    await sql.end()
  }
})
