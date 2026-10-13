// Draft generation: builds a PII-minimised payload, calls OpenAI server-side,
// and runs deterministic guardrail checks on the result.
import instructions from '../reply_instructions.md?raw'
import type { Bindings } from './db'
import { assertNoAttachmentContent, attachmentSummaryForModel, type AttachmentMeta } from './attachments'

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
  // Ticket / event flags (never sent raw to the model except the two booleans below)
  chargeback_open?: boolean | null
  battery_flag?: boolean | null
  internal_notes?: string | null // NEVER included in the payload
  delivery_date_source?: string | null // staff | amazon_actual | amazon_estimated
}
export type MessageRow = {
  direction: 'inbound' | 'outbound'
  body: string
  sent_at: string
  sender?: string | null
  kind?: 'message' | 'seller_central_copy' | 'event' | string | null
  attachments?: AttachmentMeta[] // metadata only; file content NEVER enters the payload
}
/** Amazon notice (A-to-Z / return / chargeback) linked to the order. Only non-PII fields are used. */
export type EventRow = {
  kind: string
  status: string | null
  amount: string | null
  currency: string | null
  received_at: string
  deadline_at: string | null
  return_reason?: string | null
  customer_comment?: string | null
  authorisation?: string | null
  policy_check?: string | null
  item_description?: string | null
  raw_excerpt?: string | null
}

/** What kind of text the agent is asking for. Only 'customer' may ever be emailed. */
export type DraftMode = 'customer' | 'seller_central_atoz' | 'seller_central_return' | 'chargeback_evidence'
export const DRAFT_MODES: DraftMode[] = ['customer', 'seller_central_atoz', 'seller_central_return', 'chargeback_evidence']

const MODE_INSTRUCTIONS: Record<Exclude<DraftMode, 'customer'>, string> = {
  seller_central_atoz: `MODE: A-TO-Z CLAIM RESPONSE (for pasting into Seller Central — NOT an email to the customer).
Write a short, factual statement addressed to Amazon about this order. Use the ORDER TIMELINE and AMAZON EVENTS as evidence.
State: what was ordered, dispatch/delivery with carrier and tracking (use [TRACKING NUMBER] or [DATE] placeholders if unknown — never invent), what the customer reported, what we offered and when, and what we ask Amazon to do.
No greeting to the customer, no sign-off to the customer. Plain text, under 250 words. Set needs_manager to true. Put any missing facts the agent must fill in under staff_notes.`,
  seller_central_return: `MODE: RETURN REQUEST HANDLING (for pasting into Seller Central / internal handling notes — NOT an email to the customer).
Using the return reason and comment in AMAZON EVENTS, write: (1) a one-paragraph note for Seller Central authorising or commenting on the return, and (2) under staff_notes the internal checklist (expected condition, inspection points, refund timing).
If the case input shows battery_flag = yes or the return reason mentions heat/overheating/swelling, apply the Battery rule: the customer must be told to stop using and charging, the parcel needs the Royal Mail label with the UN3481 lithium battery marking, set needs_manager true and urgency high.
Plain text. No invented facts.`,
  chargeback_evidence: `MODE: CHARGEBACK EVIDENCE (a representation to Amazon for a card chargeback — NOT an email to the customer).
Write a factual evidence statement in this order: order shipped (yes/no), ship date, carrier, tracking number and proof of delivery, our policy that applies, the return address we gave, and a summary of the customer contact from the ORDER TIMELINE.
Where a fact is missing write [MISSING: <field>] — never guess. Sign off as "Saigates Ltd". Plain text, under 300 words. Set needs_manager to true.`,
}

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
  // Protect Amazon order IDs (ddd-ddddddd-ddddddd) — they are not PII and the phone regex would mangle them.
  const orders: string[] = []
  let out = text.replace(/\b\d{3}-\d{7}-\d{7}\b/g, (m) => {
    orders.push(m)
    return `\u0000ORDER${orders.length - 1}\u0000`
  })
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
  // Amazon notice blocks that carry a full name + address
  out = out.replace(/(?:^|\n)[ \t]*shipping address:?[ \t]*\n(?:[^\n]+\n?){1,6}/gi, '\n[shipping address redacted]\n')
  // Generic patterns
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email redacted]')
  // Any UK-style number: +44 or leading 0, then 9-10 more digits allowing spaces/dashes/brackets
  out = out.replace(/(?:\+44[\s-]?\(?0?\)?|\(?0)\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, '[phone redacted]')
  out = out.replace(STREET_LINE, '\n[address redacted]')
  out = out.replace(STREET_INLINE, '[address redacted]')
  out = out.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g, '[postcode redacted]')
  out = out.replace(/\u0000ORDER(\d+)\u0000/g, (_, i) => orders[Number(i)])
  return out
}

