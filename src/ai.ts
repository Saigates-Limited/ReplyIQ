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

/** Redact known PII values from free text before it leaves the server. */
export function redactPii(text: string, kase: CaseRow): string {
  let out = text
  const values = [kase.customer_last_name, kase.customer_email, kase.customer_phone, kase.customer_address].filter(
    (v): v is string => !!v && v.trim().length > 1
  )
  for (const v of values) {
    const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    out = out.replace(re, '[redacted]')
  }
  // Generic patterns: emails, UK phone numbers, UK postcodes
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email redacted]')
  out = out.replace(/(\+44\s?7\d{3}|\(?07\d{3}\)?)\s?\d{3}\s?\d{3}/g, '[phone redacted]')
  out = out.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g, '[postcode redacted]')
  // Signature line "First Last" matching the known surname handled above; strip trailing full-name sign-offs
  if (kase.customer_last_name) {
    const sig = new RegExp(`${kase.customer_first_name}\\s+${kase.customer_last_name}`, 'gi')
    out = out.replace(sig, kase.customer_first_name)
  }
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

/** Deterministic checks that do not depend on the model's self-assessment. */
export function serverChecks(draft: string, kase: CaseRow): ServerFinding[] {
  const f: ServerFinding[] = []
  const d = draft.toLowerCase()
  const add = (rule: string, severity: 'fail' | 'warn', detail: string) => f.push({ rule, severity, detail })

  // PII leakage
  if (kase.customer_last_name && d.includes(kase.customer_last_name.toLowerCase())) add('pii', 'fail', 'Draft contains the customer surname')
  if (kase.customer_email && d.includes(kase.customer_email.toLowerCase())) add('pii', 'fail', 'Draft contains the customer email address')
  if (/\b(?:\+44|0)7\d{3}\s?\d{6}\b/.test(draft)) add('pii', 'fail', 'Draft contains a UK mobile number')

  // Forbidden requests
  if (/\b(photo id|photographic id|passport|driving licence|driver'?s licen[cs]e|proof of (?:id|identity|address))\b/.test(d))
    add('no_id_requests', 'fail', 'Asks for ID or proof of identity/address')
  if (/\b(bank details|card details|card number|sort code|account number)\b/.test(d) && !kase.approved_repair_price)
    add('no_payment_details', 'fail', 'Asks for bank/card details without an approved repair quote')

  // Promises not supported by CASE INPUT
  const promisesRefund = /\b(?:we will|we'll|will be|has been|have|i have|i've|i will|i'll)\s+(?:issue|issued|process|processed|arrange|arranged|sent|send)\s+(?:a |the |your )?(?:full |partial )?refund/.test(d) ||
    /\brefund (?:will be|has been|is being) (?:issued|processed|sent)/.test(d)
  if (promisesRefund && kase.refund_issued !== true) add('no_refund_promise', 'fail', 'Promises or confirms a refund but refund_issued is not yes')
  const promisesReplacement = /\b(?:we will|we'll|i will|i'll|has been|have been|will be)\s+(?:send|sent|dispatch|dispatched|ship|shipped)\s+(?:you )?(?:a |the )?replacement/.test(d)
  if (promisesReplacement && kase.in_stock !== true) add('no_replacement_promise', 'fail', 'Promises a replacement but in_stock is not yes')

  // Repair price without approval
  const priceMentions = draft.match(/£\s?\d+(?:\.\d{2})?/g) ?? []
  if (priceMentions.length && !kase.approved_repair_price && !/£\s?15\b/.test(draft))
    add('no_unapproved_price', 'warn', `Mentions a price (${priceMentions.join(', ')}) with no approved repair quote`)
  if (kase.approved_repair_price && priceMentions.some((p) => p.replace(/[£\s]/g, '') !== Number(kase.approved_repair_price).toFixed(2) && p.replace(/[£\s]/g, '') !== String(Number(kase.approved_repair_price))) && !/£\s?15\b/.test(draft))
    add('price_mismatch', 'warn', 'Mentions a price different from the approved repair price')

  // Tone / accusations
  if (/\b(fraud|fraudulent|scam|lying|dishonest|buyer'?s remorse|price[- ]gaming)\b/.test(d)) add('no_accusations', 'fail', 'Contains accusatory language')
  if (/\bwaterproof\b/.test(d)) add('no_waterproof', 'fail', 'Says "waterproof"')
  if (/\b(charge (?:it )?overnight|leave (?:it )?charging overnight)\b/.test(d)) add('safety', 'fail', 'Suggests charging overnight')
  if (/\b(paypal|bank transfer|outside (?:of )?amazon|off[- ]amazon|direct(?:ly)? (?:from|through) (?:us|our website))\b/.test(d) && !kase.approved_repair_price)
    add('on_platform_only', 'fail', 'References off-platform dealings without an approved repair quote')

  // Format
  if (!new RegExp(`\\b${kase.customer_first_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(draft)) add('greeting', 'warn', 'Does not address the customer by first name')
  if (!/saigates customer care/i.test(draft)) add('signoff', 'warn', 'Missing the "Saigates Customer Care" sign-off')
  if (/^\s*[-•*]\s/m.test(draft) && (draft.match(/^\s*[-•*]\s/gm) ?? []).length >= 3) add('prose_not_checklist', 'warn', 'Reads like a checklist (3+ bullet points)')

  return f
}
