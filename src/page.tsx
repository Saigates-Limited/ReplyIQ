import type { User } from './auth'

const HEAD = (title: string) => `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
  <link href="/static/style.css" rel="stylesheet">
</head>`

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))

// HTML shell for the ReplyIQ single-page UI. All data comes from /api/*.
export const page = (user: User) => `${HEAD('ReplyIQ · Saigates Ltd')}
<body class="bg-slate-100 text-slate-800 min-h-screen">
  <header id="app-header" class="bg-slate-900 text-white">
    <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
      <a href="/" class="flex items-center gap-3" data-link>
        <span class="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-amber-400 text-slate-900"><i class="fas fa-reply-all"></i></span>
        <span>
          <span class="font-bold text-lg leading-tight block">ReplyIQ</span>
          <span class="text-xs text-slate-300 block">Saigates Ltd · Amazon UK Customer Service</span>
        </span>
      </a>
      <nav class="text-sm text-slate-300 flex items-center gap-3 flex-wrap justify-end">
        <span id="header-clock" class="font-mono hidden xl:inline"></span>
        <a href="/" data-link data-nav="messages" class="nav-tab hover:text-white"><i class="fas fa-comments mr-1"></i>Messages <span class="nav-badge" data-badge="messages"></span></a>
        <a href="/atoz" data-link data-nav="atoz" class="nav-tab hover:text-white"><i class="fas fa-scale-balanced mr-1"></i>A-to-Z <span class="nav-badge" data-badge="atoz"></span></a>
        <a href="/returns" data-link data-nav="returns" class="nav-tab hover:text-white"><i class="fas fa-rotate-left mr-1"></i>Returns <span class="nav-badge" data-badge="returns"></span></a>
        <a href="/chargebacks" data-link data-nav="chargebacks" class="nav-tab hover:text-white"><i class="fas fa-credit-card mr-1"></i>Chargebacks <span class="nav-badge" data-badge="chargebacks"></span></a>
        <a href="/gmail" data-link data-nav="gmail" class="nav-tab hover:text-white"><i class="fab fa-google mr-1"></i>Gmail</a>
        ${user.role === 'manager' ? `<a href="/staff" data-link data-nav="staff" class="nav-tab hover:text-white"><i class="fas fa-users mr-1"></i>Staff</a>` : ''}
        <span class="text-slate-500">|</span>
        <span id="current-user" class="flex items-center gap-2">
          <span class="inline-flex items-center justify-center w-7 h-7 rounded-full ${user.role === 'manager' ? 'bg-violet-500' : 'bg-sky-600'} text-white text-xs font-bold" title="${esc(user.role)}">${esc(user.name.replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).map((p) => p[0] || '').join('').slice(0, 2).toUpperCase())}</span>
          <span class="hidden sm:inline">${esc(user.name)} <span class="text-xs text-slate-400">· ${user.role}</span></span>
        </span>
        <button id="logout-btn" class="hover:text-white" title="Sign out"><i class="fas fa-right-from-bracket"></i></button>
      </nav>
    </div>
  </header>

  <main id="app" class="max-w-7xl mx-auto px-4 py-6">
    <p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</p>
  </main>

  <div id="toast" class="fixed bottom-4 right-4 hidden px-4 py-2 rounded-lg shadow-lg text-sm text-white z-50"></div>

  <script>window.CURRENT_USER = ${JSON.stringify({ id: user.id, name: user.name, role: user.role, email: user.email })};</script>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/relativeTime.js"></script>
  <script>dayjs.extend(window.dayjs_plugin_relativeTime)</script>
  <script src="/static/app.js"></script>
</body>
</html>`

