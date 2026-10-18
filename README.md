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


## Phase 8 — Amazon notices, trackers, tone, tickets, draft modes, UI v2 (LIVE 2026-10-12)

**Production:** https://replyiq.saigateslimited.workers.dev · Worker version `3dc27e1e` · DB migrations applied through **0008 + 0008b** (verified: 4 triggers + status CHECK + archive columns).

### Features
- Gmail sync reads customer messages **and** Amazon notices: `atoz-guarantee-no-reply@`, `cb-seller-notification@`, `donotreply@amazon.com` (Return authorisation notifications + "Your email to <Name>" Seller Central reply copies).
- `amazon_events`: A-to-Z (3-day deadline when info requested), returns, chargebacks (7-day deadline). Statuses: A-to-Z/chargeback `open → info_requested → response_sent → won/lost/closed`; returns `requested → received → inspected → refunded/closed` (DB CHECK).
- Return reason/comment mentioning heat/overheating/swelling → `battery_flag` → battery rule forced, needs_manager, urgency high.
- Tone per customer message (`gpt-6-luna`), staff override; queue sort: overdue → angry/dispute → deadline.
- Tickets: assignee, internal notes (never sent / never to OpenAI). Archive (manager only; DB refuses DELETE on cases).
- Draft modes: customer | seller_central_atoz | seller_central_return | chargeback_evidence. Non-customer modes can never be emailed.
- UI v2: dark sidebar, Dashboard, 3-pane Inbox with search, A-to-Z/Returns/Chargebacks trackers, Reply policy (renders `reply_instructions.md`), Settings (status only). Responsive (phone list/detail toggle).
- PII: order IDs protected from redaction; "Shipping address:" blocks redacted; chargeback name/address never reach OpenAI.

### Routes
Pages: `/` dashboard · `/inbox` · `/cases/:id` · `/atoz` · `/returns` · `/chargebacks` · `/policy` · `/settings` · `/gmail` · `/staff` (manager).
API additions: `GET /api/events?kind=&status=` · `GET /api/events/counts` · `PATCH /api/events/:id` · `PATCH /api/messages/:id/tone` · `POST /api/gmail/tone-backfill` · `POST /api/cases/:id/archive|unarchive` (manager) · `GET /api/policy` · `GET /api/settings` · `POST /api/cases/:id/drafts {mode}`.

### Migrations (run in order in Supabase SQL Editor)
`0006_events_tickets_tone.sql` → `0007_draft_mode.sql` → `0008_hardening.sql` → `0008b_archive_columns.sql`. All additive; `db/schema.sql` is the from-scratch equivalent (validated).

### Next — Step C
R2 bucket (token needs "Workers R2 Storage: Edit"), Gmail attachments shown in chat, agent uploads limited to Amazon's rules (PDF/JPG/JPEG/PNG/XML, ≤5 files, ≤10 MB per message), attachments never sent to OpenAI, chargeback email only after Reply-To verified on a real notice.

## Phase 9 (LIVE 2026-10-13) — tone filter, bulk actions, SP-API orders, review requests
- **Tone filter**: multi-select chips above the Inbox list (persisted), combines with status filter + search.
- **Bulk actions**: `POST /api/cases/bulk {ids, action, value}` → `{done, skipped[{case_ref, reason}]}`.
  Actions: resolve · status · assign · tone · archive (manager). Resolve skips open A-to-Z / chargeback, `battery_flag`,
  drafts awaiting manager. No bulk send exists.
