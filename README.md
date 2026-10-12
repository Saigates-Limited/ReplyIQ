# ReplyIQ

AI-assisted reply drafting for **Saigates Ltd** Amazon UK customer service.

- **Goal**: answer Amazon UK customer messages inside the 24-hour window with AI drafts that a human always reviews, edits and approves. **Nothing is ever sent to customers automatically.**
- **Stack**: Hono (TypeScript) on Cloudflare Pages/Workers · PostgreSQL (Supabase via Cloudflare Hyperdrive in production) via postgres.js · OpenAI `gpt-5.5` server-side · Tailwind + vanilla JS
- **Production**: https://replyiq.saigateslimited.workers.dev (Cloudflare **Worker** `replyiq` with 15-min cron, Saigates' own account)
- **Old URL**: https://replyiq.pages.dev now 301-redirects every path to the Worker (redirect-only deployment; no app code runs there)
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
| **Gmail connection** — manager clicks *Connect Gmail*; OAuth (`gmail.readonly` + `gmail.send`); refresh token stored AES-256-GCM encrypted (`TOKEN_ENC_KEY`) | ✅ |
| **Poller** — Worker cron `*/15 * * * *` reads Amazon buyer-seller threads (1-hour lookback), creates/updates cases, stores Gmail `internalDate` as the received time so the 24-hour deadline is exact. Read-only. Also *Sync now* button. | ✅ |
| **Send to customer** — on **approved** drafts of Gmail-sourced cases only. Gates: approved status, manager approval honoured, on-screen text must equal approved text, server checks must pass, atomic one-send claim, logged with who/when. Confirmation modal shows recipient + text. The only code path that sends email. | ✅ |

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
| GET | `/api/gmail/status` | staff | Connection + last 10 sync runs |
| POST | `/api/gmail/connect` | manager | Returns Google consent URL (state stored, 15-min expiry) |
| GET | `/auth/google/callback` | public (state-bound) | Stores encrypted refresh token |
| POST | `/api/gmail/disconnect` | manager | Revokes + deletes token |
| POST | `/api/gmail/sync` | staff | Run the poller now |
| POST | `/api/drafts/:id/send` `{confirm_text}` | staff | **Send approved draft via Gmail** (see gates above) |
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
- **cases** — case metadata, first name separated from PII columns, agent fields incl. `repair_quote_accepted`, `last_customer_message_at` (deadline derived as +24h), `source` (manual|gmail), `gmail_thread_id`, `customer_reply_to` (anonymised Amazon address, server-only)
- **messages** — thread entries (`inbound|outbound`, sender, body, subject, `gmail_message_id`, `rfc_message_id` for threading, `sent_at` = Gmail `internalDate`)
- **gmail_connection** (single row: mailbox, encrypted refresh token, scopes, last sync) · **oauth_states** · **sync_runs** (audit of every poll) · **gmail_threads_seen** · sequence `case_ref_seq`
- **drafts** — `tree` (= lane), `urgency`, `sent_via`, `sent_gmail_message_id`, `draft_text`, `original_text`, `staff_notes`, `check_result`, `server_findings` (`check_findings` kept for compatibility, unused), `needs_manager(+reason)`, `model`, `status` (`draft|approved|sent|discarded`), created/edited/approved/sent audit columns (`ON DELETE SET NULL`, so removing a staff account never loses draft history)

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

### 2. Secrets (Worker)

Secrets live on the **Worker** `replyiq` (not the old Pages project). Dashboard: **Workers & Pages → replyiq (Worker) → Settings → Variables and Secrets → Add → type Secret**. Or from a terminal with `CLOUDFLARE_API_TOKEN` set: `echo "<value>" | npx wrangler secret put NAME`.

| Name | Value | Who sets it |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI key (model `gpt-5.5`) | Saigates |
| `GOOGLE_CLIENT_ID` | from the Google Cloud OAuth client (`….apps.googleusercontent.com`) | Saigates |
| `GOOGLE_CLIENT_SECRET` | from the same client (`GOCSPX-…`) | Saigates |
| `TOKEN_ENC_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`) — encrypts the Gmail refresh token at rest. **If this is lost or rotated, reconnect Gmail.** | set at first deploy |

