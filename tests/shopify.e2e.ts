// End-to-end: Saisales.co.uk (Shopify) customers, through the real Hono app against a throwaway PostgreSQL.
// Gmail, Shopify and OpenAI are faked in memory; nothing leaves the machine.
// Run: DATABASE_URL=postgres://…/replyiq_test node tests/run-e2e.mjs tests/shopify.e2e.ts   (db/schema.sql incl. 0029)
import assert from 'node:assert/strict'
import postgres from 'postgres'
import worker from '../src/index'
import { encryptToken } from '../src/gmail'

const DB = process.env.DATABASE_URL || 'postgres://replyiq:replyiq_dev@localhost:5432/replyiq_test'
if (!/_test|test_/.test(new URL(DB).pathname)) throw new Error('Refusing to run: DATABASE_URL must point at a throwaway database whose name contains "test"')
const env: any = { DATABASE_URL: DB, GOOGLE_CLIENT_ID: 't.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'x', TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'), OPENAI_API_KEY: 'sk-test',
  SHOPIFY_SHOP: 'testshop', SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: 'csecret', ASSETS: { fetch: async () => new Response('') } }
const sql = postgres(DB, { max: 1, onnotice: () => {} })

// ───────── fakes ─────────
const b64 = (s: string) => Buffer.from(s).toString('base64url')
const at = (iso: string) => String(Date.parse(iso))
const gmsg = (id: string, threadId: string, iso: string, headers: Record<string, string>, body: string) => ({ id, threadId, internalDate: at(iso), labelIds: ['INBOX'],
  payload: { mimeType: 'text/plain', headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: { data: b64(body) } } })
