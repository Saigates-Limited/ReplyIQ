// End-to-end: "Staff can send routine replies" against a real local PostgreSQL, through the actual Hono app.
// Gmail and OpenAI are faked in memory; nothing leaves the machine.
// Run: DATABASE_URL=postgres://… npm run test:e2e -- tests/approval.e2e.ts   (throwaway DB with db/schema.sql + all migrations)
import assert from 'node:assert/strict'
import postgres from 'postgres'
import worker from '../src/index'
import { encryptToken } from '../src/gmail'
import { _resetStaffColsCache } from '../src/approval'
import { readFileSync } from 'node:fs'

const DB = process.env.DATABASE_URL || 'postgres://replyiq:replyiq_dev@localhost:5432/replyiq_test'
if (!/_test|test_/.test(new URL(DB).pathname)) throw new Error('Refusing to run: DATABASE_URL must point at a throwaway database whose name contains "test"')
const env: any = { DATABASE_URL: DB, GOOGLE_CLIENT_ID: 't.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'x', TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'), OPENAI_API_KEY: 'sk-test', ASSETS: { fetch: async () => new Response('') } }
const sql = postgres(DB, { max: 1, onnotice: () => {} })

// ───────── fakes ─────────
const sentMail: { raw: string; threadId?: string }[] = []
let openaiReply = { lane: 'order status', reply: '', staff_notes: 'routine', needs_manager: false, urgency: 'normal' }
const CLEAN = 'Dear Sam,\n\nThank you for your message. We have noted your question and will keep you updated.\n\nKind regards,\nCustomer Support Team'
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(typeof input === 'string' ? input : input.url)
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at-ok', expires_in: 3600 })
  if (url.includes('gmail.googleapis.com') && url.endsWith('/messages/send')) {
    const b = JSON.parse(String(init.body)); sentMail.push({ raw: b.raw, threadId: b.threadId })
    return json({ id: `sent${sentMail.length}`, threadId: b.threadId })
  }
  if (url.endsWith('/chat/completions')) return json({ choices: [{ message: { content: JSON.stringify(openaiReply) } }] })
  return realFetch(input, init)
}) as typeof fetch

let cookie = ''
async function api(method: string, path: string, body?: unknown) {
  const res = await worker.fetch(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }), env, {} as any)
  const text = await res.text(); let data: any; try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}
const step = (s: string) => console.log(`  ✓ ${s}`)
const sha = async (t: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, '0')).join('')
const login = async (userId: number) => { const token = `tok${userId}-${Math.random()}`; await sql`INSERT INTO sessions (id, user_id, expires_at) VALUES (${await sha(token)}, ${userId}, now() + interval '1 day')`; cookie = `riq_session=${token}` }

let n = 0
/** A Gmail case + one inbound message + a draft written by `author`. Returns ids. */
async function mk(author: number, over: { text?: string; kase?: Record<string, unknown>; draft?: Record<string, unknown>; inbound?: string; status?: string; event?: [string, string | null] } = {}) {
  n++
  const [k] = await sql`INSERT INTO cases (case_ref, subject, customer_first_name, customer_last_name, last_customer_message_at, gmail_thread_id, customer_reply_to, source, order_id)
    VALUES (${'RIQ-T' + n}, ${'Where is my order ' + n}, 'Sam', 'Jones', now(), ${'th' + n}, 'abc@marketplace.amazon.co.uk', 'gmail', ${'205-000000' + n + '-1111111'}) RETURNING id`
  if (over.kase) for (const [c, v] of Object.entries(over.kase)) await sql.unsafe(`UPDATE cases SET ${c} = $1 WHERE id = $2`, [v as any, k.id])
  await sql`INSERT INTO messages (case_id, direction, sender, body, subject, rfc_message_id, kind) VALUES (${k.id}, 'inbound', 'Customer', ${over.inbound ?? 'Hello, where is my order?'}, 'Message from Amazon customer', ${'<in' + n + '@x>'}, 'message')`
  if (over.event) await sql`INSERT INTO amazon_events (case_id, order_id, kind, status, received_at) VALUES (${k.id}, ${'205-000000' + n + '-1111111'}, ${over.event[0]}, ${over.event[1]}, now())`
  const d = { check_result: 'PASS', needs_manager: false, status: over.status ?? 'draft', ...(over.draft ?? {}) }
  const [r] = await sql`INSERT INTO drafts (case_id, draft_text, original_text, server_findings, check_result, needs_manager, status, created_by, mode)
    VALUES (${k.id}, ${over.text ?? CLEAN}, ${over.text ?? CLEAN}, ${sql.json([])}, ${d.check_result as string}, ${d.needs_manager as boolean}, ${d.status as string}, ${author}, 'customer') RETURNING id`
  return { caseId: k.id as number, id: r.id as number }
}
const state = async (id: number) => (await sql`SELECT status, approved_by, sent_without_manager_approval AS flag, sent_recorded_by, routine_check FROM drafts WHERE id = ${id}`)[0]
const send = (id: number, text = CLEAN) => api('POST', `/api/drafts/${id}/send`, { confirm_text: text })

