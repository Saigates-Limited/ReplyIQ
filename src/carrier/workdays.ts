// UK (England & Wales) working days, in Europe/London time. Used for carrier reply deadlines ("3 working days").
// Bank holidays: gov.uk/bank-holidays. Extend the list each year (the app warns in Settings when it runs out).
export const BANK_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  // 2027
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
])
export const BANK_HOLIDAYS_UNTIL = '2027-12-31'

// Intl.DateTimeFormat construction is expensive (~1ms each, more on a cold isolate). The summary/list routes call these
// helpers several times per carrier case, so build the formatters once per isolate and reuse them.
let londonYmdFmt: Intl.DateTimeFormat | undefined
let londonHourFmt: Intl.DateTimeFormat | undefined
const ymdFmt = () => (londonYmdFmt ??= new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }))
const hourFmt = () => (londonHourFmt ??= new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }))

/** YYYY-MM-DD of an instant in London. */
export function londonDate(d: Date): string {
  return ymdFmt().format(d)
}

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
export const isWorkingDay = (ymd: string) => {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay()
  return dow !== 0 && dow !== 6 && !BANK_HOLIDAYS.has(ymd)
}

/** The date `n` working days after the London date of `from` (the day itself does not count). */
export function addWorkingDays(from: Date, n: number): string {
  let d = londonDate(from)
  let left = n
  while (left > 0) {
    d = addDays(d, 1)
    if (isWorkingDay(d)) left--
  }
  return d
}

/** End of that London day as an instant (a reply "due 14 Oct" is late only from 15 Oct). */
export function endOfLondonDay(ymd: string): Date {
  // 23:59:59 London; BST/GMT offset worked out from the formatter
  const probe = new Date(`${ymd}T12:00:00Z`)
  const hourInLondon = Number(hourFmt().format(probe))
  const offsetH = hourInLondon - 12 // 1 in summer, 0 in winter
  return new Date(Date.parse(`${ymd}T23:59:59Z`) - offsetH * 3600_000)
}

/** Whole working days from `from` to `to` (0 if `to` is not later). */
export function workingDaysBetween(from: Date, to: Date): number {
  let d = londonDate(from)
  const end = londonDate(to)
  let n = 0
  while (d < end) {
    d = addDays(d, 1)
    if (isWorkingDay(d)) n++
  }
  return n
}