/** Explicit allow-list of what the model may see. Nothing else is included. */
export function buildPayload(kase: CaseRow, messages: MessageRow[], opts: { events?: EventRow[] } = {}) {
  const daysSinceDelivery = kase.delivery_date
    ? Math.floor((Date.now() - new Date(kase.delivery_date).getTime()) / 86400_000)
    : null
  const caseInput = {
    customer_first_name: kase.customer_first_name,
    subject: redactPii(kase.subject, kase),
    order_id: kase.order_id ?? 'unknown',
    device_model: kase.device_model ?? 'unknown',
    delivery_date: kase.delivery_date ? new Date(kase.delivery_date).toISOString().slice(0, 10) : 'unknown',
    // staff-entered dates are authoritative for warranty/return lanes; Amazon "estimated" = promised window, not confirmed delivery
    delivery_date_basis: !kase.delivery_date ? 'none' : kase.delivery_date_source === 'amazon_estimated' ? 'ESTIMATED (Amazon promised window, not confirmed) — if the lane depends on days since delivery, ask staff to confirm' : kase.delivery_date_source === 'amazon_actual' ? 'confirmed by Amazon tracking' : 'entered by staff',
    days_since_delivery: daysSinceDelivery ?? 'unknown',
    refund_issued: yn(kase.refund_issued),
    atoz_open: yn(kase.a_to_z_open),
    in_stock: yn(kase.in_stock),
    approved_repair_price: kase.approved_repair_price ? `£${kase.approved_repair_price}` : 'none',
    repair_quote_accepted: yn(kase.repair_quote_accepted),
    tracking_number: kase.tracking_number ?? 'none',
    carrier: kase.carrier ?? 'unknown',
    chargeback_open: yn(kase.chargeback_open ?? null),
    battery_flag: yn(kase.battery_flag ?? null),
  }
  const stamp = (v: string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : 'unknown')
  const fromOf = (m: MessageRow) => {
    if (m.kind === 'event') return 'amazon_event'
    if (m.direction === 'inbound') return /amazon customer service|on behalf of/i.test(m.sender ?? '') ? 'amazon_cs_on_behalf_of_customer' : 'customer'
    return 'saigates'
  }
  // Order timeline: everything on this order (customer, our replies incl. Seller Central copies, Amazon notices), oldest first, last 40.
  const thread = messages.slice(-40).map((m) => ({
    from: fromOf(m),
    sent_at: stamp(m.sent_at),
    text: redactPii(m.body, kase).slice(0, 4000),
    ...(m.attachments?.length ? { attachments: attachmentSummaryForModel(m.attachments) } : {}),
  }))
  const events = (opts.events ?? []).map((e) => ({
    kind: e.kind,
    status: e.status ?? 'open',
    amount: e.amount ? `${e.currency ?? 'GBP'} ${e.amount}` : 'unknown',
    received_at: stamp(e.received_at),
    deadline_at: e.deadline_at ? stamp(e.deadline_at) : 'none',
    return_reason: e.return_reason ? redactPii(e.return_reason, kase).slice(0, 300) : undefined,
    customer_comment: e.customer_comment ? redactPii(e.customer_comment, kase).slice(0, 1000) : undefined,
    authorisation: e.authorisation ?? undefined,
    policy_check: e.policy_check ?? undefined,
    item: e.item_description ? redactPii(e.item_description, kase).slice(0, 200) : undefined,
  }))
  return { caseInput, thread, events }
}

