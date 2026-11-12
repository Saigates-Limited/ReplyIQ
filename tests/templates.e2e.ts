// End-to-end: /templates on a database shaped like PRODUCTION (reply_templates without created_by / updated_by), before and after
// migration 0021, plus the "statutory rights" ban through the real draft + KB routes. Gmail/OpenAI are faked; nothing leaves the machine.
// Run: DATABASE_URL=postgres://…_test node tests/run-e2e.mjs tests/templates.e2e.ts   (throwaway *test* DB only; it drops columns!)
import assert from 'node:assert/strict'
import postgres from 'postgres'
import worker from '../src/index'

const DB = process.env.DATABASE_URL || 'postgres://replyiq:replyiq_dev@localhost:5432/replyiq_test'
if (!/_test|test_/.test(new URL(DB).pathname)) throw new Error('Refusing to run: DATABASE_URL must point at a throwaway database whose name contains "test"')
const env: any = { DATABASE_URL: DB, GOOGLE_CLIENT_ID: 't.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'x', TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'), OPENAI_API_KEY: 'sk-test', ASSETS: { fetch: async () => new Response('') } }
const sql = postgres(DB, { max: 1, onnotice: () => {} })
import { readFileSync } from 'node:fs'

// ───────── fakes ─────────
let cookie = ''
async function api(method: string, path: string, body?: unknown) {
  const res = await worker.fetch(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }), env, {} as any)
  const text = await res.text(); let data: any; try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}
const step = (s: string) => console.log(`  ✓ ${s}`)
const sha = async (t: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, '0')).join('')
const login = async (userId: number) => { const token = `tok${userId}-${Math.random()}`; await sql`INSERT INTO sessions (id, user_id, expires_at) VALUES (${await sha(token)}, ${userId}, now() + interval '1 day')`; cookie = `riq_session=${token}` }

const sentToModel: any[] = []
let openaiReply: any = { lane: 'order status', reply: '', staff_notes: 'routine', needs_manager: false, urgency: 'normal' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(typeof input === 'string' ? input : input.url)
  if (url.endsWith('/chat/completions')) { sentToModel.push(JSON.parse(String(init.body))); return json({ choices: [{ message: { content: JSON.stringify(openaiReply) } }] }) }
  return realFetch(input, init)
}) as typeof fetch

