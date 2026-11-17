// Files attached to a reply, kept server-side until it is sent (migration 0024). See db/migrations/0024_draft_files.sql.
import type { Sql } from './db'
import { parseOutgoingAttachments, type OutgoingFile } from './attachments'

let known: boolean | null = null
export async function hasDraftFiles(sql: Sql) {
  if (known) return true
  const [r] = await sql`SELECT to_regclass('public.draft_files') IS NOT NULL AS ok`
  known = !!r?.ok
  return known
}
export const MIGRATION_0024 = 'db/migrations/0024_draft_files.sql'

const UNSENT = ['draft', 'pending_approval', 'approved', 'discarded']

/** Move the case's loose files (no draft yet, or on an unsent/superseded draft) onto `draftId`. */
export async function adoptFiles(sql: Sql, caseId: number, draftId: number) {
  if (!(await hasDraftFiles(sql))) return
  await sql`UPDATE draft_files SET draft_id = ${draftId}
            WHERE case_id = ${caseId} AND (draft_id IS NULL OR draft_id IN (
              SELECT id FROM drafts WHERE case_id = ${caseId} AND id <> ${draftId} AND status = ANY(string_to_array(${UNSENT.join(',')}, ','))))`
}

/** Metadata for the files waiting on a case (no content). */
export async function listCaseFiles(sql: Sql, caseId: number) {
  if (!(await hasDraftFiles(sql))) return []
  return sql`SELECT f.id, f.draft_id, f.filename, f.mime_type, f.size_bytes, f.created_at, u.name AS created_by_name
             FROM draft_files f LEFT JOIN users u ON u.id = f.created_by WHERE f.case_id = ${caseId} ORDER BY f.id`
}

/** The case's current unsent draft (newest), if any. */
export async function currentDraftId(sql: Sql, caseId: number): Promise<number | null> {
  const [d] = await sql`SELECT id FROM drafts WHERE case_id = ${caseId} AND status IN ('draft','pending_approval','approved') ORDER BY created_at DESC LIMIT 1`
  return d?.id ?? null
}

/** Add one file to the case (on its current draft if there is one). Enforces Amazon's limits across all waiting files. */
export async function addCaseFile(sql: Sql, caseId: number, userId: number, input: unknown): Promise<{ ok: true; id: number; draft_id: number | null } | { ok: false; error: string; status: number }> {
  if (!(await hasDraftFiles(sql))) return { ok: false, error: `Attaching files needs ${MIGRATION_0024} to be run in Supabase.`, status: 503 }
  const one = parseOutgoingAttachments([input])
  if ('error' in one) return { ok: false, error: one.error, status: 400 }
  const f = one.list[0]
  const draftId = await currentDraftId(sql, caseId)
  if (draftId) await adoptFiles(sql, caseId, draftId)
  const existing = await sql`SELECT filename, mime_type, size_bytes FROM draft_files WHERE case_id = ${caseId} AND draft_id IS NOT DISTINCT FROM ${draftId}`
  if (existing.some((x: any) => x.filename === f.filename)) return { ok: false, error: `${f.filename} is already attached`, status: 409 }
  // Re-check the whole set against Amazon's rules (5 files, 10 MB).
  const all = parseOutgoingAttachments([...existing.map((x: any) => ({ filename: x.filename, mime_type: x.mime_type, base64: 'A'.repeat(Math.ceil(x.size_bytes / 3) * 4) })), { filename: f.filename, mime_type: f.mimeType, base64: f.base64 }])
  if ('error' in all) return { ok: false, error: all.error, status: 400 }
  const [row] = await sql`INSERT INTO draft_files (case_id, draft_id, filename, mime_type, size_bytes, base64, created_by)
                          VALUES (${caseId}, ${draftId}, ${f.filename}, ${f.mimeType}, ${f.size}, ${f.base64}, ${userId}) RETURNING id`
  return { ok: true, id: row.id, draft_id: draftId }
}

/** Full files (with content) to send with `draftId`. */
export async function filesForSend(sql: Sql, caseId: number, draftId: number): Promise<OutgoingFile[]> {
  if (!(await hasDraftFiles(sql))) return []
  await adoptFiles(sql, caseId, draftId)
  const rows = await sql`SELECT filename, mime_type, size_bytes, base64 FROM draft_files WHERE draft_id = ${draftId} ORDER BY id`
  return rows.map((r: any) => ({ filename: r.filename, mimeType: r.mime_type, base64: r.base64, size: r.size_bytes }))
}

/** True when the reply text tells the customer a file comes with it ("is attached", "please find attached", ...).
 *  Mentions of what the CUSTOMER attached ("thank you for the attached photos") do not count. */
export function saysFileAttached(text: string): boolean {
  const t = String(text || '').toLowerCase()
  return /\b(?:is|are|has been|have been|been|we've|we have|i've|i have)\s+(?:also\s+)?attached\b/.test(t) ||
    /\b(?:please\s+)?find\s+(?:the\s+)?attached\b/.test(t) ||
    /\bhere (?:is|are) (?:the |your )?attached\b/.test(t) ||
    /\battached (?:to this (?:message|email)|herewith|below|here)\b/.test(t) ||
    /\b(?:i|we) (?:have |'ve )?(?:also )?attached\b/.test(t) ||
    /\b(?:we )?(?:enclose|enclosed)\b/.test(t)
}