export async function generateDraft(
  env: Bindings,
  kase: CaseRow,
  messages: MessageRow[],
  opts: { events?: EventRow[]; mode?: DraftMode } = {}
): Promise<{ result: AiResult; payload: ReturnType<typeof buildPayload>; mode: DraftMode }> {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured on the server')
  const mode: DraftMode = opts.mode && DRAFT_MODES.includes(opts.mode) ? opts.mode : 'customer'
  const payload = buildPayload(kase, messages, { events: opts.events })
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')

  const modeBlock = mode === 'customer' ? '' : `${MODE_INSTRUCTIONS[mode]}\nIn this mode the "reply" field holds the text to paste, not an email to the customer.\n\n`
  const eventsBlock = payload.events.length ? `AMAZON EVENTS ON THIS ORDER:\n${JSON.stringify(payload.events, null, 2)}\n\n` : ''
  const userMsg = `${modeBlock}CASE INPUT:\n${JSON.stringify(payload.caseInput, null, 2)}\n\n${eventsBlock}ORDER TIMELINE (oldest first):\n${payload.thread
    .map((m) => `[${m.from} @ ${m.sent_at}]\n${m.text}`)
    .join('\n\n')}\n\nReturn the JSON object described under "## Output" and nothing else.`

  // Hard guard: attachments are summarised as counts only. If any file content ever reaches this point, abort.
  assertNoAttachmentContent(userMsg)

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
  if (mode !== 'customer') result.needs_manager = true // Seller Central / Amazon statements always need a manager
  if (kase.battery_flag === true) {
    result.needs_manager = true
    result.urgency = 'high'
  }
  return { result, payload, mode }
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
export function serverChecks(draft: string, kase: CaseRow, mode: DraftMode = 'customer'): ServerFinding[] {
  const f: ServerFinding[] = []
  const d = draft.toLowerCase()
  const add = (rule: string, severity: 'fail' | 'warn', detail: string) => f.push({ rule, severity, detail })
  const toAmazon = mode !== 'customer'

  // ── PII must never appear in a reply
  if (kase.customer_last_name && d.includes(kase.customer_last_name.toLowerCase())) add('pii', 'fail', 'Contains the customer surname')
  if (kase.customer_email && d.includes(kase.customer_email.toLowerCase())) add('pii', 'fail', 'Contains the customer email address')
  // Amazon order IDs (ddd-ddddddd-ddddddd) look like phone numbers to the regex — strip them first.
  const draftNoOrders = draft.replace(/\b\d{3}-\d{7}-\d{7}\b/g, '[order]')
  if (/(?:\+44[\s-]?\(?0?\)?|\(?0)\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/.test(draftNoOrders) && !paidRepairApproved(kase))
    add('pii', 'fail', 'Repeats a phone number in the reply')
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
  // Fail only when the reply ASKS for a phone number (a request verb nearby), not on the bare phrase.
  if (
    asks(/\b(?:send|share|provide|give|tell|confirm|let us know|what is|what's|could you|can you|please)\b[^.\n]{0,40}\b(?:your |a |the best |a contact )?(?:phone|mobile|telephone|contact) number\b/) ||
    asks(/\bnumber (?:we|i) can (?:call|reach|contact) you\b/)
  )
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
  // (In statements to Amazon, "we ask Amazon to review the evidence" is normal — only flag product-review/feedback wording there.)
  if (toAmazon ? /\b(product review|seller feedback|leave (?:a |us )?(?:review|feedback)|star rating|5[- ]star|five[- ]star)\b/.test(d) : /\b(review|feedback|star rating|5[- ]star|five[- ]star)\b/.test(d))
    add('never_reviews', 'fail', 'Mentions reviews or feedback')

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
  // Statements to Amazon legitimately quote the order/claim value; only customer replies are quoting a price *to* someone.
  if (nonSmall.length && !kase.approved_repair_price && !toAmazon) add('price_unapproved', 'fail', `Quotes ${nonSmall.map((p) => '£' + p.toFixed(2)).join(', ')} but no approved repair price is set`)
  if (kase.approved_repair_price) {
    const approved = Number(kase.approved_repair_price)
    const other = nonSmall.filter((p) => p !== approved)
    if (other.length) add('price_mismatch', 'warn', `Mentions ${other.map((p) => '£' + p.toFixed(2)).join(', ')} which differs from the approved £${approved.toFixed(2)}`)
  }

  // ── Refunds above £15 need a manager (warn: the needs_manager flag is enforced separately)
  if ([...refundAmountSet].some((a) => a > 15)) add('refund_over_15', 'warn', 'Offers a refund above £15 — manager approval required')

  // ── Battery: stop using/charging is mandatory; RM label + UN3481 are expected and allowed.
  // battery_flag (set from a return reason mentioning heat/overheating) forces the rule even if the draft avoids the words.
  const batteryCase = kase.battery_flag === true || /\b(battery|batteries|swollen|swelling|bulging|overheat(?:ing|s)?|very hot|too hot|burning smell|smoke|smoking)\b/.test(d)
  if (batteryCase) {
    if (!/\bstop (?:using|charging)\b|\bdo not (?:use|charge)\b|\bdon't (?:use|charge)\b|\bstopped? (?:using|charging)\b|\bnot (?:to )?(?:use|charge)\b/.test(d))
      add('battery_stop_using', toAmazon ? 'warn' : 'fail', 'Battery/heat case does not tell the customer to stop using and charging the phone')
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

  // ── Format (customer emails only)
  if (!toAmazon) {
    if (!new RegExp(`\\b${escapeReLocal(kase.customer_first_name)}\\b`, 'i').test(draft)) add('greeting', 'warn', 'Does not address the customer by first name')
    if (!/saigates customer care/i.test(draft)) add('signoff', 'warn', 'Missing the "Saigates Customer Care" sign-off')
  } else {
    // Seller Central / Amazon statements: placeholders must be filled before use
    const missing = draft.match(/\[MISSING:[^\]]*\]/gi) ?? []
    if (missing.length) add('placeholders', 'warn', `Fill in before pasting: ${[...new Set(missing)].join(', ')}`)
    const ph = [...new Set(draft.match(/\[[A-Z][A-Z /]{2,30}\]/g) ?? [])]
    if (ph.length) add('placeholders', 'warn', `Contains placeholders — replace with the real values: ${ph.join(', ')}`)
    if (mode === 'chargeback_evidence' && !/saigates ltd/i.test(draft)) add('signoff', 'warn', 'Chargeback evidence should be signed "Saigates Ltd"')
  }

  return f
}
