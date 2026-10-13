// End-to-end test of the carrier desk against a real local PostgreSQL, driving the actual Hono app.
// Google (OAuth + Gmail) is replaced by an in-memory fake; nothing leaves the machine.
// Run: npm run test:e2e   (needs DATABASE_URL to a throwaway database with db/schema.sql + migrations applied)
import assert from 'node:assert/strict'
import postgres from 'postgres'
import worker from '../src/index'
import { encryptToken } from '../src/gmail'

const DB = process.env.DATABASE_URL || 'postgres://replyiq:replyiq_dev@localhost:5432/replyiq'
const env: any = {
  DATABASE_URL: DB,
  GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'x',
  TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
  ASSETS: { fetch: async () => new Response('') },
}
const sql = postgres(DB, { max: 1, onnotice: () => {} })

// ───────── Fake Gmail ─────────
type Msg = { id: string; threadId: string; internalDate: string; labelIds?: string[]; from: string; to: string; subject: string; body: string; msgId: string }
const mailbox: Record<string, Msg[]> = { 'at-rt-1': [], 'at-rt-2': [] } // access token → messages (1 = Amazon inbox, 2 = carrier mailbox)
const sent: { token: string; raw: string; threadId?: string }[] = []
let seq = 1000
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function add(box: 'at-rt-1' | 'at-rt-2', m: Omit<Msg, 'id' | 'msgId'> & { id?: string }) {
  const id = m.id ?? `m${++seq}`
  const msg = { ...m, id, msgId: `<${id}@test>` }
  mailbox[box].push(msg)
  return msg
}
const toGmail = (m: Msg) => ({
  id: m.id, threadId: m.threadId, internalDate: m.internalDate, labelIds: m.labelIds ?? ['INBOX'],
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: m.from }, { name: 'To', value: m.to }, { name: 'Subject', value: m.subject }, { name: 'Message-ID', value: m.msgId }], body: { data: b64url(m.body) } },
})
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(typeof input === 'string' ? input : input.url)
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    const p = new URLSearchParams(String(init.body))
    return json({ access_token: `at-${p.get('refresh_token')}`, expires_in: 3600 })
  }
  if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/')) {
    const token = String(init.headers?.Authorization ?? '').replace('Bearer ', '')
    const box = mailbox[token]
    if (!box) return json({ error: 'bad token' }, 401)
    const path = url.split('/users/me')[1]
    if (path.startsWith('/threads?')) {
      const q = new URL(url).searchParams.get('q') ?? ''
      const carrierQ = /royalmail\.com/.test(q), amazonQ = /marketplace\.amazon/.test(q)
      const ids = [...new Set(box.filter((m) => (carrierQ && /royalmail|dpd|fedex|evri/i.test(m.from + m.to)) || (amazonQ && /amazon/i.test(m.from + m.to))).map((m) => m.threadId))]
      return json({ threads: ids.map((id) => ({ id })) })
    }
    const th = path.match(/^\/threads\/([^?]+)/)
    if (th) return json({ id: th[1], messages: box.filter((m) => m.threadId === th[1]).map(toGmail) })
    if (path === '/messages/send') {
      const b = JSON.parse(String(init.body))
      const raw = Buffer.from(b.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
      sent.push({ token, raw, threadId: b.threadId })
      const id = `sent${++seq}`
      const threadId = b.threadId ?? `t-${id}`
      // Gmail keeps the sent message in the thread: the next poll must recognise it as ours and not import it twice
      const hdr = (n: string) => raw.match(new RegExp(`^${n}: (.*)$`, 'mi'))?.[1] ?? ''
      box.push({ id, threadId, internalDate: String(Date.now()), labelIds: ['SENT'], from: hdr('From'), to: hdr('To'), subject: hdr('Subject'), body: 'sent', msgId: `<${id}@mail.gmail.com>` })
      return json({ id, threadId })
    }
    const mm = path.match(/^\/messages\/([^?]+)\?format=metadata/)
    if (mm) return json({ id: mm[1], threadId: 'x', internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers: [{ name: 'Message-ID', value: `<${mm[1]}@mail.gmail.com>` }] } })
  }
  if (/api\.openai\.com/.test(url)) return json({ choices: [{ message: { content: '{"tone":"worried"}' } }] })
  return realFetch(input, init)
}) as typeof fetch

