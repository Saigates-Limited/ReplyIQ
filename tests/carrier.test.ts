// Run: npm run test:unit   (node:test via tsx). Fixtures are real carrier emails with personal details removed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectCarrierIssue } from '../src/carrier/detect'
import { classifyCarrierEmail, extractCaseRefs } from '../src/carrier/classify'
import { findTrackings, normaliseCarrier, carrierOfTracking } from '../src/carrier/carriers'
import { addWorkingDays, workingDaysBetween, endOfLondonDay } from '../src/carrier/workdays'
import { onInbound, onOutbound, displayStatus, onClaimSubmitted, type CarrierCaseRow } from '../src/carrier/engine'
import { compose, type Facts } from '../src/carrier/templates'

const RM_AUTO_ACK = `Reference # 14882087

Thank you for contacting Royal Mail.
We aim to respond within 3 days; however, this may take longer during busy periods. Multiple messages won't speed up our response and may delay our ability to assist you.`

const RM_LOST = `Dear Kuldeep,

Case Number: 14882087
Tracking Reference: JT902500896GB

I've reviewed all internal tracking information available but, unfortunately, there has been no further movement and your item has not reached a location that we are able to contact for further assistance

I apologise for the delay in delivering this item. At this time, we will of course consider a claim for loss compensation, and you should submit your claim at www.royalmail.com/claims

If you require further assistance, please visit our Help and Support Centre at www.royalmail.com/help

Kind Regards,
Brodie

--------------- Original Message ---------------
From: donotreply@royalmail.com
Reference # 14882087
Thank you for contacting Royal Mail.
We aim to respond within 3 days; however, this may take longer during busy periods.`

const RM_HOLDING = `Case Reference #14856287

Good afternoon Kuldeep,

Thank you for your enquiry regarding tracking number XM424652166GB. I am sorry that your customer has not received their item.

I have checked the GPS co-ordinates which have been obtained within close proximity of the delivery address.

I will make enquiries with the Delivery Office to see if further delivery details can be provided.

We will update you once we receive a reply.`

const RM_DELIVERED = `Case Reference #13226550
Thank you for your enquiry about AS306048305GB. The proof of delivery shows the item was delivered to the correct address and signed for by the recipient. We are unable to take any further action.`

const RM_CLAIM_PAID = `We've concluded your claim. Your Reference number is: 14411455
Dear Sagar Patel,
We've now resolved your claim(s) and a summary of the outcome is below.
Tracking number: HZ623769535GB  Amount paid: £155.00`

const DPD_SETTLED = `Your Claim Has Been Settled - CLM-0388557
Parcel 1550 8002 281 032. We have now paid £100.00 to your account.`

test('detects carrier issues in customer messages', () => {
  assert.equal(detectCarrierIssue("Hi, my order still hasn't arrived and it's been a week")?.issue, 'lost')
  assert.equal(detectCarrierIssue('Tracking says delivered but I have not received anything')?.issue, 'delivered_not_received')
  assert.equal(detectCarrierIssue('The box was empty when I opened it, no phone inside')?.issue, 'empty_parcel')
  assert.equal(detectCarrierIssue('The parcel arrived damaged and the box was crushed')?.issue, 'damaged')
  assert.equal(detectCarrierIssue('Where is my order? No updates since Monday')?.issue, 'lost')
  assert.equal(detectCarrierIssue('The battery drains fast, can I return it?'), null)
  assert.equal(detectCarrierIssue('How long does delivery take before I order?'), null)
})

test('finds and normalises tracking numbers', () => {
  const t = findTrackings('RE: Follow-Up - JT902500896GB - Order 203-7672354-9186752 and DPD 1550 3235 785 485')
  assert.deepEqual(t.map((x) => x.tracking).sort(), ['15503235785485', 'JT902500896GB'])
  assert.equal(carrierOfTracking('xm424652166gb'), 'royal_mail')
  assert.equal(normaliseCarrier('Royal Mail Tracked 24'), 'royal_mail')
  assert.equal(normaliseCarrier('DPD UK'), 'dpd')
  // Amazon order ids and UK phone numbers are not tracking numbers
  assert.deepEqual(findTrackings('Order 204-8103591-2625136, call 07456 539261'), [])
})

test('classifies Royal Mail emails', () => {
  const ack = classifyCarrierEmail('donotreply@royalmail.com', 'RE: URGENT - JT902500896GB - Case Reference #14882087', RM_AUTO_ACK)
  assert.equal(ack.kind, 'auto_ack'); assert.deepEqual(ack.caseRefs, ['14882087']); assert.equal(ack.carrier, 'royal_mail')
  const lost = classifyCarrierEmail('business.customer.service@royalmail.com', 'RE: RE: URGENT - JT902500896GB - Case Reference #14882087', RM_LOST)
  assert.equal(lost.kind, 'decision_lost'); assert.deepEqual(lost.trackings, ['JT902500896GB'])
  assert.equal(classifyCarrierEmail('rmserviceteam@royalmail.com', 'RE: Urgent - XM424652166GB', RM_HOLDING).kind, 'holding_reply')
  assert.equal(classifyCarrierEmail('rmserviceteam@royalmail.com', 'RE: AS306048305GB', RM_DELIVERED).kind, 'decision_delivered')
  const paid = classifyCarrierEmail('donotreply@royalmail.com', 'Thanks for Contacting Royal Mail', RM_CLAIM_PAID)
  assert.equal(paid.kind, 'claim_settled'); assert.equal(paid.amount, 155)
  assert.deepEqual(extractCaseRefs('Your Reference number is: 14411455'), ['14411455'])
})

