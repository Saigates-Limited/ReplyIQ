// End-to-end test of carrier KPIs + the order-ID task (migration 0030) against a real local PostgreSQL, driving the
// actual Hono app. Gmail is an in-memory fake; nothing leaves the machine.
// Run: node tests/run-e2e.mjs tests/carrier_kpis.e2e.ts   (DATABASE_URL → throwaway DB with schema + all migrations)
import assert from 'node:assert/strict'
import postgres from 'postgres'
import worker from '../src/index'
import { encryptToken } from '../src/gmail'

const DB = process.env.DATABASE_URL || 'postgres://replyiq:replyiq_dev@localhost:5432/replyiq'
const env: any = { DATABASE_URL: DB, GOOGLE_CLIENT_ID: 't', GOOGLE_CLIENT_SECRET: 'x', TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'), ASSETS: { fetch: async () => new Response('') } }
const sql = postgres(DB, { max: 1, onnotice: () => {} })

// ───────── Fake Gmail (carrier mailbox only) ─────────
type Msg = { id: string; threadId: string; internalDate: string; labelIds?: string[]; from: string; to: string; subject: string; body: string }
const box: Msg[] = []
let seq = 1
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const toGmail = (m: Msg) => ({ id: m.id, threadId: m.threadId, internalDate: m.internalDate, labelIds: m.labelIds ?? ['INBOX'],
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: m.from }, { name: 'To', value: m.to }, { name: 'Subject', value: m.subject }, { name: 'Message-ID', value: `<${m.id}@t>` }], body: { data: b64url(m.body) } } })
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(typeof input === 'string' ? input : input.url)
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3600 })
  if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/')) {
    const path = url.split('/users/me')[1]
    if (path.startsWith('/threads?')) return json({ threads: [...new Set(box.map((m) => m.threadId))].map((id) => ({ id })) })
    const th = path.match(/^\/threads\/([^?]+)/)
    if (th) return json({ id: th[1], messages: box.filter((m) => m.threadId === th[1]).map(toGmail) })
    if (path === '/messages/send') { const id = `sent${++seq}`; const b = JSON.parse(String(init.body)); return json({ id, threadId: b.threadId ?? `t-${id}` }) }
    const mm = path.match(/^\/messages\/([^?]+)\?format=metadata/)
    if (mm) return json({ id: mm[1], threadId: 'x', internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'Message-ID', value: `<${mm[1]}@g>` }] } })
  }
  if (/api\.openai\.com/.test(url)) return json({ choices: [{ message: { content: '{}' } }] })
  return realFetch(input, init)
}) as typeof fetch

let cookie = ''
async function api(method: string, path: string, body?: unknown) {
  const res = await worker.fetch(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }), env, {} as any)
  const text = await res.text()
  let data: any; try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}
const step = (s: string) => console.log(`  ✓ ${s}`)