- **SP-API** (`src/spapi.ts`, Orders **v2026-01-01**, Solicitations v1; EU endpoint; UK marketplace `A1F83G8C2ARO7P`):
  - Secrets: `SPAPI_LWA_CLIENT_ID`, `SPAPI_LWA_CLIENT_SECRET`, `SPAPI_REFRESH_TOKEN`. Roles: Inventory & Order Tracking, Buyer Solicitation.
    `includedData=FULFILLMENT,PACKAGES,PROCEEDS` only — never BUYER/RECIPIENT.
  - `POST /api/cases/:id/fetch-order` (auto on first open; 6 h cache in `amazon_orders`): fills EMPTY fields only —
    delivery_date (actual from `packages[].packageStatus=DELIVERED` → `amazon_actual`; else promised `deliverByWindow.latest` → `amazon_estimated`),
    tracking_number, carrier, device_model. Staff-typed dates set `delivery_date_source='staff'` and are never overwritten.
    The AI payload carries `delivery_date_basis` so estimated dates are treated as unconfirmed.
  - `GET|POST /api/cases/:id/review-request`: rule = delivery+7d ≤ today ≤ delivery+30d (identical for all orders) →
    once per order (`review_requests.order_id UNIQUE`) → Amazon `getSolicitationActionsForOrder` → `createProductReviewAndSellerFeedbackSolicitation`.
    Result logged as an event message on the case. Manual button only; automation is a separate approval.
  - `GET /api/spapi/status`, `POST /api/spapi/test` (manager; LWA exchange only). Settings page shows state + Test connection.
- Migration **0010_spapi.sql** (`amazon_orders`, `review_requests`, `cases.delivery_date_source`, `cases.spapi_synced_at`). App tolerates its absence.

## Phase 10 (LIVE 2026-10-13) — collapsible sidebar, dark mode, Knowledge base, Decision Trees
- **Collapsible sidebar** (desktop): `«` button in the sidebar header → icon-only rail (badges stay visible, titles on hover).
  Remembered per browser (`localStorage riq.sidebar`), applied before first paint via `html.sb-collapsed`.
- **Dark / light toggle**: moon/sun button in the top bar. `html.dark` + Tailwind `darkMode:'class'`; theme overrides live in
  `public/static/style.css` (`html.dark …`). Remembered per browser (`riq.theme`). Default is light.
- **Knowledge base** (`/knowledge`, `src/kb.ts`, `src/routes/kb.ts`): staff-added **rules / facts / phrasing examples** for the drafting model.
  - Prompt = `reply_instructions.md` (unchanged, still the file) **+ active rules appended after it** under a heading that says they can
    never relax the "Never" list or Step 0. The deterministic `serverChecks` guardrails still run on every draft.
  - Workflow: agents **propose** (status `draft`), managers **approve & activate / reject / retire**; managers can also save straight to active.
    Max 60 active rules, 1 500 chars each; `modes` = all | customer | amazon (Seller Central statements).
  - `validateRuleText` rejects text that asks for PIN/password/phone/email/ID, says "waterproof", mentions reviews/feedback, refuses a return,
    says "no rights", contains bank details, contains links, or tries to override instructions ("ignore previous…", "act as…").
  - Audit: every draft stores `drafts.kb_rule_ids` (the rules in force when it was generated); the card shows "used in N drafts".
    No DELETE — DB trigger refuses it; retire instead.
  - API: `GET /api/kb?status=live|active|draft|all` · `POST /api/kb` · `PATCH /api/kb/:id` · `POST /api/kb/:id/activate|reject|retire|reorder` (manager) ·
    `POST /api/kb/check` (live validation) · `GET /api/kb/preview` (manager; exact prompt block). `GET /api/events/counts` adds `kb_pending` (manager badge).
  - Migration **0011_knowledge_base.sql** (`kb_rules`, `drafts.kb_rule_ids`, triggers). App tolerates its absence (page shows a banner; drafts still work).
- **Decision Trees** (`/decision-trees`): flowchart cards built from the lanes in `reply_instructions.md` — Step 0, Faults by days since delivery
  (0–30 / 31–90 / 91–180 / 181–365 / 365+), Battery, Item not received, Locked phone, Change of mind, Partial refund, Paid repair, eSIM/charger —
  with the "Never" list pinned at the top. Category filter; cards remember open/closed state. Static content (`TREES` in `app.js`) — update it when the policy changes.

