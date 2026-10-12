// Amazon Buyer-Seller Messaging attachment rules — single source of truth.
// Source: Amazon help "The Buyer-Seller Messaging Service" (PDF, .jpg/.jpeg/.png, XML; message ≤ 10 MB incl.
// attachments) plus the Seller Central compose limit of 5 files. Enforced for every outbound reply regardless of
// whether it is sent from Seller Central or from the connected Gmail mailbox: the Amazon relay filters both.

export const AMAZON_ATTACHMENT_RULES = {
  maxFiles: 5,
  maxMessageBytes: 10 * 1024 * 1024, // 10 MB total message incl. attachments and encoding overhead
  allowed: {
    'application/pdf': ['pdf'],
    'image/jpeg': ['jpg', 'jpeg'],
    'image/png': ['png'],
    'application/xml': ['xml'],
    'text/xml': ['xml'],
  } as Record<string, string[]>,
  allowedLabel: 'PDF, JPG/JPEG, PNG, XML',
}

export type AttachmentMeta = {
  filename: string
  mime_type: string
  size_bytes: number
}

const extOf = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '')

/** Is this a type Amazon's relay will accept? Checks both the MIME type and the extension. */
export function isAllowedType(filename: string, mime: string): boolean {
  const exts = AMAZON_ATTACHMENT_RULES.allowed[mime.toLowerCase().split(';')[0].trim()]
  const ext = extOf(filename)
  if (exts) return exts.includes(ext) || ext === ''
  // Some mail clients send images as application/octet-stream — fall back to the extension
  return ['pdf', 'jpg', 'jpeg', 'png', 'xml'].includes(ext)
}

export type AttachmentCheck = { ok: boolean; problems: string[] }

/**
 * Validate a set of attachments for an outbound message. `bodyText` is counted towards the 10 MB
 * limit; base64 inflates binaries by ~37 %, so that overhead is included.
 */
export function checkAttachments(files: AttachmentMeta[], bodyText = ''): AttachmentCheck {
  const problems: string[] = []
  if (files.length > AMAZON_ATTACHMENT_RULES.maxFiles) problems.push(`Amazon allows at most ${AMAZON_ATTACHMENT_RULES.maxFiles} attachments per message (you have ${files.length})`)
  for (const f of files) {
    if (!isAllowedType(f.filename, f.mime_type)) problems.push(`"${f.filename}" is not an allowed type — Amazon accepts ${AMAZON_ATTACHMENT_RULES.allowedLabel} only`)
    if (f.size_bytes <= 0) problems.push(`"${f.filename}" is empty`)
  }
  const encoded = files.reduce((n, f) => n + Math.ceil(f.size_bytes * 1.37), 0) + new TextEncoder().encode(bodyText).length
  if (encoded > AMAZON_ATTACHMENT_RULES.maxMessageBytes)
    problems.push(`Message would be ${(encoded / 1024 / 1024).toFixed(1)} MB — Amazon's limit is 10 MB including attachments`)
  return { ok: problems.length === 0, problems }
}

// ───────── "Never to OpenAI" guard ─────────
// Attachments are reduced to a count + type list before anything is built for the model, and the
// finished payload is scanned for anything that looks like file content. If a future change ever
// leaks binary/base64/data-URI material into the prompt, generation aborts instead of sending it.

export function attachmentSummaryForModel(files: AttachmentMeta[]): string {
  if (!files.length) return 'none'
  const kinds = files.map((f) => (f.mime_type.startsWith('image/') ? 'photo' : f.mime_type === 'application/pdf' ? 'PDF' : 'file'))
  const counts = kinds.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {})
  return Object.entries(counts).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ') + ' (not shown to you — staff will review them)'
}

const BASE64_RUN = /[A-Za-z0-9+/]{200,}={0,2}/ // 200+ contiguous base64 chars = almost certainly file content
const DATA_URI = /data:[\w.+-]+\/[\w.+-]+;base64,/i
const BINARY_MAGIC = /(?:%PDF-|\xFF\xD8\xFF|\x89PNG|JFIF|Exif)/

export function assertNoAttachmentContent(payload: unknown): void {
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload)
  if (DATA_URI.test(s)) throw new Error('Refusing to call OpenAI: payload contains a data: URI (attachment content)')
  if (BASE64_RUN.test(s)) throw new Error('Refusing to call OpenAI: payload contains a long base64 run (attachment content)')
  if (BINARY_MAGIC.test(s)) throw new Error('Refusing to call OpenAI: payload contains binary file markers')
}
