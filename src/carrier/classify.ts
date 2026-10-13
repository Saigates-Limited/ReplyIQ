// Reads a carrier email and works out what it means for the parcel: an automatic acknowledgement, a holding reply,
// a request for information, or a decision (lost → claim, delivered, rejected, paid). Deterministic and testable;
// unknown wording falls through to 'other' and is shown to staff rather than guessed.
import { carrierFromAddress, findTrackings, type CarrierId } from './carriers'

export type InboundKind =
  | 'auto_ack' | 'holding_reply' | 'info_request' | 'decision_lost' | 'decision_delivered' | 'decision_rejected'
  | 'claim_settled' | 'escalation' | 'notification' | 'other'

export type Classified = {
  carrier: CarrierId | null
  kind: InboundKind
  trackings: string[]
  caseRefs: string[]
  claimRef: string | null
  amount: number | null // money the carrier says it is paying
  summary: string // one line, no personal data
}

const KIND_LABEL: Record<InboundKind, string> = {
  auto_ack: 'Automatic acknowledgement',
  holding_reply: 'Holding reply – investigating',
  info_request: 'Asked us for information',
  decision_lost: 'Confirmed lost – submit a claim',
  decision_delivered: 'Says the item was delivered',
  decision_rejected: 'Declined',
  claim_settled: 'Claim settled',
  escalation: 'Escalated for review',
  notification: 'Tracking notification',
  other: 'Carrier email',
}
export const inboundLabel = (k: string) => KIND_LABEL[k as InboundKind] ?? k

/** Only the part the carrier wrote: drop quoted history and our original email below it. */
export function topOfEmail(body: string) {
  const t = body.replace(/\r\n/g, '\n')
  const cut = t.search(/^-{3,}\s*Original Message\s*-{3,}|^On .{10,120} wrote:\s*$|^From: .+\n(?:Sent|Date): /im)
  return (cut > 20 ? t.slice(0, cut) : t).trim()
}

export function extractCaseRefs(text: string): string[] {
  const refs = new Set<string>()
  for (const m of text.matchAll(/\b(?:Case\s*(?:Reference|Ref(?:erence)?|Number|No\.?)|Reference)\s*(?:#|:|number)?\s*(?:is)?\s*:?\s*#?\s*(\d{7,9})\b/gi)) refs.add(m[1])
  for (const m of text.matchAll(/\bcase\s+(\d{7,9})\b/gi)) refs.add(m[1])
  return [...refs]
}

const money = (s: string) => Number(s.replace(/,/g, ''))

export function classifyCarrierEmail(from: string, subject: string, body: string): Classified {
  const carrier = carrierFromAddress(from)
  const top = topOfEmail(body)
  const all = `${subject}\n${top}`
  const lower = all.toLowerCase()
  const trackings = findTrackings(`${subject}\n${body}`, carrier).map((t) => t.tracking)
  const caseRefs = extractCaseRefs(`${subject}\n${body}`)
  const claimRef = all.match(/\b(CLM-\d{5,})\b/i)?.[1]?.toUpperCase() ?? null
  const amounts = [...top.matchAll(/£\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g)].map((m) => money(m[1]))

  const has = (re: RegExp) => re.test(lower)
  let kind: InboundKind = 'other'

  if (has(/we aim to respond within \d+ (?:working )?days|thank you for contacting royal mail\.\s*we aim|this is an automated (?:response|reply)|we have received your (?:email|enquiry|query)\b[^.]{0,80}\b(?:respond|reply|get back)/)) kind = 'auto_ack'
  else if (has(/has been delivered|is due to be delivered|out for delivery|your parcel is on its way|we'?ve delivered|collect your item/) && !has(/case (?:number|reference)|investigat|claim/)) kind = 'notification'
  else if (has(/claim has been settled|we(?:'ve| have) (?:now )?(?:paid|settled)|remittance advice|payment of £|compensation (?:of|payment)|we will (?:pay|be paying|make a payment)|amount (?:paid|approved)|(?:offer|award)(?:ed)? (?:you )?(?:compensation|£)/)) kind = 'claim_settled'
  else if (has(/we(?:'ve| have) concluded your claim|resolved your claim/)) kind = amounts.length && !has(/unable to|not able to|declined|reject|no compensation/) ? 'claim_settled' : has(/unable to|not able to|declined|reject|no compensation/) ? 'decision_rejected' : 'claim_settled'
  else if (has(/t2 case review|second[- ]tier|escalat(?:ed|ion) (?:team|to)|passed (?:this|your case) to (?:our|the) (?:escalation|specialist|claims) team/)) kind = 'escalation'
  else if (has(/(?:please|could you|can you|kindly)\s+(?:\w+\s+){0,3}(?:provide|send|confirm|supply|advise|let us know)|we (?:will )?(?:need|require) (?:the|a|some|further)|in order to (?:progress|proceed|investigate)[^.]{0,60}(?:need|require|provide)|is the (?:correct|full) (?:parcel|tracking) number|unmonitored (?:inbox|mailbox)|this (?:mailbox|inbox) is not monitored/)) kind = 'info_request'
  else if (has(/outside (?:of )?(?:our|the) (?:claim )?(?:timescales?|time ?frame|time limit)|too old to (?:investigate|claim)|unable to (?:accept|consider|process) (?:a |your |the )?claim|claim (?:has been|is|was) (?:declined|rejected|unsuccessful)|not (?:eligible|able) (?:for|to offer) compensation/)) kind = 'decision_rejected'
  else if (has(/(?:classed|treated|considered|recorded) as lost|consider a claim for (?:loss|compensation)|(?:submit|make|raise) (?:a|your) claim|royalmail\.com\/(?:business)?claims|please (?:use|complete) (?:our|the) claims? (?:form|process|portal)|has not reached a location that we are able to contact/)) kind = 'decision_lost'
  else if (has(/will make enquiries|we(?:'ll| will) (?:update|contact|be in touch with) you|raised (?:this |an enquiry )?with (?:the )?(?:delivery office|local|depot|mail centre)|currently investigating|investigation is (?:under ?way|ongoing|in progress)|within \d+ working days/)) kind = 'holding_reply'
  else if (has(/(?:item|parcel) (?:was|has been) (?:successfully )?delivered|proof of delivery (?:shows|confirms)|(?:gps|co-?ordinates)[^.]{0,80}(?:close proximity|match|at the (?:delivery )?address)|delivered (?:correctly|to the correct address)|signed for by/)) kind = 'decision_delivered'

  const amount = kind === 'claim_settled' && amounts.length ? Math.max(...amounts) : null
  const summary = [
    KIND_LABEL[kind],
    amount != null ? `£${amount.toFixed(2)}` : null,
    claimRef,
    caseRefs.length ? `case ${caseRefs[caseRefs.length - 1]}` : null,
  ].filter(Boolean).join(' · ')
  return { carrier, kind, trackings, caseRefs, claimRef, amount, summary }
}