async function main() {
  await sql.unsafe(`TRUNCATE carrier_drafts, carrier_messages, messages, drafts, amazon_orders, gmail_threads_seen, sessions RESTART IDENTITY CASCADE`)
  await sql.unsafe(`DELETE FROM app_settings WHERE key = 'carrier'`)
  await sql.unsafe(`ALTER TABLE carrier_cases DISABLE TRIGGER trg_carrier_cases_no_delete; TRUNCATE carrier_cases RESTART IDENTITY CASCADE; ALTER TABLE carrier_cases ENABLE TRIGGER trg_carrier_cases_no_delete`)
  await sql.unsafe(`ALTER TABLE cases DISABLE TRIGGER trg_cases_no_delete; TRUNCATE cases RESTART IDENTITY CASCADE; ALTER TABLE cases ENABLE TRIGGER trg_cases_no_delete`)
  await sql.unsafe(`TRUNCATE gmail_connection RESTART IDENTITY CASCADE; TRUNCATE users RESTART IDENTITY CASCADE`)
  // KPIs start counting from a week ago so the backdated test data below is scored
  await sql`INSERT INTO app_settings (key, value) VALUES ('carrier_kpi', ${sql.json({ target_days: 1, start: new Date(Date.now() - 20 * 86400_000).toISOString().slice(0, 10) } as any)})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  const [mgr] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES ('sagar@test', 'Sagar', 'manager', 'x') RETURNING id`
  const [agent] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES ('kuldeep@test', 'Kuldeep Kaur', 'agent', 'x') RETURNING id`
  const login = async (userId: number) => {
    const token = `tok${userId}${Date.now()}${Math.random()}`
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map((x) => x.toString(16).padStart(2, '0')).join('')
    await sql`INSERT INTO sessions (id, user_id, expires_at) VALUES (${id}, ${userId}, now() + interval '1 day')`
    cookie = `riq_session=${token}`
  }
  await sql`INSERT INTO gmail_connection (email_address, refresh_token_enc, scopes, label, is_default, carrier_mail) VALUES ('saigateslimited@gmail.com', ${await encryptToken(env, 'rt')}, 'x', 'Carriers', TRUE, TRUE)`

  console.log('1. Settings: owner of new carrier cases + KPI target')
  await login(agent.id)
  assert.equal((await api('PUT', '/api/carrier/settings', { owner_id: agent.id })).status, 403)
  await login(mgr.id)
  let r = await api('PUT', '/api/carrier/settings', { owner_id: agent.id }); assert.equal(r.status, 200); assert.equal(r.data.settings.owner_id, agent.id)
  r = await api('GET', '/api/carrier/settings'); assert.equal(r.data.kpi.target_days, 1); assert.ok(r.data.staff.length >= 2)
  assert.equal((await api('PUT', '/api/carrier/kpi-settings', { target_days: 0 })).status, 422)
  step('manager sets Kuldeep as owner of new carrier cases; KPI target 1 working day; agents cannot change it')

  console.log('2. Customer report → investigation raised (KPI 1)')
  await login(agent.id)
  const reported = new Date(Date.now() - 3 * 3600_000)
  const [kase] = await sql`INSERT INTO cases (case_ref, subject, customer_first_name, order_id, tracking_number, carrier, source, last_customer_message_at)
    VALUES ('RIQ-9001', 'Not received', 'Henry', '202-5745896-9109132', 'HZ623769535GB', 'Royal Mail', 'gmail', ${reported}) RETURNING id`
  await sql`INSERT INTO messages (case_id, direction, sender, body, sent_at) VALUES (${kase.id}, 'inbound', 'Henry', 'Tracking says delivered but nothing arrived', ${reported})`
  r = await api('POST', '/api/carrier/open', { case_id: kase.id, force: true }); assert.ok([200, 201].includes(r.status), JSON.stringify(r.data))
  const ccId = r.data.carrier_case_id
  let [row] = await sql`SELECT reported_at, assigned_to, order_id, order_id_set_at FROM carrier_cases WHERE id = ${ccId}`
  assert.equal(+new Date(row.reported_at), +reported); assert.equal(row.assigned_to, agent.id); assert.ok(row.order_id_set_at)
  let d = (await api('GET', `/api/carrier/cases/${ccId}`)).data.drafts[0]
  r = await api('POST', `/api/carrier/drafts/${d.id}/send`, { confirm_to: d.to_address, confirm_subject: d.subject, confirm_body: d.body }); assert.equal(r.status, 200, JSON.stringify(r.data))
  step('parcel opened from the customer case: report time and owner recorded; order ID present from the start (not scored)')

  console.log('3. Carrier says claim → claim lodged (KPI 2)')
  const outThread = (await sql`SELECT gmail_thread_id FROM carrier_messages WHERE carrier_case_id = ${ccId} AND direction = 'outbound'`)[0].gmail_thread_id
  box.push({ id: `m${++seq}`, threadId: outThread, internalDate: String(Date.now()), from: 'business.customer.service@royalmail.com', to: 'ecom@saigates.com',
    subject: 'RE: Investigation HZ623769535GB - Case Reference #14174431',
    body: 'Case Number:14174431\nTracking Number: HZ623769535GB\n\nYour item has not reached a location that we are able to contact. As there has been no further movement I have to advise you to proceed to claims.\nYou should submit your claim at www.royalmail.com/claims' })
  r = await api('POST', '/api/carrier/sync'); assert.equal(r.status, 200, JSON.stringify(r.data))
  let k = (await api('GET', `/api/carrier/cases/${ccId}`)).data.carrier_case
  assert.equal(k.status, 'claim_form_needed')
  r = await api('POST', `/api/carrier/cases/${ccId}/claim-submitted`, { claim_ref: '14411455', claimed: 243 }); assert.equal(r.status, 200)
  step('decision "submit a claim" read from carrier mail; Kuldeep lodges claim 14411455 the same day')

  console.log('4. Order-ID task list')
  r = await api('POST', '/api/carrier/cases', { carrier: 'royal_mail', tracking: 'JT902478708GB', issue: 'lost' }); assert.equal(r.status, 201)
  const noOrderId = r.data.carrier_case_id
  r = await api('POST', '/api/carrier/cases', { carrier: 'royal_mail', tracking: 'AS566117604GB', issue: 'postage_refund' }); assert.equal(r.status, 201)
  const refundId = r.data.carrier_case_id
  // backlog parcel imported days ago, never given an order ID (2-working-day window, now overdue)
  const [old] = await sql`INSERT INTO carrier_cases (carrier, tracking, issue, status, source, order_id_requested_at, order_id_window_days, assigned_to)
    VALUES ('royal_mail', 'BM493186513GB', 'lost', 'awaiting_carrier', 'import', now() - interval '8 days', 2, ${agent.id}) RETURNING id`
  r = await api('GET', '/api/carrier/summary'); assert.equal(r.data.missing_order_id, 3); assert.equal(r.data.missing_order_id_overdue, 1)
  r = await api('GET', '/api/carrier/cases?view=order_id')
  assert.deepEqual(r.data.cases.map((x: any) => x.id).sort(), [noOrderId, refundId, old.id].sort())
  assert.equal(r.data.cases[0].id, old.id); assert.ok(r.data.cases[0].order_id_due)
  step('summary: 3 parcels missing an order ID, 1 overdue; task list sorted by deadline')
  const [kase2] = await sql`INSERT INTO cases (case_ref, subject, customer_first_name, order_id, source, last_customer_message_at) VALUES ('RIQ-9002', 'Where is it', 'Pete', '206-7250999-3388303', 'gmail', now()) RETURNING id`
  r = await api('PATCH', `/api/carrier/cases/${noOrderId}`, { order_id: '206-7250999-3388303' }); assert.equal(r.status, 200, JSON.stringify(r.data))
  ;[row] = await sql`SELECT order_id_set_at, order_id_set_by, case_id FROM carrier_cases WHERE id = ${noOrderId}`
  assert.ok(row.order_id_set_at); assert.equal(row.order_id_set_by, agent.id); assert.equal(row.case_id, kase2.id)
  step('order ID saved: time and person recorded, parcel linked to the customer case RIQ-9002')
  assert.equal((await api('PATCH', `/api/carrier/cases/${refundId}`, { order_id: 'x!' })).status, 422)
  r = await api('PATCH', `/api/carrier/cases/${refundId}`, { no_order: true }); assert.equal(r.status, 200)
  r = await api('GET', '/api/carrier/summary'); assert.equal(r.data.missing_order_id, 1)
  step('"No order" takes a postage-refund parcel off the list; nonsense order IDs are refused')
  assert.equal((await api('PATCH', `/api/carrier/cases/${old.id}`, { assigned_to: mgr.id })).status, 422)
  step('only a manager can change a case owner')

  console.log('5. KPI report')
  r = await api('GET', '/api/carrier/kpis'); assert.equal(r.status, 200, JSON.stringify(r.data))
  const by = Object.fromEntries(r.data.steps.map((x: any) => [x.step, x]))
  assert.equal(by.investigate.on_time, 1); assert.equal(by.claim.on_time, 1)
  assert.equal(by.order_id.on_time, 2); assert.equal(by.order_id.overdue, 1)
  const kuldeep = r.data.people.find((p: any) => p.id === agent.id)
  assert.ok(kuldeep); assert.equal(kuldeep.name, 'Kuldeep Kaur')
  assert.equal(r.data.misses.length, 1); assert.equal(r.data.misses[0].tracking, 'BM493186513GB'); assert.equal(r.data.misses[0].owner, 'Kuldeep Kaur')
  step(`investigate ${by.investigate.on_time_pct}% · claim ${by.claim.on_time_pct}% · order ID ${by.order_id.on_time_pct}% on time; the overdue backlog parcel is listed against Kuldeep`)
  ;[row] = await sql`SELECT kind, extracted FROM carrier_messages WHERE carrier_case_id = ${ccId} AND kind = 'claim_submitted'`
  assert.ok(row)

  console.log('6. Customer update clock')
  await sql`UPDATE carrier_cases SET customer_update_due = TRUE WHERE id = ${ccId}`
  ;[row] = await sql`SELECT customer_update_due_at FROM carrier_cases WHERE id = ${ccId}`; assert.ok(row.customer_update_due_at)
  await api('PATCH', `/api/carrier/cases/${ccId}`, { customer_update_due: false })
  ;[row] = await sql`SELECT customer_told_at FROM carrier_cases WHERE id = ${ccId}`; assert.ok(row.customer_told_at)
  r = await api('GET', '/api/carrier/kpis'); assert.equal(r.data.steps.find((x: any) => x.step === 'customer').on_time, 1)
  step('carrier news → customer told is timed and scored')

  console.log('\nAll carrier KPI end-to-end checks passed.')
  await sql.end()
}
main().catch(async (e) => { console.error(e); await sql.end(); process.exit(1) })
