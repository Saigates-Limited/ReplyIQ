# ReplyIQ

AI-assisted reply drafting for **Saigates Ltd** Amazon UK customer service.

- **Goal**: answer Amazon UK customer messages inside the 24-hour window with AI drafts that a human always reviews, edits and approves. **Nothing is ever sent to customers automatically.**
- **Stack**: Hono (TypeScript) on Cloudflare Pages/Workers · PostgreSQL (Supabase via Cloudflare Hyperdrive in production) via postgres.js · OpenAI `gpt-5.5` server-side · Tailwind + vanilla JS
- **Production**: https://replyiq.pages.dev (Cloudflare Pages project `replyiq`, Saigates' own account)
- **Sandbox preview**: https://3000-id2nlba4e4s5y3pr1acd5-02b9cc79.sandbox.novita.ai
  - No demo accounts. On a fresh database the app shows **`/setup`** once, to create the first manager; after that it is permanently disabled.

## Features

| Area | Status |
|---|---|
| **Staff login** — email + password (PBKDF2-SHA256, 100k iterations), HttpOnly session cookie (7 days), login throttling. Every page and every `/api/*` route is blocked without a session. | ✅ |
| **Roles** — `agent` and `manager`. Managers get a Staff page to add/deactivate users, change roles and reset passwords. | ✅ |
| **First-run setup** — `/setup` creates the first manager while the `users` table is empty, then self-disables (atomic `INSERT … WHERE NOT EXISTS`). No seeded demo accounts. | ✅ |
| **Case queue** sorted by reply deadline (last customer message + 24h, round the clock, no pausing) with overdue / due-soon highlighting and filters | ✅ |
| **Case screen** — email thread, customer panel, auto-saving agent fields (order ID, device model, delivery date, refund issued, A-to-Z open, in stock, approved repair price, **repair quote accepted**, tracking number, carrier), case status | ✅ |
| **Generate draft** — server-side call to OpenAI `gpt-5.5` using `reply_instructions.md` as the system prompt; returns the reply, lane used, staff notes, `urgency` and `needs_manager`; the server computes PASS/FAIL | ✅ |
| **Guardrail checks** — model self-check **plus** deterministic server checks (PII leakage incl. street address, unsupported refund/replacement promises, unapproved prices, ID / customer card-detail requests, accusations, "waterproof", unsafe charging advice, off-platform dealings, greeting/sign-off). Any server *fail* forces FAIL and blocks approval. | ✅ |
| **Bank details rule** — our bank/payment details are allowed in a reply **only** when `approved_repair_price` is set **and** `repair_quote_accepted` = yes; blocked (FAIL) in every other case. | ✅ |
| **Battery returns rule** — the Royal Mail return label and the UN3481 lithium-battery label are allowed in every battery case (incl. swollen/overheating) alongside "stop using and charging the phone"; a battery case that asks for a return *without* mentioning UN3481 gets a warning. | ✅ |
| **Edit → Approve → Mark as sent** — edits are re-checked and un-approve the draft; `needs_manager` drafts can only be approved by a manager; FAIL drafts cannot be approved; "Mark as sent" logs the outbound message on the thread after the agent sends it manually in Amazon | ✅ |
| Transparency — the API returns the exact payload sent to the model (`sent_to_model`) | ✅ |
| Gmail integration | ⏳ redirect URI reserved, see below |

## Privacy: what reaches OpenAI

Built from an explicit allow-list in `src/ai.ts → buildPayload()`:

- `customer_first_name` **only** — never surname, email, phone or address (these live in separate columns that are never read by the AI code path)
- Thread text, after redaction of: the known surname/email/phone/address values (and each comma-separated part of the address), any email address, any UK phone number (mobile or landline, +44 or 0), **street-address lines** (e.g. "Flat 3, 22 Castle Street", "9 Abbey Close"), UK postcodes, and "First Last" signatures
- Every OpenAI request is sent with **`store: false`** (OpenAI does not retain the prompt or completion)
- Agent-filled case fields (order ID, device, dates, yes/no flags, approved price, tracking, carrier)

`OPENAI_API_KEY` is a Cloudflare secret read only inside the Worker. The browser never sees it; the browser only calls `POST /api/cases/:id/drafts`.

## `reply_instructions.md`

The official Saigates instructions (supplied 2026-10-11). Where it disagrees with the earlier flowcharts, **the file wins**. It defines Step 0 (refund issued / A-to-Z → acknowledge only + manager), the "Never" list, the £15 refund limit, fault lanes by `days_since_delivery`, battery handling (stop using/charging + Royal Mail label + UN3481), INR, locked phones, eSIM, compatibility, change of mind, paid repair, the return checklist, and the JSON output (`reply`, `lane`, `needs_manager`, `urgency`, `staff_notes`). It is bundled at build time (`import ... '?raw'`), so run `npm run build` (and redeploy) after editing.