export const loginPage = () => `${HEAD('Sign in · ReplyIQ')}
<body class="bg-slate-900 min-h-screen flex items-center justify-center p-4">
  <main id="login-card" class="w-full max-w-sm bg-white rounded-2xl shadow-xl p-8">
    <div class="flex items-center gap-3 mb-6">
      <span class="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-amber-400 text-slate-900 text-lg"><i class="fas fa-reply-all"></i></span>
      <div>
        <h1 class="font-bold text-xl leading-tight">ReplyIQ</h1>
        <p class="text-xs text-slate-500">Saigates Ltd · Staff sign in</p>
      </div>
    </div>
    <form id="login-form" class="space-y-4" autocomplete="on">
      <div>
        <label for="email" class="field-label">Work email</label>
        <input id="email" name="email" type="email" required autocomplete="username" class="field-input" placeholder="you@saigates.co.uk">
      </div>
      <div>
        <label for="password" class="field-label">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password" class="field-input">
      </div>
      <p id="login-error" class="hidden text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"></p>
      <button id="login-btn" type="submit" class="w-full py-2.5 rounded-md bg-slate-900 text-white font-medium hover:bg-slate-800">
        Sign in
      </button>
    </form>
    <p class="mt-6 text-xs text-slate-400 text-center"><i class="fas fa-lock mr-1"></i>Staff only. Access is logged.</p>
    <p class="mt-2 text-xs text-slate-400 text-center"><a href="/privacy" class="underline hover:text-slate-600">Privacy policy</a> · Saigates Ltd</p>
  </main>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script>
    const form = document.getElementById('login-form'), err = document.getElementById('login-error'), btn = document.getElementById('login-btn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.classList.add('hidden'); btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        await axios.post('/api/auth/login', { email: form.email.value, password: form.password.value });
        const next = new URLSearchParams(location.search).get('next');
        location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
      } catch (ex) {
        err.textContent = ex.response?.data?.error || 'Sign in failed'; err.classList.remove('hidden');
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    });
  </script>
</body>
</html>`

export const setupPage = () => `${HEAD('First-run setup · ReplyIQ')}
<body class="bg-slate-900 min-h-screen flex items-center justify-center p-4">
  <main id="setup-card" class="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
    <div class="flex items-center gap-3 mb-2">
      <span class="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-amber-400 text-slate-900 text-lg"><i class="fas fa-reply-all"></i></span>
      <div>
        <h1 class="font-bold text-xl leading-tight">ReplyIQ — first-run setup</h1>
        <p class="text-xs text-slate-500">Saigates Ltd</p>
      </div>
    </div>
    <p class="text-sm text-slate-600 mb-6">No staff accounts exist yet. Create the first <strong>manager</strong> account. This page disappears permanently once an account exists.</p>
    <form id="setup-form" class="space-y-4" autocomplete="off">
      <div><label for="name" class="field-label">Your name</label><input id="name" name="name" required class="field-input"></div>
      <div><label for="email" class="field-label">Work email</label><input id="email" name="email" type="email" required class="field-input"></div>
      <div><label for="password" class="field-label">Password (12+ characters)</label><input id="password" name="password" type="password" minlength="12" required autocomplete="new-password" class="field-input"></div>
      <div><label for="confirm" class="field-label">Confirm password</label><input id="confirm" name="confirm" type="password" required autocomplete="new-password" class="field-input"></div>
      <p id="setup-error" class="hidden text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2"></p>
      <button id="setup-btn" type="submit" class="w-full py-2.5 rounded-md bg-slate-900 text-white font-medium hover:bg-slate-800">Create manager account</button>
    </form>
  </main>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script>
    const form = document.getElementById('setup-form'), err = document.getElementById('setup-error'), btn = document.getElementById('setup-btn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.classList.add('hidden');
      if (form.password.value !== form.confirm.value) { err.textContent = 'Passwords do not match'; err.classList.remove('hidden'); return; }
      btn.disabled = true; btn.textContent = 'Creating…';
      try {
        await axios.post('/api/auth/setup', { name: form.name.value, email: form.email.value, password: form.password.value });
        location.href = '/';
      } catch (ex) {
        err.textContent = ex.response?.data?.error || 'Setup failed'; err.classList.remove('hidden');
        btn.disabled = false; btn.textContent = 'Create manager account';
      }
    });
  </script>
</body>
</html>`

