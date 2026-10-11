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
  lane: string
  draft: string
  staff_notes: string
  needs_manager: boolean
  urgency: 'high' | 'normal' | 'low'
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
    atoz_open: yn(kase.a_to_z_open),
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
    .join('\n\n')}\n\nReturn the JSON object described under "## Output" and nothing else.`

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
  const urgency = ['high', 'normal', 'low'].includes(parsed.urgency) ? parsed.urgency : 'normal'
  const result: AiResult = {
    lane: String(parsed.lane ?? 'unspecified').slice(0, 120),
    draft: String(parsed.reply ?? parsed.draft ?? '').trim(),
    staff_notes: String(parsed.staff_notes ?? '').trim(),
    needs_manager: Boolean(parsed.needs_manager),
    urgency,
  }
  if (!result.draft) throw new Error('Model returned an empty draft')
  return { result, payload }
}

export type ServerFinding = { rule: string; severity: 'fail' | 'warn'; detail: string }

/** Paid repair: bank details are allowed only when a price is approved AND the customer accepted it. */
export const paidRepairApproved = (k: CaseRow) => !!k.approved_repair_price && k.repair_quote_accepted === true

const escapeReLocal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Deterministic checks mirroring the "Never" list and the conditional rules in
 * reply_instructions.md. Anything the file allows is allowed here.
 * A `fail` blocks approval; a `warn` is shown to the agent only.
 */
export function serverChecks(draft: string, kase: CaseRow): ServerFinding[] {
  const f: ServerFinding[] = []
  const d = draft.toLowerCase()
  const add = (rule: string, severity: 'fail' | 'warn', detail: string) => f.push({ rule, severity, detail })

  // ── PII must never appear in a reply
  if (kase.customer_last_name && d.includes(kase.customer_last_name.toLowerCase())) add('pii', 'fail', 'Contains the customer surname')
  if (kase.customer_email && d.includes(kase.customer_email.toLowerCase())) add('pii', 'fail', 'Contains the customer email address')
  if (/(?:\+44[\s-]?\(?0?\)?|\(?0)\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/.test(draft) && !paidRepairApproved(kase))
    add('pii', 'fail', 'Contains a phone number')
  if (kase.customer_address) {
    const street = kase.customer_address.split(',')[0].trim()
    if (street.length > 3 && d.includes(street.toLowerCase())) add('pii', 'fail', 'Contains the customer street address')
  }

  // ── Never ask for: PIN, passcode, verification code, Apple ID password, phone number, email address, ID document, or to call us
  const asks = (re: RegExp) => re.test(d)
  // Only fire when the draft *requests* a credential, not when it says "never share your password".
  const credWord = '(?:pin|passcode|pass code|verification code|one[- ]time code|otp|apple id password|icloud password|password)'
  if (
    asks(new RegExp(`\\b(?:send|share|provide|give|tell|confirm|enter|type|let us know|what is|what's)\\b[^.\\n]{0,40}\\b(?:your |the )?${credWord}\\b`)) &&
    !asks(new RegExp(`\\b(?:never|do not|don't|not) (?:share|send|give|provide|tell)\\b[^.\\n]{0,30}${credWord}`))
  )
    add('never_ask_credentials', 'fail', 'Asks for a PIN, passcode, verification code or password')
  if (asks(/\b(your|a|best|contact) (phone|mobile|telephone|contact) number\b|\bnumber (?:we|i) can (?:call|reach)\b/))
    add('never_ask_phone', 'fail', 'Asks for the customer phone number')
  if (asks(/\b(your|an?) email address\b|\bemail (?:us|me) (?:at|on)\b/))
    add('never_ask_email', 'fail', 'Asks for an email address')
  if (asks(/\b(photo id|photographic id|passport|driving licence|driver'?s licen[cs]e|proof of (?:id|identity|address)|id document|identification)\b/))
    add('never_ask_id', 'fail', 'Asks for an ID document')
  if (asks(/\b(give us a call|call us|phone us|ring us|call our (?:team|office|line)|telephone us)\b/))
    add('never_ask_call', 'fail', 'Asks the customer to call us')

  // ── Never refuse a return
  if (asks(/\b(cannot|can't|unable to|won't|will not|not able to|do not|don't) (?:accept|take|process|offer|authori[sz]e) (?:a |the |your |this )?return\b|\breturn (?:is|will be|has been) (?:refused|declined|rejected)\b|\bno returns?\b/))
    add('never_refuse_return', 'fail', 'Refuses a return')

  // ── Never say "waterproof"
  if (/\bwaterproof\b/.test(d)) add('never_waterproof', 'fail', 'Says "waterproof"')

  // ── Never say a refund has been issued unless refund_issued = Yes
  if (/\brefund (?:has been|was|is|has now been) (?:issued|processed|sent|made|completed)\b|\b(?:have|we've|i've) (?:now )?(?:issued|processed) (?:a |the |your )?(?:full |partial )?refund\b/.test(d) && kase.refund_issued !== true)
    add('never_refund_issued', 'fail', 'Says a refund has been issued but refund_issued is not Yes')

  // ── Never mention reviews/feedback in exchange for anything (any mention of reviews is flagged)
  if (/\b(review|feedback|star rating|5[- ]star|five[- ]star)\b/.test(d)) add('never_reviews', 'fail', 'Mentions reviews or feedback')

  // ── Never "no rights" / "no claim"
  if (/\bno (?:legal )?rights?\b|\bno (?:valid )?claim\b|\bnot entitled\b/.test(d)) add('never_no_rights', 'fail', 'Tells the customer they have no rights / no claim')

  // ── Bank details only for an approved, accepted paid repair
  const mentionsBank = /\b(sort code|account number|account name|iban|bank transfer|bacs|bank details|payment details|transfer the payment|make the payment)\b/.test(d)
  if (mentionsBank && !paidRepairApproved(kase)) {
    const why = !kase.approved_repair_price ? 'no approved repair price' : 'repair quote not marked as accepted'
    add('bank_details_repair_only', 'fail', `Gives bank/payment details outside an approved, accepted paid repair (${why})`)
  }

  // ── Paid repair price only if approved_repair_price is set; must match
  // Refund/goodwill amounts are handled by the £15 rule below; other prices (repair quotes) need approval.
  const refundAmountSet = new Set(
    [...draft.matchAll(/(?:refund|credit|goodwill|compensation)[^£\n]{0,40}£\s?(\d+(?:\.\d{2})?)|£\s?(\d+(?:\.\d{2})?)[^\n]{0,30}(?:refund|credit|goodwill|compensation)/gi)].map((m) => Number(m[1] ?? m[2]))
  )
  const prices = (draft.match(/£\s?\d+(?:\.\d{2})?/g) ?? []).map((p) => Number(p.replace(/[£\s]/g, '')))
  const nonSmall = prices.filter((p) => p > 15 && !refundAmountSet.has(p))
  if (nonSmall.length && !kase.approved_repair_price) add('price_unapproved', 'fail', `Quotes ${nonSmall.map((p) => '£' + p.toFixed(2)).join(', ')} but no approved repair price is set`)
  if (kase.approved_repair_price) {
    const approved = Number(kase.approved_repair_price)
    const other = nonSmall.filter((p) => p !== approved)
    if (other.length) add('price_mismatch', 'warn', `Mentions ${other.map((p) => '£' + p.toFixed(2)).join(', ')} which differs from the approved £${approved.toFixed(2)}`)
  }

  // ── Refunds above £15 need a manager (warn: the needs_manager flag is enforced separately)
  if ([...refundAmountSet].some((a) => a > 15)) add('refund_over_15', 'warn', 'Offers a refund above £15 — manager approval required')

  // ── Battery: stop using/charging is mandatory; RM label + UN3481 are expected and allowed
  const batteryCase = /\b(battery|batteries|swollen|swelling|bulging|overheat(?:ing|s)?|very hot|too hot|burning smell|smoke|smoking)\b/.test(d)
  if (batteryCase) {
    if (!/\bstop (?:using|charging)\b|\bdo not (?:use|charge)\b|\bdon't (?:use|charge)\b/.test(d)) add('battery_stop_using', 'fail', 'Battery case does not tell the customer to stop using and charging the phone')
    if (!/un\s?3481/i.test(draft)) add('battery_un3481', 'warn', 'Battery case does not mention the UN3481 lithium battery label')
    if (!/royal mail/.test(d)) add('battery_rm_label', 'warn', 'Battery case does not mention the Royal Mail return label')
  }
  if (/\b(charge (?:it )?overnight|leave (?:it )?charging overnight|keep (?:it )?charging|continue (?:to )?charg)/.test(d)) add('unsafe_advice', 'fail', 'Suggests continuing to charge the device')

  // ── Locked phone: never ask for their password (covered above); fine to point at icloud.com/find

  // ── INR: police crime reference only for phones, not accessory-only orders
  const accessoryOnly = !!kase.device_model && !/iphone|phone|ipad|samsung|pixel|galaxy/i.test(kase.device_model)
  if (/\b(crime reference|police reference|police report)\b/.test(d) && accessoryOnly) add('inr_police_accessory', 'fail', 'Mentions a police crime reference on an accessory-only order')

  // ── Return checklist: expected whenever a return is arranged
  const arrangesReturn = /\b(return label|return (?:the|your) (?:phone|device|item)|send (?:it|the (?:phone|device)) back|returns? (?:process|request|for inspection)|arrange (?:a |the )?return)\b/.test(d)
  if (arrangesReturn && !/\b(sign out of icloud|find my|factory reset|remove (?:the|your) sim)\b/.test(d))
    add('return_checklist', 'warn', 'Arranges a return but omits the return checklist (sign out of iCloud/Find My, factory reset, remove SIM, pack securely)')

  // ── Off-platform (bank transfer for accepted repair handled above)
  if (/\b(paypal|outside (?:of )?amazon|off[- ]amazon|our website|direct(?:ly)? (?:from|with) us\b)/.test(d)) add('off_platform', 'fail', 'References off-platform dealings')

  // ── Format
  if (!new RegExp(`\\b${escapeReLocal(kase.customer_first_name)}\\b`, 'i').test(draft)) add('greeting', 'warn', 'Does not address the customer by first name')
  if (!/saigates customer care/i.test(draft)) add('signoff', 'warn', 'Missing the "Saigates Customer Care" sign-off')

  return f
}
