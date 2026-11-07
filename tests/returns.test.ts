// Unit tests: IMEI, return rules, sheet import clean-up, refund-initiated parser (2 samples + partial).
// Run: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkImei, imeiCheckDigit, luhnOk, normaliseImei } from '../src/returns/imei'
import { evaluateItem, isOverdue, daysSince, canMove } from '../src/returns/rules'
import { parseCsv, cleanRow, normaliseSku, matchSku, mapCable, mapReason, mapOutcome, parseUkDate, dateFromNotes } from '../src/returns/importer'
import { parseRefundInitiated, classifyRefundNotice, stripBuyerName, isPartialRefund } from '../src/returns/refundParser'

// ───────── IMEI ─────────
const validImei = (prefix14: string) => prefix14 + imeiCheckDigit(prefix14)

test('IMEI: Luhn accepts a valid 15-digit IMEI and rejects a typo', () => {
  const good = validImei('35487028857015')
  assert.equal(good.length, 15)
  assert.ok(luhnOk(good))
  const typo = good.slice(0, 14) + String((Number(good[14]) + 1) % 10)
  assert.equal(luhnOk(typo), false)
  assert.deepEqual(checkImei(good), { ok: true, imei: good })
})

test('IMEI: spreadsheet-mangled number is rejected, not truncated', () => {
  const r = checkImei('354,870,288,570,151,000')
  assert.equal(r.ok, false)
  if (!r.ok) { assert.match(r.reason, /18 digits/); assert.match(r.reason, /spreadsheet/) }
  assert.equal(normaliseImei(' 3548 7028 8570 151 '), '354870288570151')
  assert.equal(checkImei('').ok, false)
  assert.equal(checkImei('12345').ok, false)
})

// ───────── Rules ─────────
test('Rules: cable + reason combinations', () => {
  const com = evaluateItem({ cable: 'not_returned', reason_category: 'change_of_mind' })
  assert.equal(com.needsManager, true); assert.match(com.managerReasons.join(), /partial refund/i)
  const faulty = evaluateItem({ cable: 'not_returned', reason_category: 'faulty' })
  assert.equal(faulty.needsManager, false); assert.match(faulty.flags.join(), /restock/i)
  const burnt = evaluateItem({ cable: 'damaged', reason_category: 'faulty' })
  assert.equal(burnt.batteryFlag, true); assert.equal(burnt.needsManager, true)
})

test('Rules: battery words, FRP lock, partial refund threshold', () => {
  assert.equal(evaluateItem({ fault_found: 'Phone gets very hot when charging' }).batteryFlag, true)
  assert.equal(evaluateItem({ notes: 'battery swollen under screen' }).batteryFlag, true)
  assert.equal(evaluateItem({ fault_found: 'Hotspot not working' }).batteryFlag, false, '"Hotspot" must not trigger')
  assert.equal(evaluateItem({ frp_lock: true }).startActivationLock, true)
  assert.equal(evaluateItem({ outcome: 'partial_refund', refund_amount: 15 }).needsManager, false)
  assert.equal(evaluateItem({ outcome: 'partial_refund', refund_amount: '15.01' }).needsManager, true)
})

test('Rules: overdue after 2 UK working days without outcome; days-since computed', () => {
  // Friday 2026-10-16 10:00 received → Tue 2026-10-20 is 2 working days later
  const received_at = '2026-10-16T10:00:00Z'
  assert.equal(isOverdue({ status: 'received', received_at }, new Date('2026-10-19T12:00:00Z')), false) // Monday = 1 wd
  assert.equal(isOverdue({ status: 'received', received_at }, new Date('2026-10-20T12:00:00Z')), true)
  assert.equal(isOverdue({ status: 'outcome_agreed', received_at }, new Date('2026-11-20T12:00:00Z')), false)
  assert.equal(isOverdue({ status: 'expected', received_at: null }, new Date()), false)
  const d = daysSince({ order_date: '2026-10-01', delivery_date: '2026-10-03' }, new Date('2026-10-13T12:00:00Z'))
  assert.equal(d.days_since_order, 12); assert.equal(d.days_since_delivery, 10)
  assert.equal(canMove('expected', 'received'), true); assert.equal(canMove('expected', 'closed'), false); assert.equal(canMove('inspected', 'received'), true)
})

