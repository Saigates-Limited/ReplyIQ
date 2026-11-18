// RIQ-1300: the same reply went out twice, and follow-ups repeated earlier wording ("Is this an AI reply?").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sameReply, overlap, repeatedFromEarlier, repeatFinding } from '../src/sendGuards'

const first = `Dear Rhandee,

Thank you for your message and for sending the photo.

We're sorry to hear the battery is not lasting as expected, especially as the phone is being used so you can track your son on his way home from school. We understand your concern.

We have checked the snapshot provided, and the battery health shown as 83% is above the minimum standard required under Amazon Renewed. We also cannot see anything in the usage information provided that appears alarming or clearly indicates an abnormal battery drain.

We have noted your request for a replacement with a better battery. However, we are unable to send a replacement before receiving and inspecting the original device.

Kind regards,
Customer Support Team`

test('same reply sent from Seller Central is recognised (draft #146)', () => {
  assert.ok(sameReply(first, first))
  // Seller Central copy without greeting/sign-off, small edits
  const copy = first.replace('Dear Rhandee,\n\n', '').replace('\n\nKind regards,\nCustomer Support Team', '').replace('We understand your concern.', '')
  assert.ok(sameReply(first, copy))
})

test('a different follow-up is not "already sent"', () => {
  const later = `Dear Rhandee,\n\nYes, that works. Keep the phone until the new one arrives, then send it back with the return details we sent earlier. We will refund you once it has been received and checked.\n\nKind regards,\nCustomer Support Team`
  assert.ok(!sameReply(later, first))
})

test('Ivan: Amazon copy is mostly inside the draft', () => {
  const draft = 'Hello Ivan,\n\nThank you for shopping with us. Here are the attached invoice document(s) for your recent order.\n\nRegards\nCustomer Support Team'
  const o = overlap('Here are the attached invoice document(s) for your recent order.', draft)
  assert.ok((o.aInB >= 0.8 && o.bInA >= 0.5) || (o.aInB >= 0.95 && o.bInA >= 0.35))
})

test('follow-up that reuses the long phrase is flagged (16:21 reply)', () => {
  const reply = `Dear Rhandee,\n\nThank you for your message.\n\nWe understand this is inconvenient, especially as the phone is being used so you can track your son on his way home from school.\n\nAt this stage, the battery health shown in the photo was 83%, which is above the minimum standard for Amazon Renewed.\n\nKind regards,\nCustomer Support Team`
  const reps = repeatedFromEarlier(reply, [{ body: first, sent_at: '2026-11-16' }])
  assert.equal(reps.length, 1)
  assert.match(reps[0].sentence, /track your son/)
  const f = repeatFinding(reply, [{ direction: 'outbound', body: first, sent_at: '2026-11-16', kind: 'seller_central_copy' }])
  assert.equal(f?.severity, 'warn')
})

test('greeting, thanks and sign-off may repeat', () => {
  const reply = `Dear Rhandee,\n\nThank you for your message and for sending the photo.\n\nIf you need any further help, please let us know.\n\nKind regards,\nCustomer Support Team`
  assert.equal(repeatedFromEarlier(reply, [{ body: first + '\nIf you need any further help, please let us know.', sent_at: 'x' }]).length, 0)
})

test('first reply on a case: nothing to repeat', () => {
  assert.equal(repeatFinding(first, [{ direction: 'inbound', body: 'The battery has been defective', sent_at: 'x', kind: 'message' }]), null)
})
