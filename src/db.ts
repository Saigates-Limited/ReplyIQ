import postgres from 'postgres'

export type Bindings = {
  DATABASE_URL: string
  OPENAI_API_KEY?: string // server-only; never exposed to the browser
}

// One connection per request on Workers (no long-lived pools at the edge).
export function getDb(env: Bindings) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured')
  return postgres(env.DATABASE_URL, {
    max: 1,
    prepare: false,
    fetch_types: false,
    idle_timeout: 5,
  })
}

export type Sql = ReturnType<typeof getDb>
