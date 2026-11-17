// "The reply says a file is attached" guard (RIQ-1343 went out without its invoice).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { saysFileAttached } from '../src/draftFiles'

test('replies that promise a file', () => {
  for (const t of [
    'Thank you for shopping with us. Here are the attached invoice document(s) for your recent order.',
    'Your prepaid Royal Mail Tracked returns label is attached to this message.',
    'Please find attached your invoice.',
    'Please find the attached label.',
    'We have attached the invoice.',
    "I've attached the label for you.",
    'The invoice has been attached.',
    'We enclose your invoice.',
  ]) assert.ok(saysFileAttached(t), t)
})

test('mentions of what the customer attached are fine', () => {
  for (const t of [
    'Thank you for the attached photos.',
    'Thank you for your message and for sending the photo.',
    'We have checked the photos you attached.',
    'Could you attach a photo of the screen?',
    'Please attach clear photographs of all six sides.',
  ]) assert.ok(!saysFileAttached(t), t)
})