// ───────── Import clean-up ─────────
test('Import: SKU normalisation and exact matching only', () => {
  const known = new Set(['I13-128-MDT-A', 'I15-128-PNK-A'])
  assert.equal(normaliseSku(': I13-128-MDT-A-AMZ'), 'I13-128-MDT-A')
  assert.equal(normaliseSku('  I15-128-PNK-A-AMAZON iPhone 15'), 'I15-128-PNK-A')
  assert.equal(normaliseSku('I15-128-PNK-A-AAMZ'), 'I15-128-PNK-A')
  assert.equal(normaliseSku('I15-128-PNK-A-AMZ1'), 'I15-128-PNK-A')
  assert.equal(matchSku('I13-128-MDT-A', known), 'I13-128-MDT-A')
  assert.equal(matchSku('I13-128-MDT-B', known), null, 'no guessing')
})

test('Import: value maps (cable, reason, outcome, dates, notes date)', () => {
  assert.equal(mapCable('cable'), 'returned'); assert.equal(mapCable('CABLE'), 'returned')
  assert.equal(mapCable('n-cable'), 'not_returned'); assert.equal(mapCable('none'), 'not_returned'); assert.equal(mapCable('NONE'), 'not_returned')
  assert.equal(mapCable('burn cable'), 'damaged'); assert.equal(mapCable('RTS'), 'not_applicable')
  assert.equal(mapReason('Esthetic'), 'cosmetic'); assert.equal(mapReason('COM'), 'change_of_mind'); assert.equal(mapReason('RTS'), 'returned_to_sender')
  assert.equal(mapOutcome('Replace'), 'replacement'); assert.equal(mapOutcome('Resend'), 'resend'); assert.equal(mapOutcome('Refund'), 'refund')
  assert.equal(parseUkDate('06/01/2026'), '2026-01-06'); assert.equal(parseUkDate('6/1/26'), '2026-01-06'); assert.equal(parseUkDate('2026-01-06'), '2026-01-06')
  assert.equal(dateFromNotes('RPL SENT 06/01/2026 via DPD'), '2026-01-06'); assert.equal(dateFromNotes('customer happy'), null)
})

test('Import: a full sheet row → clean row + review list; wrong-column values move to Notes', () => {
  const csv = [
    'Order Date,Date of Return,Days since order,Marketplace,Customer Name,Order ID,Item details,Reason,cable,Solution agreed,FRP,Resolution,Notes,IMEI NO,SUPPLIER CODE,CMS REFUND TICKET NUMBER,COMPENSATION NUMBER/INVOICE',
    '12/09/2026,02/10/2026,20,Amazon.co.uk,Jane Doe,205-1900538-4667561,: I15-128-PNK-A-AMZ1,COM,n-cable,Replace,No,TRUE,RPL SENT 06/10/2026,"354,870,288,570,151,000",RPL,special 10.25,INV-77',
    `01/09/2026,,,Amazon.co.uk,,026-9630916-1793908,I13-128-MDT-A-AMZ,Faulty,cable,Refund,Yes,TRUE,,${validImei('35487028857015')},SW001,123456789,`,
  ].join('\n')
  const rows = parseCsv(csv)
  assert.equal(rows.length, 2)
  const known = new Set(['I15-128-PNK-A', 'I13-128-MDT-A']), sup = new Set(['SW001', 'RT001'])
  const a = cleanRow(rows[0], 2, known, sup)
  assert.equal(a.order_id, '205-1900538-4667561'); assert.equal(a.order_date, '2026-09-12'); assert.equal(a.return_date, '2026-10-02')
  assert.equal(a.sku, 'I15-128-PNK-A'); assert.equal(a.reason, 'change_of_mind'); assert.equal(a.cable, 'not_returned'); assert.equal(a.outcome, 'replacement'); assert.equal(a.frp, false)
  assert.equal(a.imei, null); assert.ok(a.review.some((r) => r.field === 'IMEI NO' && /18 digits/.test(r.reason)))
  assert.equal(a.supplier_code, null); assert.ok(a.review.some((r) => r.field === 'SUPPLIER CODE' && /moved to Notes/.test(r.reason)))
  assert.equal(a.cms_ticket, null); assert.ok(a.review.some((r) => r.field === 'CMS REFUND TICKET NUMBER'))
  assert.match(a.notes!, /Supplier code column said: RPL/); assert.match(a.notes!, /CMS ticket column said: special 10.25/); assert.match(a.notes!, /^RPL SENT 06\/10\/2026/)
  assert.equal(a.replacement_sent_on, '2026-10-06'); assert.equal(a.compensation_ref, 'INV-77')
  assert.ok(!('Resolution' in a), 'Resolution column is not imported')
  const b = cleanRow(rows[1], 3, known, sup)
  assert.equal(b.review.length, 0, JSON.stringify(b.review)); assert.equal(b.sku, 'I13-128-MDT-A'); assert.equal(b.frp, true); assert.equal(b.supplier_code, 'SW001'); assert.equal(b.cms_ticket, '123456789'); assert.ok(b.imei)
})

