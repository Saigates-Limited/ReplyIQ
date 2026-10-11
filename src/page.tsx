// HTML shell for the ReplyIQ single-page UI. All data comes from /api/*.
export const page = () => `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ReplyIQ · Saigates Ltd</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
  <link href="/static/style.css" rel="stylesheet">
</head>
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
        <span id="header-clock" class="font-mono"></span>
        <span class="hidden sm:inline text-slate-500">|</span>
        <span class="hidden sm:inline"><i class="fas fa-shield-halved mr-1"></i>Drafts are never sent automatically</span>
      </nav>
    </div>
  </header>

  <main id="app" class="max-w-7xl mx-auto px-4 py-6">
    <p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</p>
  </main>

  <div id="toast" class="fixed bottom-4 right-4 hidden px-4 py-2 rounded-lg shadow-lg text-sm text-white"></div>

  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/relativeTime.js"></script>
  <script>dayjs.extend(window.dayjs_plugin_relativeTime)</script>
  <script src="/static/app.js"></script>
</body>
</html>`