test('classifies DPD settlements', () => {
  const d = classifyCarrierEmail('claims-form@claims.dpdgroup.co.uk', 'Your Claim Has Been Settled - CLM-0388557', DPD_SETTLED)
  assert.equal(d.carrier, 'dpd'); assert.equal(d.kind, 'claim_settled'); assert.equal(d.amount, 100); assert.equal(d.claimRef, 'CLM-0388557')
  assert.deepEqual(d.trackings, ['15508002281032'])
})

test('working days skip weekends and bank holidays (Europe/London)', () => {
  assert.equal(addWorkingDays(new Date('2026-10-09T11:00:00Z'), 3), '2026-10-14') // Fri → Wed
  assert.equal(addWorkingDays(new Date('2026-12-23T10:00:00Z'), 3), '2026-12-30') // skips 25, 26/27 weekend, 28 Dec
  assert.equal(workingDaysBetween(new Date('2026-10-02T09:00:00Z'), new Date('2026-10-12T09:00:00Z')), 6)
  // 23:30 UTC on 31 Oct 2026 (GMT) is still 31 Oct in London; in BST 23:30 UTC is already the next day
  assert.equal(endOfLondonDay('2026-10-14').toISOString(), '2026-10-14T22:59:59.000Z')
  assert.equal(endOfLondonDay('2026-11-14').toISOString(), '2026-11-14T23:59:59.000Z')
})

const row = (over: Partial<CarrierCaseRow> = {}): CarrierCaseRow => ({
  id: 1, carrier: 'royal_mail', tracking: 'JT902500896GB', status: 'to_raise', value: 243, claimed: null, paid: null,
  carrier_refs: [], claim_ref: null, raised_at: null, last_us_at: null, last_carrier_at: null, carrier_reply_type: null, sla_due_at: null, ...over,
})

test('status engine follows the claims-desk rules', () => {
  const sent = new Date('2026-10-09T10:18:00Z')
  const p1 = onOutbound(row(), 'investigation', sent)
  assert.equal(p1.status, 'awaiting_carrier')
  assert.equal(p1.next_due, '2026-10-14')
  const k1 = row({ ...p1, status: 'awaiting_carrier', sla_due_at: p1.sla_due_at!, last_us_at: sent, raised_at: sent } as any)
  // auto-ack does not stop the clock
  const ack = onInbound(k1, 'auto_ack', sent, { caseRefs: ['14940211'] })
  assert.equal(ack.status, undefined); assert.deepEqual(ack.carrier_refs, ['14940211']); assert.equal(ack.carrier_reply_type, 'auto_ack')
  assert.equal(displayStatus(k1, new Date('2026-10-14T20:00:00Z')), 'awaiting_carrier')
  assert.equal(displayStatus(k1, new Date('2026-10-15T08:00:00Z')), 'sla_breach')
  // lost → claim form needed
  assert.equal(onInbound(k1, 'decision_lost', new Date('2026-10-12T09:00:00Z')).status, 'claim_form_needed')
  // claim submitted → 10 working days
  assert.equal(onClaimSubmitted(k1, new Date('2026-10-13T09:00:00Z'), 'C123', 243).next_due, '2026-10-27')
  // part payment
  const paid = onInbound(row({ status: 'claim_submitted', claimed: 243 }), 'claim_settled', new Date('2026-10-20T09:00:00Z'), { amount: 155 })
  assert.equal(paid.status, 'partially_paid'); assert.equal(paid.paid, 155)
  assert.equal(onInbound(row({ status: 'claim_submitted', claimed: 100 }), 'claim_settled', new Date(), { amount: 100 }).status, 'paid')
  assert.equal(onInbound(k1, 'info_request', new Date()).status, 'action_needed')
})

const facts: Facts = {
  carrier: 'royal_mail', tracking: 'OM386686017GB', orderId: 'PO-210-12440920335993639', issue: 'delivered_not_received',
  product: 'Apple iPhone 13 128GB', service: 'Tracked 24', value: 289, postedOn: '2026-09-22', deliveredOn: '2026-09-23', lastScan: null,
  recipientName: 'Test Person', recipientAddress: null, carrierRefs: [], claimRef: null, raisedAt: null, lastUsAt: null, workingDaysWaiting: null,
  carrierAsked: null, claimed: null, staffName: 'Kuldeep Kaur', signature: 'Saigates Ltd',
}

test('templates fill facts and list what is missing', () => {
  const inv = compose('investigation', facts)
  assert.equal(inv.to, 'business.customer.service@royalmail.com')
  assert.match(inv.subject, /marked delivered but not received – OM386686017GB/)
  assert.match(inv.body, /GPS location/)
  assert.match(inv.body, /Kuldeep Kaur\nSaigates Ltd/)
  assert.ok(inv.missing.some((m) => /delivery address/.test(m)))
  const chase = compose('chase', { ...facts, carrierRefs: ['14940211'], lastUsAt: '2026-10-09T10:18:00Z', workingDaysWaiting: 4 })
  assert.match(chase.subject, /Case Reference #14940211/)
  assert.match(chase.body, /after 4 working days/)
  const pack = compose('claim_pack', { ...facts, issue: 'lost' })
  assert.equal(pack.to, null)
  assert.match(pack.body, /Value claimed: £289.00/)
  assert.equal(compose('investigation', { ...facts, carrier: 'fedex' }).missing[0].startsWith('FedEx email address'), true)
})