// ───────── Refund initiated ─────────
const SAMPLE_1 = `Hello,

We initiated a refund of GBP 359.00 to Alex Example for order 205-1900538-4667561 on 4 November 2026.

Order ID: 205-1900538-4667561
Refund details:
Item name: Apple iPhone 15 128GB Pink (Renewed)
ASIN: B0CW114X7P
SKU: I15-128-PNK-A-AMZ1
Return quantity: 1
Item price refund: GBP 359.00
Outbound delivery cost refund: GBP 0.00
Refund reason: Buyer Cancelled

Sincerely,
Amazon Services Europe`

const SAMPLE_2 = `We initiated a refund of GBP 223.00 to Sam Example for order 026-9630916-1793908.
Reference: SPC-EUAmazon-2128656218003830

Item: Apple iPhone 13 128GB Midnight (Renewed)  ASIN: B09MGFJK73
Seller SKU: I13-128-MDT-A-AMZ
Quantity: 1
Item price refund: £223.00
Outbound delivery cost refund: £0.00
Reason: Customer Return`

import { readFileSync } from 'node:fs'
import { judgePartial, canonicalReason, validateParsed, typeOk } from '../src/returns/refundParser'
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8')

test('Refund (real layout): labels block then values block — 205 Buyer Cancelled', () => {
  const r = parseRefundInitiated(fx('refund_205_buyer_cancelled.txt'), 'Refund Initiated for Order 205-1900538-4667561')
  assert.equal(r.orderId, '205-1900538-4667561'); assert.equal(r.amount, 359); assert.equal(r.currency, 'GBP')
  assert.equal(r.items.length, 1, JSON.stringify(r.items))
  const it = r.items[0]
  assert.equal(it.name, 'Apple iPhone 15 128GB Pink (Renewed)'); assert.equal(it.asin, 'B0CW114X7P'); assert.equal(it.sku, 'I15-128-PNK-A-AMZ1')
  assert.equal(it.quantity, 1); assert.equal(it.item_refund, 359); assert.equal(it.delivery_refund, 0)
  assert.equal(it.reason, 'Buyer Cancelled'); assert.equal(r.reason, 'Buyer Cancelled'); assert.equal(r.knownReason, true)
})
test('Refund (real layout): 026 Customer Return with SPC ref and £', () => {
  const r = parseRefundInitiated(fx('refund_026_customer_return.txt'), 'Refund Initiated for Order 026-9630916-1793908')
  assert.equal(r.orderId, '026-9630916-1793908'); assert.equal(r.amount, 223); assert.equal(r.spcRef, 'SPC-EUAmazon-2128656218003830')
  assert.equal(r.items[0].sku, 'I13-128-MDT-A-AMZ'); assert.equal(r.items[0].asin, 'B09MGFJK73'); assert.equal(r.items[0].item_refund, 223)
  assert.equal(r.reason, 'Customer Return'); assert.equal(r.knownReason, true)
  // the bug: reason must never be the product name, sku must never be "Return"
  assert.doesNotMatch(r.reason!, /iPhone/); assert.notEqual(r.items[0].sku, 'RETURN')
})
test('Refund (real layout): £0.01 partial — reason still read, amount tiny', () => {
  const r = parseRefundInitiated(fx('refund_203_partial_penny.txt'), 'Refund Initiated for Order 203-6734713-7728355')
  assert.equal(r.amount, 0.01); assert.equal(r.reason, 'Customer Return'); assert.equal(r.items[0].item_refund, 0.01)
})
test('Refund: partial judgement — £0.01, £5.00, £55.59 are partial without an order price; full refund is not', () => {
  assert.equal(judgePartial(0.01, {}).partial, true)
  assert.equal(judgePartial(5, {}).partial, true)
  assert.equal(judgePartial(55.59, {}).partial, true)
  assert.equal(judgePartial(223, {}).partial, null)                                  // unknown price, plausible full amount → undecided
  assert.equal(judgePartial(223, { unitPrice: 223 }).partial, false)
  assert.equal(judgePartial(150, { unitPrice: 223 }).partial, true)
  assert.equal(judgePartial(120, { peerMax: 359 }).partial, true)                     // well below the highest refund for the same item
  assert.equal(judgePartial(340, { peerMax: 359 }).partial, false)
  assert.equal(canonicalReason('buyer canceled.'), 'Buyer Cancelled'); assert.equal(canonicalReason('Goodwill'), 'Goodwill')
})
test('Refund (real layout #114): "Order Item" label — values must NOT shift left', () => {
  // Reconstructed from event #114 (204-3717148-0301107): with "Order Item" unknown the old parser gave
  // sku=ASIN, asin=product name, quantity=13128, item_refund=1, delivery_refund=300.14, reason="0".
  const r = parseRefundInitiated(fx('refund_204_order_item_label.txt'), 'Refund Initiated for Order 204-3717148-0301107')
  const it = r.items[0]
  assert.equal(it.name, 'Apple iPhone 13 Pro, 128GB, Graphite (Renewed)')
  assert.equal(it.asin, 'B09ML6X61Z'); assert.equal(it.sku, 'I13P-128-GRP-A-AMZ'); assert.equal(it.quantity, 1)
  assert.equal(it.item_refund, 300.14); assert.equal(it.delivery_refund, 0); assert.equal(it.reason, 'Customer Return')
  assert.equal(r.amount, 300.14); assert.equal(r.reason, 'Customer Return'); assert.equal(r.knownReason, true)
  assert.deepEqual(validateParsed(r), [])
})
test('Refund: an UNKNOWN label still cannot shift the values (type-aware assignment)', () => {
  const txt = fx('refund_204_order_item_label.txt').replace('Order Item', 'Some Future Label')
  const r = parseRefundInitiated(txt, 'Refund Initiated for Order 204-3717148-0301107')
  const it = r.items[0]
  assert.equal(it.asin, 'B09ML6X61Z'); assert.equal(it.sku, 'I13P-128-GRP-A-AMZ'); assert.equal(it.quantity, 1)
  assert.equal(it.item_refund, 300.14); assert.equal(it.reason, 'Customer Return'); assert.equal(it.name, 'Apple iPhone 13 Pro, 128GB, Graphite (Renewed)')
  assert.deepEqual(validateParsed(r), [])
})
test('Refund: every fixture passes the sanity validator; a shifted result fails it', () => {
  for (const f of ['refund_205_buyer_cancelled.txt', 'refund_026_customer_return.txt', 'refund_203_partial_penny.txt', 'refund_204_order_item_label.txt'])
    assert.deepEqual(validateParsed(parseRefundInitiated(fx(f))), [], f)
  const shifted = { orderId: '204-3717148-0301107', amount: 300.14, currency: 'GBP', spcRef: null, reason: '0', knownReason: false, excerpt: '',
    items: [{ name: null, asin: 'Apple iPhone 13 Pro, 128GB', sku: 'B09ML6X61Z', quantity: 13128, item_refund: 1, delivery_refund: 300.14, reason: '0' }] }
  const w = validateParsed(shifted as any)
  assert.ok(w.length >= 4, w.join('; ')); assert.ok(w.some((x) => /ASIN/.test(x))); assert.ok(w.some((x) => /quantity/.test(x))); assert.ok(w.some((x) => /reason/.test(x)))
  assert.equal(typeOk('asin', 'Apple iPhone'), false); assert.equal(typeOk('quantity', 'I13P-128'), false); assert.equal(typeOk('item_refund', '1'), false); assert.equal(typeOk('reason', '0'), false)
})