## Phase 10b (LIVE 2026-10-13) — Custom system prompt (managers only)
- **Where**: Settings → "Custom system prompt" card → `/settings/prompt`. Agents get 403 on every `/api/prompt/*` route, including reads.
- **Assembled system message** (`assembleSystemPrompt` in `src/ai.ts`), fixed order: `reply_instructions.md` → custom prompt
  (`## Additional instructions from Saigates Ltd management`, wrapper says it can never relax Never/Step 0) → knowledge-base rules.
- **Versioned, append-only** (`system_prompt_versions`): every save is a new row; roll back = new version with the old text
  (`restored_from`). DB triggers refuse UPDATE and DELETE. Saving identical text is rejected. Empty body = no custom prompt.
- **Checks**: same forbidden-content rules as the knowledge base (`validateSystemPrompt` → `validateRuleText`) + 4 000-char cap; live as you type.
- **Test before saving**: `POST /api/prompt/test {body, case_id, mode}` generates a throwaway draft with the unsaved text through the
  normal `generateDraft` + `serverChecks` + manager-decision path; nothing is written to `drafts` and the case is untouched.
- **Audit**: `drafts.system_prompt_version` records the version in force for every real draft; history shows "N drafts" per version.
- API: `GET /api/prompt` · `POST /api/prompt/check` · `POST /api/prompt` · `POST /api/prompt/rollback/:v` · `GET /api/prompt/preview?body=&mode=` · `POST /api/prompt/test`.
- Migration **0012_system_prompt.sql**. App tolerates its absence (editor shows a banner; drafts run without a custom prompt).

## Phase 11 (LIVE 2026-10-13) — Multiple Gmail mailboxes
- **Mailboxes**: `gmail_connection` is now a list (migration **0013**): `label` (Manager / Agent / Returns / …), `enabled` (polled or paused),
  `is_default` (used for cases with no mailbox). One row per Gmail address (unique, case-insensitive); reconnecting the same address
  refreshes its token and keeps its history. Planned set-up: **Manager = saigateslimited@gmail.com**, **Agent = bijalshah.cc@gmail.com**.
- **Routing**: every case, message, Amazon event and sync run records `mailbox_id`. **Send to customer** replies from the case's own mailbox
  (`accessToken(env, sql, case.mailbox_id)`); the send dialog shows the From address. Attachment proxy and MIME diagnostics use the message's mailbox.
  Disconnecting a mailbox keeps its cases (`ON DELETE SET NULL` → replies fall back to the default mailbox).
- **Sync**: `runSync` loops over enabled mailboxes (cron and manual); one failing mailbox does not stop the others; `sync_runs` has one row per mailbox.
  "Seen thread" keys are prefixed with the mailbox id because Gmail thread ids are per account. `isOurs()` treats mail from *any* connected address as ours.
- **UI** (`/gmail`): a card per mailbox — Sync this mailbox, Import history (7/30/90 d), Rename, Make default, Pause/Resume, Reconnect, Disconnect —
  plus "Add another mailbox" with a label picker (sign in to Google *as that mailbox*). Case view shows "Via mailbox" and which address will reply.
- API: `GET /api/gmail/status` → `mailboxes[]`, `multi_mailbox` · `POST /api/gmail/connect {label}` · `POST /api/gmail/disconnect {mailbox_id}` ·
  `PATCH /api/gmail/mailboxes/:id {label, enabled, is_default}` · `POST /api/gmail/sync {days?, mailbox_id?}`.
- App tolerates the migration not being applied yet (single-mailbox behaviour; the page shows a banner).
- **Cross-mailbox de-duplication**: the same Amazon email reaches every connected mailbox with a different Gmail id. Sync now skips a
  message whose RFC `Message-ID` header (or identical text within 2 min on the same case) is already stored; Amazon notices are
  deduped the same way. One-off clean-up for copies imported before this: Gmail page → **Remove duplicates**
  (`POST /api/gmail/dedupe {apply}`; preview first; keeps the earliest copy, re-points attachments, merges duplicate event rows).