export const privacyPage = () => `${HEAD('Privacy Policy · ReplyIQ · Saigates Ltd')}
<body class="bg-slate-100 text-slate-800 min-h-screen">
  <header class="bg-slate-900 text-white">
    <div class="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
      <span class="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-amber-400 text-slate-900"><i class="fas fa-reply-all"></i></span>
      <span><span class="font-bold text-lg leading-tight block">ReplyIQ</span><span class="text-xs text-slate-300 block">Saigates Ltd · Amazon UK Customer Service</span></span>
      <a href="/login" class="ml-auto text-sm text-slate-300 hover:text-white">Staff sign in</a>
    </div>
  </header>
  <main id="privacy-policy" class="max-w-3xl mx-auto px-4 py-10">
    <article class="bg-white rounded-xl shadow-sm p-8 space-y-6 leading-relaxed">
      <header>
        <h1 class="text-2xl font-bold">Privacy Policy</h1>
        <p class="text-sm text-slate-500 mt-1">ReplyIQ — an internal customer-service tool operated by Saigates Ltd. Last updated 11 October 2026.</p>
      </header>

      <section>
        <h2 class="font-semibold text-lg mb-2">What ReplyIQ is</h2>
        <p>ReplyIQ is used only by Saigates Ltd staff. It helps us answer messages from customers who have bought from us on Amazon UK. It is not a consumer product and has no public sign-up.</p>
      </section>

      <section>
        <h2 class="font-semibold text-lg mb-2">What data we process and why</h2>
        <ul class="list-disc pl-5 space-y-1">
          <li><strong>Customer messages.</strong> ReplyIQ reads Amazon customer messages that arrive in our Amazon Seller Central Gmail inbox (Gmail read permission) so that our staff can see and reply to them in one place, and sends staff-approved replies from that same inbox (Gmail send permission).</li>
          <li><strong>Order details</strong> that our staff enter about a case (order number, product, delivery date, tracking) so that replies are accurate.</li>
          <li><strong>Staff accounts</strong> (name, work email, hashed password) so that only authorised staff can use the tool.</li>
        </ul>
        <p class="mt-2">Every reply to a customer is written as a draft and reviewed by a member of staff. A reply is sent only when a member of staff approves it and presses <strong>Send</strong>; the send goes through our Gmail account using the Gmail send permission. Nothing is sent automatically.</p>
      </section>

      <section>
        <h2 class="font-semibold text-lg mb-2">AI drafting</h2>
        <p>To help staff write replies, ReplyIQ sends a reduced version of the case to OpenAI. Before anything is sent we remove personal details: only the customer's first name is included, and surnames, email addresses, phone numbers, postal addresses and postcodes are stripped from the message text. Requests are made with OpenAI's <code>store: false</code> setting, so OpenAI does not retain the content for training or storage.</p>
      </section>

      <section>
        <h2 class="font-semibold text-lg mb-2">Where data is stored</h2>
        <p>Case data is stored in our Supabase (PostgreSQL) database hosted in London, United Kingdom, and accessed through Cloudflare. Access requires a staff login. The Google sign-in token for the connected mailbox is stored encrypted (AES-256) and is never shown in the browser. Only a manager can connect or disconnect the mailbox.</p>
      </section>

      <section>
        <h2 class="font-semibold text-lg mb-2">What we do not do</h2>
        <ul class="list-disc pl-5 space-y-1">
          <li>We do not sell personal data.</li>
          <li>We do not share data with third parties for advertising or marketing.</li>
          <li>We do not use Gmail data for any purpose other than reading and replying to our customers' messages.</li>
        </ul>
      </section>

      <section>
        <h2 class="font-semibold text-lg mb-2">Google API Services</h2>
        <p>ReplyIQ's use of information received from Google APIs adheres to the <a class="text-sky-700 underline" href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener" target="_blank">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
      </section>

      <section>
        <h2 class="font-semibold text-lg mb-2">Retention and your rights</h2>
        <p>We keep case records for as long as needed to handle the customer's order and any follow-up, and to meet our obligations as an Amazon seller. Customers may ask us what we hold about them, or ask us to correct or delete it, by contacting us below.</p>
      </section>

      <section>
        <h2 class="font-semibold text-lg mb-2">Contact</h2>
        <p>Saigates Ltd — <a class="text-sky-700 underline" href="mailto:bijalshah.cc@gmail.com">bijalshah.cc@gmail.com</a></p>
      </section>
    </article>
    <p class="text-xs text-slate-400 mt-6 text-center">&copy; 2026 Saigates Ltd</p>
  </main>
</body>
</html>`
