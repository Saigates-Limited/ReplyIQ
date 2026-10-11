// Draft generation: builds a PII-minimised payload, calls OpenAI server-side,
// and runs deterministic guardrail checks on the result.
import instructions from '../reply_instructions.md?raw'
import type { Bindings } from './db'

export const MODEL = 'gpt-5.5'

export type CaseRow = {
  id: number
  case_ref: string
  subject: string
  customer_first_name: string
  customer_last_name: string | null
  customer_email: string | null
  customer_phone: string | null
  customer_address: string | null
  order_id: string | null
  device_model: string | null
  delivery_date: string | null
  refund_issued: boolean | null
  a_to_z_open: boolean | null
  in_stock: boolean | null
  approved_repair_price: string | null
  repair_quote_accepted: boolean | null
  tracking_number: string | null
  carrier: string | null
}
export type MessageRow = { direction: 'inbound' | 'outbound'; body: string; sent_at: string }

export type AiResult = {
  tree: string
  draft: string
  staff_notes: string
  needs_manager: boolean
  needs_manager_reason: string
  check: { result: 'PASS' | 'FAIL'; findings: string[] }
}

const yn = (v: boolean | null) => (v === true ? 'yes' : v === false ? 'no' : 'unknown')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// UK street-address line: "<number or Flat x>, <words> <Road|Street|…>" optionally followed by town/postcode
const STREET_TYPES =
  'road|rd|street|st|avenue|ave|lane|ln|drive|dr|close|cl|court|ct|crescent|cres|way|place|pl|square|sq|terrace|gardens|gdns|grove|park|hill|view|walk|row|mews|green|rise|vale|parade|estate|house|flat|apartment'
const STREET_LINE = new RegExp(
  `(?:^|\\n)[ \\t]*(?:(?:flat|apartment|unit|apt)\\s*\\d+[a-z]?,?\\s*)?\\d+[a-z]?(?:\\s*[-/]\\s*\\d+)?[ ,]+[a-z'’. ]{2,40}?\\b(?:${STREET_TYPES})\\b[^\\n]*`,
  'gi'
)
// "<number> <Name> <StreetType>" inline (without a preceding newline)
const STREET_INLINE = new RegExp(`\\b\\d{1,4}[a-z]?\\s+[A-Z][a-z'’]+(?:\\s+[A-Z][a-z'’]+){0,3}\\s+(?:${STREET_TYPES.split('|').map((t) => t[0].toUpperCase() + t.slice(1)).join('|')})\\b[^\\n,.]*`, 'g')

/** Redact known and pattern-matched PII from free text before it leaves the server. */
export function redactPii(text: string, kase: CaseRow): string {
  let out = text
  // Known values for this customer
  const known = [kase.customer_last_name, kase.customer_email, kase.customer_phone, kase.customer_address].filter(
    (v): v is string => !!v && v.trim().length > 1
  )
  for (const v of known) out = out.replace(new RegExp(escapeRe(v), 'gi'), '[redacted]')
  if (kase.customer_address) {
    // Also redact each comma-separated part of the known address (street line, town)
    for (const part of kase.customer_address.split(',').map((p) => p.trim()).filter((p) => p.length > 3))
      out = out.replace(new RegExp(escapeRe(part), 'gi'), '[redacted]')
  }
  if (kase.customer_last_name) {
    out = out.replace(new RegExp(`${escapeRe(kase.customer_first_name)}\\s+${escapeRe(kase.customer_last_name)}`, 'gi'), kase.customer_first_name)
  }
  // Generic patterns
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email redacted]')
  // Any UK-style number: +44 or leading 0, then 9-10 more digits allowing spaces/dashes/brackets
  out = out.replace(/(?:\+44[\s-]?\(?0?\)?|\(?0)\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, '[phone redacted]')
  out = out.replace(STREET_LINE, '\n[address redacted]')
  out = out.replace(STREET_INLINE, '[address redacted]')
  out = out.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g, '[postcode redacted]')
  return out
}

