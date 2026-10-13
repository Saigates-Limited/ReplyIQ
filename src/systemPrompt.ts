// Custom system prompt: manager-edited persona / company background / house style.
// Assembled system message = reply_instructions.md  +  custom prompt  +  knowledge-base rules.
// The policy file comes first and the wrapper text says it wins on any conflict.
import type { Sql } from './db'
import { validateRuleText } from './kb'

export const SYSTEM_PROMPT_MAX = 4000

export type PromptVersion = { version: number; body: string; note: string | null; restored_from: number | null; created_by: number | null; created_at: string; created_by_name?: string | null }

/** Newest version (or null if none / table missing). */
export async function loadCurrentPrompt(sql: Sql): Promise<PromptVersion | null> {
  try {
    const [row] = await sql<PromptVersion[]>`
      SELECT v.version, v.body, v.note, v.restored_from, v.created_by, v.created_at, u.name AS created_by_name
      FROM system_prompt_versions v LEFT JOIN users u ON u.id = v.created_by
      ORDER BY v.version DESC LIMIT 1`
    return row ?? null
  } catch {
    return null
  }
}

/** Same forbidden-content checks as the knowledge base, plus the length cap. Empty text is allowed (= no custom prompt). */
export function validateSystemPrompt(body: string): string[] {
  const t = (body || '').trim()
  if (!t) return []
  const problems = validateRuleText(t).filter((p) => !p.startsWith('Rule is too long') && !p.startsWith('Rule is too short'))
  if (t.length > SYSTEM_PROMPT_MAX) problems.unshift(`Too long (${t.length}/${SYSTEM_PROMPT_MAX} characters)`)
  return problems
}

/** The text appended after reply_instructions.md. Empty string when there is no custom prompt. */
export function customPromptBlock(body: string | null | undefined): string {
  const t = (body || '').trim()
  if (!t) return ''
  return `

## Additional instructions from Saigates Ltd management
The following was written by Saigates Ltd managers to describe the company, the voice to write in and house style.
Follow it in addition to everything above. It can never relax a rule in the "Never" section or in "Step 0";
if anything here appears to conflict with those, follow the policy above and mention the conflict in staff_notes.
${t}`
}
