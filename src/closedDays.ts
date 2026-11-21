// Closed days for replies sent while the office is shut (21 Nov 2026): Saturdays, Sundays and UK bank holidays
// (England and Wales: the business is in Wolverhampton), plus any extra dates a manager adds. All dates are Europe/London.
import type { Sql } from './db'

// gov.uk is the source (https://www.gov.uk/bank-holidays.json, refreshed weekly). This list is the fallback if it can't be reached.
export const FALLBACK_BANK_HOLIDAYS: Record<string, string> = {
  '2026-01-01': "New Year's Day", '2026-04-03': 'Good Friday', '2026-04-06': 'Easter Monday', '2026-05-04': 'Early May bank holiday',
  '2026-05-25': 'Spring bank holiday', '2026-08-31': 'Summer bank holiday', '2026-12-25': 'Christmas Day', '2026-12-28': 'Boxing Day (substitute day)',
  '2027-01-01': "New Year's Day", '2027-03-26': 'Good Friday', '2027-03-29': 'Easter Monday', '2027-05-03': 'Early May bank holiday',
  '2027-05-31': 'Spring bank holiday', '2027-08-30': 'Summer bank holiday', '2027-12-27': 'Christmas Day (substitute day)', '2027-12-28': 'Boxing Day (substitute day)',
}

/** YYYY-MM-DD of an instant in Europe/London. */
export const londonDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const londonHour = (d: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(d))
const weekday = (ymd: string) => new Date(ymd + 'T12:00:00Z').getUTCDay() // 0 Sun … 6 Sat
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

export type Holidays = Record<string, string>

/** Why a London date is closed ('Saturday', 'Sunday', the bank holiday's name, or the manager's note), or null when open. */
export function closedReason(ymd: string, holidays: Holidays, extra: Record<string, string> = {}): string | null {
  if (holidays[ymd]) return holidays[ymd]
  if (extra[ymd]) return extra[ymd] || 'Closed'
  const wd = weekday(ymd)
  return wd === 6 ? 'Saturday' : wd === 0 ? 'Sunday' : null
}

export function nextWorkingDay(ymd: string, holidays: Holidays, extra: Record<string, string> = {}): string {
  let d = addDays(ymd, 1)
  for (let i = 0; i < 14 && closedReason(d, holidays, extra); i++) d = addDays(d, 1)
  return d
}

/** "Monday 23 November" */
export const longDate = (ymd: string) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })

/**
 * Messages that arrived since the office last closed get a reply: from 17:00 London on the last working day before
 * this closed spell (e.g. Friday 17:00 for a weekend). Returns that instant, or null when today is a working day.
 */
export function closedSpellStart(now: Date, holidays: Holidays, extra: Record<string, string> = {}, closeHour = 17): { since: Date; reason: string; reopens: string } | null {
  const today = londonDate(now)
  const reason = closedReason(today, holidays, extra)
  if (!reason) return null
  let d = today
  for (let i = 0; i < 14 && closedReason(addDays(d, -1), holidays, extra); i++) d = addDays(d, -1)
  const lastWorking = addDays(d, -1)
  // 17:00 London on lastWorking, as a UTC instant (try both GMT and BST offsets and keep the one that is 17:00 in London).
  const cands = [0, 1].map((off) => new Date(`${lastWorking}T${String(closeHour - off).padStart(2, '0')}:00:00Z`))
  const since = cands.find((c) => londonHour(c) === closeHour && londonDate(c) === lastWorking) ?? cands[0]
  return { since, reason, reopens: nextWorkingDay(today, holidays, extra) }
}