async function main() {
  await sql.unsafe(`TRUNCATE app_settings, messages, drafts, amazon_events, attachments, sessions, gmail_threads_seen RESTART IDENTITY CASCADE`)
  await sql.unsafe(`ALTER TABLE cases DISABLE TRIGGER trg_cases_no_delete; TRUNCATE cases RESTART IDENTITY CASCADE; ALTER TABLE cases ENABLE TRIGGER trg_cases_no_delete`)
  await sql.unsafe(`TRUNCATE gmail_connection RESTART IDENTITY CASCADE; TRUNCATE users RESTART IDENTITY CASCADE`)
  const [mgr] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES ('sagar@test', 'Sagar', 'manager', 'x') RETURNING id`
  const [kul] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES ('kuldeep@test', 'Kuldeep Kaur', 'agent', 'x') RETURNING id`
  const [raj] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES ('raj@test', 'Raj', 'agent', 'x') RETURNING id`
  await sql`INSERT INTO gmail_connection (email_address, refresh_token_enc, scopes, label, is_default, carrier_mail) VALUES ('bijalshah.cc@gmail.com', ${await encryptToken(env, 'rt-1')}, 'x', 'Amazon', TRUE, FALSE)`
  _resetStaffColsCache()
  const sentCount = () => sentMail.length

  console.log('1. The setting')
  await login(kul.id)
  let r = await api('GET', '/api/approval-settings')
  assert.equal(r.status, 200); assert.equal(r.data.staff_can_send_routine, true); assert.equal(r.data.migration_ok, true); assert.equal(r.data.effective, true)
  step('defaults to ON when nothing has been saved')
  r = await api('PUT', '/api/approval-settings', { staff_can_send_routine: false }); assert.equal(r.status, 403)
  step('an agent cannot change it (403)')
  await login(mgr.id)
  r = await api('PUT', '/api/approval-settings', { staff_can_send_routine: 'no' }); assert.equal(r.status, 400)
  step('a manager must send true/false (junk is rejected)')

  console.log('2. ON: an agent sends their own routine reply')
  await login(kul.id)
  const a = await mk(kul.id)
  r = await api('GET', `/api/drafts/${a.id}/routine-check`); assert.equal(r.data.eligible, true, JSON.stringify(r.data))
  const before = sentCount()
  r = await send(a.id); assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(sentCount(), before + 1)
  let st = await state(a.id)
  assert.equal(st.status, 'sent'); assert.equal(st.flag, true); assert.equal(st.sent_recorded_by, kul.id)
  assert.equal(st.routine_check.rule, 'staff_routine_reply'); assert.equal(st.routine_check.battery_flag, false)
  step('sent through Gmail; recorded who sent (Kuldeep), flagged sent_without_manager_approval, and what the server verified')
  r = await send(a.id); assert.equal(r.status, 409); assert.equal(sentCount(), before + 1)
  step('a second send of the same draft is refused')

  console.log('3. The review filter')
  r = await api('GET', '/api/cases?status=staff_sent'); assert.equal(r.status, 403)
  step('agents cannot open the "Sent by staff without manager approval" filter')
  await login(mgr.id)
  r = await api('GET', '/api/cases?status=staff_sent'); assert.equal(r.status, 200)
  assert.equal(r.data.cases.length, 1); assert.equal(r.data.cases[0].id, a.caseId); assert.equal(r.data.cases[0].staff_sent_by_name, 'Kuldeep Kaur')
  step('the manager sees exactly that case, with the sender named')
  // a manager-approved send must NOT appear in it
  const m1 = await mk(kul.id); await sql`UPDATE drafts SET status='approved', approved_by=${mgr.id}, approved_at=now() WHERE id=${m1.id}`
  r = await send(m1.id); assert.equal(r.status, 200, JSON.stringify(r.data))
  st = await state(m1.id); assert.equal(st.flag, false); assert.equal(st.sent_recorded_by, mgr.id)
  r = await api('GET', '/api/cases?status=staff_sent'); assert.equal(r.data.cases.length, 1)
  step('a manager-approved send is recorded as such and is NOT in the filter')

  console.log('4. ON: every blocker stops a staff send, and no email goes out')
  await login(kul.id)
  const blocked: [string, Awaited<ReturnType<typeof mk>>, RegExp][] = [
    ['open A-to-Z on the case', await mk(kul.id, { kase: { a_to_z_open: true } }), /A-to-Z/],
    ['open chargeback on the case', await mk(kul.id, { kase: { chargeback_open: true } }), /Chargeback/],
    ['battery_flag on the case', await mk(kul.id, { kase: { battery_flag: true } }), /Battery/],
    ['open A-to-Z notice from Amazon (case flag never ticked)', await mk(kul.id, { event: ['atoz_claim', 'open'] }), /A-to-Z/],
    ['open chargeback notice from Amazon', await mk(kul.id, { event: ['chargeback', 'open'] }), /chargeback/i],
    ['needs_manager = true on the draft', await mk(kul.id, { draft: { needs_manager: true } }), /needs-manager/],
    ['stored result is FAIL', await mk(kul.id, { draft: { check_result: 'FAIL' } }), /not PASS/],
    ['guardrail warning (no sign-off)', await mk(kul.id, { text: 'Dear Sam,\n\nWe have noted your question and will keep you updated.' }), /warning/i],
    ['guardrail fail (customer surname in the reply)', await mk(kul.id, { text: CLEAN.replace('Thank you', 'Mr Jones, thank you') }), /fails/],
    ['needs_manager stored false but the customer now cites Trading Standards (fresh recompute)', await mk(kul.id, { inbound: 'I will report this to Trading Standards' }), /legal/],
  ]
  for (const [label, d, re] of blocked) {
    const c0 = sentCount()
    r = await send(d.id, (await sql`SELECT draft_text FROM drafts WHERE id = ${d.id}`)[0].draft_text)
    assert.equal(r.status, 403, `${label}: ${JSON.stringify(r.data)}`); assert.match(r.data.error, re, label); assert.match(r.data.error, /Request approval/, label)
    assert.equal(sentCount(), c0, `${label}: an email was sent`); assert.equal((await state(d.id)).status, 'draft', label)
    const rc = await api('GET', `/api/drafts/${d.id}/routine-check`); assert.equal(rc.data.eligible, false, label)
  }
  step(`${blocked.length} blockers: 403, tells the agent to Request approval, nothing sent, draft untouched, routine-check agrees`)

  console.log('5. Other gates stay')
  const b = await mk(kul.id)
  await login(raj.id)
  r = await send(b.id); assert.equal(r.status, 403); assert.match(r.data.error, /only send your own draft/); step("another agent cannot send Kuldeep's draft")
  await login(kul.id)
  r = await send(b.id, CLEAN + ' EDITED'); const c11 = sentCount(); assert.equal(r.status, 409); assert.equal(sentCount(), c11); assert.equal((await state(b.id)).status, 'draft')
  step('text on screen must match the saved text (409), nothing sent')
  r = await api('POST', `/api/drafts/${b.id}/approve`); assert.equal(r.status, 403); step('/approve is still manager-only for agents')
  // approved by a non-manager account (users-table check)
  const c1 = await mk(kul.id, { status: 'approved' }); await sql`UPDATE drafts SET approved_by=${raj.id}, approved_at=now() WHERE id=${c1.id}`
  r = await send(c1.id); assert.equal(r.status, 403); assert.match(r.data.error, /non-manager/); step('approved by an agent account → refused (checked against the users table)')
  // approved by someone who WAS a manager but is not any more
  const [ex] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES ('ex@test', 'Ex', 'manager', 'x') RETURNING id`
  const c2 = await mk(kul.id, { status: 'approved' }); await sql`UPDATE drafts SET approved_by=${ex.id}, approved_at=now() WHERE id=${c2.id}`
  await sql`UPDATE users SET role = 'agent' WHERE id = ${ex.id}`
  r = await send(c2.id); assert.equal(r.status, 403); step('approver demoted since approving → refused (role read from the users table at send time)')
  // an agent's own approval cannot be smuggled in: a draft marked approved by the sender who is an agent
  const c3 = await mk(kul.id, { status: 'approved' }); await sql`UPDATE drafts SET approved_by=${kul.id}, approved_at=now() WHERE id=${c3.id}`
  r = await send(c3.id); assert.equal(r.status, 403); step('a draft "approved" by an agent (self) is refused: only managers approve')
  // edit after approval clears the approval
  await login(mgr.id)
  const e = await mk(kul.id, { kase: { battery_flag: true } })
  r = await api('POST', `/api/drafts/${e.id}/approve`); assert.equal(r.status, 200); assert.equal((await state(e.id)).status, 'approved')
  await login(kul.id)
  r = await api('PATCH', `/api/drafts/${e.id}`, { draft_text: CLEAN + '\n\nP.S. one more thing.' }); assert.equal(r.status, 200)
  st = await state(e.id); assert.equal(st.status, 'draft'); assert.equal(st.approved_by, null)
  r = await send(e.id, CLEAN + '\n\nP.S. one more thing.'); assert.equal(r.status, 403)
  step('an edit after manager approval clears the approval; on a battery-flag case the agent still cannot send it')

  console.log('6. Request approval + manager approval still works (exactly as before)')
  const f = await mk(kul.id, { kase: { chargeback_open: true } })
  r = await api('POST', `/api/drafts/${f.id}/request-approval`, { note: 'please check' }); assert.equal(r.status, 200); assert.equal(r.data.draft.status, 'pending_approval')
  r = await send(f.id); assert.equal(r.status, 403); assert.match(r.data.error, /waiting for a manager/)
  await login(mgr.id)
  r = await api('POST', `/api/drafts/${f.id}/approve`); assert.equal(r.status, 200)
  await login(kul.id)
  const c0 = sentCount(); r = await send(f.id); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(sentCount(), c0 + 1)
  st = await state(f.id); assert.equal(st.flag, false); assert.equal(st.sent_recorded_by, kul.id)
  step('pending → manager approves → agent sends; recorded as manager-approved (not in the staff-sent filter), sender still recorded')
  await login(mgr.id)
  r = await api('GET', '/api/cases?status=staff_sent'); assert.equal(r.data.cases.length, 1)

  console.log('7. OFF = current behaviour')
  r = await api('PUT', '/api/approval-settings', { staff_can_send_routine: false }); assert.equal(r.status, 200); assert.equal(r.data.staff_can_send_routine, false)
  await login(kul.id)
  const g = await mk(kul.id)
  r = await api('GET', `/api/drafts/${g.id}/routine-check`); assert.equal(r.data.eligible, false); assert.equal(r.data.setting_on, false)
  const c4 = sentCount(); r = await send(g.id); assert.equal(r.status, 403); assert.match(r.data.error, /Request approval/); assert.equal(sentCount(), c4)
  step('a perfectly routine reply is refused when the setting is OFF')
  // an approval given by a manager before it went OFF still works; one self-"approved" does not
  await login(mgr.id); r = await api('GET', '/api/approval-settings'); assert.equal(r.data.updated_by_name, 'Sagar'); step('who changed the setting is recorded')
  r = await api('PUT', '/api/approval-settings', { staff_can_send_routine: true }); assert.equal(r.data.staff_can_send_routine, true)
  await login(kul.id); r = await send(g.id); assert.equal(r.status, 200, JSON.stringify(r.data)); step('switching it back ON takes effect immediately')

  console.log('8. Rewrite re-runs the check; needs_manager means approval again')
  const h = await mk(kul.id)
  openaiReply = { ...openaiReply, reply: CLEAN, needs_manager: true }
  r = await api('POST', `/api/drafts/${h.id}/revise`, { guidance: 'Make it a bit shorter please' }); assert.equal(r.status, 201, JSON.stringify(r.data))
  let nd = r.data.draft
  assert.equal(nd.status, 'draft'); assert.equal(nd.needs_manager, true); assert.match(r.data.guardrail, /needs a manager/i); assert.equal(r.data.check.clean, false)
  assert.equal((await state(h.id)).status, 'discarded')
  const c5 = sentCount(); r = await send(nd.id); assert.equal(r.status, 403); assert.equal(sentCount(), c5)
  step('a rewrite the model flags needs_manager: old draft superseded, new one is a plain draft, staff send refused')
  // approved draft → rewrite never inherits the approval
  await login(mgr.id)
  const i = await mk(kul.id); await api('POST', `/api/drafts/${i.id}/approve`)
  assert.equal((await state(i.id)).status, 'approved')
  await login(kul.id)
  openaiReply = { ...openaiReply, reply: CLEAN, needs_manager: false }
  r = await api('POST', `/api/drafts/${i.id}/revise`, { guidance: 'Warmer tone please' }); assert.equal(r.status, 201)
  nd = r.data.draft; assert.equal(nd.status, 'draft'); assert.equal(nd.approved_by, null); assert.match(r.data.guardrail, /needs approval again/); assert.equal(r.data.check.approval_cleared, true)
  step('a rewrite of an approved draft does not inherit the approval, and says so')
  // rewrite that now FAILS / warns
  openaiReply = { ...openaiReply, reply: 'Dear Sam,\n\nWe have noted your question and will keep you updated.', needs_manager: false }
  r = await api('POST', `/api/drafts/${nd.id}/revise`, { guidance: 'Remove the sign-off' }); assert.equal(r.status, 201)
  assert.match(r.data.guardrail, /Guardrail warning/); assert.equal(r.data.check.warnings > 0, true)
  const warned = r.data.draft // the live draft now; the one before it was superseded
  const c6 = sentCount(); r = await send(warned.id, 'Dear Sam,\n\nWe have noted your question and will keep you updated.'); assert.equal(r.status, 403); assert.equal(sentCount(), c6)
  step('a rewrite that picks up a guardrail warning is reported and cannot be staff-sent')
  // clean rewrite on a clean case → still eligible (and the message says all clear)
  openaiReply = { ...openaiReply, reply: CLEAN, needs_manager: false }
  r = await api('POST', `/api/drafts/${warned.id}/revise`, { guidance: 'Add the sign-off back' }); assert.equal(r.status, 201, JSON.stringify(r.data))
  const j = r.data.draft; assert.equal(r.data.check.clean, true); assert.equal(r.data.guardrail, null)
  const c7 = sentCount(); r = await send(j.id); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(sentCount(), c7 + 1)
  step('a clean rewrite is reported clean and the agent can send it')

  console.log('9. Case changes between draft and send')
  const k2 = await mk(kul.id)
  await sql`UPDATE cases SET battery_flag = TRUE WHERE id = ${k2.caseId}`
  const c8 = sentCount(); r = await send(k2.id); assert.equal(r.status, 403); assert.equal(sentCount(), c8)
  step('battery_flag set after the draft was written → refused at send time (checked live, not from the stored draft)')
  const k3 = await mk(kul.id)
  await sql`INSERT INTO amazon_events (case_id, order_id, kind, status, received_at) VALUES (${k3.caseId}, 'late-notice', 'atoz_claim', 'open', now())`
  r = await send(k3.id); assert.equal(r.status, 403); step('an A-to-Z notice arriving after the draft was written → refused')

  console.log('10. Migration 0020 not applied (production before the user runs it) → fail closed')
  await sql`DROP INDEX IF EXISTS idx_drafts_staff_sent`
  await sql`ALTER TABLE drafts DROP COLUMN sent_without_manager_approval, DROP COLUMN routine_check`
  _resetStaffColsCache()
  try {
    const l = await mk(kul.id).catch(() => null) // insert still works without the columns
    assert.ok(l)
    r = await api('GET', `/api/drafts/${l!.id}/routine-check`); assert.equal(r.data.eligible, false); assert.match(r.data.reasons.join(' '), /0020/)
    const c9 = sentCount(); r = await send(l!.id); assert.equal(r.status, 403); assert.match(r.data.error, /migration 0020/); assert.equal(sentCount(), c9)
    r = await api('GET', '/api/approval-settings'); assert.equal(r.data.migration_ok, false); assert.equal(r.data.effective, false)
    await login(mgr.id)
    r = await api('GET', '/api/cases?status=staff_sent'); assert.equal(r.status, 200); assert.equal(r.data.cases.length, 0)
    r = await api('GET', '/api/cases?status=open'); assert.equal(r.status, 200)
    // the manager path is unaffected
    const mm = await mk(kul.id, { status: 'approved' }); await sql`UPDATE drafts SET approved_by=${mgr.id} WHERE id=${mm.id}`
    await login(kul.id); const c10 = sentCount(); r = await send(mm.id); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(sentCount(), c10 + 1)
    step('staff sending paused with a clear message, settings page says so, filter is empty (no crash), manager-approved sends still work')
  } finally {
    await sql.unsafe(readFileSync(new URL('../db/migrations/0020_staff_routine_send.sql', import.meta.url), 'utf8'))
    _resetStaffColsCache()
  }

  console.log('\nAll approval-flow checks passed.')
  await sql.end()
}
main().catch(async (e) => { console.error('\nFAILED:', e); await sql.end().catch(() => {}); process.exit(1) })
