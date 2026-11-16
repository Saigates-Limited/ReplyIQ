// Outgoing reply with files: MIME structure, and the Amazon file rules on the send route.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendReply } from '../src/gmail'
import { parseOutgoingAttachments } from '../src/attachments'

const pdf = Buffer.from('%PDF-1.4 test label').toString('base64')

test('reply with a PDF is multipart/mixed with the text first and the file after', async () => {
  let raw = ''
  const orig = globalThis.fetch
  globalThis.fetch = (async (_u: any, init: any) => {
    raw = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8')
    return new Response(JSON.stringify({ id: 'm1', threadId: 't1' }), { status: 200 })
  }) as any
  try {
    await sendReply('tok', { from: 'a@x', to: 'b@marketplace.amazon.co.uk', subject: 'Re: Return £', body: 'Hi Christopher,\n\nLabel attached.', threadId: 't1',
      attachments: [{ filename: 'label.pdf', mimeType: 'application/pdf', base64: pdf }] })
  } finally { globalThis.fetch = orig }
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="=_riqm_/)
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="=_riq_/)
  assert.ok(raw.indexOf('text/plain') < raw.indexOf('application/pdf'))
  assert.match(raw, /Content-Disposition: attachment; filename="label.pdf"/)
  assert.ok(raw.includes(pdf))
})

test('reply without files keeps the old multipart/alternative shape', async () => {
  let raw = ''
  const orig = globalThis.fetch
  globalThis.fetch = (async (_u: any, init: any) => { raw = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8'); return new Response('{"id":"m","threadId":"t"}') }) as any
  try { await sendReply('tok', { from: 'a@x', to: 'b@x', subject: 's', body: 'hi', threadId: 't' }) } finally { globalThis.fetch = orig }
  assert.match(raw, /^From:[^\n]*\r\nTo:[^\n]*\r\nSubject:[^\n]*\r\nMIME-Version: 1.0\r\nContent-Type: multipart\/alternative/)
  assert.ok(!raw.includes('multipart/mixed'))
})

test('file rules', () => {
  assert.deepEqual(parseOutgoingAttachments(undefined), { list: [] })
  const ok: any = parseOutgoingAttachments([{ filename: 'a.pdf', mime_type: 'application/pdf', base64: pdf }])
  assert.equal(ok.list[0].size, Buffer.from(pdf, 'base64').length)
  assert.ok('error' in parseOutgoingAttachments([{ filename: 'a.exe', mime_type: 'application/x-msdownload', base64: pdf }]))
  assert.ok('error' in parseOutgoingAttachments(Array.from({ length: 6 }, () => ({ filename: 'a.pdf', mime_type: 'application/pdf', base64: pdf }))))
  assert.ok('error' in parseOutgoingAttachments([{ filename: 'a.pdf', mime_type: 'application/pdf', base64: 'not base64!' }]))
  const big = Buffer.alloc(8 * 1024 * 1024).toString('base64')
  assert.ok('error' in parseOutgoingAttachments([{ filename: 'a.pdf', mime_type: 'application/pdf', base64: big }]))
  const odd: any = parseOutgoingAttachments([{ filename: 'x"\r\n.pdf', mime_type: 'application/pdf', base64: pdf }])
  assert.ok(!/["\r\n]/.test(odd.list[0].filename))
})