## Phase 12 (LIVE 2026-10-13) — New reply policy, templates, KB seed, system prompt
- **`reply_instructions.md` rewritten** from the "UK Renewed Smartphone Customer Support Agent" brief: Step 0 (refund/A-to-z/chargeback
  open; legal mentions; safety), expanded Never list (no liability admission, no accusations, no "fake" parts, no refurbed on Amazon, no
  rejection without inspection), product positioning, 15 case types, physical damage / safety / battery / Unknown Part / overheating /
  refund / return instructions (Royal Mail portal) / iCloud / cosmetic / repeat fault / replacement-first / INR & delivery disputes /
  accessories / SIM / reviews / troubleshooting / out of warranty / paid repair, default reply structure. Sign-off: **Kind regards, Customer Support Team**.
- **Guardrails updated to match** (`serverChecks`): `never_accuse` (fraud / you damaged it / this proves), `never_fake_parts`,
  `no_liability_admission`, `no_unconditional_promise` (warn), `never_refurbed`, `never_refuse_return` now allows refusal only when
  the 12-month warranty has clearly expired (staff/actual delivery date > 365 d), `safety_stop_using` only for swelling / lifting
  screen / excessive heat (not battery-health enquiries), `battery_overexplain` (warn on UN3481 / dangerous-goods wording), style warnings
  (sign-off, em dash, "I", >4,000 chars). Tested on 13 scenarios.
- **Reply templates** (`/templates`, `reply_templates`, migration **0014**): 13 seeded short replies (found accessory, return proof,
  replacement address, photos requested, photos cannot upload, return instructions, iCloud still linked, replacement before return,
  INR check-first, Royal Mail confirmed delivery, out of warranty, SIM left in return, dispatched). Draft editor → **Insert template…**
  fills `[Name]` / `[tracking]` from the case; other `[placeholders]` stay visible. Managers add/edit/retire; same content checks as the KB.
- **Knowledge base seeded** (14 active facts/rules/examples from the brief). KB validator now allows the Royal Mail returns-portal link only.
- **Custom system prompt**: seed text (company, voice, seller position, house style) saved as a new version via the editor.
- **Decision Trees** rebuilt to the new lanes. Gmail From name is now "Customer Support Team".
- OpenAI JSON parsing is more tolerant and logs the finish reason / head of any non-JSON reply.

## Phase 13 (LIVE 2026-10-14) — Carrier desk: customer message → carrier investigation → claim → payout

One loop instead of two tools. A customer writes "it says delivered but I never got it"; ReplyIQ already knows the order,
the tracking number, the carrier, the ship date and the price, so the Royal Mail / DPD email is ready before anyone asks.

```
customer message ──► detect issue (no AI) ──► parcel "Ready to raise" + investigation email prepared
                                                          │  one click: Approve & send (from ecom@ via the carrier mailbox)
                                                          ▼
carrier mail (every 15 min) ──► match by tracking / case ref / thread ──► classify ──► status + next email prepared
   auto-ack: store case ref, clock keeps running          holding reply: clock restarts
   "asked us for X": Needs us                            "lost – claim": claim pack prepared, customer flagged "tell the customer"
   "delivered (GPS/POD)": Rejected → challenge or tell   "claim settled £X": Paid / Partially paid
reply late (3 wd RM, 5 wd DPD/FedEx/Evri, 10 wd claims) ──► chase prepared automatically, threaded into the carrier's own email
```

**What's new**
- **Case screen → Carrier panel**: what the customer reported, the tracking/carrier from Amazon, an optional delivery
  address (sent to the carrier only), and **Open carrier investigation**. Shows each parcel's status, carrier case
  reference, working days waiting, next step, ready emails, and a blue **"New carrier news for the customer"** banner
  with *Draft customer update* (the AI sees carrier events on the timeline as `carrier_update`, facts only).