test('Refund: delivery refund is 0 (not null) when the email says 0; new reasons canonicalised', () => {
  const r = parseRefundInitiated(fx('refund_204_order_item_label.txt'))
  assert.strictEqual(r.items[0].delivery_refund, 0)
  const noShip = parseRefundInitiated(fx('refund_204_order_item_label.txt').replace('Shipping Refund\n', '').replace('GBP 0.00\n', ''))
  assert.strictEqual(noShip.items[0].delivery_refund, 0, 'defaults to 0 when the line is absent but an item refund exists')
  assert.equal(canonicalReason('Different Item'), 'Different item'); assert.equal(canonicalReason('order not received'), 'Order not received')
  assert.equal(canonicalReason('Goodwill / Return Delivery Cost Refund'), 'Goodwill/Return Delivery Costs Refund')
})

test('Refund: alternating label/value lines also parse', () => {
  const alt = 'We initiated a refund of GBP 100.00 to [buyer] for order 111-1111111-1111111.\nItem name\nPhone A\nASIN\nB0AAAAAAA1\nSKU\nSKU-A\nReturn quantity\n1\nItem price refund\nGBP 100.00\nOutbound delivery cost refund\nGBP 0.00\nRefund reason\nBuyer Cancelled'
  const r = parseRefundInitiated(alt)
  assert.equal(r.items[0].sku, 'SKU-A'); assert.equal(r.items[0].asin, 'B0AAAAAAA1'); assert.equal(r.reason, 'Buyer Cancelled'); assert.equal(r.amount, 100)
})