// ───────── HTTP helper ─────────
let cookie = ''
async function api(method: string, path: string, body?: unknown) {
  const res = await worker.fetch(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }), env, {} as any)
  const text = await res.text()
  let data: any; try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}
const decodeB64Parts = (raw: string) => [...raw.matchAll(/Content-Type: text\/plain[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8')).join('\n')
const step = (s: string) => console.log(`  ✓ ${s}`)

async function main() {
  // Clean slate (cases refuse DELETE by trigger, so truncate)
  await sql.unsafe(`TRUNCATE carrier_drafts, carrier_messages, app_settings, messages, drafts, amazon_events, attachments, review_requests, amazon_orders, sync_runs, gmail_threads_seen, sessions, oauth_states RESTART IDENTITY CASCADE`)
  await sql.unsafe(`ALTER TABLE carrier_cases DISABLE TRIGGER trg_carrier_cases_no_delete; TRUNCATE carrier_cases RESTART IDENTITY CASCADE; ALTER TABLE carrier_cases ENABLE TRIGGER trg_carrier_cases_no_delete`)
  await sql.unsafe(`ALTER TABLE cases DISABLE TRIGGER trg_cases_no_delete; TRUNCATE cases RESTART IDENTITY CASCADE; ALTER TABLE cases ENABLE TRIGGER trg_cases_no_delete`)
  await sql.unsafe(`TRUNCATE gmail_connection RESTART IDENTITY CASCADE; TRUNCATE users RESTART IDENTITY CASCADE`)
  const [mgr] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES ('sagar@test', 'Sagar', 'manager', 'x') RETURNING id`
  const [agent] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES ('kuldeep@test', 'Kuldeep Kaur', 'agent', 'x') RETURNING id`
  const login = async (userId: number) => {
    const token = `tok${userId}${Date.now()}`
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map((x) => x.toString(16).padStart(2, '0')).join('')
    await sql`INSERT INTO sessions (id, user_id, expires_at) VALUES (${id}, ${userId}, now() + interval '1 day')`
    cookie = `riq_session=${token}`
  }
  await sql`INSERT INTO gmail_connection (email_address, refresh_token_enc, scopes, label, is_default, carrier_mail) VALUES
    ('bijalshah.cc@gmail.com', ${await encryptToken(env, 'rt-1')}, 'x', 'Amazon', TRUE, FALSE),
    ('saigateslimited@gmail.com', ${await encryptToken(env, 'rt-2')}, 'x', 'Carriers', FALSE, TRUE)`
  await login(agent.id)

  console.log('1. Customer says "delivered but not received" → investigation prepared automatically')
  const now = Date.now()
  await sql`INSERT INTO amazon_orders (order_id, payload, fetched_at) VALUES ('204-8103591-2625136', ${sql.json({
    orderId: '204-8103591-2625136', trackingNumber: 'XM424652166GB', carrier: 'Royal Mail', shipDate: '2026-10-01T15:00:00Z', deliveredAt: '2026-10-02T11:00:00Z',
    packageStatus: 'DELIVERED', promisedDelivery: { earliest: '2026-10-02T00:00:00Z', latest: '2026-10-03T00:00:00Z' },
    items: [{ title: 'Apple iPhone 15 256GB Black (Renewed)', unitPrice: '389.00', quantity: 1, currency: 'GBP' }], grandTotal: '389.00', currency: 'GBP',
  } as any)}, now())`
  add('at-rt-1', { threadId: 'amz1', internalDate: String(now - 3600_000), from: 'Daniel Brown <xyz1@marketplace.amazon.co.uk>', to: 'bijalshah.cc@gmail.com',
    subject: 'Message from Amazon customer Daniel (Order: 204-8103591-2625136)',
    body: `Order ID: 204-8103591-2625136\n1 / Apple iPhone 15 256GB Black (Renewed) [ASIN: B0CHX1W1XY]\n------------- Message: -------------\nHi, the tracking says delivered on Friday but I have not received anything. Nobody here signed for it.\n------------- End message -------------` })
  let r = await api('POST', '/api/gmail/sync')
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const [kase] = await sql`SELECT * FROM cases WHERE order_id = '204-8103591-2625136'`
  assert.equal(kase.carrier_issue, 'delivered_not_received')
  r = await api('GET', `/api/carrier/for-case/${kase.id}`)
  assert.equal(r.data.carrier_cases.length, 1)
  const cc = r.data.carrier_cases[0]
  assert.equal(cc.status, 'to_raise'); assert.equal(cc.tracking, 'XM424652166GB'); assert.equal(Number(cc.value), 389); assert.equal(cc.live_drafts[0].kind, 'investigation')
  step('case flagged, parcel XM424652166GB opened as "Ready to raise" with £389 value from the Amazon order')
  r = await api('GET', '/api/cases?status=active')
  assert.equal(r.data.cases.find((x: any) => x.id === kase.id).carrier_status, 'to_raise')
  step('inbox list carries the carrier status chip')

  console.log('2. Review + one-click send (gates)')
  r = await api('GET', `/api/carrier/cases/${cc.id}`)
  let d = r.data.drafts[0]
  assert.match(d.subject, /marked delivered but not received – XM424652166GB \(204-8103591-2625136\)/)
  assert.match(d.body, /Recipient: Daniel Brown/) // name goes to the carrier…
  assert.match(d.body, /Kind regards,\n\nSaigates Ltd/) // auto-created by the sync: signed with the company name
  let bad = await api('POST', `/api/carrier/drafts/${d.id}/send`, { confirm_to: d.to_address, confirm_subject: d.subject, confirm_body: d.body + ' edited' })
  assert.equal(bad.status, 409); step('refuses when the text on screen differs from the saved draft')
  bad = await api('PATCH', `/api/carrier/drafts/${d.id}`, { to_address: 'someone@gmail.com' })
  bad = await api('POST', `/api/carrier/drafts/${d.id}/send`, { confirm_to: 'someone@gmail.com', confirm_subject: d.subject, confirm_body: d.body })
  assert.equal(bad.status, 422); assert.match(bad.data.error, /not a carrier address/); step('refuses a non-carrier recipient')
  r = await api('PATCH', `/api/carrier/drafts/${d.id}`, { to_address: 'business.customer.service@royalmail.com' }); d = r.data.draft
  await api('PUT', '/api/carrier/settings', { from_address: 'ecom@saigates.com' }).then((x) => assert.equal(x.status, 403)) // agent cannot change settings
  await login(mgr.id)
  r = await api('PUT', '/api/carrier/settings', { from_address: 'ecom@saigates.com', cc: 'sagar.patel@saigates.com' }); assert.equal(r.status, 200)
  await login(agent.id)
  r = await api('POST', `/api/carrier/drafts/${d.id}/send`, { confirm_to: d.to_address, confirm_subject: d.subject, confirm_body: d.body })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const mail = sent[sent.length - 1]
  assert.equal(mail.token, 'at-rt-2') // sent from the carrier mailbox
  assert.match(mail.raw, /From: Saigates Ltd <ecom@saigates\.com>/); assert.match(mail.raw, /To: business\.customer\.service@royalmail\.com/); assert.match(mail.raw, /Cc: sagar\.patel@saigates\.com/)
  assert.match(decodeB64Parts(mail.raw), /GPS location of the delivery scan/)
  assert.equal(r.data.carrier_case.status, 'awaiting_carrier'); assert.ok(r.data.carrier_case.sla_due_at)
  step(`sent from the carrier mailbox as ecom@saigates.com; status → Awaiting carrier, reply due ${String(r.data.carrier_case.next_due).slice(0, 10)}`)
  const again = await api('POST', `/api/carrier/drafts/${d.id}/send`, { confirm_to: d.to_address, confirm_subject: d.subject, confirm_body: d.body })
  assert.equal(again.status, 409); step('cannot be sent twice')
  const [mirror] = await sql`SELECT body FROM messages WHERE case_id = ${kase.id} AND sender LIKE 'Carrier update%' ORDER BY id DESC LIMIT 1`
  assert.match(mirror.body, /We asked Royal Mail to investigate/); step('customer timeline notes the investigation (no personal data)')

  console.log('3. Carrier replies are matched and move the status')
  const sentThread = (await sql`SELECT gmail_thread_id FROM carrier_messages WHERE carrier_case_id = ${cc.id} AND direction = 'outbound'`)[0].gmail_thread_id
  add('at-rt-2', { threadId: sentThread, internalDate: String(Date.now() + 1000), from: 'donotreply@royalmail.com', to: 'ecom@saigates.com',
    subject: 'RE: Urgent delivery investigation - XM424652166GB (204-8103591-2625136) - Case Reference #14856287',
    body: 'Reference # 14856287\n\nThank you for contacting Royal Mail.\nWe aim to respond within 3 days; however, this may take longer during busy periods.' })
  r = await api('POST', '/api/carrier/sync')
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.messagesNew, 1) // the auto-ack; our own sent copy is recognised, not re-imported
  let k = (await api('GET', `/api/carrier/cases/${cc.id}`)).data.carrier_case
  assert.deepEqual(k.carrier_refs, ['14856287']); assert.equal(k.carrier_reply_type, 'auto_ack'); assert.equal(k.status, 'awaiting_carrier')
  step('auto-acknowledgement: case reference 14856287 stored, clock keeps running from our email')
  add('at-rt-2', { threadId: sentThread, internalDate: String(Date.now() + 2000), from: 'rmserviceteam@royalmail.com', to: 'ecom@saigates.com',
    subject: 'RE: Urgent delivery investigation - XM424652166GB - Case Reference #14856287',
    body: 'Case Reference #14856287\n\nGood afternoon,\n\nI have checked the GPS co-ordinates which have been obtained within close proximity of the delivery address.\n\nI will make enquiries with the Delivery Office to see if further delivery details can be provided.\n\nWe will update you once we receive a reply.' })
  await api('POST', '/api/carrier/sync')
  k = (await api('GET', `/api/carrier/cases/${cc.id}`)).data.carrier_case
  assert.equal(k.carrier_reply_type, 'replied'); assert.match(k.next_action, /investigating case 14856287/)
  step(`holding reply recognised → "${k.next_action}"`)

  console.log('4. Investigation sent outside ReplyIQ → lost decision → claim pack → claim submitted')
  const [kase2] = await sql`INSERT INTO cases (case_ref, subject, customer_first_name, order_id, source, last_customer_message_at) VALUES ('RIQ-2001', 'Where is my order', 'Priya', '203-7672354-9186752', 'gmail', now() - interval '5 days') RETURNING id`
  add('at-rt-2', { threadId: 'rm2', internalDate: String(Date.now() - 6 * 86400_000), labelIds: ['SENT'], from: 'Kuldeep Kaur <ecom@saigates.com>', to: 'business.customer.service@royalmail.com',
    subject: 'URGENT: No Tracking Update Since 19 September - JT902500896GB - Order 203-7672354-9186752', body: 'Dear Royal Mail, please investigate JT902500896GB. Order 203-7672354-9186752.' })
  add('at-rt-2', { threadId: 'rm2', internalDate: String(Date.now() - 6 * 86400_000 + 60_000), from: 'donotreply@royalmail.com', to: 'ecom@saigates.com',
    subject: 'RE: URGENT: No Tracking Update Since 19 September - JT902500896GB - Case Reference #14882087', body: 'Reference # 14882087\nThank you for contacting Royal Mail.\nWe aim to respond within 3 days.' })
  add('at-rt-2', { threadId: 'rm2', internalDate: String(Date.now() - 3600_000), from: 'business.customer.service@royalmail.com', to: 'ecom@saigates.com',
    subject: 'RE: RE: URGENT: No Tracking Update Since 19 September - JT902500896GB - Case Reference #14882087',
    body: 'Case Number: 14882087\nTracking Reference: JT902500896GB\n\nThere has been no further movement and your item has not reached a location that we are able to contact. At this time, we will of course consider a claim for loss compensation, and you should submit your claim at www.royalmail.com/claims\n\n--------------- Original Message ---------------\nReference # 14882087\nWe aim to respond within 3 days' })
  r = await api('POST', '/api/carrier/sync')
  const [k2] = await sql`SELECT * FROM carrier_cases WHERE tracking = 'JT902500896GB'`
  assert.equal(k2.case_id, kase2.id); assert.equal(k2.issue, 'lost'); assert.equal(k2.status, 'claim_form_needed'); assert.equal(k2.customer_update_due, true)
  assert.ok(r.data.prepared >= 1)
  step('parcel created from our own Outlook/Gmail email, linked to the customer case by order id; lost → "Claim to submit"; customer update flagged')
  const [pack] = await sql`SELECT * FROM carrier_drafts WHERE carrier_case_id = ${k2.id} AND kind = 'claim_pack'`
  assert.ok(pack); assert.equal(pack.to_address, null)
  bad = await api('POST', `/api/carrier/drafts/${pack.id}/send`, { confirm_to: '', confirm_subject: pack.subject, confirm_body: pack.body })
  assert.equal(bad.status, 400); step('claim pack prepared automatically and can never be emailed')
  await api('PATCH', `/api/carrier/cases/${k2.id}`, { value: 289 })
  r = await api('POST', `/api/carrier/cases/${k2.id}/claim-submitted`, { claim_ref: 'RMC-778812', claimed: 289 })
  assert.equal(r.data.carrier_case.status, 'claim_submitted'); assert.equal(Number(r.data.carrier_case.claimed), 289)
  step(`claim submitted → decision due ${String(r.data.carrier_case.next_due).slice(0, 10)}`)
  add('at-rt-2', { threadId: 'rm3', internalDate: String(Date.now() + 5000), from: 'donotreply@royalmail.com', to: 'sagar.patel@saigates.com', subject: 'Thanks for Contacting Royal Mail',
    body: "We've concluded your claim. Your Reference number is: 14882087\nWe've now resolved your claim(s) and a summary of the outcome is below.\nTracking number: JT902500896GB  Amount paid: £150.00" })
  await api('POST', '/api/carrier/sync')
  const [k2b] = await sql`SELECT status, paid FROM carrier_cases WHERE id = ${k2.id}`
  assert.equal(k2b.status, 'partially_paid'); assert.equal(Number(k2b.paid), 150)
  step('claim settled for £150 of £289 → Partially paid')

  console.log('5. Overdue reply → chase prepared by the cron, threaded into the carrier\'s email')
  await sql`UPDATE carrier_cases SET sla_due_at = now() - interval '1 hour', last_us_at = now() - interval '6 days' WHERE id = ${cc.id}`
  r = await api('GET', '/api/carrier/summary'); assert.equal(r.data.chase_now, 1); assert.equal(r.data.customer_updates_due, 1)
  r = await api('POST', '/api/carrier/sync')
  const [chase] = await sql`SELECT * FROM carrier_drafts WHERE carrier_case_id = ${cc.id} AND kind = 'chase' AND status = 'draft'`
  assert.ok(chase?.auto_created); assert.match(chase.subject, /^RE: .*Case Reference #14856287/)
  r = await api('POST', `/api/carrier/drafts/${chase.id}/send`, { confirm_to: chase.to_address, confirm_subject: chase.subject, confirm_body: chase.body })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const chaseMail = sent[sent.length - 1]
  assert.equal(chaseMail.threadId, sentThread); assert.match(chaseMail.raw, /In-Reply-To: <m\d+@test>/)
  step('chase sent as a reply in Royal Mail\'s own thread (In-Reply-To set), clock restarted')
  const twice = (await sql`SELECT count(*)::int AS n FROM carrier_drafts WHERE carrier_case_id = ${cc.id} AND kind = 'chase' AND status IN ('draft','approved')`)[0].n
  await api('POST', '/api/carrier/sync'); await api('POST', '/api/carrier/sync')
  assert.equal((await sql`SELECT count(*)::int AS n FROM carrier_drafts WHERE carrier_case_id = ${cc.id} AND kind = 'chase' AND status IN ('draft','approved')`)[0].n, twice)
  step('repeated cron runs never stack duplicate drafts')

  console.log('6. Customer update + guards')
  await sql`UPDATE carrier_cases SET customer_update_due = TRUE WHERE id = ${cc.id}`
  const [cd] = await sql`INSERT INTO drafts (case_id, draft_text, original_text, status, check_result, server_findings) VALUES (${kase.id}, 'Hi Daniel, Royal Mail are checking with the delivery office. Kind regards, Customer Support Team', 'x', 'approved', 'PASS', '[]') RETURNING id`
  r = await api('POST', `/api/drafts/${cd.id}/record-sent`)
  assert.equal(r.status, 200)
  assert.equal((await sql`SELECT customer_update_due FROM carrier_cases WHERE id = ${cc.id}`)[0].customer_update_due, false)
  step('sending the customer an update clears the "tell the customer" flag')
  r = await api('POST', `/api/carrier/cases/${cc.id}/drafts`, { kind: 'challenge' })
  const ch = r.data.draft
  assert.equal(ch.needs_manager, true)
  bad = await api('POST', `/api/carrier/drafts/${ch.id}/send`, { confirm_to: ch.to_address, confirm_subject: ch.subject, confirm_body: ch.body })
  assert.equal(bad.status, 403); step('challenge emails need a manager')
  await login(mgr.id)
  bad = await api('POST', `/api/carrier/drafts/${ch.id}/send`, { confirm_to: ch.to_address, confirm_subject: ch.subject, confirm_body: ch.body })
  assert.equal(bad.status, 422); assert.match(bad.data.error, /MISSING/); step('…and cannot go out with [MISSING: …] placeholders')

  console.log('7. Import from the old Carrier Claims Desk')
  const exportFile = process.env.IMPORT_FILE
  if (exportFile) {
    const { readFileSync } = await import('node:fs')
    const cases = JSON.parse(readFileSync(exportFile, 'utf8')).cases
    r = await api('POST', '/api/carrier/import', { cases })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const s = (await api('GET', '/api/carrier/summary')).data
    step(`imported ${r.data.created} new + ${r.data.updated} updated (${r.data.skipped.length} skipped) · open ${s.open} · chase now ${s.chase_now} · recovered £${s.recovered}`)
    const again2 = await api('POST', '/api/carrier/import', { cases })
    assert.equal(again2.data.created, 0); step('re-import is idempotent (updates only)')
  } else console.log('  (skipped: set IMPORT_FILE)')

  console.log('\nAll carrier desk end-to-end checks passed.')
  await sql.end()
}

main().catch(async (e) => { console.error(e); await sql.end(); process.exit(1) })