The server checker (`src/ai.ts → serverChecks`) mirrors the file one-for-one: every "Never" item is a **fail**; bank details pass only for an approved + accepted paid repair; battery cases must say stop using/charging (fail) and are expected to mention Royal Mail + UN3481 (warn); refunds over £15 and missing return checklists are **warnings** for the agent. `needs_manager` is also enforced server-side from the case data (refund issued, A-to-Z open, legal/Trading Standards/chargeback mentions, swollen/hot/burning battery, refund > £15).

## API

All routes except `/login`, `/setup`, `/privacy`, `POST /api/auth/login|logout|setup`, `/api/health`, `/static/*` and `/auth/google/callback` require a session.

| Method | Path | Who | Description |
|---|---|---|---|
| GET | `/api/auth/setup-status` | public | `{needs_setup}` — true only when no users exist |
| POST | `/api/auth/setup` `{name,email,password}` | public, first run only | Creates the first manager; 409 once any user exists |
| POST | `/api/auth/login` `{email,password}` | public | Sets session cookie |
| POST | `/api/auth/logout` | public | Clears session |
| GET | `/api/auth/me` | staff | Current user |
| POST | `/api/auth/password` `{current,next}` | staff | Change own password |
| GET/POST | `/api/auth/users` | manager | List / create staff |
| PATCH | `/api/auth/users/:id` `{role,is_active,name,password}` | manager | Update staff |
| GET | `/api/cases?status=active\|open\|awaiting_customer\|resolved\|all` | staff | Queue ordered by deadline |
| GET | `/api/cases/:id` | staff | Case + messages + drafts |
| PATCH | `/api/cases/:id` | staff | Update agent fields / status (422 on bad input) |
| POST | `/api/cases/:id/drafts` | staff | **Generate draft** (OpenAI, server-side) |
| PATCH | `/api/drafts/:id` `{draft_text,staff_notes}` | staff | Edit; re-runs server checks; un-approves |
| POST | `/api/drafts/:id/approve` | staff / **manager if needs_manager** | Approve (blocked if FAIL) |
| POST | `/api/drafts/:id/unapprove` | approver or manager | Withdraw approval |
| POST | `/api/drafts/:id/record-sent` | staff | Log that the approved text was sent manually via Amazon |
| POST | `/api/drafts/:id/discard` | staff | Discard |

## Data model (PostgreSQL) — `db/schema.sql`

- **users** — email, name, role (`agent|manager`), `password_hash`, `is_active`, `last_login_at`
- **sessions** — SHA-256 of cookie token → user, `expires_at`
- **cases** — case metadata, first name separated from PII columns, agent fields incl. `repair_quote_accepted`, `last_customer_message_at` (deadline derived as +24h)
- **messages** — thread entries (`inbound|outbound`, sender, body, sent_at)
- **drafts** — `tree` (= lane), `urgency`, `draft_text`, `original_text`, `staff_notes`, `check_result`, `server_findings` (`check_findings` kept for compatibility, unused), `needs_manager(+reason)`, `model`, `status` (`draft|approved|sent|discarded`), created/edited/approved/sent audit columns (`ON DELETE SET NULL`, so removing a staff account never loses draft history)

## Production setup (Supabase + Cloudflare Pages)

### 1. Database — Supabase via Cloudflare Hyperdrive

**Why Hyperdrive:** a direct TLS connection from a Cloudflare Worker to Supabase's Supavisor pooler does not complete the handshake (verified from the edge: plain TCP connects, TLS loops until the subrequest limit). Hyperdrive terminates the Postgres TLS session inside Cloudflare and exposes a local binding to the Worker, which postgres.js uses with `prepare: false`, `max: 1`, one connection per request.

Production configuration (already created, bound in `wrangler.jsonc` as `HYPERDRIVE`):

| Setting | Value |
|---|---|
| Hyperdrive name / ID | `replyiq-db` / `619303c46e164a8eab43ef1101c16470` |
| Origin host | `aws-0-eu-west-2.pooler.supabase.com` (**Session pooler**) |
| Port | **5432** (session mode — Hyperdrive needs this, not the 6543 transaction pooler) |
| User | `postgres.<project-ref>` |
| Caching | Max Age 1 s, Stale-While-Revalidate 0 |

If the Supabase password is ever rotated, update it in **Cloudflare → Workers & Pages → Hyperdrive → replyiq-db → Settings**; no redeploy needed.

**Create the tables (Supabase SQL Editor — no psql needed):**

1. Supabase Dashboard → **SQL Editor** → **New query**.
2. Paste the full contents of [`db/schema.sql`](db/schema.sql) and click **Run**. (Idempotent — safe to re-run.)
3. If you are upgrading an existing database, also run each file in `db/migrations/` in order.
4. Do **not** run `db/seed.sql` in production — it is demo cases only.