- **Carrier desk** (`/carriers`): KPI tiles (open by carrier, chase now, needs us, tell the customer, £ at risk,
  £ recovered), views (Chase now · Needs us · Waiting · All open · Closed · Everything) and **Review N ready emails**:
  a queue that opens each prepared email in turn — edit if needed, then *Approve & send* or *Skip*.
- **Parcel page** (`/carriers/:id`): full timeline (our emails, carrier emails with their classification, notes),
  editable details (status, value, claimed, paid, refs, claim ref…), and *Prepare an email*: investigation, chase,
  reply with info, challenge, claim pack, postage refund.
- **Dashboard strip** and **sidebar badge** (chase now + needs us + customer updates). Inbox items show a truck chip
  (`NEWS` when there is carrier news for the customer; `?` when the customer reported a delivery problem but no parcel is open).
- **Import** from the old Carrier Claims Desk dashboard (manager, Settings ⚙ on the carrier desk). Idempotent; never
  overwrites a parcel ReplyIQ already tracks live (it only fills gaps and merges case references).

**Safety (same discipline as customer replies)**
- Carrier emails are written from **server-side templates, not the AI** — they need the recipient's name and address,
  which never go to OpenAI. Zero model cost, instant.
- Sending is only `POST /api/carrier/drafts/:id/send`, one click from the review screen, with gates: the text on screen
  must equal the saved text; the recipient must be a carrier domain (royalmail.com, dpd.co.uk, dpd.uk, dpdgroup.co.uk,
  fedex.com, evri.com, parcelforce.co.uk, plus any a manager adds); no `[MISSING: …]` left; challenges (and claim packs
  over £500) need a manager; claim packs can never be emailed; atomic one-send claim.
- The cron only **reads** Gmail and **prepares** drafts (one live draft per parcel and kind, enforced by a unique index).
- Carrier cases are closed, never deleted (DB trigger), so recovery figures stay right.

**Setup after merging**
1. Supabase SQL editor: run `db/migrations/0015_carrier_desk.sql` (additive, safe to re-run). Deploy.
2. Gmail page → *Connect a mailbox* → sign in as **saigateslimited@gmail.com** (it receives copies of
   ecom@saigates.com) and label it "Carriers".
