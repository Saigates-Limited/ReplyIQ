// Spots customer messages that are really a carrier problem, so the case can offer "Open carrier investigation".
// Deterministic (no AI call): runs on every synced customer message at no cost.

export type CarrierIssue = 'lost' | 'delivered_not_received' | 'empty_parcel' | 'damaged' | 'wrong_item' | 'pod_request' | 'return_to_sender' | 'postage_refund' | 'other'

export const ISSUE_LABEL: Record<CarrierIssue, string> = {
  lost: 'Lost / no tracking update',
  delivered_not_received: 'Delivered but not received',
  empty_parcel: 'Empty parcel / contents missing',
  damaged: 'Damaged in transit',
  wrong_item: 'Wrong item',
  pod_request: 'Proof of delivery request',
  return_to_sender: 'Return to sender',
  postage_refund: 'Postage refund',
  other: 'Other',
}

export type Detection = { issue: CarrierIssue; phrase: string }

// Order matters: the most specific pattern wins.
const RULES: { issue: CarrierIssue; re: RegExp }[] = [
  { issue: 'empty_parcel', re: /\b(?:(?:box|parcel|package|envelope|bag)\s+(?:was|is|came|arrived)\s+(?:completely\s+|totally\s+)?empty|empty\s+(?:box|parcel|package|envelope|bag)|nothing\s+(?:was\s+)?(?:inside|in\s+(?:the|it))|no\s+(?:phone|device|iphone|handset)\s+(?:was\s+)?(?:inside|in\s+the\s+(?:box|parcel|package))|(?:phone|device|iphone)\s+(?:was\s+)?missing\s+from\s+the\s+(?:box|parcel|package)|only\s+(?:the\s+)?(?:charger|cable|box)\s+(?:was\s+)?(?:inside|in\s+(?:the\s+)?(?:box|parcel)))\b/i },
  { issue: 'delivered_not_received', re: /\b(?:(?:says|shows|showing|marked|marked\s+as|states|tracking\s+says)\s+(?:it\s+(?:was|has\s+been)\s+|as\s+)?delivered\b[^.?!\n]{0,80}\b(?:not|never|haven'?t|hasn'?t|didn'?t|no)\b|(?:not|never|haven'?t|didn'?t)\s+(?:actually\s+)?(?:received|got)\b[^.?!\n]{0,80}\b(?:says|shows|marked|showing)\s+(?:as\s+)?delivered|delivered\s+to\s+(?:the\s+)?wrong\s+(?:address|house|door|person)|left\s+(?:it\s+)?(?:with|at)\s+(?:a\s+)?(?:neighbou?r|safe\s*place)[^.?!\n]{0,60}\b(?:not|no|can'?t\s+find))/i },
  { issue: 'damaged', re: /\b(?:(?:box|parcel|package|packaging)\s+(?:was\s+|is\s+|arrived\s+|came\s+)?(?:badly\s+)?(?:damaged|crushed|torn|ripped|smashed|soaked|wet|opened|tampered(?:\s+with)?)|arrived\s+(?:damaged|broken|smashed|cracked|in\s+pieces)|damaged\s+(?:in|during)\s+(?:transit|delivery|the\s+post))\b/i },
  { issue: 'return_to_sender', re: /\b(?:return(?:ed|ing)?\s+to\s+sender|being\s+sent\s+back\s+to\s+you|sent\s+back\s+to\s+the\s+seller)\b/i },
  { issue: 'lost', re: /\b(?:(?:has|have|hasn'?t|haven'?t|still\s+(?:has\s+)?not|still\s+haven'?t|not\s+yet|never|did\s+not|didn'?t)\s+(?:yet\s+)?(?:been\s+)?(?:arrived?|received|delivered|got\s+(?:it|the\s+(?:phone|parcel|order)))|(?:not|never)\s+(?:yet\s+)?(?:arrived|received|delivered)|where\s+is\s+my\s+(?:order|parcel|package|phone|item|delivery)|(?:tracking|it)\s+(?:has(?:n'?t|\s+not)\s+(?:been\s+)?(?:updated|moved|changed)|(?:is\s+)?(?:stuck|not\s+(?:moving|updating)))|no\s+(?:tracking\s+)?updates?\s+(?:since|for)|still\s+waiting\s+for\s+(?:my|the)\s+(?:order|parcel|phone|delivery|package)|(?:parcel|package|order|phone)\s+(?:is|has\s+been|was|got)\s+lost|lost\s+in\s+(?:the\s+)?(?:post|transit))\b/i },
]

/** Questions about tracking from someone who has not ordered yet, or who already has the phone, are not carrier issues. */
const NOT_A_CARRIER_ISSUE = /\b(?:before\s+(?:I|we)\s+(?:order|buy|purchase)|how\s+long\s+(?:does|will)\s+(?:delivery|shipping|it)\s+take|can\s+(?:you|it)\s+be\s+delivered\s+by|received\s+(?:it|the\s+phone|my\s+order)\s+(?:today|yesterday|this\s+morning)\s*(?:,|and|but)\s+(?:the\s+)?(?:battery|screen|camera|face\s*id|sim|charger))\b/i

/** Returns the most likely carrier issue in a customer's message, or null. */
export function detectCarrierIssue(text: string | null | undefined): Detection | null {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (t.length < 8 || NOT_A_CARRIER_ISSUE.test(t)) return null
  for (const r of RULES) {
    const m = t.match(r.re)
    if (m) return { issue: r.issue, phrase: m[0].trim().slice(0, 120) }
  }
  return null
}