Data API can stay off — the app speaks plain Postgres.

**First login:** open `https://replyiq.pages.dev/setup` and create your own manager account. The page is disabled permanently as soon as one account exists; add further staff from the **Staff** page.

### 2. Secrets — where to paste them (never in chat, never in git)

**Cloudflare Dashboard → Workers & Pages → `replyiq` → Settings → Environment variables → Production → Add variable → tick "Encrypt" (Secret):**

| Name | Value |
|---|---|
| `OPENAI_API_KEY` | your OpenAI key (model `gpt-5.5`) |
| `DATABASE_URL` | *optional* — only used when no Hyperdrive binding exists (e.g. local dev). Production uses Hyperdrive. |

Or from a terminal with `CLOUDFLARE_API_TOKEN` set:

```bash
npx wrangler pages secret put OPENAI_API_KEY --project-name replyiq
```

Redeploy after adding secrets (Deployments → ⋯ → Retry deployment, or `npm run build && npx wrangler pages deploy dist --project-name replyiq`). Until then https://replyiq.pages.dev shows a "not configured" page. For local development paste the same values into `.dev.vars` (gitignored).

### 3. Deploy

```bash
npm run build
npx wrangler pages deploy dist --project-name replyiq --branch main
```

## Gmail (future phase) — scheduled polling

**Can this run every 2 minutes with nobody logged in?** Not on Cloudflare **Pages** alone — Pages Functions have no cron triggers. Two options, both small:

| Option | What it is | Effort |
|---|---|---|
| **A. Cloudflare Worker with a Cron Trigger** (recommended) | Deploy the same codebase as a *Worker* instead of Pages (`wrangler.jsonc` → `main` + `triggers.crons = ["*/2 * * * *"]`, static assets via `[assets]`). A `scheduled()` handler polls Gmail and writes cases to Supabase. Runs 24/7 regardless of browser sessions. | ~1 hour; one-time switch from Pages to Workers, same account, same URL style (`*.workers.dev` or custom domain). |
| **B. Keep Pages, add Supabase `pg_cron` + `pg_net`** | A Postgres cron job in Supabase calls `POST https://<domain>/api/jobs/gmail-sync` every 2 minutes with a secret header. | ~30 min; no infra change, but the poll runs in a request context (CPU-time limits apply). |

Both use Gmail **push-free polling** (`users.messages.list` with `q=newer_than:10m from:marketplace.amazon.co.uk`, ~720 calls/day — well inside Gmail's free quota), store the refresh token as a secret, and need the redirect URI below. I recommend **A** — it is the standard Cloudflare answer and removes the dependency on a browser being open. Note: Cloudflare cron triggers are only available when you deploy to your **own** Cloudflare account (not the Genspark-hosted path).

### Google OAuth consent screen (Branding)

| Field | Value |
|---|---|
| Application home page | `https://replyiq.pages.dev/login` (public, no login required) |
| Privacy policy | `https://replyiq.pages.dev/privacy` (public) |
| Authorised domain | `replyiq.pages.dev` |

### Google OAuth redirect URI

Register this **Authorised redirect URI** in Google Cloud → APIs & Services → Credentials → OAuth 2.0 Client (Web application):

```
https://<your-production-domain>/auth/google/callback
```

Live value now: **`https://replyiq.pages.dev/auth/google/callback`** (add a second entry if you later attach a custom domain, e.g. `https://replyiq.saigates.co.uk/auth/google/callback`). Add the sandbox URL too if you want to test before going live: `https://3000-id2nlba4e4s5y3pr1acd5-02b9cc79.sandbox.novita.ai/auth/google/callback`. Scopes will be `gmail.readonly` (to ingest threads) and, only if you later want ReplyIQ to create Gmail *drafts* (still never send), `gmail.compose`. The route exists already and returns 501 until the integration is built; it will need `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` secrets.

## Local development

```bash
sudo service postgresql start                       # sandbox has PostgreSQL 17
export DATABASE_URL=postgres://replyiq:replyiq_dev@localhost:5432/replyiq
npm run db:reset                                    # schema + demo cases (no users)
cp .dev.vars.example .dev.vars                      # fill DATABASE_URL, OPENAI_API_KEY
npm run build && pm2 start ecosystem.config.cjs
# then open /setup to create the first manager
```

## Not yet implemented

- Gmail ingestion (new emails → cases/threads)
- Password-reset-by-email, 2FA
- Analytics / reporting on outcomes
- Attachments (photos) on cases

- **Platform**: Cloudflare Pages on Saigates' account + Hyperdrive → Supabase (switch to Worker + Cron for the Gmail phase) · **Status**: ✅ live at https://replyiq.pages.dev, awaiting first manager account via `/setup` · **Last updated**: 2026-10-11