/** Explicit allow-list of what the model may see. Nothing else is included. */
export function buildPayload(kase: CaseRow, messages: MessageRow[]) {
  const daysSinceDelivery = kase.delivery_date
    ? Math.floor((Date.now() - new Date(kase.delivery_date).getTime()) / 86400_000)
    : null
  const caseInput = {
    customer_first_name: kase.customer_first_name,
    subject: redactPii(kase.subject, kase),
    order_id: kase.order_id ?? 'unknown',
    device_model: kase.device_model ?? 'unknown',
    delivery_date: kase.delivery_date ? new Date(kase.delivery_date).toISOString().slice(0, 10) : 'unknown',
    days_since_delivery: daysSinceDelivery ?? 'unknown',
    refund_issued: yn(kase.refund_issued),
    a_to_z_open: yn(kase.a_to_z_open),
    in_stock: yn(kase.in_stock),
    approved_repair_price: kase.approved_repair_price ? `£${kase.approved_repair_price}` : 'none',
    repair_quote_accepted: yn(kase.repair_quote_accepted),
    tracking_number: kase.tracking_number ?? 'none',
    carrier: kase.carrier ?? 'unknown',
  }
  const thread = messages.map((m) => ({
    from: m.direction === 'inbound' ? 'customer' : 'saigates',
    sent_at: new Date(m.sent_at).toISOString().slice(0, 16).replace('T', ' '),
    text: redactPii(m.body, kase).slice(0, 4000),
  }))
  return { caseInput, thread }
}

export async function generateDraft(env: Bindings, kase: CaseRow, messages: MessageRow[]): Promise<{ result: AiResult; payload: ReturnType<typeof buildPayload> }> {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured on the server')
  const payload = buildPayload(kase, messages)
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')

  const userMsg = `CASE INPUT:\n${JSON.stringify(payload.caseInput, null, 2)}\n\nTHREAD (oldest first):\n${payload.thread
    .map((m) => `[${m.from} @ ${m.sent_at}]\n${m.text}`)
    .join('\n\n')}\n\nProduce the JSON object described in section 5.`

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      store: false, // never retain prompts/completions on OpenAI's side
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: userMsg },
      ],
    }),
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`OpenAI error ${res.status}: ${txt.slice(0, 300)}`)
  }
  const data: any = await res.json()
  const content: string = data.choices?.[0]?.message?.content ?? ''
  let parsed: any
  try {
    parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch {
    throw new Error('Model returned invalid JSON')
  }
  const result: AiResult = {
    tree: String(parsed.tree ?? 'other'),
    draft: String(parsed.draft ?? '').trim(),
    staff_notes: String(parsed.staff_notes ?? '').trim(),
    needs_manager: Boolean(parsed.needs_manager),
    needs_manager_reason: String(parsed.needs_manager_reason ?? ''),
    check: {
      result: parsed.check?.result === 'PASS' ? 'PASS' : 'FAIL',
      findings: Array.isArray(parsed.check?.findings) ? parsed.check.findings.map(String) : [],
    },
  }
  if (!result.draft) throw new Error('Model returned an empty draft')
  return { result, payload }
}

export type ServerFinding = { rule: string; severity: 'fail' | 'warn'; detail: string }

/** Paid repair is "approved" only when a manager-approved price exists AND the customer accepted it. */
export const paidRepairApproved = (k: CaseRow) => !!k.approved_repair_price && k.repair_quote_accepted === true