3. Carrier desk → ⚙ Settings: tick that mailbox under *Mailboxes that receive carrier mail*; set *From address* to
   `ecom@saigates.com` **only if** it is a verified "Send mail as" alias in that Gmail account (otherwise Gmail sends
   from the account's own address); Cc `sagar.patel@saigates.com` if wanted; check the signature and DPD/FedEx/Evri addresses.
4. Optional: import `carrier-claims-export.json` (Settings ⚙ → Import). Press *Check carrier mail* once.

**API** (all staff unless noted): `GET /api/carrier/cases?view=` · `GET /api/carrier/summary` · `GET /api/carrier/cases/:id` ·
`GET /api/carrier/for-case/:caseId` · `POST /api/carrier/open {case_id, issue?, force?}` · `POST /api/carrier/cases` ·
`PATCH /api/carrier/cases/:id` · `POST /api/carrier/cases/:id/drafts {kind}` · `PATCH /api/carrier/drafts/:id` ·
`POST /api/carrier/drafts/:id/send` · `POST /api/carrier/drafts/:id/discard` · `POST /api/carrier/cases/:id/claim-submitted` ·
`POST /api/carrier/cases/:id/note` · `POST /api/carrier/sync {days?}` · `GET|PUT /api/carrier/settings` (PUT manager) ·
`POST /api/carrier/import` (manager). `PATCH /api/gmail/mailboxes/:id {carrier_mail}` (manager).

**Code**: `src/carrier/` — `detect.ts` (customer wording → issue), `carriers.ts` (registry, tracking formats),
`classify.ts` (carrier email → auto-ack / holding / info request / lost / delivered / rejected / settled / escalation),
`engine.ts` (status rules, SLA, next email), `templates.ts` (emails + claim pack), `workdays.ts` (England & Wales
working days, bank holidays to end-2027 — extend the list yearly), `service.ts` (DB + Gmail). Route: `src/routes/carrier.ts`.
UI: `public/static/carrier.js`.

**Tests**: `npm run test:unit` (detection, classification on real carrier wording, working days, status rules, templates) ·
`npm run test:e2e` (drives the real app against a throwaway local Postgres with a fake Gmail: customer message →
auto-prepared investigation → send gates → auto-ack/holding reply → lost → claim pack → claim submitted → part payment →
overdue chase threaded into Royal Mail's thread → customer-update flag → manager/placeholder gates → import).

**Also fixed**: `src/sync.ts` used `markSeen()` before declaring it, so any Amazon thread with no parseable customer text
threw a ReferenceError and stopped that mailbox's sync run.

## Phase 14 (LIVE 2026-10-18) — Free-plan CPU fixes, photo attachments, "Request changes", Inbox folders

**Why the Carrier desk 503'd.** Cloudflare's Workers *Free* plan gives each request ~10 ms CPU. Two things blew it: the
carrier summary decorated every case in JS (building an `Intl.DateTimeFormat` per row), and the legacy import did ~1.7 s
of CPU in one request. Once an isolate overruns, Cloudflare fails *every* later request on it (`exceededCpu` → 503) until
it is recycled, which is why the whole app went down for minutes after an import. Fixes:
- `/api/carrier/summary` is one aggregate SQL query; Intl formatters are cached per isolate (`src/carrier/workdays.ts`).
- Import is chunked by the browser (15 parcels / request) with batched lookups and one `INSERT … unnest` per parcel.
- Attachment proxy decodes with the native `Uint8Array.fromBase64` (24 ms for 9 MB vs 2.5 s with `atob` + loop) and
  skips `JSON.parse` on the multi-MB Gmail response. **This is why photos were not showing**: the old decode exceeded the
  CPU limit on anything bigger than ~100 KB, so the `<img>` silently failed.
- Recommendation parked by Sagar: Workers Paid (US$5/mo) lifts the limit to 30 s/request. Remind once everything is functional.

**Photos in chat.** Thumbnails now show a spinner until the proxy answers and a visible "Could not load — click to open"
if it fails. `image/jpg` and extension-based types are accepted. Responses are `Cache-Control: private, max-age=3600`.

**"Not right? Tell the AI what to change."** Under every editable draft: the agent writes the change they want
(e.g. "offer the repair first, drop the 30-day line"), presses *Rewrite with these changes*, and the model rewrites the
reply with the previous draft + the instruction appended to the normal prompt. The policy still overrides the note; if a
requested change would break it, the model refuses it under staff notes. The old draft is marked `discarded`; the new one
records `revision_of` and `agent_guidance` (migration **0016**, optional — works without it, just no audit trail).
`POST /api/drafts/:id/revise {guidance, draft_text?}`.

**Inbox folders** (sidebar, under Inbox): **Open** (every unresolved case — the old *Active* + *Open* merged) ·
**Awaiting customer** · **Update customer** (new status: we owe the customer news, e.g. a carrier decision) ·
**Resolved** · **Archive** (managers). URLs `/inbox/<folder>`; counts come from `/api/events/counts`
(`messages`, `awaiting_customer`, `update_customer`, `resolved`, `archived`). `update_customer` is a new `cases.status`
value (no DB change — the column has no CHECK). Bulk "Set status…" and the case-status dropdown include it.

### Migrations
1. `db/migrations/0016_draft_revisions.sql` — optional audit columns for revisions (safe to re-run).