const recent = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const threads: Record<string, any[]> = {
  t1: [gmsg('g1', 't1', recent(30), { From: 'Jo Bloggs <jo.bloggs@example.com>', To: 'info@saisales.co.uk', Subject: 'Order #1201 not charging', 'Message-ID': '<g1@x>' },
    'Hello, my iPhone from order #1201 will not charge since yesterday. Jo Bloggs, 12 Mill Lane, Leeds LS1 4AB')],
  t2: [gmsg('g2', 't2', recent(20), { From: 'Shopify <mailer@shopify.com>', 'Reply-To': 'jo.bloggs@example.com', To: 'info@saisales.co.uk', Subject: 'New customer message on 23 November 2026 at 10:00 am', 'Message-ID': '<g2@x>' },
    "You received a new message from your online store's contact form.\nName: Jo Bloggs\nEmail: jo.bloggs@example.com\nComment: Any update on my charging problem?")],
  t3: [gmsg('g3', 't3', recent(15), { From: 'Deals <news@deals.example>', To: 'info@saisales.co.uk', Subject: 'Big sale', 'List-Unsubscribe': '<mailto:u@deals.example>' }, 'Buy now')],
  t4: [gmsg('g4', 't4', recent(10), { From: 'Alex Pre <alex@example.org>', To: 'support@saisales.co.uk', Subject: 'Is the iPhone 14 unlocked?', 'Message-ID': '<g4@x>' }, 'Hi, is the iPhone 14 on your site unlocked?')],
}
const order: any = {
  id: 'gid://shopify/Order/1', name: '#1201', createdAt: '2026-11-01T10:00:00Z', processedAt: '2026-11-01T09:59:00Z', cancelledAt: null, closed: false,
  displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED', returnStatus: 'NO_RETURN', sourceName: 'web', email: 'jo.bloggs@example.com', currencyCode: 'GBP',
  currentTotalPriceSet: { shopMoney: { amount: '349.00', currencyCode: 'GBP' } }, totalRefundedSet: { shopMoney: { amount: '0.0', currencyCode: 'GBP' } },
  customer: { firstName: 'Jo', lastName: 'Bloggs' },
  shippingAddress: { name: 'Jo Bloggs', address1: '12 Mill Lane', city: 'Leeds', zip: 'LS1 4AB', country: 'United Kingdom' },
  billingAddress: { name: 'Jo Bloggs', address1: '12 Mill Lane', city: 'Leeds', zip: 'LS1 4AB', country: 'United Kingdom' },
  lineItems: { nodes: [{ id: 'gid://shopify/LineItem/9', title: 'Apple iPhone 13 128GB Unlocked', variantTitle: 'Blue / A - Excellent', sku: null, quantity: 1, originalUnitPriceSet: { shopMoney: { amount: '349.00' } } }] },
  fulfillments: [{ id: 'gid://shopify/Fulfillment/3', createdAt: '2026-11-02T12:00:00Z', status: 'SUCCESS', displayStatus: 'DELIVERED', deliveredAt: '2026-11-03T10:00:00Z', trackingInfo: [{ company: 'Royal Mail', number: 'XM000000001GB', url: null }],
    fulfillmentLineItems: { nodes: [{ id: 'gid://shopify/FulfillmentLineItem/5', quantity: 1, lineItem: { id: 'gid://shopify/LineItem/9', title: 'Apple iPhone 13 128GB Unlocked' } }] } }],
  refunds: [], returns: { nodes: [] },
  transactions: [{ id: 'gid://shopify/OrderTransaction/77', kind: 'SALE', status: 'SUCCESS', gateway: 'shopify_payments', formattedGateway: 'Shopify Payments', manualPaymentGateway: false, amountSet: { shopMoney: { amount: '349.00' } } }],
}
const sentMail: { raw: string; threadId?: string }[] = []
const gql: { query: string; variables: any }[] = []
const openai: string[] = []
let tokenCalls = 0, uploads = 0
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const refunded = () => order.refunds.reduce((n: number, r: any) => n + Number(r.totalRefundedSet.shopMoney.amount), 0)
function shopify(query: string, v: any) {
  if (query.includes('refundCreate')) {
    assert.match(query, /@idempotent\(key: \$key\)/); assert.ok(v.key)
    const amt = v.input.transactions.reduce((n: number, t: any) => n + Number(t.amount), 0)
    const r = { id: `gid://shopify/Refund/${order.refunds.length + 1}`, createdAt: new Date().toISOString(), note: v.input.note, totalRefundedSet: { shopMoney: { amount: amt.toFixed(2), currencyCode: 'GBP' } } }
    order.refunds.push(r); order.totalRefundedSet.shopMoney.amount = refunded().toFixed(2)
    return { refundCreate: { refund: r, userErrors: [] } }
  }
  if (query.includes('returnCreate')) {
    const r = { id: 'gid://shopify/Return/1', name: '#1201-R1', status: 'OPEN', createdAt: new Date().toISOString(), closedAt: null, totalQuantity: 1,
      returnLineItems: { nodes: [{ id: 'gid://shopify/ReturnLineItem/1', quantity: 1, processedQuantity: 0, fulfillmentLineItem: { id: v.input.returnLineItems[0].fulfillmentLineItemId, lineItem: { title: 'Apple iPhone 13 128GB Unlocked' } } }] },
      reverseFulfillmentOrders: { nodes: [{ id: 'gid://shopify/ReverseFulfillmentOrder/1', status: 'OPEN', reverseDeliveries: { nodes: [] as any[] } }] } }
    order.returns.nodes.push(r); order.returnStatus = 'IN_PROGRESS'
    return { returnCreate: { return: r, userErrors: [] } }
  }
  if (query.includes('stagedUploadsCreate')) { assert.equal(v.input[0].resource, 'RETURN_LABEL'); return { stagedUploadsCreate: { stagedTargets: [{ url: 'https://upload.shopify.test/', resourceUrl: 'https://upload.shopify.test/label.pdf', parameters: [{ name: 'key', value: 'k1' }] }], userErrors: [] } } }
  if (query.includes('reverseDeliveryCreateWithShipping')) {
    assert.equal(v.notify, false); assert.equal(v.label.fileUrl, 'https://upload.shopify.test/label.pdf')
    order.returns.nodes[0].reverseFulfillmentOrders.nodes[0].reverseDeliveries.nodes.push({ id: 'rd1', deliverable: { tracking: { number: v.tracking?.number, url: null, carrierName: null }, label: { publicFileUrl: 'https://cdn.test/label.pdf' } } })
    return { reverseDeliveryCreateWithShipping: { reverseDelivery: { id: 'rd1' }, userErrors: [] } }
  }
  if (query.includes('returnProcess')) { order.returns.nodes[0].status = 'CLOSED'; return { returnProcess: { return: { id: v.input.returnId, status: 'CLOSED' }, userErrors: [] } } }
  if (query.includes('return(id: $id)')) return { return: order.returns.nodes.find((r: any) => r.id === v.id) ?? null }
  if (query.includes('suggestedRefund')) {
    const max = 349 - refunded()
    return { order: { transactions: order.transactions, suggestedRefund: { maximumRefundableSet: { shopMoney: { amount: max.toFixed(2) } }, suggestedTransactions: [{ gateway: 'shopify_payments', kind: 'SUGGESTED_REFUND', maximumRefundableSet: { shopMoney: { amount: max.toFixed(2) } }, parentTransaction: { id: 'gid://shopify/OrderTransaction/77' } }] } } }
  }
  if (query.includes('order(id: $id)')) return { order: v.id === order.id ? order : null }
  if (query.includes('orders(first: $n')) return { orders: { nodes: String(v.q).includes('jo.bloggs@example.com') ? [order] : [] } }
  if (query.includes('orders(first: 1, query: $q)')) return { orders: { nodes: v.q === 'name:#1201' ? [order] : [] } }
  if (query.includes('shop {')) return { shop: { name: 'Test Saisales', myshopifyDomain: 'testshop.myshopify.com', currencyCode: 'GBP' }, orders: { nodes: [{ name: '#1201', createdAt: order.createdAt }] } }
  throw new Error('unexpected Shopify query: ' + query.slice(0, 120))
}
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(typeof input === 'string' ? input : input.url)
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at-ok', expires_in: 3600 })
  if (url.includes('gmail.googleapis.com')) {
    const u = new URL(url)
    if (u.pathname.endsWith('/messages/send')) { const b = JSON.parse(String(init.body)); sentMail.push({ raw: b.raw, threadId: b.threadId }); return json({ id: `sent${sentMail.length}`, threadId: b.threadId ?? 'tnew' }) }
    if (u.pathname.endsWith('/threads')) {
      const q = u.searchParams.get('q') || ''
      if (/marketplace\.amazon/.test(q)) return json({})
      if (/saisales\.co\.uk/.test(q)) return json({ threads: Object.keys(threads).map((id) => ({ id })) })
      return json({})
    }
    const tm = u.pathname.match(/\/threads\/([^/]+)$/); if (tm) return json({ id: tm[1], messages: threads[tm[1]] })
  }
  if (url === 'https://testshop.myshopify.com/admin/oauth/access_token') { tokenCalls++; assert.match(String(init.body), /grant_type=client_credentials/); return json({ access_token: 'shpat_test', scope: 'read_orders', expires_in: 86399 }) }
  if (url.startsWith('https://testshop.myshopify.com/admin/api/')) { assert.equal(init.headers['X-Shopify-Access-Token'], 'shpat_test'); const b = JSON.parse(String(init.body)); gql.push(b); return json({ data: shopify(b.query, b.variables ?? {}) }) }
  if (url === 'https://upload.shopify.test/') { uploads++; return new Response(null, { status: 204 }) }
  if (url.endsWith('/chat/completions')) {
    openai.push(String(init.body))
    return json({ choices: [{ message: { content: JSON.stringify({ lane: 'fault', reply: 'Dear Jo,\n\nThank you for your message. We are sorry to hear your phone is not charging. Please try another cable and plug. If it still does not charge, we will email you a free prepaid returns label so our technicians can inspect it.\n\nKind regards,\nCustomer Support Team', staff_notes: '', needs_manager: false, urgency: 'normal' }) } }] })
  }
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
const rawOf = (i: number) => Buffer.from(sentMail[i].raw, 'base64url').toString('utf8')

