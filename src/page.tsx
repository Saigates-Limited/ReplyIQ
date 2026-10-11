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
      <nav class="text-sm text-slate-300 flex items-center gap-4">
        <span id="header-clock" class="font-mono hidden md:inline"></span>
        <a href="/" data-link class="hover:text-white"><i class="fas fa-inbox mr-1"></i>Queue</a>
        ${user.role === 'manager' ? `<a href="/staff" data-link class="hover:text-white"><i class="fas fa-users mr-1"></i>Staff</a>` : ''}
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
