// IMEI handling. An IMEI is 15 digits with a Luhn check digit. It is ALWAYS a string: spreadsheets turn it into a
// float ("354,870,288,570,151,000") and lose the last digits, which is exactly the corruption the import must catch.

/** Keep digits only. Returns '' for null/undefined. */
export function normaliseImei(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '')
}

/** Luhn check over a 15-digit string. */
export function luhnOk(digits: string): boolean {
  if (!/^\d{15}$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < 15; i++) {
    let d = Number(digits[i])
    // double every second digit from the right (positions 14, 12, … → index odd from left for a 15-digit string)
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

export type ImeiCheck = { ok: true; imei: string } | { ok: false; reason: string; digits: string }

/** Validate anything a human or a spreadsheet produced. */
export function checkImei(raw: unknown): ImeiCheck {
  const digits = normaliseImei(raw)
  if (!digits) return { ok: false, reason: 'empty', digits }
  if (digits.length !== 15) return { ok: false, reason: `${digits.length} digits (needs 15)${digits.length > 15 ? ' — looks like a spreadsheet number, not an IMEI' : ''}`, digits }
  if (!luhnOk(digits)) return { ok: false, reason: 'check digit does not match (typo?)', digits }
  return { ok: true, imei: digits }
}

/** Compute the Luhn check digit for a 14-digit TAC+serial (used by tests to build valid fixtures). */
export function imeiCheckDigit(first14: string): string {
  if (!/^\d{14}$/.test(first14)) throw new Error('need 14 digits')
  let sum = 0
  for (let i = 0; i < 14; i++) {
    let d = Number(first14[i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return String((10 - (sum % 10)) % 10)
}

export type ImeiCell =
  | { kind: 'none' }
  | { kind: 'imei'; imeis: string[]; split: boolean; duplicate: boolean }
  | { kind: 'serial'; serial: string }
  | { kind: 'bad'; reason: string; digits: string }

// Letters AND digits, 8-14 characters (iPad / Samsung / Watch serials). Digits-only values never qualify: those are
// truncated or mistyped IMEIs and still go to review.
const SERIAL_RE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{8,14}$/

/** Interpret one spreadsheet "IMEI NO" cell: nothing, one IMEI, two IMEIs run together (30 digits), a serial number, or junk. */
export function parseImeiCell(raw: unknown): ImeiCell {
  const text = String(raw ?? '').trim()
  if (!text) return { kind: 'none' }
  const one = checkImei(text)
  if (one.ok) return { kind: 'imei', imeis: [one.imei], split: false, duplicate: false }
  const digits = normaliseImei(text)
  if (digits.length === 30) {
    const a = digits.slice(0, 15), b = digits.slice(15)
    if (luhnOk(a) && luhnOk(b)) return a === b ? { kind: 'imei', imeis: [a], split: true, duplicate: true } : { kind: 'imei', imeis: [a, b], split: true, duplicate: false }
    return { kind: 'bad', reason: '30 digits (two IMEIs?) but at least one check digit does not match', digits }
  }
  const compact = text.replace(/[\s-]+/g, '')
  if (SERIAL_RE.test(compact)) return { kind: 'serial', serial: compact.toUpperCase() }
  return { kind: 'bad', reason: one.reason, digits }
}