async function main() {
  await sql.unsafe(`TRUNCATE app_settings, messages, drafts, amazon_events, attachments, sessions, gmail_threads_seen, shopify_actions RESTART IDENTITY CASCADE`)
  await sql.unsafe(`ALTER TABLE cases DISABLE TRIGGER trg_cases_no_delete; TRUNCATE cases RESTART IDENTITY CASCADE; ALTER TABLE cases ENABLE TRIGGER trg_cases_no_delete`)
  await sql.unsafe(`TRUNCATE gmail_connection RESTART IDENTITY CASCADE; TRUNCATE users RESTART IDENTITY CASCADE`)
  const [mgr] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES ('sagar@test', 'Sagar', 'manager', 'x') RETURNING id`
  const [kul] = await sql`INSERT INTO users (email, name, role, password_hash) VALUES ('kuldeep@test', 'Kuldeep', 'agent', 'x') RETURNING id`
  await sql`INSERT INTO gmail_connection (email_address, refresh_token_enc, scopes, label, is_default) VALUES ('bijalshah.cc@gmail.com', ${await encryptToken(env, 'rt-1')}, 'x', 'Amazon', TRUE)`
  const [ssBox] = await sql`INSERT INTO gmail_connection (email_address, refresh_token_enc, scopes, label, is_default) VALUES ('saigateslimited@gmail.com', ${await encryptToken(env, 'rt-2')}, 'x', 'Saisales', FALSE) RETURNING id`

  console.log('1. Mailbox switch and sync')
  await login(kul.id)
  let r = await api('PATCH', `/api/gmail/mailboxes/${ssBox.id}`, { saisales_mail: true }); assert.equal(r.status, 403)
  step('an agent cannot switch on Saisales mail')
  await login(mgr.id)
  r = await api('PATCH', `/api/gmail/mailboxes/${ssBox.id}`, { saisales_mail: true }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.mailbox.saisales_mail, true)
  r = await api('POST', '/api/gmail/sync', { mailbox_id: ssBox.id }); assert.equal(r.status, 200, JSON.stringify(r.data))
  const cases = await sql`SELECT * FROM cases ORDER BY id`
  assert.equal(cases.length, 2, 'Jo (2 emails, 1 order) + Alex (pre-sale); the newsletter is skipped')
  const jo = cases.find((k: any) => k.customer_email === 'jo.bloggs@example.com')!
  const alex = cases.find((k: any) => k.customer_email === 'alex@example.org')!
  assert.equal(jo.channel, 'shopify'); assert.equal(jo.order_id, '#1201'); assert.equal(jo.shopify_order_gid, order.id); assert.equal(jo.mailbox_id, ssBox.id)
  assert.equal(jo.tracking_number, 'XM000000001GB'); assert.equal(jo.carrier, 'Royal Mail'); assert.equal(String(jo.delivery_date?.toISOString?.() ?? jo.delivery_date).slice(0, 10), '2026-11-03')
  assert.equal(jo.device_model, 'Apple iPhone 13 128GB Unlocked'); assert.equal(jo.customer_first_name, 'Jo'); assert.equal(jo.gmail_thread_id, 't2')
  assert.ok(!JSON.stringify(jo.shopify_order).includes('Bloggs') && !JSON.stringify(jo.shopify_order).includes('Mill Lane'))
  const joMsgs = await sql`SELECT sender, body FROM messages WHERE case_id = ${jo.id} AND kind = 'message' ORDER BY sent_at`
  assert.equal(joMsgs.length, 2); assert.equal(joMsgs[1].sender, 'Customer (website contact form)'); assert.equal(joMsgs[1].body, 'Any update on my charging problem?')
  step('order quoted (#1201) → case linked to the Shopify order; tracking, delivery date, device filled; facts hold no PII')
  step('the contact-form message about the same order joined the same case; replies go on the latest thread')
  assert.equal(alex.channel, 'shopify'); assert.equal(alex.shopify_order_gid, null); assert.equal(alex.order_id, null)
  step('pre-sale email with no order → Saisales case without an order; newsletter skipped')
  assert.equal(tokenCalls, 1); step('one Shopify token for the whole sync (cached)')
  r = await api('POST', '/api/gmail/sync', { mailbox_id: ssBox.id })
  assert.equal((await sql`SELECT COUNT(*)::int AS n FROM messages`)[0].n, 3); step('a second sync imports nothing twice')

  console.log('2. Case page')
  await login(kul.id)
  r = await api('GET', `/api/cases/${jo.id}`); assert.equal(r.data.case.channel, 'shopify'); assert.equal(r.data.case.shopify_order.order, '#1201')
  r = await api('GET', `/api/shopify/cases/${jo.id}`); assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.order.facts.order, '#1201'); assert.equal(r.data.order.max_refundable, 349); assert.equal(r.data.order.returnable.length, 1)
  assert.deepEqual(r.data.order.shipping_address.slice(0, 2), ['Jo Bloggs', '12 Mill Lane'])
  step('Saisales order panel: facts, refundable £349, one returnable line, delivery address for staff')
  r = await api('GET', `/api/cases/${alex.id}`)
  r = await api('GET', `/api/shopify/cases/${alex.id}`); assert.equal(r.data.order, null)
  r = await api('POST', `/api/shopify/cases/${alex.id}/link`, { order_name: '#9999' }); assert.equal(r.status, 404)
  step('no order for the pre-sale customer; linking a non-existent order is refused')
  const [amz] = await sql`INSERT INTO cases (case_ref, subject, customer_first_name, last_customer_message_at, source, customer_reply_to, gmail_thread_id, order_id) VALUES ('RIQ-A1', 'Amazon', 'Sam', now(), 'gmail', 'abc@marketplace.amazon.co.uk', 'ta', '205-0000000-1111111') RETURNING id`
  r = await api('GET', `/api/shopify/cases/${amz.id}`); assert.equal(r.data.not_saisales, true)
  r = await api('POST', `/api/shopify/cases/${amz.id}/refund`, { amount: 5, confirm_amount: 5, reason: 'test' }); assert.equal(r.status, 400)
  step('Amazon cases are untouched: no Shopify lookup, no Shopify refund')

  console.log('3. Draft')
  const before = gql.length
  r = await api('POST', `/api/cases/${jo.id}/drafts`, { mode: 'customer' }); assert.equal(r.status, 201, JSON.stringify(r.data).slice(0, 400))
  const req = JSON.parse(openai.find((b) => b.includes('SHOPIFY ORDER'))!)
  const sys = req.messages[0].content, user = req.messages[1].content
  assert.match(sys, /CHANNEL: Saisales\.co\.uk/); assert.match(user, /SHOPIFY ORDER \(Saisales\.co\.uk\)/); assert.match(user, /#1201/); assert.match(user, /XM000000001GB/)
  for (const pii of ['Bloggs', 'jo.bloggs@', 'Mill Lane', 'LS1 4AB']) assert.ok(!user.includes(pii), `model input contains ${pii}`)
  assert.equal(gql.length, before, 'drafting reads the stored facts, no Shopify call')
  step('the model gets the Saisales overlay and the order summary, and no surname, email or address')
  const draft = r.data.draft ?? r.data
  assert.equal(draft.check_result, 'PASS', JSON.stringify(draft.server_findings))
  step(`draft PASSes the checks (${draft.check_result})`)

  console.log('4. Send')
  r = await api('POST', `/api/drafts/${draft.id}/send`, { confirm_text: draft.draft_text, seen_new_messages: true })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const raw = rawOf(sentMail.length - 1)
  assert.match(raw, /^From: Saisales Customer Support <info@saisales\.co\.uk>/m); assert.match(raw, /^To: jo\.bloggs@example\.com/m)
  assert.equal(sentMail[sentMail.length - 1].threadId, 't2')
  const [om] = await sql`SELECT sender FROM messages WHERE case_id = ${jo.id} AND direction = 'outbound' ORDER BY id DESC LIMIT 1`
  assert.equal(om.sender, 'Saisales Support (Kuldeep)')
  step('sent from the Saisales mailbox as "Saisales Customer Support <info@saisales.co.uk>", on the customer\'s thread')

  console.log('5. Refunds')
  r = await api('POST', `/api/shopify/cases/${jo.id}/refund`, { amount: 20, confirm_amount: 20, reason: 'goodwill' }); assert.equal(r.status, 403)
  r = await api('POST', `/api/shopify/cases/${jo.id}/refund`, { amount: 10, confirm_amount: 12, reason: 'goodwill' }); assert.equal(r.status, 409)
  r = await api('POST', `/api/shopify/cases/${jo.id}/refund`, { amount: 10, confirm_amount: 10, reason: '' }); assert.equal(r.status, 400)
  assert.equal(order.refunds.length, 0); step('agent: £20 refused (manager only), mismatched confirmation and missing reason refused, nothing refunded')
  const key = '0f9c1b5e-1111-4a2b-9c3d-abcdefabcdef'
  r = await api('POST', `/api/shopify/cases/${jo.id}/refund`, { amount: 10, confirm_amount: 10, reason: 'goodwill for slow charging', key }); assert.equal(r.status, 200, JSON.stringify(r.data))
  const call = gql.find((g) => g.query.includes('refundCreate'))!
  assert.equal(call.variables.key, key); assert.deepEqual(call.variables.input.transactions, [{ orderId: order.id, gateway: 'shopify_payments', kind: 'REFUND', amount: '10.00', parentId: 'gid://shopify/OrderTransaction/77' }])
  assert.equal(call.variables.input.notify, false)
  const [k1] = await sql`SELECT refund_issued, shopify_order FROM cases WHERE id = ${jo.id}`; assert.equal(k1.refund_issued, true); assert.equal(k1.shopify_order.refunded, '10.00')
  const [act] = await sql`SELECT kind, status, amount, created_by FROM shopify_actions WHERE kind = 'refund'`; assert.equal(act.status, 'done'); assert.equal(Number(act.amount), 10); assert.equal(act.created_by, kul.id)
  step('agent £10: refundCreate with idempotency key, to the original payment, no Shopify email; case marked refunded; audited')
  r = await api('POST', `/api/shopify/cases/${jo.id}/refund`, { amount: 10, confirm_amount: 10, reason: 'goodwill for slow charging', key }); assert.equal(r.status, 409)
  assert.equal(order.refunds.length, 1); step('the same confirmation pressed twice refunds once')
  await login(mgr.id)
  r = await api('POST', `/api/shopify/cases/${jo.id}/refund`, { amount: 400, confirm_amount: 400, reason: 'full' }); assert.equal(r.status, 422); assert.match(r.data.error, /more than can be refunded/)
  step('manager: more than what is left (£339) is refused')

  console.log('6. Returns')
  await login(kul.id)
  r = await api('POST', `/api/shopify/cases/${jo.id}/returns`, { lines: [{ fulfillment_line_item_id: 'gid://shopify/FulfillmentLineItem/5', quantity: 2 }] }); assert.equal(r.status, 422)
  r = await api('POST', `/api/shopify/cases/${jo.id}/returns`, { lines: [{ fulfillment_line_item_id: 'gid://shopify/FulfillmentLineItem/5', quantity: 1 }], note: 'not charging' }); assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.return.name, '#1201-R1'); step('return opened (asking for more than was shipped is refused)')
  r = await api('POST', `/api/shopify/cases/${jo.id}/returns/label`, { return_id: 'gid://shopify/Return/1', pdf_base64: Buffer.from('not a pdf').toString('base64') }); assert.equal(r.status, 400)
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(400, 32)]).toString('base64')
  r = await api('POST', `/api/shopify/cases/${jo.id}/returns/label`, { return_id: 'gid://shopify/Return/1', pdf_base64: pdf, filename: 'label.pdf', tracking_number: 'rt123456789gb', notify_customer: false }); assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(uploads, 1); step('label: non-PDF refused; PDF uploaded to Shopify and attached with tracking RT123456789GB, customer not emailed')
  r = await api('POST', `/api/shopify/cases/${jo.id}/returns/process`, { return_id: 'gid://shopify/Return/1', note: 'received, IMEI matches' }); assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(order.returns.nodes[0].status, 'CLOSED')
  const kinds = (await sql`SELECT kind, status FROM shopify_actions ORDER BY id`).map((x: any) => `${x.kind}:${x.status}`)
  assert.deepEqual(kinds, ['refund:done', 'return_open:done', 'return_label:done', 'return_process:done'])
  const notes = (await sql`SELECT body FROM messages WHERE case_id = ${jo.id} AND kind = 'event' ORDER BY id`).map((x: any) => x.body)
  assert.ok(notes.some((b: string) => /Refund of £10\.00 issued on Shopify/.test(b)) && notes.some((b: string) => /Return #1201-R1 opened/.test(b)))
  step('phone received closes the return; every step audited and noted on the case timeline')

  console.log('7. Invoice prefill')
  r = await api('GET', `/api/invoices/prefill?case_id=${jo.id}`); assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.sales_channel, 'Saisales.co.uk'); assert.equal(r.data.buyer_name, 'Jo Bloggs'); assert.match(r.data.buyer_address, /12 Mill Lane/); assert.equal(r.data.order.items[0].unitPrice, '349.00')
  step('invoice generator pre-filled from Shopify with the full billing address')

  console.log('\nAll Shopify end-to-end checks passed.')
}

main().then(() => sql.end().then(() => process.exit(0)), async (e) => { console.error('\nFAILED:', e); await sql.end(); process.exit(1) })