const MIG21 = readFileSync('db/migrations/0021_template_columns_and_kb_cleanup.sql', 'utf8')
const cols = async () => (await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'reply_templates' AND column_name IN ('created_by','updated_by')`).map((r: any) => r.column_name).sort()
const SIGN = '\n\nKind regards,\nCustomer Support Team'
const BAD = 'Dear Sam,\n\nThank you for your message. This is in line with Amazon\'s policies and your statutory rights.' + SIGN
const GOOD = 'Dear Sam,\n\nThank you for your message. We will update you once the phone has been returned and inspected.' + SIGN

async function main() {
  // A database shaped like production: reply_templates created BEFORE 0014, so 0014's CREATE TABLE IF NOT EXISTS skipped it and the audit columns never existed.
  await sql.unsafe(`TRUNCATE app_settings, messages, drafts, amazon_events, attachments, sessions, gmail_threads_seen RESTART IDENTITY CASCADE`)
  await sql.unsafe(`ALTER TABLE cases DISABLE TRIGGER trg_cases_no_delete; TRUNCATE cases RESTART IDENTITY CASCADE; ALTER TABLE cases ENABLE TRIGGER trg_cases_no_delete`)
  await sql.unsafe(`TRUNCATE users RESTART IDENTITY CASCADE`)
  const [mgr] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES ('sagar@test', 'Sagar', 'manager', 'x') RETURNING id`
  const [kul] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES ('kuldeep@test', 'Kuldeep Kaur', 'agent', 'x') RETURNING id`
  await sql.unsafe(`ALTER TABLE reply_templates DROP COLUMN IF EXISTS created_by; ALTER TABLE reply_templates DROP COLUMN IF EXISTS updated_by`)
  // the old seed rule, as it is on production (title from the ORIGINAL 0014)
  await sql`DELETE FROM kb_rules WHERE false`.catch(() => {})
  await sql.unsafe(`ALTER TABLE kb_rules DISABLE TRIGGER trg_kb_rules_no_delete; DELETE FROM kb_rules WHERE title IN ('Statutory wording only when needed','Marketplace wording only when needed'); ALTER TABLE kb_rules ENABLE TRIGGER trg_kb_rules_no_delete`)
  const [old] = await sql`INSERT INTO kb_rules (kind, category, title, rule_text, modes, status, sort_order, approved_at)
    VALUES ('rule','tone','Statutory wording only when needed','Use phrases like in line with Amazon policies and your statutory rights only for refund eligibility.','all','active',110, now()) RETURNING id`
  // TRUNCATE users CASCADE also emptied reply_templates (FK), so put back a few production-style rows (no audit columns, as on production)
  await sql.unsafe(`ALTER TABLE reply_templates DISABLE TRIGGER trg_reply_templates_no_delete; DELETE FROM reply_templates; ALTER TABLE reply_templates ENABLE TRIGGER trg_reply_templates_no_delete`)
  for (const [slug, title] of [['found-accessory', 'Customer found missing accessory'], ['return-proof-received', 'Customer returned phone and sent proof'], ['photos-requested', 'Photos requested (six sides)']])
    await sql`INSERT INTO reply_templates (slug, category, title, body, sort_order) VALUES (${slug}, 'general', ${title}, ${'Dear [Name],\n\nThank you for your message.' + SIGN}, 10)`
  const [templates0] = await sql`SELECT COUNT(*)::int AS n FROM reply_templates`
  assert.deepEqual(await cols(), []); step(`production-shaped DB: reply_templates has no created_by / updated_by (${templates0.n} templates)`)

  console.log('1. /templates BEFORE migration 0021 (the reported 500)')
  await login(mgr.id)
  let r = await api('GET', '/api/templates?all=1')
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.templates.length, templates0.n)
  assert.equal(r.data.migration_needed, '0021_template_columns_and_kb_cleanup.sql'); assert.equal(r.data.templates[0].updated_by_name, null)
  step('GET /api/templates is 200 (was 500 "column t.updated_by does not exist"), lists all templates and asks for 0021')
  await login(kul.id)
  r = await api('GET', '/api/templates'); assert.equal(r.status, 200); assert.ok(r.data.templates.length > 0); step('agents can load it too')
  await login(mgr.id)
  r = await api('POST', '/api/templates', { title: 'Plain template', category: 'general', body: 'Dear [Name],\n\nThanks for getting in touch.' + SIGN }); assert.equal(r.status, 201, JSON.stringify(r.data))
  const tid = r.data.template.id
  r = await api('PATCH', `/api/templates/${tid}`, { title: 'Plain template 2' }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.template.title, 'Plain template 2')
  step('adding and editing a template also work before the migration')

  console.log('2. Run 0021')
  await sql.unsafe(MIG21); assert.deepEqual(await cols(), ['created_by', 'updated_by'])
  await sql.unsafe(MIG21); step('0021 adds created_by / updated_by and is safe to run twice')
  const [oldRule] = await sql`SELECT status, review_note FROM kb_rules WHERE id = ${old.id}`
  assert.equal(oldRule.status, 'retired'); assert.match(oldRule.review_note, /statutory/i); step('the "Statutory wording only when needed" rule is retired (not deleted)')
  r = await api('GET', '/api/templates?all=1')
  assert.equal(r.status, 200); assert.equal(r.data.migration_needed, undefined); step('GET /api/templates: no migration banner any more')
  r = await api('PATCH', `/api/templates/${tid}`, { title: 'Plain template 3' }); assert.equal(r.status, 200)
  r = await api('GET', '/api/templates?all=1'); assert.equal(r.data.templates.find((t: any) => t.id === tid).updated_by_name, 'Sagar'); step('edits now record who changed the template')
  const m = await api('GET', '/api/settings/migrations'); const row = m.data.migrations.find((x: any) => x.file.startsWith('0021')); assert.equal(row.applied, true); step('Settings → Database migrations shows 0021 as applied')

  console.log('3. The statutory wording cannot come back')
  r = await api('POST', '/api/templates', { title: 'Bad template', category: 'general', body: 'Dear [Name],\n\nThis is in line with your statutory rights.' + SIGN })
  assert.equal(r.status, 400); assert.match(r.data.error, /statutory/i); step('a template containing "statutory rights" is refused')
  r = await api('POST', '/api/kb', { title: 'Add statutory', rule_text: 'Always say in line with Amazon policies and your statutory rights.', status: 'active' })
  assert.equal(r.status, 400); assert.match(r.data.error, /statutory/i); step('a knowledge-base rule containing it is refused')
  // an old saved template that already has the wording is found by the migration's review query
  await sql`INSERT INTO reply_templates (slug, title, body) VALUES ('legacy-statutory', 'Legacy', ${'Dear [Name],\n\nIn line with your statutory rights we will help.' + SIGN})`
  const review = await sql.unsafe(MIG21.slice(MIG21.indexOf('SELECT \'template\'')))
  assert.ok(review.some((x: any) => x.kind === 'template' && x.ref === 'legacy-statutory')); step('the migration lists saved templates that still contain the wording (read-only)')

  console.log('4. Drafts: the guardrail fails the wording')
  const [k] = await sql`INSERT INTO cases (case_ref, subject, customer_first_name, customer_last_name, last_customer_message_at, gmail_thread_id, customer_reply_to, source, order_id)
    VALUES ('RIQ-T1', 'Faulty phone', 'Sam', 'Jones', now(), 'th1', 'abc@marketplace.amazon.co.uk', 'gmail', '205-0000001-1111111') RETURNING id`
  await sql`INSERT INTO messages (case_id, direction, sender, body, subject, rfc_message_id, kind) VALUES (${k.id}, 'inbound', 'Customer', 'The phone has a fault and I know my rights.', 'Message from Amazon customer', '<in1@x>', 'message')`
  await login(kul.id)
  openaiReply = { ...openaiReply, reply: BAD }
  r = await api('POST', `/api/cases/${k.id}/drafts`, {}); assert.equal(r.status, 201, JSON.stringify(r.data))
  const bad = r.data.draft
  assert.equal(bad.check_result, 'FAIL'); assert.ok(bad.server_findings.some((f: any) => f.rule === 'never_statutory_rights' && f.severity === 'fail'))
  step('a generated draft saying "your statutory rights" is FAIL with rule never_statutory_rights')
  r = await api('GET', `/api/drafts/${bad.id}/routine-check`); assert.equal(r.data.eligible, false)
  r = await api('POST', `/api/drafts/${bad.id}/send`, { confirm_text: bad.draft_text }); assert.equal(r.status, 403); step('staff cannot send it')
  await login(mgr.id)
  r = await api('POST', `/api/drafts/${bad.id}/approve`); assert.equal(r.status, 422); step('a manager cannot approve it either (fix the failing check first)')
  await login(kul.id)
  r = await api('PATCH', `/api/drafts/${bad.id}`, { draft_text: GOOD }); assert.equal(r.status, 200); assert.equal(r.data.draft.check_result, 'PASS', JSON.stringify(r.data.draft.server_findings)); step('editing the wording out clears the FAIL')
  openaiReply = { ...openaiReply, reply: BAD }
  r = await api('POST', `/api/drafts/${bad.id}/revise`, { guidance: 'Make it shorter please' }); assert.equal(r.status, 201, JSON.stringify(r.data))
  assert.equal(r.data.draft.check_result, 'FAIL'); step('the rewrite box is checked too: a rewrite that brings the wording back is FAIL')

  console.log('5. What the model is told')
  const sys = String(sentToModel.at(-1).messages.find((x: any) => x.role === 'system').content)
  assert.match(sys, /Never mention statutory rights, consumer rights or legal rights/)
  assert.doesNotMatch(sys, /and your statutory rights"\)/); assert.doesNotMatch(sys, /Statutory wording only when needed/)
  assert.doesNotMatch(sys, /Use marketplace\/statutory wording/)
  step('the prompt carries the new Never rule, no longer recommends the wording, and the retired knowledge-base rule is not sent')
  console.log('\nAll template / statutory-wording checks passed.')
}
main().then(() => sql.end()).catch(async (e) => { console.error('\nFAILED:', e); await sql.end(); process.exit(1) })