test('Refund: classify subject + sender', () => {
  assert.equal(classifyRefundNotice('Amazon <donotreply@amazon.com>', 'Refund Initiated for Order 205-1900538-4667561'), true)
  assert.equal(classifyRefundNotice('donotreply@amazon.com', 'Return authorisation notification'), false)
  assert.equal(classifyRefundNotice('someone@example.com', 'Refund Initiated for Order 1'), false)
})

test('Refund: sample 1 (Buyer Cancelled) parses and strips the buyer name', () => {
  const r = parseRefundInitiated(SAMPLE_1, 'Refund Initiated for Order 205-1900538-4667561')
  assert.equal(r.orderId, '205-1900538-4667561'); assert.equal(r.amount, 359); assert.equal(r.currency, 'GBP')
  assert.equal(r.items.length, 1)
  const it = r.items[0]
  assert.equal(it.asin, 'B0CW114X7P'); assert.equal(it.sku, 'I15-128-PNK-A-AMZ1'); assert.equal(it.quantity, 1)
  assert.equal(it.item_refund, 359); assert.equal(it.delivery_refund, 0); assert.equal(it.reason, 'Buyer Cancelled')
  assert.equal(r.reason, 'Buyer Cancelled'); assert.equal(r.knownReason, true); assert.equal(r.spcRef, null)
  assert.doesNotMatch(r.excerpt, /Alex Example/); assert.match(stripBuyerName(SAMPLE_1), /to \[buyer\] for order/)
})

test('Refund: sample 2 (Customer Return, SPC ref, £ symbol)', () => {
  const r = parseRefundInitiated(SAMPLE_2, 'Refund Initiated for Order 026-9630916-1793908')
  assert.equal(r.orderId, '026-9630916-1793908'); assert.equal(r.amount, 223); assert.equal(r.currency, 'GBP')
  assert.equal(r.spcRef, 'SPC-EUAmazon-2128656218003830')
  assert.equal(r.items[0].asin, 'B09MGFJK73'); assert.equal(r.items[0].sku, 'I13-128-MDT-A-AMZ'); assert.equal(r.items[0].item_refund, 223); assert.equal(r.items[0].delivery_refund, 0)
  assert.equal(r.reason, 'Customer Return'); assert.equal(r.knownReason, true)
  assert.doesNotMatch(JSON.stringify(r), /Sam Example/)
})

test('Refund: unknown reason is kept verbatim and flagged; partial detection', () => {
  const r = parseRefundInitiated(SAMPLE_1.replace('Buyer Cancelled', 'Goodwill'))
  assert.equal(r.reason, 'Goodwill'); assert.equal(r.knownReason, false)
  assert.equal(isPartialRefund(359, 359), false)
  assert.equal(isPartialRefund(300, 359), true)
  assert.equal(isPartialRefund(718, 359, 2), false)
  assert.equal(isPartialRefund(null, 359), null)
  const p = parseRefundInitiated(SAMPLE_2.replace('£223.00', '£150.00').replace('GBP 223.00', 'GBP 150.00'))
  assert.equal(p.amount, 150); assert.equal(isPartialRefund(p.items[0].item_refund, 223), true)
})