/** Bank holidays from gov.uk, cached in app_settings for 7 days; the built-in list if gov.uk can't be reached. */
export async function loadHolidays(sql: Sql, fetcher: typeof fetch = fetch): Promise<Holidays> {
  try {
    const [r] = await sql`SELECT value, updated_at FROM app_settings WHERE key = 'bank_holidays'`
    const v = (typeof r?.value === 'string' ? JSON.parse(r.value) : r?.value) as Holidays | undefined
    if (v && Object.keys(v).length && Date.now() - new Date(r.updated_at).getTime() < 7 * 86400_000) return { ...FALLBACK_BANK_HOLIDAYS, ...v }
  } catch {}
  try {
    const res = await fetcher('https://www.gov.uk/bank-holidays.json', { headers: { accept: 'application/json' } })
    if (res.ok) {
      const j: any = await res.json()
      const list: Holidays = {}
      for (const e of j?.['england-and-wales']?.events ?? []) if (/^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date >= '2026-01-01') list[e.date] = String(e.title)
      if (Object.keys(list).length) {
        await sql`INSERT INTO app_settings (key, value, updated_at) VALUES ('bank_holidays', ${sql.json(list as any)}, now())
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`.catch(() => {})
        return { ...FALLBACK_BANK_HOLIDAYS, ...list }
      }
    }
  } catch {}
  return { ...FALLBACK_BANK_HOLIDAYS }
}

// ───────── Reply timing (Sagar, 21 Nov 2026) ─────────
// Amazon expects a reply within 48 hours, weekends and holidays included. Closed-day replies go out only between 09:00 and 17:00.
// A holding reply (high stakes) is sent as LATE as possible inside the 48 hours, and only if staff would not be back in time.
export const REPLY_DEADLINE_HOURS = 48
export const WINDOW_START = 9, WINDOW_END = 17 // London hours; last send slot 16:45 (cron runs every 15 minutes)
export const SAFETY_MINUTES = 60 // send at least an hour before the deadline
export const STAFF_BUFFER_HOURS = 4 // staff need this long after opening to reach a message before its deadline

/** The instant that is hh:mm on a London date (handles GMT and BST). */
export function londonInstant(ymd: string, hh: number, mm = 0): Date {
  for (const off of [0, 1]) {
    const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), hh - off, mm))
    if (londonDate(d) === ymd && londonHour(d) === hh) return d
  }
  return new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10), hh, mm))
}

/** True between 09:00 and 17:00 London on a closed day. */
export function inReplyWindow(now: Date, holidays: Holidays, extra: Record<string, string> = {}) {
  const h = londonHour(now)
  return !!closedReason(londonDate(now), holidays, extra) && h >= WINDOW_START && h < WINDOW_END
}

/**
 * When to send a holding reply for a customer message that arrived at `msgAt`:
 * needed = false when staff are back (09:00 on the next working day) with STAFF_BUFFER_HOURS to spare before the 48-hour deadline;
 * otherwise sendAt = the latest 09:00–16:45 slot on a closed day that is at least an hour before the deadline
 * (or now, if that slot has already passed: late is better than never).
 */
export function holdingPlan(msgAt: Date, now: Date, holidays: Holidays, extra: Record<string, string> = {}) {
  const deadline = new Date(msgAt.getTime() + REPLY_DEADLINE_HOURS * 3600_000)
  const staffBack = londonInstant(nextWorkingDay(londonDate(now), holidays, extra), WINDOW_START)
  if (closedReason(londonDate(now), holidays, extra) === null) return { needed: false, sendAt: null, deadline, staffBack }
  if (deadline.getTime() >= staffBack.getTime() + STAFF_BUFFER_HOURS * 3600_000) return { needed: false, sendAt: null, deadline, staffBack }
  const target = new Date(deadline.getTime() - SAFETY_MINUTES * 60_000)
  let d = londonDate(target)
  const today = londonDate(now)
  for (let i = 0; i < 14 && d >= today; i++) {
    if (closedReason(d, holidays, extra)) {
      const start = londonInstant(d, WINDOW_START), end = londonInstant(d, WINDOW_END - 1, 45)
      // Round down to the quarter hour: the cron runs at :00, :15, :30 and :45.
      const cand = new Date(Math.floor(Math.min(end.getTime(), target.getTime()) / 900_000) * 900_000)
      if (cand >= start) return { needed: true, sendAt: cand < now ? now : cand, deadline, staffBack }
    }
    const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); d = x.toISOString().slice(0, 10)
  }
  return { needed: true, sendAt: now, deadline, staffBack }
}