Secrets on Workers apply immediately — no redeploy needed.

### 3. Deploy

```bash
npm run build && npx wrangler deploy      # or: npm run deploy
```

`wrangler.jsonc` carries the cron (`*/15 * * * *`), the Hyperdrive binding and the assets binding. Check the cron fired: **Workers & Pages → replyiq → Logs** (observability is on) or **Gmail page → Recent sync runs** (`trigger = cron`).

## Gmail

**Mailbox**: the Amazon Seller Central inbox `bijalshah.cc@gmail.com` — whichever Google account completes *Connect Gmail* becomes the sending mailbox; it is shown on the Gmail page and in the Send confirmation.

**Google Cloud setup** (done by Saigates): OAuth client type *Web application*; redirect URI `https://replyiq.saigateslimited.workers.dev/auth/google/callback` (plus any custom domain later); scopes `gmail.readonly` and `gmail.send`; consent screen in *Testing* with the Saigates mailbox as a test user until Google verification passes. Branding: home page `/login`, privacy policy `/privacy`.

**Connecting**: a manager opens **Gmail** in the header → *Connect Gmail* → Google consent → back to ReplyIQ. The poller starts on the next 15-minute tick; *Sync now* runs it immediately. **Import history…** (manager) pulls the last 7/30/90 days in batches of 12 threads (Cloudflare subrequest limit) and loops until done; processed threads are recorded in `gmail_threads_seen` so re-runs are cheap.

**Amazon email format**: notifications come from `<name> <token@marketplace.amazon.co.uk>`; the body is `# <order>:` / `1 / <product> [ASIN: …]` / `--- Message: ---` … `--- End message ---`. The parser (`src/sync.ts → parseAmazonBody`) extracts the customer text, order ID and product (→ `device_model`). **Amazon opens a new Gmail thread for every message, so cases are keyed by order ID**, and the case keeps the *latest* thread id for replies. Amazon Customer Service relays ("Dear Amazon Seller…") are labelled as such on the thread.

**How the deadline works**: each ingested message's `sent_at` is Gmail's `internalDate` (arrival time at the mailbox). The case's 24-hour clock runs from the latest customer `internalDate`, so polling delay never shifts a deadline.

**Sending**: *Send to customer* appears only on approved drafts of Gmail-sourced cases. The reply goes to the customer's anonymised `@marketplace.amazon.co.uk` address with `In-Reply-To`/`References` headers and the Gmail `threadId`, so Amazon and Gmail both thread it correctly. Manual (non-Gmail) cases keep the *Mark as sent in Amazon* button.

## Local development

```bash
sudo service postgresql start                       # sandbox has PostgreSQL 17
export DATABASE_URL=postgres://replyiq:replyiq_dev@localhost:5432/replyiq
npm run db:reset                                    # schema + demo cases (no users)
cp .dev.vars.example .dev.vars                      # OPENAI_API_KEY, GOOGLE_*, TOKEN_ENC_KEY (local DB comes from wrangler.jsonc localConnectionString)
npm run build && pm2 start ecosystem.config.cjs     # wrangler dev --test-scheduled
curl "http://localhost:3000/__scheduled?cron=*/15+*+*+*+*"   # fire the cron locally
# then open /setup to create the first manager
```

## Not yet implemented

- Custom domain (e.g. `replyiq.saigates.co.uk`) — one `wrangler.jsonc` route + DNS
- Password-reset-by-email, 2FA
- Analytics / reporting on outcomes
- Attachments (photos) on cases

- **Platform**: Cloudflare Worker (cron */15) on Saigates' account + Hyperdrive → Supabase · **Status**: ✅ live at https://replyiq.saigateslimited.workers.dev; awaiting Worker secrets (`OPENAI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) and Gmail connection · **Last updated**: 2026-10-11