/** Deterministic checks that do not depend on the model's self-assessment. */
export function serverChecks(draft: string, kase: CaseRow): ServerFinding[] {
  const f: ServerFinding[] = []
  const d = draft.toLowerCase()
  const add = (rule: string, severity: 'fail' | 'warn', detail: string) => f.push({ rule, severity, detail })
  const repairOk = paidRepairApproved(kase)

  // ── PII leakage
  if (kase.customer_last_name && d.includes(kase.customer_last_name.toLowerCase())) add('pii', 'fail', 'Draft contains the customer surname')
  if (kase.customer_email && d.includes(kase.customer_email.toLowerCase())) add('pii', 'fail', 'Draft contains the customer email address')
  if (/\b(?:\+44|0)7\d{3}\s?\d{6}\b/.test(draft)) add('pii', 'fail', 'Draft contains a UK mobile number')
  if (kase.customer_address) {
    const street = kase.customer_address.split(',')[0].trim()
    if (street.length > 3 && d.includes(street.toLowerCase())) add('pii', 'fail', 'Draft contains the customer street address')
  }

  // ── Forbidden requests
  if (/\b(photo id|photographic id|passport|driving licence|driver'?s licen[cs]e|proof of (?:id|identity|address))\b/.test(d))
    add('no_id_requests', 'fail', 'Asks for ID or proof of identity/address')
  if (/\b(?:your|the customer'?s)\s+(?:card|bank|payment)\s+details\b|\bcard number\b/.test(d))
    add('no_payment_details', 'fail', 'Asks the customer for their card/bank details')

  // ── Our bank details: ONLY for an approved paid repair the customer has accepted
  const mentionsOurBank = /\b(sort code|account number|account name|bank transfer|iban|payment (?:details|instructions)|pay(?:ment)? (?:by|via) (?:bank|bacs|transfer))\b/.test(d)
  if (mentionsOurBank && !repairOk) {
    const why = !kase.approved_repair_price
      ? 'no approved repair price'
      : kase.repair_quote_accepted !== true
        ? 'customer has not accepted the quote (set "Repair quote accepted" = Yes)'
        : ''
    add('bank_details_repair_only', 'fail', `Bank/payment details are only allowed for an approved paid repair the customer has accepted (${why})`)
  }

  // ── Promises not supported by CASE INPUT
  const promisesRefund =
    /\b(?:we will|we'll|will be|has been|have|i have|i've|i will|i'll)\s+(?:issue|issued|process|processed|arrange|arranged|sent|send)\s+(?:a |the |your )?(?:full |partial )?refund/.test(d) ||
    /\brefund (?:will be|has been|is being) (?:issued|processed|sent)/.test(d)
  if (promisesRefund && kase.refund_issued !== true) add('no_refund_promise', 'fail', 'Promises or confirms a refund but refund_issued is not yes')
  const promisesReplacement = /\b(?:we will|we'll|i will|i'll|has been|have been|will be)\s+(?:send|sent|dispatch|dispatched|ship|shipped)\s+(?:you )?(?:a |the )?replacement/.test(d)
  if (promisesReplacement && kase.in_stock !== true) add('no_replacement_promise', 'fail', 'Promises a replacement but in_stock is not yes')

  // ── Prices
  const priceMentions = (draft.match(/£\s?\d+(?:\.\d{2})?/g) ?? []).filter((p) => !/£\s?15\b/.test(p))
  if (priceMentions.length && !kase.approved_repair_price)
    add('no_unapproved_price', 'warn', `Mentions a price (${priceMentions.join(', ')}) with no approved repair quote`)
  if (kase.approved_repair_price) {
    const approved = Number(kase.approved_repair_price)
    const other = priceMentions.filter((p) => Number(p.replace(/[£\s]/g, '')) !== approved)
    if (other.length) add('price_mismatch', 'warn', `Mentions ${other.join(', ')} which differs from the approved repair price £${approved.toFixed(2)}`)
  }

  // ── Tone / accusations / unsafe advice
  if (/\b(fraud|fraudulent|scam|lying|dishonest|buyer'?s remorse|price[- ]gaming)\b/.test(d)) add('no_accusations', 'fail', 'Contains accusatory language')
  if (/\bwaterproof\b/.test(d)) add('no_waterproof', 'fail', 'Says "waterproof"')
  if (/\b(charge (?:it )?overnight|leave (?:it )?charging overnight|keep (?:it )?charging)\b/.test(d)) add('safety', 'fail', 'Suggests unsafe charging')

  // ── Off-platform dealings (bank transfer for an accepted repair is handled above)
  if (/\b(paypal|outside (?:of )?amazon|off[- ]amazon|direct(?:ly)? (?:from|through) (?:us|our website))\b/.test(d))
    add('on_platform_only', 'fail', 'References off-platform dealings')

  // ── Battery / safety cases: the Royal Mail return label and the UN3481 lithium-battery label are
  //    always allowed (with "stop using and charging"). Flag only if a battery case talks about
  //    posting the device without the UN3481 marking.
  const batteryCase = /\b(battery|swollen|swelling|overheat(?:ing)?|hot|burning smell|smoke|charging)\b/.test(d)
  const mentionsReturnPost = /\b(royal mail|return label|returns? (?:it|the (?:phone|device)|the item)|post(?:ing)? (?:it|the (?:phone|device)) back|send (?:it|the (?:phone|device)) back)\b/.test(d)
  if (batteryCase && mentionsReturnPost && !/un\s?3481/i.test(draft))
    add('un3481_label', 'warn', 'Battery case asks the customer to post the device but does not mention the UN3481 battery label')

  // ── Format
  if (!new RegExp(`\\b${escapeRe(kase.customer_first_name)}\\b`, 'i').test(draft)) add('greeting', 'warn', 'Does not address the customer by first name')
  if (!/saigates customer care/i.test(draft)) add('signoff', 'warn', 'Missing the "Saigates Customer Care" sign-off')
  if ((draft.match(/^\s*[-•*]\s/gm) ?? []).length >= 3) add('prose_not_checklist', 'warn', 'Reads like a checklist (3+ bullet points)')

  return f
}
