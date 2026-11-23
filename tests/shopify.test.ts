// Saisales.co.uk (Shopify): order matching, the non-PII order summary the AI sees, refund rules, returns, contact-form mail,
// and the Saisales-specific reply checks. No network: every Shopify call is exercised through its pure helpers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(`
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export async function resolve(spec, ctx, next) {
  if (spec.endsWith('?raw')) return { url: new URL(spec, ctx.parentURL).href + '?raw', shortCircuit: true }
  return next(spec, ctx)
}
export async function load(url, ctx, next) {
  if (url.endsWith('?raw')) return { format: 'module', source: 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url.slice(0, -4)), 'utf8')), shortCircuit: true }
  return next(url, ctx)
}`))
const shop = await import('../src/shopify')
const ss = await import('../src/saisales')
const ai = await import('../src/ai')
const { channelOf } = await import('../src/autoReply')

// A made-up order in the Admin API shape (same fields as ORDER_FIELDS).
const order: any = {
  id: 'gid://shopify/Order/1', name: '#1201', createdAt: '2026-11-01T10:00:00Z', processedAt: '2026-11-01T09:59:00Z', cancelledAt: null, closed: false,
  displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED', returnStatus: 'NO_RETURN', sourceName: 'web', email: 'jo.bloggs@example.com', currencyCode: 'GBP',
  currentTotalPriceSet: { shopMoney: { amount: '349.00' } }, totalRefundedSet: { shopMoney: { amount: '0.0' } },
  customer: { firstName: 'Jo', lastName: 'Bloggs' },
  shippingAddress: { name: 'Jo Bloggs', address1: '12 Mill Lane', city: 'Leeds', zip: 'LS1 4AB', country: 'United Kingdom' },
  billingAddress: { name: 'Jo Bloggs', address1: '12 Mill Lane', city: 'Leeds', zip: 'LS1 4AB', country: 'United Kingdom' },
  lineItems: { nodes: [{ id: 'gid://shopify/LineItem/9', title: 'Apple iPhone 13 128GB Unlocked', variantTitle: 'Blue / A - Excellent', quantity: 1, originalUnitPriceSet: { shopMoney: { amount: '349.00' } } }] },
  fulfillments: [{ createdAt: '2026-11-02T12:00:00Z', displayStatus: 'DELIVERED', deliveredAt: '2026-11-03T10:00:00Z', trackingInfo: [{ company: 'Royal Mail', number: 'XM000000001GB' }],
    fulfillmentLineItems: { nodes: [{ id: 'gid://shopify/FulfillmentLineItem/5', quantity: 1, lineItem: { title: 'Apple iPhone 13 128GB Unlocked' } }] } }],
  refunds: [], returns: { nodes: [] },
  transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: 'shopify_payments', formattedGateway: 'Shopify Payments', manualPaymentGateway: false }],
}

test('order numbers: normalised and found in customer text', () => {
  assert.equal(shop.normaliseOrderName('1094'), '#1094')
  assert.equal(shop.normaliseOrderName('#1094'), '#1094')
  assert.equal(shop.normaliseOrderName('no number'), null)
  assert.deepEqual(shop.orderRefsInText('Hi, about my order #1094 please'), ['#1094'])
  assert.deepEqual(shop.orderRefsInText('Order number: 1093 arrived damaged'), ['#1093'])
  assert.deepEqual(shop.orderRefsInText('Order no. 1092'), ['#1092'])
  // Phone numbers, IMEIs and prices are not order numbers
  assert.deepEqual(shop.orderRefsInText('IMEI 356789012345678, paid £399.95, call 07700 900123'), [])
})

test('orderFacts: what the AI may see has no name, email, phone or address', () => {
  const f = shop.orderFacts(order)
  assert.equal(f.order, '#1201')
  assert.equal(f.total, '349.00')
  assert.equal(f.items[0].variant, 'Blue / A - Excellent')
  assert.equal(f.shipments[0].tracking, 'XM000000001GB')
  assert.equal(f.shipments[0].delivered, '2026-11-03')
  assert.deepEqual(f.paid_via, ['Shopify Payments'])
  assert.equal(f.channel, 'Saisales.co.uk website')
  const json = JSON.stringify(f)
  for (const pii of ['Bloggs', 'Jo ', 'jo.bloggs', 'Mill Lane', 'LS1 4AB', 'Leeds']) assert.ok(!json.includes(pii), `facts must not contain ${pii}`)
  assert.equal(shop.deliveredDate(order), '2026-11-03')
})

test('refunds: split over the payments, capped at what is refundable', () => {
  const src = [{ gateway: 'shopify_payments', max: 349, parentId: 'gid://shopify/OrderTransaction/1' }]
  const p = shop.splitRefund(15, 349, src)
  assert.ok(!('error' in p)); if ('error' in p) return
  assert.deepEqual(p.transactions, [{ gateway: 'shopify_payments', amount: 15, parentId: 'gid://shopify/OrderTransaction/1' }])
  assert.match((shop.splitRefund(400, 349, src) as any).error, /more than can be refunded/)
  assert.match((shop.splitRefund(0, 349, src) as any).error, /above £0/)
  // Two payments (e.g. gift card + card): largest first
  const two = shop.splitRefund(300, 349, [{ gateway: 'gift_card', max: 49, parentId: 'a' }, { gateway: 'shopify_payments', max: 300, parentId: 'b' }]) as any
  assert.deepEqual(two.transactions.map((t: any) => [t.gateway, t.amount]), [['shopify_payments', 300]])
  const both = shop.splitRefund(320, 349, [{ gateway: 'gift_card', max: 49, parentId: 'a' }, { gateway: 'shopify_payments', max: 300, parentId: 'b' }]) as any
  assert.deepEqual(both.transactions.map((t: any) => [t.gateway, t.amount]), [['shopify_payments', 300], ['gift_card', 20]])
})

test('refunds: agents up to £15, managers any amount', () => {
  assert.equal(shop.refundAllowed('agent', 15).ok, true)
  assert.equal(shop.refundAllowed('agent', 15.01).ok, false)
  assert.equal(shop.refundAllowed('manager', 349).ok, true)
})

test('returns: only shipped lines not already on an open return', () => {
  assert.deepEqual(shop.returnableLines(order).map((l) => [l.fulfillmentLineItemId, l.quantity]), [['gid://shopify/FulfillmentLineItem/5', 1]])
  const withReturn = { ...order, returns: { nodes: [{ id: 'r1', status: 'OPEN', returnLineItems: { nodes: [{ quantity: 1, fulfillmentLineItem: { id: 'gid://shopify/FulfillmentLineItem/5' } }] } }] } }
  assert.deepEqual(shop.returnableLines(withReturn), [])
  const cancelled = { ...order, returns: { nodes: [{ id: 'r1', status: 'CANCELED', returnLineItems: { nodes: [{ quantity: 1, fulfillmentLineItem: { id: 'gid://shopify/FulfillmentLineItem/5' } }] } }] } }
  assert.equal(shop.returnableLines(cancelled).length, 1)
})

test('shop domain from the secret', () => {
  assert.equal(shop.shopDomain({ SHOPIFY_SHOP: 'a6fdb4' } as any), 'a6fdb4.myshopify.com')
  assert.equal(shop.shopDomain({ SHOPIFY_SHOP: 'https://a6fdb4.myshopify.com/admin' } as any), 'a6fdb4.myshopify.com')
  assert.throws(() => shop.shopDomain({ SHOPIFY_SHOP: 'saisales.co.uk' } as any))
})

// ───────── Mail ─────────
const b64 = (s: string) => Buffer.from(s).toString('base64url')
const mail = (headers: Record<string, string>, body: string, id = 'm1'): any => ({
  id, threadId: 't1', internalDate: String(Date.parse('2026-11-23T10:00:00Z')), labelIds: ['INBOX'],
  payload: { mimeType: 'text/plain', headers: Object.entries(headers).map(([name, value]) => ({ name, value })), body: { data: b64(body) } },
})

test('Shopify contact form: customer, order number and message are read from the notification', () => {
  const m = mail({ From: 'Shopify <mailer@shopify.com>', 'Reply-To': 'jo.bloggs@example.com', Subject: 'New customer message on 23 November 2026 at 10:00 am' },
    'You received a new message from your online store\'s contact form.\nCountry Code: GB\nName: Jo Bloggs\nEmail: jo.bloggs@example.com\nPhone Number: \nOrder number: 1201\nComment: Hello, my phone will not charge.\nThanks')
  assert.equal(ss.isContactFormEmail(m), true)
  assert.equal(ss.isAutomated(m), false)
  const c = ss.customerOf(m)
  assert.equal(c.address, 'jo.bloggs@example.com')
  assert.equal(c.name, 'Jo Bloggs')
  assert.match(c.text, /will not charge/)
  assert.equal(c.form?.orderRef, '1201')
})

test('plain email and automated mail', () => {
  const m = mail({ From: '"Jo Bloggs" <Jo.Bloggs@example.com>', Subject: 'Re: Your order #1201' }, 'Is it unlocked?\n\nOn Mon, 23 Nov 2026 at 09:00, Saisales <info@saisales.co.uk> wrote:\n> old text')
  const c = ss.customerOf(m)
  assert.equal(c.address, 'jo.bloggs@example.com')
  assert.equal(c.text, 'Is it unlocked?')
  assert.equal(ss.isAutomated(mail({ From: 'no-reply@royalmail.com' }, 'x')), true)
  assert.equal(ss.isAutomated(mail({ From: 'Shopify <mailer@shopify.com>', Subject: 'Shopify verification code' }, 'x')), true)
  assert.equal(ss.isAutomated(mail({ From: 'news@shop.example', 'List-Unsubscribe': '<mailto:x>' }, 'x')), true)
  assert.equal(ss.isAutomated(mail({ From: 'jo@example.com' }, 'x')), false)
})

test('Gmail query covers every Saisales address and the contact form', () => {
  const q = ss.saisalesQuery(ss.DEFAULT_SAISALES, 'newer_than:1h')
  for (const a of ss.DEFAULT_SAISALES.addresses) assert.ok(q.includes(`to:${a}`) && q.includes(`deliveredto:${a}`))
  assert.ok(q.includes('from:mailer@shopify.com'))
  assert.ok(q.endsWith('newer_than:1h'))
})

// ───────── AI payload and checks ─────────
const kase: any = { id: 1, case_ref: 'RIQ-1', subject: 'Charging problem', customer_first_name: 'Jo', customer_last_name: 'Bloggs', customer_email: 'jo.bloggs@example.com',
  customer_phone: null, customer_address: null, order_id: '#1201', device_model: 'Apple iPhone 13 128GB Unlocked', delivery_date: '2026-11-03', delivery_date_source: 'shopify_delivered',
  refund_issued: null, a_to_z_open: null, in_stock: null, approved_repair_price: null, repair_quote_accepted: null, tracking_number: 'XM000000001GB', carrier: 'Royal Mail',
  channel: 'shopify', shopify_order: shop.orderFacts(order) }

test('buildPayload: Saisales cases carry the order summary, never the customer details', () => {
  const p: any = ai.buildPayload(kase, [{ direction: 'inbound', body: 'Hi, I am Jo Bloggs, jo.bloggs@example.com. My phone will not charge.', sent_at: '2026-11-23T10:00:00Z' }])
  assert.equal(p.caseInput.sales_channel, 'Saisales.co.uk (our own website)')
  assert.equal(p.caseInput.delivery_date_basis, 'confirmed by courier tracking (Shopify)')
  assert.equal(p.shopifyOrder.order, '#1201')
  const json = JSON.stringify(p)
  assert.ok(!json.includes('Bloggs') && !json.includes('jo.bloggs@'))
  const amazon: any = ai.buildPayload({ ...kase, channel: 'amazon', shopify_order: null }, [])
  assert.equal('shopifyOrder' in amazon, false)
  assert.equal((ai.buildPayload({ ...kase, shopify_order: null }, []) as any).shopifyOrder, 'none matched')
})

test('system prompt: the Saisales overlay only for Saisales cases', () => {
  assert.match(ai.assembleSystemPrompt(null, [], 'shopify'), /CHANNEL: Saisales\.co\.uk/)
  assert.doesNotMatch(ai.assembleSystemPrompt(null, [], 'amazon'), /CHANNEL: Saisales\.co\.uk/)
  assert.doesNotMatch(ai.assembleSystemPrompt(null, [], 'shopify'), /statutory rights? (?:apply|are)/i)
})

test('serverChecks: Saisales replies may mention our website, never Amazon', () => {
  const reply = (s: string) => `Dear Jo,\n\n${s}\n\nKind regards,\nCustomer Support Team`
  const rules = (t: string, k = kase) => ai.serverChecks(reply(t), k).map((f) => f.rule)
  assert.ok(!rules('You can see the order on our website.').includes('off_platform'))
  assert.ok(rules('You can see the order on our website.', { ...kase, channel: 'amazon' }).includes('off_platform'))
  assert.ok(rules('Please start the return through Amazon.').includes('saisales_amazon'))
  assert.ok(!rules('Please start the return through Amazon.', { ...kase, channel: 'amazon' }).includes('saisales_amazon'))
  assert.ok(rules('Your statutory rights are not affected.').includes('never_statutory_rights'))
})

test('closed-day replies recognise Saisales cases', () => {
  assert.equal(channelOf({ channel: 'shopify', customer_reply_to: 'jo@example.com' }), 'shopify')
  assert.equal(channelOf({ customer_reply_to: 'abc@marketplace.amazon.co.uk' }), 'amazon')
  assert.equal(channelOf({ customer_reply_to: 'jo@example.com' }), null)
})
