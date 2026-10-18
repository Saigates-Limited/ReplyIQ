/* ReplyIQ frontend — case list + case screen. Talks only to /api/*. */
(function () {
  const app = document.getElementById('app')
  const toastEl = document.getElementById('toast')

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  const fmtDate = (d) => (d ? dayjs(d).format('DD MMM YYYY') : '—')
  const fmtDateTime = (d) => (d ? dayjs(d).format('DD MMM YYYY, HH:mm') : '—')
  const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—')
  const STATUS_LABEL = { open: 'Open', awaiting_customer: 'Awaiting customer', update_customer: 'Update customer', resolved: 'Resolved' }
  const STATUS_CLASS = {
    open: 'bg-blue-100 text-blue-800',
    awaiting_customer: 'bg-violet-100 text-violet-800',
    update_customer: 'bg-amber-100 text-amber-800',
    resolved: 'bg-slate-200 text-slate-700',
  }
  // Inbox folders (sidebar). "open" = every unresolved case (what used to be Active + Open).
  const FOLDERS = [['open', 'Open'], ['awaiting_customer', 'Awaiting customer'], ['update_customer', 'Update customer'], ['resolved', 'Resolved'], ['all', 'All']]
  const folderList = () => [...FOLDERS, ...(isManager ? [['archived', 'Archive']] : [])]
  const FOLDER_ICON = { open: 'fa-envelope-open', awaiting_customer: 'fa-hourglass-half', update_customer: 'fa-bell', resolved: 'fa-circle-check', all: 'fa-layer-group', archived: 'fa-box-archive' }

  // Tone labels (AI-suggested, staff can override). Order = severity rank.
  const TONE_META = {
    angry: { word: 'ANGRY / ESCALATING', colour: 'Red' },
    dispute: { word: 'DISPUTE / LEGAL', colour: 'Purple' },
    frustrated: { word: 'FRUSTRATED', colour: 'Orange' },
    worried: { word: 'WORRIED / CONFUSED', colour: 'Yellow' },
    neutral: { word: 'NEUTRAL', colour: 'Blue' },
    happy: { word: 'HAPPY', colour: 'Green' },
  }
  const toneChip = (t, extra = '') => (t && TONE_META[t] ? `<span class="tone tone-${t} ${extra}" title="${TONE_META[t].colour}">${TONE_META[t].word}</span>` : `<span class="tone tone-none ${extra}">NO LABEL</span>`)
  const EVENT_LABEL = { atoz_claim: 'A-to-Z claim', atoz_info_request: 'A-to-Z: info requested', atoz_decision: 'A-to-Z decision', return_request: 'Return request', chargeback: 'Chargeback' }
  const EVENT_CLASS = (kind) => (kind.startsWith('atoz') ? 'notice-atoz' : kind === 'chargeback' ? 'notice-chargeback' : 'notice-return')

  function toast(msg, kind = 'ok') {
    toastEl.textContent = msg
    toastEl.className = `fixed bottom-4 right-4 px-4 py-2 rounded-lg shadow-lg text-sm text-white ${kind === 'ok' ? 'bg-emerald-600' : 'bg-red-600'}`
    clearTimeout(toastEl._t)
    toastEl._t = setTimeout(() => toastEl.classList.add('hidden'), 2500)
  }

  // Deadline = 24h after last customer message, or the earliest open Amazon event deadline (whichever is sooner).
  function deadlineInfo(kase, now) {
    if (kase.status === 'resolved') return { label: 'Resolved', cls: 'text-slate-500', row: 'row-resolved', urgency: 3 }
    const when = kase.effective_deadline || kase.reply_deadline
    if (!when) return { label: 'No deadline', cls: 'text-slate-400', row: 'row-ok', urgency: 2 }
    const dl = dayjs(when)
    const mins = dl.diff(now, 'minute')
    const abs = Math.abs(mins)
    const h = Math.floor(abs / 60), m = abs % 60
    const span = h ? `${h}h ${m}m` : `${m}m`
    if (mins < 0) return { label: `Overdue by ${span}`, cls: 'deadline-overdue font-semibold', row: 'row-overdue', urgency: 0 }
    if (mins < 240) return { label: `${span} left`, cls: 'deadline-urgent font-semibold', row: 'row-urgent', urgency: 1 }
    return { label: `${span} left`, cls: 'deadline-ok', row: 'row-ok', urgency: 2 }
  }

  function statusBadge(s) {
    return `<span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[s] || ''}">${esc(STATUS_LABEL[s] || s)}</span>`
  }

  // ---------- routing ----------
  function navigate(path) {
    history.pushState({}, '', path)
    route()
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]')
    if (a) { e.preventDefault(); navigate(a.getAttribute('href')) }
  })
  window.addEventListener('popstate', route)

  function route() {
    const m = location.pathname.match(/^\/cases\/(\d+)$/)
    const p = location.pathname
    const cm = p.match(/^\/carriers\/(\d+)$/)
    const fm = p.match(/^\/inbox\/([a-z_]+)$/)
    if (fm && folderList().some(([v]) => v === fm[1])) { listFilter = fm[1]; localStorage.setItem('riq.filter', listFilter) }
    setActiveNav(m || p === '/inbox' || fm ? 'messages' : p.startsWith('/carriers') ? 'carriers' : p === '/atoz' ? 'atoz' : p === '/returns' ? 'returns' : p === '/chargebacks' ? 'chargebacks' : p === '/gmail' ? 'gmail' : p === '/staff' ? 'staff' : p === '/policy' ? 'policy' : p === '/decision-trees' ? 'trees' : p === '/knowledge' ? 'knowledge' : p === '/templates' ? 'templates' : p.startsWith('/settings') ? 'settings' : 'dashboard')
    refreshBadges()
    document.getElementById('sidebar')?.classList.remove('open')
    if (m) renderInbox(Number(m[1]))
    else if (p === '/inbox' || fm) renderInbox(null)
    else if (p === '/staff') renderStaff()
    else if (p === '/gmail') renderGmail()
    else if (p === '/policy') renderPolicy()
    else if (p === '/settings') renderSettings()
    else if (p === '/settings/prompt') renderPromptEditor()
    else if (p === '/decision-trees') renderDecisionTrees()
    else if (p === '/knowledge') renderKnowledge()
    else if (p === '/templates') renderTemplates()
    else if (p === '/atoz') renderTracker('atoz')
    else if (p === '/returns') renderTracker('return')
    else if (p === '/chargebacks') renderTracker('chargeback')
    else if (cm && carrierUI) carrierUI.renderParcel(Number(cm[1]))
    else if (p === '/carriers' && carrierUI) carrierUI.renderDesk()
    else renderDashboard()
  }
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'))

  // ---------- desktop sidebar collapse + dark/light theme (both remembered per browser) ----------
  const html = document.documentElement
  const collapseBtn = document.getElementById('sidebar-collapse')
  const syncCollapse = () => { if (collapseBtn) collapseBtn.title = html.classList.contains('sb-collapsed') ? 'Expand sidebar' : 'Collapse sidebar' }
  collapseBtn?.addEventListener('click', () => {
    html.classList.toggle('sb-collapsed')
    localStorage.setItem('riq.sidebar', html.classList.contains('sb-collapsed') ? 'collapsed' : 'expanded')
    syncCollapse()
  })
  syncCollapse()
  const themeBtn = document.getElementById('theme-toggle')
  const syncTheme = () => { if (themeBtn) { const dark = html.classList.contains('dark'); themeBtn.innerHTML = dark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>'; themeBtn.title = dark ? 'Switch to light mode' : 'Switch to dark mode' } }
  themeBtn?.addEventListener('click', () => {
    html.classList.toggle('dark')
    localStorage.setItem('riq.theme', html.classList.contains('dark') ? 'dark' : 'light')
    syncTheme()
  })
  syncTheme()
  let searchTerm = ''
  document.getElementById('global-search')?.addEventListener('input', (e) => {
    searchTerm = e.target.value.trim().toLowerCase()
    if (!location.pathname.startsWith('/inbox') && !location.pathname.startsWith('/cases/')) navigate('/inbox')
    else filterInboxList()
  })
  function setActiveNav(name) {
    document.querySelectorAll('.nav-tab').forEach((a) => a.classList.toggle('active', a.dataset.nav === name))
    document.querySelectorAll('[data-folder]').forEach((a) => a.classList.toggle('active', name === 'messages' && a.dataset.folder === listFilter))
  }
  let badgeTimer = 0
  async function refreshBadges() {
    clearTimeout(badgeTimer)
    try {
      const { data } = await axios.get('/api/events/counts')
      const set = (k, v) => { const el = document.querySelector(`[data-badge="${k}"]`); if (el) el.textContent = v ? String(v) : '' }
      set('atoz', data.atoz); set('returns', data.returns); set('chargebacks', data.chargebacks); set('messages', data.messages)
      set('folder-open', data.messages); set('folder-awaiting_customer', data.awaiting_customer); set('folder-update_customer', data.update_customer)
      if (data.kb_pending !== undefined) set('kb', data.kb_pending)
      if (carrierUI) set('carriers', await carrierUI.badgeCount())
    } catch {}
    badgeTimer = setTimeout(refreshBadges, 120000)
  }

  // Session expired anywhere → back to login
  axios.interceptors.response.use(
    (r) => r,
    (err) => {
      if (err.response?.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname)
      return Promise.reject(err)
    }
  )
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await axios.post('/api/auth/logout')
    location.href = '/login'
  })
  const ME = window.CURRENT_USER || { role: 'agent' }
  const isManager = ME.role === 'manager'

  // Carrier desk (public/static/carrier.js). Function declarations below are hoisted, so they can be handed over here.
  const carrierUI = window.RiqCarrier ? window.RiqCarrier({ app, esc, toast, fmtDate, fmtDateTime, navigate, isManager, renderCase: (id) => renderCase(id), renderError: (e) => renderError(e), refreshBadges: () => refreshBadges(), generate: (id, mode) => generate(id, mode) }) : null

  // ---------- header clock ----------
  const clock = document.getElementById('header-clock')
  const tick = () => { if (clock) clock.textContent = dayjs().format('ddd DD MMM · HH:mm') }
  tick(); setInterval(tick, 30000)

  // ---------- CASE LIST ----------
  let listFilter = localStorage.getItem('riq.filter') || 'open'
  if (listFilter === 'active') listFilter = 'open'

  async function renderList() {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading cases…</p>`
    let data
    try {
      ;({ data } = await axios.get('/api/cases', { params: { status: listFilter } }))
    } catch (err) {
      return renderError(err)
    }
    const now = dayjs(data.now)
    const cases = data.cases
    const dlOf = (k) => k.effective_deadline || k.reply_deadline
    const overdue = cases.filter((k) => k.status !== 'resolved' && dlOf(k) && dayjs(dlOf(k)).isBefore(now)).length
    const urgent = cases.filter((k) => k.status !== 'resolved' && dlOf(k) && !dayjs(dlOf(k)).isBefore(now) && dayjs(dlOf(k)).diff(now, 'minute') < 240).length
    const hot = cases.filter((k) => k.status !== 'resolved' && (k.tone === 'angry' || k.tone === 'dispute')).length

    const filters = folderList()

    app.innerHTML = `
      <section id="case-list-section">
        <div class="flex flex-wrap items-end justify-between gap-4 mb-4">
          <div>
            <h1 class="text-2xl font-bold">Messages</h1>
            <p class="text-sm text-slate-500">Overdue first, then <span class="tone tone-angry">ANGRY</span> / <span class="tone tone-dispute">DISPUTE</span>, then everyone else by deadline (24h from the customer's latest message, or an Amazon deadline if sooner).</p>
          </div>
          <div class="flex items-center gap-3 text-sm">
            <span class="px-3 py-1 rounded-full bg-red-100 text-red-800"><i class="fas fa-triangle-exclamation mr-1"></i>${overdue} overdue</span>
            <span class="px-3 py-1 rounded-full bg-violet-100 text-violet-800" title="Angry or dispute/legal tone"><i class="fas fa-fire mr-1"></i>${hot} hot</span>
            <span class="px-3 py-1 rounded-full bg-orange-100 text-orange-800"><i class="fas fa-clock mr-1"></i>${urgent} due &lt; 4h</span>
            <button id="refresh-btn" class="px-3 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50"><i class="fas fa-rotate mr-1"></i>Refresh</button>
          </div>
        </div>

        <nav id="status-filter" class="flex gap-1 mb-3 text-sm">
          ${filters.map(([v, l]) => `<button data-filter="${v}" class="px-3 py-1.5 rounded-md ${listFilter === v ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 hover:bg-slate-50'}">${l}</button>`).join('')}
        </nav>

        <div class="bg-white rounded-xl shadow-sm overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th class="px-4 py-3">Deadline</th>
                <th class="px-4 py-3">Case</th>
                <th class="px-4 py-3">Tone</th>
                <th class="px-4 py-3 hidden md:table-cell">Customer</th>
                <th class="px-4 py-3 hidden lg:table-cell">Order / Device</th>
                <th class="px-4 py-3">Status</th>
                <th class="px-4 py-3 hidden xl:table-cell">Assigned</th>
                <th class="px-4 py-3 hidden sm:table-cell">Last message</th>
                <th class="px-4 py-3 hidden md:table-cell">Draft</th>
              </tr>
            </thead>
            <tbody id="case-rows">
              ${cases.length ? cases.map((k) => caseRow(k, now)).join('') : `<tr><td colspan="9" class="px-4 py-8 text-center text-slate-500">No cases match this filter.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>`

    app.querySelector('#refresh-btn').onclick = renderList
    app.querySelectorAll('#status-filter button').forEach((b) => {
      b.onclick = () => { listFilter = b.dataset.filter; localStorage.setItem('riq.filter', listFilter); renderList() }
    })
    app.querySelectorAll('tr[data-case-id]').forEach((tr) => {
      tr.onclick = () => navigate(`/cases/${tr.dataset.caseId}`)
    })
  }

  function caseRow(k, now) {
    const d = deadlineInfo(k, now)
    const draft = k.latest_draft_status
    const flags = [
      k.open_atoz ? '<span class="px-1.5 py-0.5 rounded bg-violet-100 text-violet-800 text-[10px] font-semibold" title="Open A-to-Z claim">A-to-Z</span>' : '',
      k.open_returns ? '<span class="px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-800 text-[10px] font-semibold" title="Open return">RETURN</span>' : '',
      k.open_chargebacks ? '<span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 text-[10px] font-semibold" title="Open chargeback">CHARGEBACK</span>' : '',
      k.battery_flag ? '<span class="px-1.5 py-0.5 rounded bg-red-600 text-white text-[10px] font-semibold" title="Battery / heat safety rule applies"><i class="fas fa-fire"></i> BATTERY</span>' : '',
    ].join(' ')
    return `
      <tr data-case-id="${k.id}" class="case-row ${d.row} row-tone-${k.tone || 'none'} border-b border-slate-100 hover:bg-amber-50 cursor-pointer">
        <td class="px-4 py-3 whitespace-nowrap">
          <div class="${d.cls}">${esc(d.label)}</div>
          <div class="text-xs text-slate-400">${fmtDateTime(k.effective_deadline || k.reply_deadline)}</div>
        </td>
        <td class="px-4 py-3">
          <div class="font-mono text-xs text-slate-500">${esc(k.case_ref)}</div>
          <div class="font-medium">${esc(k.subject)}</div>
          ${flags ? `<div class="mt-1 flex flex-wrap gap-1">${flags}</div>` : ''}
        </td>
        <td class="px-4 py-3">${toneChip(k.tone)}</td>
        <td class="px-4 py-3 hidden md:table-cell">${esc(k.customer_first_name)} ${esc(k.customer_last_name || '')}</td>
        <td class="px-4 py-3 hidden lg:table-cell">
          <div class="font-mono text-xs">${esc(k.order_id || '—')}</div>
          <div class="text-xs text-slate-500">${esc(k.device_model || '')}</div>
        </td>
        <td class="px-4 py-3">${statusBadge(k.status)}</td>
        <td class="px-4 py-3 hidden xl:table-cell text-slate-600 text-xs">${k.assigned_to_name ? `<i class="far fa-user mr-1 text-slate-400"></i>${esc(k.assigned_to_name)}` : '<span class="text-slate-300">unassigned</span>'}</td>
        <td class="px-4 py-3 hidden sm:table-cell text-slate-500 whitespace-nowrap">${dayjs(k.last_customer_message_at).from(now)} <span class="text-xs text-slate-400">(${k.message_count})</span></td>
        <td class="px-4 py-3 hidden md:table-cell text-xs">${draftBadge(draft, k.latest_draft_needs_manager)}</td>
      </tr>`
  }

  function draftBadge(status, needsManager) {
    if (!status) return '<span class="text-slate-400">none</span>'
    const cls = { draft: 'bg-amber-100 text-amber-800', approved: 'bg-emerald-100 text-emerald-800', sending: 'bg-sky-100 text-sky-800', sent: 'bg-slate-200 text-slate-700' }[status] || 'bg-slate-100 text-slate-600'
    return `<span class="px-2 py-0.5 rounded-full ${cls}">${esc(status)}</span>${needsManager && status === 'draft' ? ' <span class="px-2 py-0.5 rounded-full bg-violet-100 text-violet-800" title="Needs manager approval"><i class="fas fa-user-shield"></i></span>' : ''}`
  }

  // ---------- CASE SCREEN ----------
  async function renderCase(id) {
    const target = document.getElementById('inbox-detail') || app
    target.innerHTML = `<p class="text-slate-500 p-4"><i class="fas fa-spinner fa-spin mr-2"></i>Loading case…</p>`
    let data
    try {
      ;({ data } = await axios.get(`/api/cases/${id}`))
    } catch (err) {
      return renderError(err)
    }
    const k = data.case
    const now = dayjs(data.now)
    const d = deadlineInfo(k, now)

    target.innerHTML = `
      <section id="case-screen" class="p-3 sm:p-4">
        <a href="/inbox" data-link class="lg:hidden text-sm text-slate-500 hover:text-slate-800"><i class="fas fa-arrow-left mr-1"></i>Back to inbox</a>

        <header class="mt-2 mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div class="font-mono text-xs text-slate-500">${esc(k.case_ref)}</div>
            <h1 class="text-2xl font-bold">${esc(k.subject)}</h1>
            <div class="mt-1 flex items-center gap-3 text-sm">
              ${statusBadge(k.status)}
              ${k.source === 'gmail' ? '<span class="inline-block px-2 py-0.5 rounded-full text-xs bg-red-50 text-red-700 border border-red-200"><i class="fab fa-google mr-1"></i>Gmail</span>' : ''}
              <span class="${d.cls}"><i class="far fa-clock mr-1"></i>${esc(d.label)} · due ${fmtDateTime(k.reply_deadline)}</span>
            </div>
          </div>
          <div class="flex items-end gap-2 text-sm">
            ${k.archived_at ? `<span class="text-xs px-2 py-1.5 rounded bg-slate-200 text-slate-700"><i class="fas fa-box-archive mr-1"></i>Archived ${fmtDateTime(k.archived_at)}</span>` : ''}
            <div>
              <label class="field-label">Case status</label>
              <select id="status-select" class="field-input mt-1" style="width:auto">
              ${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}" ${k.status === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            ${isManager ? `<button id="archive-btn" class="text-xs px-2.5 py-2 rounded-md border border-slate-300 text-slate-600 hover:text-slate-900" title="${k.archived_at ? 'Restore to the queue' : 'Archive (keeps everything, hides from queue)'}">${k.archived_at ? '<i class="fas fa-box-open mr-1"></i>Unarchive' : '<i class="fas fa-box-archive mr-1"></i>Archive'}</button>` : ''}
          </div>
        </header>

        <div class="grid grid-cols-1 2xl:grid-cols-5 gap-4">
          <!-- Left column: conversation, then the draft directly beneath it -->
          <div class="2xl:col-span-3 space-y-4 min-w-0">
          <article id="conversation" class="bg-white rounded-xl shadow-sm border border-slate-100">
            <div class="px-5 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2">
              <h2 class="font-semibold"><i class="far fa-comments mr-2 text-slate-400"></i>Conversation <span class="text-xs font-normal text-slate-500">· order ${esc(k.order_id || '—')}</span></h2>
              <div class="flex items-center gap-2 text-xs">
                ${toneChip(k.tone)}
                <select id="tone-select" class="field-input py-0.5 text-xs mt-0" style="width:auto" title="Override the AI tone label">
                  <option value="">Override tone…</option>
                  ${Object.entries(TONE_META).map(([v, m]) => `<option value="${v}">${m.colour} — ${m.word}</option>`).join('')}
                </select>
                <span class="text-slate-400">${data.messages.length} item${data.messages.length === 1 ? '' : 's'}</span>
              </div>
            </div>
            <div class="chat p-3 sm:p-4 flex flex-col gap-2 max-h-[60vh] overflow-auto" id="chat-scroll">
              ${chatItems(data.messages, data.events, data.attachments || [])}
            </div>
            ${k.battery_flag ? '<div class="px-5 py-2 text-xs bg-red-600 text-white rounded-b-xl"><i class="fas fa-fire mr-1"></i><strong>Safety flag:</strong> tell the customer to avoid using and charging the phone, return for inspection, manager approval, high urgency.</div>' : ''}
          </article>
          <section id="draft-workspace"></section>
          </div>

          <!-- Right column: details (collapsible so the draft stays close to the chat on smaller screens) -->
          <aside class="2xl:col-span-2 space-y-4 min-w-0">
            <section id="ticket-panel" class="bg-white rounded-xl shadow-sm p-5">
              <h2 class="font-semibold mb-3"><i class="fas fa-ticket mr-2 text-slate-400"></i>Ticket</h2>
              <div class="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <label class="field-label" for="assigned-select">Assigned to</label>
                  <select id="assigned-select" class="field-input">
                    <option value="">Unassigned</option>
                    ${(data.staff || []).map((u) => `<option value="${u.id}" ${k.assigned_to === u.id ? 'selected' : ''}>${esc(u.name)}${u.id === ME.id ? ' (me)' : ''}</option>`).join('')}
                  </select>
                </div>
                <div>
                  <label class="field-label">Deadline</label>
                  <div class="mt-2 ${d.cls} text-sm">${esc(d.label)}</div>
                </div>
                <div class="col-span-2">
                  <label class="field-label" for="internal-notes">Internal notes <span class="normal-case font-normal">(never sent, never shared with the AI)</span></label>
                  <textarea id="internal-notes" class="field-input text-xs" rows="3" placeholder="Stock check, call-backs, anything for colleagues…">${esc(k.internal_notes || '')}</textarea>
                </div>
              </div>
              ${data.events.length ? `<div class="mt-3 space-y-1">${data.events.map((e) => `<a href="/${e.kind.startsWith('atoz') ? 'atoz' : e.kind === 'chargeback' ? 'chargebacks' : 'returns'}" data-link class="block text-xs rounded-md px-2 py-1 notice ${EVENT_CLASS(e.kind)} text-left"><strong>${esc(EVENT_LABEL[e.kind] || e.kind)}</strong> · ${esc(e.status)}${e.amount ? ` · £${Number(e.amount).toFixed(2)}` : ''}${e.deadline_at ? ` · due ${fmtDateTime(e.deadline_at)}` : ''}</a>`).join('')}</div>` : ''}
            </section>

            <section id="carrier-panel" class="bg-white rounded-xl shadow-sm p-5 hidden"></section>

            <section id="customer-panel" class="bg-white rounded-xl shadow-sm p-5">
              <h2 class="font-semibold mb-3"><i class="far fa-user mr-2 text-slate-400"></i>Customer</h2>
              <dl class="text-sm grid grid-cols-3 gap-y-2">
                <dt class="text-slate-500">Name</dt><dd class="col-span-2">${esc(k.customer_first_name)} ${esc(k.customer_last_name || '')}</dd>
                <dt class="text-slate-500">Email</dt><dd class="col-span-2 break-all">${esc(k.customer_email || '—')}</dd>
                <dt class="text-slate-500">Phone</dt><dd class="col-span-2">${esc(k.customer_phone || '—')}</dd>
                <dt class="text-slate-500">Address</dt><dd class="col-span-2">${esc(k.customer_address || '—')}</dd>
                ${k.mailbox_email ? `<dt class="text-slate-500">Via mailbox</dt><dd class="col-span-2"><span class="pill ${(k.mailbox_label || '').toLowerCase() === 'manager' ? 'bg-violet-100 text-violet-800' : 'bg-sky-100 text-sky-800'}">${esc(k.mailbox_label || 'Mailbox')}</span> <span class="text-xs text-slate-500 break-all">${esc(k.mailbox_email)}</span><div class="text-[10px] text-slate-400">Replies are sent from this address</div></dd>` : ''}
              </dl>
              <p class="mt-3 text-xs text-slate-500 bg-slate-50 rounded-md p-2"><i class="fas fa-lock mr-1"></i>Only the first name (<strong>${esc(k.customer_first_name)}</strong>) is ever shared with the AI drafting service.</p>
            </section>

            <section id="amazon-order-panel" class="bg-white rounded-xl shadow-sm p-5">
              <div class="flex items-center justify-between mb-2">
                <h2 class="font-semibold"><i class="fab fa-amazon mr-2 text-slate-400"></i>Amazon order</h2>
                <button id="fetch-order-btn" class="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50" ${k.order_id ? '' : 'disabled'}><i class="fas fa-rotate mr-1"></i>Fetch from Amazon</button>
              </div>
              <div id="amazon-order-body" class="text-sm text-slate-500">${k.order_id ? (k.spapi_synced_at ? 'Loading…' : 'Not fetched yet.') : 'No order ID on this case.'}</div>
              <div id="review-request-box" class="mt-3"></div>
            </section>

            <section id="case-fields" class="bg-white rounded-xl shadow-sm p-5">
              <div class="flex items-center justify-between mb-3">
                <h2 class="font-semibold"><i class="fas fa-clipboard-list mr-2 text-slate-400"></i>Case details</h2>
                <span id="save-indicator" class="saving-indicator text-xs text-slate-400 opacity-0">Saved</span>
              </div>
              <form id="fields-form" class="grid grid-cols-1 sm:grid-cols-2 gap-4" autocomplete="off">
                <div class="sm:col-span-2">
                  <label class="field-label" for="f-order_id">Order ID</label>
                  <input id="f-order_id" name="order_id" class="field-input font-mono" placeholder="e.g. 204-1234567-1234567" value="${esc(k.order_id || '')}">
                </div>
                <div class="sm:col-span-2">
                  <label class="field-label" for="f-device_model">Device model</label>
                  <input id="f-device_model" name="device_model" class="field-input" value="${esc(k.device_model || '')}">
                </div>
                <div>
                  <label class="field-label" for="f-delivery_date">Delivery date ${k.delivery_date_source === 'amazon_estimated' ? '<span class="normal-case font-normal text-amber-700">(Amazon estimate — promised window)</span>' : k.delivery_date_source === 'amazon_actual' ? '<span class="normal-case font-normal text-emerald-700">(Amazon: delivered)</span>' : k.delivery_date_source === 'staff' ? '<span class="normal-case font-normal text-slate-500">(entered by staff)</span>' : ''}</label>
                  <input id="f-delivery_date" name="delivery_date" type="date" class="field-input ${k.delivery_date_source === 'amazon_estimated' ? 'border-amber-400' : ''}" value="${esc(k.delivery_date ? String(k.delivery_date).slice(0, 10) : '')}">
                </div>
                <div>
                  <label class="field-label" for="f-approved_repair_price">Approved repair price (£)</label>
                  <input id="f-approved_repair_price" name="approved_repair_price" type="number" step="0.01" min="0" class="field-input" value="${esc(k.approved_repair_price ?? '')}">
                </div>
                ${boolField('refund_issued', 'Refund issued', k.refund_issued)}
                ${boolField('a_to_z_open', 'A-to-Z open', k.a_to_z_open)}
                ${boolField('in_stock', 'In stock', k.in_stock)}
                ${boolField('repair_quote_accepted', 'Repair quote accepted', k.repair_quote_accepted)}
                <div>
                  <label class="field-label" for="f-carrier">Carrier</label>
                  <input id="f-carrier" name="carrier" list="carrier-list" class="field-input" value="${esc(k.carrier || '')}">
                  <datalist id="carrier-list"><option>Royal Mail</option><option>Evri</option><option>DPD</option><option>Amazon Logistics</option><option>Yodel</option><option>UPS</option><option>DHL</option></datalist>
                </div>
                <div class="sm:col-span-2">
                  <label class="field-label" for="f-tracking_number">Tracking number</label>
                  <input id="f-tracking_number" name="tracking_number" class="field-input font-mono" value="${esc(k.tracking_number || '')}">
                </div>
              </form>
              <p class="mt-3 text-xs text-slate-400">Changes save automatically.</p>
            </section>

          </aside>
        </div>
      </section>`

    wireFields(id)
    wireTicket(id, k)
    wireAmazonOrder(id, k)
    carrierUI?.mountCasePanel(id, k)
    renderDraftWorkspace(id, k, data.drafts, data.events)
    const sc = document.getElementById('chat-scroll'); if (sc) sc.scrollTop = sc.scrollHeight
    document.querySelectorAll('#inbox-list .ticket-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.caseId) === id))
    document.querySelector('.inbox')?.classList.add('show-detail')
  }

  // ---------- Amazon order (SP-API) + review request ----------
  async function wireAmazonOrder(id, k) {
    const body = document.getElementById('amazon-order-body')
    const btn = document.getElementById('fetch-order-btn')
    const box = document.getElementById('review-request-box')
    if (!body) return
    const render = (o, filled) => {
      if (!o) return
      const items = (o.items || []).map((it) => `<li>${esc(it.title || it.asin || '')}${it.quantity > 1 ? ` ×${it.quantity}` : ''}${it.unitPrice ? ` · ${esc(it.currency || '')} ${esc(it.unitPrice)}` : ''}${it.condition ? ` · <span class="text-slate-400">${esc(it.condition)}</span>` : ''}</li>`).join('')
      body.innerHTML = `<dl class="grid grid-cols-3 gap-y-1 text-xs">
        <dt class="text-slate-500">Ordered</dt><dd class="col-span-2">${o.orderDate ? fmtDateTime(o.orderDate) : '—'}</dd>
        <dt class="text-slate-500">Status</dt><dd class="col-span-2">${esc(o.status || '—')} ${o.fulfilledBy ? `<span class="text-slate-400">· ${esc(o.fulfilledBy)}</span>` : ''}</dd>
        <dt class="text-slate-500">Total</dt><dd class="col-span-2">${o.grandTotal ? `${esc(o.currency || '')} ${esc(o.grandTotal)}` : '—'}</dd>
        <dt class="text-slate-500">Shipped</dt><dd class="col-span-2">${o.shipDate ? fmtDateTime(o.shipDate) : '—'}${o.carrier ? ` · ${esc(o.carrier)}` : ''}</dd>
        <dt class="text-slate-500">Tracking</dt><dd class="col-span-2 font-mono">${esc(o.trackingNumber || '—')} ${o.packageStatus ? `<span class="font-sans px-1.5 rounded ${o.packageStatus === 'DELIVERED' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'} text-[10px]">${esc(o.packageStatus)}</span>` : ''}</dd>
        <dt class="text-slate-500">Delivery</dt><dd class="col-span-2">${o.deliveredAt ? `<span class="text-emerald-700">Delivered ${fmtDateTime(o.deliveredAt)}</span>` : o.promisedDelivery?.latest ? `<span class="text-amber-700">Promised ${fmtDate(o.promisedDelivery.earliest)} – ${fmtDate(o.promisedDelivery.latest)} (estimate)</span>` : '—'}</dd>
      </dl>
      ${items ? `<ul class="mt-2 text-xs list-disc pl-4 text-slate-700">${items}</ul>` : ''}
      ${filled?.length ? `<div class="mt-2 text-[10px] text-emerald-700"><i class="fas fa-circle-check mr-1"></i>Filled from Amazon: ${esc(filled.join(', '))}</div>` : ''}
      <div class="mt-1 text-[10px] text-slate-400">Fetched ${o.fetchedAt ? dayjs(o.fetchedAt).fromNow() : ''} · staff-entered values are never overwritten</div>`
    }
    const fetchOrder = async (force) => {
      btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Fetching…'
      try {
        const { data } = await axios.post(`/api/cases/${id}/fetch-order`, { force }, { timeout: 30000 })
        render(data.order, data.filled)
        if (data.filled?.length) { toast(`Filled from Amazon: ${data.filled.join(', ')}`); renderCase(id); return }
      } catch (err) {
        const d = err.response?.data || {}
        body.innerHTML = `<span class="${d.configured === false ? 'text-slate-400' : 'text-red-700'}">${esc(d.error || err.message)}</span>${d.configured === false ? ' <a href="/settings" data-link class="underline">Settings</a>' : ''}`
      } finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-rotate mr-1"></i>Fetch from Amazon' }
    }
    btn.onclick = () => fetchOrder(true)
    // Auto-fetch once on first open (cached 6h server-side; silent if SP-API isn't configured)
    if (k.order_id) {
      const st = await axios.get('/api/spapi/status').then((r) => r.data).catch(() => ({ configured: false }))
      if (st.configured) await fetchOrder(false)
      else body.innerHTML = '<span class="text-slate-400">Amazon connection not configured yet — <a href="/settings" data-link class="underline">Settings</a>.</span>'
    }
    // Review request
    if (box && k.order_id) {
      try {
        const { data: r } = await axios.get(`/api/cases/${id}/review-request`)
        const rule = r.rule || {}
        let html = ''
        if (r.previous) html = `<div class="text-xs rounded-md bg-slate-50 border border-slate-200 px-2 py-1.5"><i class="fas fa-star mr-1 text-amber-500"></i>Review request <strong>${esc(r.previous.result)}</strong> ${fmtDateTime(r.previous.requested_at)} by ${esc(r.previous.requested_by_name || '—')}${r.previous.detail && r.previous.result !== 'sent' ? ` — ${esc(r.previous.detail)}` : ''}</div>`
        else if (rule.state === 'window_open') html = `<button id="review-btn" ${r.configured ? '' : 'disabled'} class="w-full text-xs px-3 py-2 rounded-md bg-amber-500 text-white font-medium disabled:opacity-50"><i class="fas fa-star mr-1"></i>Request review via Amazon <span class="font-normal opacity-80">(day ${rule.days_since} of 30)</span></button>`
        else if (rule.state === 'too_early') html = `<button disabled class="w-full text-xs px-3 py-2 rounded-md bg-slate-200 text-slate-500"><i class="fas fa-star mr-1"></i>Request review — available from ${fmtDate(rule.available_from)}</button>`
        else if (rule.state === 'no_delivery_date') html = `<div class="text-[10px] text-slate-400"><i class="fas fa-star mr-1"></i>Review request: set the delivery date first.</div>`
        box.innerHTML = html + (rule.state !== 'expired' ? '<div class="mt-1 text-[10px] text-slate-400">Same rule for every order: 7–30 days after delivery, checked with Amazon, once per order. Never based on tone or outcome.</div>' : '')
        document.getElementById('review-btn')?.addEventListener('click', async (e) => {
          if (!confirm(`Ask Amazon to send its standard review request for order ${k.order_id}? This can only be done once.`)) return
          e.target.disabled = true
          try { const { data } = await axios.post(`/api/cases/${id}/review-request`, {}, { timeout: 30000 }); toast(data.detail || 'Review request sent'); renderCase(id) }
          catch (err) { toast(err.response?.data?.error || err.response?.data?.detail || err.message, 'err'); renderCase(id) }
        })
      } catch {}
    }
  }

  // WhatsApp-style items: customer left (white), Saigates right (green), Seller Central copies right (dashed), Amazon notices centred.
  function attachmentChips(list) {
    if (!list.length) return ''
    const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB')
    return `<div class="mt-2 flex flex-wrap gap-2">${list.map((a) => {
      const url = `/api/gmail/attachments/${a.id}`
      const img = /^image\/(jpe?g|png|gif|webp)$/i.test(a.mime_type) || /\.(jpe?g|png|gif|webp)$/i.test(a.filename || "")
      const warn = a.amazon_allowed ? '' : '<span class="ml-1 text-[9px] px-1 rounded bg-amber-100 text-amber-800" title="Amazon would not accept this type if sent back">not Amazon-allowed</span>'
      return img
        ? `<a href="${url}" target="_blank" rel="noopener" class="block attachment-thumb" data-att="${a.id}"><div class="relative h-40 w-[220px] rounded-md border border-slate-200 bg-slate-100 overflow-hidden flex items-center justify-center text-slate-400 text-xs"><span class="att-state"><i class="fas fa-spinner fa-spin"></i></span><img src="${url}" alt="${esc(a.filename)}" loading="lazy" class="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity"></div><div class="text-[10px] text-slate-500 mt-0.5"><i class="fas fa-image mr-1"></i>${esc(a.filename)} · ${fmtSize(a.size_bytes)}${warn}</div></a>`
        : `<a href="${url}" target="_blank" rel="noopener" class="attachment-chip"><i class="fas ${a.mime_type === 'application/pdf' ? 'fa-file-pdf text-red-600' : 'fa-paperclip'}"></i>${esc(a.filename)} <span class="text-slate-400">${fmtSize(a.size_bytes)}</span>${warn}</a>`
    }).join('')}</div><div class="text-[9px] text-slate-400 mt-1"><i class="fas fa-lock"></i> Attachments are shown to staff only — never sent to the AI</div>`
  }

  // Image thumbnails: show a spinner until the proxy answers; on failure say so instead of leaving a blank box
  document.addEventListener('load', (e) => { const img = e.target; if (img.tagName === 'IMG' && img.closest('.attachment-thumb')) { img.classList.remove('opacity-0'); img.parentElement.querySelector('.att-state')?.remove() } }, true)
  document.addEventListener('error', (e) => { const img = e.target; if (img.tagName === 'IMG' && img.closest('.attachment-thumb')) { const st = img.parentElement.querySelector('.att-state'); if (st) st.innerHTML = '<i class="fas fa-triangle-exclamation text-amber-500 mr-1"></i>Could not load — click to open'; img.remove() } }, true)

  function chatItems(messages, events, attachments) {
    const attsByMsg = {}
    for (const a of attachments || []) (attsByMsg[a.message_id] ||= []).push(a)
    const evById = Object.fromEntries((events || []).map((e) => [e.id, e]))
    let lastDay = ''
    return messages.map((m) => {
      const day = dayjs(m.sent_at).format('ddd DD MMM YYYY')
      const sep = day !== lastDay ? `<div class="day-sep">${day}</div>` : ''
      lastDay = day
      if (m.kind === 'event' && !m.event_id && /^Carrier update/.test(m.sender || '')) {
        return `${sep}<div class="notice notice-carrier"><div class="font-semibold"><i class="fas fa-truck-fast mr-1"></i>${esc(m.sender)}</div><div class="message-body">${esc(m.body)}</div><div class="opacity-70 mt-1">${fmtDateTime(m.sent_at)} · internal, from the carrier desk</div></div>`
      }
      if (m.kind === 'event') {
        const e = evById[m.event_id]
        const kind = e?.kind || 'return_request'
        return `${sep}<div class="notice ${EVENT_CLASS(kind)}"><div class="font-semibold"><i class="fab fa-amazon mr-1"></i>${esc(EVENT_LABEL[kind] || kind)}${e?.amount ? ` · £${Number(e.amount).toFixed(2)}` : ''}</div><div class="message-body">${esc(m.body)}</div>${e?.customer_comment ? `<div class="mt-1 italic">“${esc(e.customer_comment)}”</div>` : ''}<div class="opacity-70 mt-1">${fmtDateTime(m.sent_at)}${e?.deadline_at ? ` · respond by ${fmtDateTime(e.deadline_at)}` : ''}</div></div>`
      }
      const inbound = m.direction === 'inbound'
      const sc = m.kind === 'seller_central_copy'
      const cls = inbound ? 'bubble-in' : sc ? 'bubble-sc' : 'bubble-out'
      const tone = inbound ? `<span data-msg-tone="${m.id}" class="cursor-pointer" title="Click to change">${toneChip(m.tone)}</span>${m.tone_source === 'staff' ? '<i class="fas fa-user-pen text-slate-400" title="Set by staff"></i>' : ''}` : ''
      return `${sep}<div class="bubble ${cls}">
        <div class="text-[11px] font-semibold ${inbound ? 'text-sky-700' : 'text-emerald-800'}">${esc(m.sender || (inbound ? 'Customer' : 'Saigates'))}${sc ? ' <span class="font-normal text-orange-700">· sent via Seller Central</span>' : ''}</div>
        <div class="message-body">${esc(m.body)}</div>
        ${attachmentChips(attsByMsg[m.id] || [])}
        <div class="bubble-meta">${tone}<span>${dayjs(m.sent_at).format('HH:mm')}</span>${!inbound ? '<i class="fas fa-check-double text-sky-500"></i>' : ''}</div>
      </div>`
    }).join('')
  }

  function wireTicket(id, k) {
    const save = async (patch, msg) => {
      try { await axios.patch(`/api/cases/${id}`, patch); toast(msg); renderCase(id) } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
    }
    document.getElementById('assigned-select')?.addEventListener('change', (e) => save({ assigned_to: e.target.value || null }, 'Assignment saved').then(loadInboxList))
    let nt
    document.getElementById('internal-notes')?.addEventListener('input', (e) => { clearTimeout(nt); nt = setTimeout(() => axios.patch(`/api/cases/${id}`, { internal_notes: e.target.value }).catch(() => toast('Could not save notes', 'err')), 800) })
    document.getElementById('archive-btn')?.addEventListener('click', async () => {
      const un = !!k.archived_at
      if (!un && !confirm('Archive this case? It leaves the queue but every message, draft and Amazon event is kept. Nothing is deleted.')) return
      try { await axios.post(`/api/cases/${id}/${un ? 'unarchive' : 'archive'}`); toast(un ? 'Case restored' : 'Case archived'); un ? renderCase(id) : (loadInboxList(), navigate('/inbox')) } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
    })
    document.getElementById('tone-select')?.addEventListener('change', (e) => { if (e.target.value) save({ tone: e.target.value }, 'Tone label updated').then(loadInboxList) })
    document.querySelectorAll('[data-msg-tone]').forEach((el) => {
      el.onclick = async () => {
        const pick = prompt('Set tone for this message: ' + Object.keys(TONE_META).join(', '))
        if (!pick || !TONE_META[pick.trim().toLowerCase()]) return
        try { await axios.patch(`/api/messages/${el.dataset.msgTone}/tone`, { tone: pick.trim().toLowerCase() }); toast('Tone updated'); renderCase(id) } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      }
    })
  }

  function boolField(name, label, value) {
    const cls = (v) => (value === v ? (v ? 'active-yes' : 'active-no') : '')
    return `
      <div>
        <span class="field-label">${label}</span>
        <div class="seg mt-1" data-bool="${name}">
          <button type="button" data-val="true" class="${cls(true)}">Yes</button>
          <button type="button" data-val="false" class="${cls(false)}">No</button>
          <button type="button" data-val="" class="${value === null || value === undefined ? 'active-unset' : ''}">Unset</button>
        </div>
      </div>`
  }

  function wireFields(id) {
    const form = document.getElementById('fields-form')
    const indicator = document.getElementById('save-indicator')

    async function save(patch) {
      try {
        const { data } = await axios.patch(`/api/cases/${id}`, patch)
        indicator.textContent = 'Saved'
        indicator.className = 'saving-indicator text-xs text-emerald-600 opacity-100'
        setTimeout(() => (indicator.style.opacity = 0), 1500)
        indicator.style.opacity = 1
        return data.case
      } catch (err) {
        const msg = err.response?.data?.fields ? Object.values(err.response.data.fields).join(', ') : err.response?.data?.error || err.message
        toast(`Save failed: ${msg}`, 'err')
        throw err
      }
    }

    // Text/date/number inputs: save on change (blur / enter)
    form.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => save({ [inp.name]: inp.value }))
    })

    // Yes/No/Unset toggles
    form.querySelectorAll('[data-bool]').forEach((seg) => {
      seg.querySelectorAll('button').forEach((btn) => {
        btn.onclick = async () => {
          const raw = btn.dataset.val
          const val = raw === '' ? null : raw === 'true'
          await save({ [seg.dataset.bool]: val })
          seg.querySelectorAll('button').forEach((b) => (b.className = ''))
          btn.className = val === null ? 'active-unset' : val ? 'active-yes' : 'active-no'
        }
      })
    })

    // Status select re-renders header deadline colouring
    document.getElementById('status-select').addEventListener('change', async (e) => {
      await save({ status: e.target.value })
      renderCase(id); loadInboxList()
    })
  }

  // ---------- DRAFT WORKSPACE ----------
  // Draft modes. Only 'customer' can ever be emailed; the others are copy-and-paste into Seller Central.
  const MODES = {
    customer: { label: 'Reply to customer', icon: 'fa-envelope', banner: '' },
    seller_central_atoz: { label: 'A-to-Z response (Seller Central)', icon: 'fa-scale-balanced', banner: 'Statement to Amazon for the A-to-Z claim. Copy and paste it into Seller Central → A-to-z Guarantee claims. Never emailed. Manager approval required.' },
    seller_central_return: { label: 'Return handling (Seller Central)', icon: 'fa-rotate-left', banner: 'Return note for Seller Central → Manage Returns plus an internal checklist in staff notes. Never emailed. Manager approval required.' },
    chargeback_evidence: { label: 'Chargeback evidence', icon: 'fa-credit-card', banner: 'Evidence representation to Amazon for the chargeback. Copy into the Seller Central chargeback form (email sending will be enabled once the Reply-To address is verified). Manager approval required.' },
  }
  let draftMode = 'customer'

  function renderDraftWorkspace(caseId, kase, drafts, events) {
    const ws = document.getElementById('draft-workspace')
    const active = drafts.filter((d) => d.status !== 'discarded')
    const current = active[0] || null
    const history = active.slice(1)
    const hasCustomerMsg = true
    const ev = events || []
    const available = ['customer', ev.some((e) => e.kind.startsWith('atoz')) || kase.a_to_z_open ? 'seller_central_atoz' : null, ev.some((e) => e.kind === 'return_request') ? 'seller_central_return' : null, ev.some((e) => e.kind === 'chargeback') || kase.chargeback_open ? 'chargeback_evidence' : null].filter(Boolean)
    if (!available.includes(draftMode)) draftMode = current?.mode && available.includes(current.mode) ? current.mode : 'customer'
    const mode = MODES[draftMode]

    ws.innerHTML = `
      <div class="bg-white rounded-xl shadow-sm">
        <div class="px-5 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-semibold"><i class="fas fa-wand-magic-sparkles mr-2 text-slate-400"></i>Draft</h2>
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <div id="mode-bar" class="flex flex-wrap gap-1">${available.map((m) => `<button data-mode="${m}" class="mode-btn ${m === draftMode ? 'active' : ''}"><i class="fas ${MODES[m].icon} mr-1"></i>${MODES[m].label}</button>`).join('')}</div>
            <button id="generate-btn" class="px-4 py-2 rounded-md bg-slate-900 text-white font-medium hover:bg-slate-800 disabled:opacity-50">
              <i class="fas fa-wand-magic-sparkles mr-1"></i>Generate
            </button>
          </div>
        </div>
        ${mode.banner ? `<div class="mode-banner mx-5 mt-4 bg-amber-50 border border-amber-200 text-amber-900"><i class="fas fa-clipboard mr-1"></i>${esc(mode.banner)}</div>` : ''}
        ${current && current.mode && current.mode !== 'customer' ? `<div class="mode-banner mx-5 mt-4 bg-violet-50 border border-violet-200 text-violet-900"><i class="fas fa-paste mr-1"></i>The draft below is a <strong>${esc(MODES[current.mode]?.label || current.mode)}</strong> — copy it into Seller Central, then press <em>Mark as sent</em>. It cannot be emailed.</div>` : ''}
        <div id="draft-body" class="p-5">
          ${current ? draftEditor(current, kase) : `
            <div class="text-center py-10 text-slate-500">
              <i class="fas fa-file-lines text-3xl mb-3 text-slate-300 block"></i>
              No draft yet. Fill in the case details above, then click <strong>Generate draft</strong>.
              <div class="mt-2 text-xs">The AI receives the customer's first name, the thread text (with emails, phones and postcodes redacted) and the case fields — nothing else.</div>
            </div>`}
        </div>
        ${history.length ? `
          <details class="border-t border-slate-100 px-5 py-3 text-sm">
            <summary class="cursor-pointer text-slate-600">${history.length} earlier draft${history.length === 1 ? '' : 's'}</summary>
            <div class="mt-3 space-y-3">
              ${history.map((d) => `
                <div class="rounded-md border border-slate-200 p-3">
                  <div class="flex items-center justify-between text-xs text-slate-500 mb-2">
                    <span>${draftBadge(d.status, d.needs_manager)} ${esc(d.tree || '')} · ${fmtDateTime(d.created_at)} by ${esc(d.created_by_name || '—')}</span>
                    <span class="${d.check_result === 'PASS' ? 'text-emerald-700' : 'text-red-700'} font-semibold">${esc(d.check_result || '')}</span>
                  </div>
                  <div class="message-body text-sm text-slate-700 max-h-40 overflow-auto">${esc(d.draft_text)}</div>
                </div>`).join('')}
            </div>
          </details>` : ''}
      </div>`

    document.getElementById('generate-btn').onclick = () => generate(caseId, draftMode)
    ws.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { draftMode = b.dataset.mode; renderDraftWorkspace(caseId, kase, drafts, events) }))
    if (current) wireDraftEditor(caseId, kase, current)
  }

  function checkBadge(result) {
    return result === 'PASS'
      ? '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold"><i class="fas fa-circle-check"></i> PASS</span>'
      : '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-red-100 text-red-800 text-xs font-bold"><i class="fas fa-circle-xmark"></i> FAIL</span>'
  }

  function draftEditor(d, kase) {
    const server = d.server_findings || []
    const fails = server.filter((f) => f.severity === 'fail')
    const warns = server.filter((f) => f.severity === 'warn')
    const locked = d.status === 'sent'
    const canApprove = d.status === 'draft' && !fails.length && (!d.needs_manager || isManager)
    // One-step send: customer reply on a Gmail case → "Send to customer" saves edits, approves and sends in one go
    const oneStep = !locked && (!d.mode || d.mode === 'customer') && kase.gmail_thread_id && kase.customer_reply_to && ['draft', 'approved'].includes(d.status)
    const canSend = oneStep && !fails.length && (!d.needs_manager || isManager)

    return `
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div class="lg:col-span-2">
          <div class="flex flex-wrap items-center gap-2 mb-3 text-sm">
            ${checkBadge(d.check_result)}
            ${draftBadge(d.status, false)}
            ${d.needs_manager ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-violet-100 text-violet-800 text-xs font-semibold" title="${esc(d.needs_manager_reason || '')}"><i class="fas fa-user-shield"></i> Needs manager${d.needs_manager_reason ? ': ' + esc(d.needs_manager_reason) : ''}</span>` : ''}
            ${d.urgency === 'high' ? '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-red-600 text-white text-xs font-bold"><i class="fas fa-bolt"></i> HIGH URGENCY</span>' : ''}
            <span class="text-xs text-slate-500 ml-auto">Lane: ${esc(d.tree || '—')} · ${esc(d.model || '')}</span>
          </div>
          <label class="field-label" for="draft-text">${d.mode && d.mode !== 'customer' ? 'Text to paste into Seller Central' : 'Customer-facing reply'} ${locked ? '(sent — read only)' : '(edit freely)'}</label>
          <textarea id="draft-text" class="field-input font-sans leading-relaxed" rows="14" ${locked ? 'readonly' : ''}>${esc(d.draft_text)}</textarea>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            ${locked ? '' : `<button id="save-draft-btn" class="px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-sm" title="${oneStep ? 'Optional — Send saves your edits automatically. Use this to re-run the checks without sending.' : ''}"><i class="far fa-floppy-disk mr-1"></i>${oneStep ? 'Save & re-check' : 'Save edits'}</button>`}
            ${locked || (d.mode && d.mode !== 'customer') ? '' : `<select id="template-pick" class="field-input py-1.5 text-sm mt-0" style="width:auto;max-width:16rem" title="Replace the text with a ready-made reply, then fill in the [placeholders]"><option value="">Insert template…</option></select>`}
            <button id="copy-draft-btn" class="px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-sm"><i class="far fa-copy mr-1"></i>Copy reply</button>
            <span id="draft-save-indicator" class="text-xs text-slate-400"></span>
            <span class="ml-auto flex items-center gap-2">
              ${oneStep ? `
                <button id="discard-btn" class="px-3 py-1.5 rounded-md text-sm text-slate-500 hover:text-red-700">Discard</button>
                <button id="send-btn" ${canSend ? '' : 'disabled'} class="px-4 py-1.5 rounded-md text-sm font-medium ${canSend ? 'bg-emerald-700 text-white hover:bg-emerald-800' : 'bg-slate-200 text-slate-500 cursor-not-allowed'}"
                  title="${!canSend ? (fails.length ? 'Fix failing checks first' : 'Only a manager can send this reply') : 'Saves your edits, approves and sends in one step'}">
                  <i class="fas fa-paper-plane mr-1"></i>Send to customer
                </button>
                ${!canSend ? `<span class="block w-full text-right text-[11px] ${fails.length ? 'text-red-700' : 'text-violet-700'}" style="flex-basis:100%">${fails.length ? `<i class="fas fa-lock mr-1"></i>Sending is blocked while a check is <strong>FAIL</strong>. Edit the reply (or use <em>Tell the AI what to change</em>) and it re-checks on send.` : `<i class="fas fa-user-shield mr-1"></i>Needs a manager to send${isManager ? '' : ' — ask a manager'}.`}</span>` : ''}` : d.status === 'draft' ? `
                <button id="discard-btn" class="px-3 py-1.5 rounded-md text-sm text-slate-500 hover:text-red-700">Discard</button>
                <button id="approve-btn" ${canApprove ? '' : 'disabled'} class="px-4 py-1.5 rounded-md text-sm font-medium ${canApprove ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-slate-200 text-slate-500 cursor-not-allowed'}"
                  title="${!canApprove ? (fails.length ? 'Fix failing checks first' : d.needs_manager ? 'Only a manager can approve this draft' : '') : ''}">
                  <i class="fas fa-check mr-1"></i>Approve
                </button>` : ''}
              ${d.status === 'draft' && !canApprove ? `<span class="block w-full text-right text-[11px] ${fails.length ? 'text-red-700' : 'text-violet-700'}" style="flex-basis:100%">${fails.length ? `<i class="fas fa-lock mr-1"></i>Approval is blocked while a check is <strong>FAIL</strong>. Edit the reply to fix it (or press <strong>Save edits</strong> to re-run the checks), then Approve.` : `<i class="fas fa-user-shield mr-1"></i>Needs a manager's approval${isManager ? '' : ' — ask a manager'}.`}</span>` : ''}
              ${!oneStep && d.status === 'approved' ? `
                <button id="unapprove-btn" class="px-3 py-1.5 rounded-md text-sm text-slate-500 hover:text-slate-800">Withdraw approval</button>
                ${(!d.mode || d.mode === 'customer') && kase.gmail_thread_id && kase.customer_reply_to ? `
                <button id="send-btn" class="px-4 py-1.5 rounded-md text-sm font-medium bg-emerald-700 text-white hover:bg-emerald-800">
                  <i class="fas fa-paper-plane mr-1"></i>Send to customer
                </button>` : `
                <button id="record-sent-btn" class="px-4 py-1.5 rounded-md text-sm font-medium bg-sky-600 text-white hover:bg-sky-700" title="${(!d.mode || d.mode === 'customer') ? 'This case has no Gmail thread to reply on (it came from an Amazon notice, not a customer email). Copy the reply, paste it into Seller Central / Buyer-Seller Messages, then confirm here.' : 'Confirm you have pasted this into Amazon Seller Central'}">
                  <i class="fas fa-paste mr-1"></i>Mark as sent in Seller Central
                </button>`}` : ''}
              ${d.status === 'sending' ? '<span class="text-sm text-slate-500"><i class="fas fa-spinner fa-spin mr-1"></i>Sending…</span>' : ''}
            </span>
          </div>
          ${locked ? '' : `
          <section id="revise-panel" class="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3">
            <label class="field-label text-indigo-900" for="revise-text"><i class="fas fa-wand-magic-sparkles mr-1"></i>Not right? Tell the AI what to change</label>
            <textarea id="revise-text" class="field-input text-sm mt-1" rows="2" placeholder="e.g. Shorter. Offer the repair option first, not the return. Don't mention the 30-day window. Ask for a photo of the screen."></textarea>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <button id="revise-btn" class="px-3 py-1.5 rounded-md text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700"><i class="fas fa-rotate mr-1"></i>Rewrite with these changes</button>
              <span class="text-[11px] text-indigo-900/70">Your note is an instruction to the AI, never pasted into the reply. The policy still wins over your note. The current draft is kept in the history as superseded.</span>
            </div>
            ${d.agent_guidance ? `<div class="mt-2 text-[11px] text-indigo-900/80"><i class="fas fa-clock-rotate-left mr-1"></i>This version was rewritten from your request: <em>“${esc(d.agent_guidance)}”</em></div>` : ''}
          </section>`}
          <dl class="mt-3 text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
            <div>Generated ${fmtDateTime(d.created_at)} by ${esc(d.created_by_name || '—')}</div>
            ${d.edited_at ? `<div>Edited ${fmtDateTime(d.edited_at)} by ${esc(d.edited_by_name || '—')}</div>` : ''}
            ${d.approved_at ? `<div class="text-emerald-700">Approved ${fmtDateTime(d.approved_at)} by ${esc(d.approved_by_name || '—')}</div>` : ''}
            ${d.sent_recorded_at ? `<div class="text-sky-700">Sent ${d.sent_via === 'gmail' ? 'via Gmail' : '(recorded manually)'} ${fmtDateTime(d.sent_recorded_at)} by ${esc(d.sent_recorded_by_name || '—')}</div>` : ''}
          </dl>
        </div>

        <aside class="space-y-4">
          <section id="check-panel" class="rounded-lg border ${fails.length ? 'border-red-200 bg-red-50' : d.check_result === 'PASS' ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'} p-4">
            <h3 class="font-semibold text-sm mb-2"><i class="fas fa-list-check mr-1"></i>Guardrail check</h3>
            ${fails.length ? `<ul class="text-sm text-red-800 space-y-1 mb-2">${fails.map((f) => `<li><i class="fas fa-circle-xmark mr-1"></i>${esc(f.detail)}</li>`).join('')}</ul>` : ''}
            ${warns.length ? `<ul class="text-sm text-amber-800 space-y-1 mb-2">${warns.map((f) => `<li><i class="fas fa-triangle-exclamation mr-1"></i>${esc(f.detail)}</li>`).join('')}</ul>` : ''}
            ${!fails.length && !warns.length ? '<p class="text-sm text-emerald-800"><i class="fas fa-circle-check mr-1"></i>All checks against reply_instructions.md passed.</p>' : ''}
          </section>

          <section id="staff-notes-panel" class="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h3 class="font-semibold text-sm mb-2"><i class="fas fa-note-sticky mr-1"></i>Staff notes <span class="font-normal text-xs text-slate-500">(internal, never sent)</span></h3>
            <textarea id="staff-notes" class="field-input text-xs" rows="8" ${locked ? 'readonly' : ''}>${esc(d.staff_notes || '')}</textarea>
          </section>
        </aside>
      </div>`
  }

  function wireDraftEditor(caseId, kase, d) {
    const text = document.getElementById('draft-text')
    const notes = document.getElementById('staff-notes')
    const ind = document.getElementById('draft-save-indicator')
    const refresh = () => { renderCase(caseId); loadInboxList() }

    async function act(fn, okMsg) {
      try {
        await fn()
        if (okMsg) toast(okMsg)
        refresh()
      } catch (err) {
        toast(err.response?.data?.error || err.message, 'err')
      }
    }

    document.getElementById('save-draft-btn')?.addEventListener('click', () =>
      act(() => axios.patch(`/api/drafts/${d.id}`, { draft_text: text.value, staff_notes: notes.value }), 'Draft saved and re-checked')
    )
    const reviseBtn = document.getElementById('revise-btn'), reviseText = document.getElementById('revise-text')
    if (reviseBtn) {
      const go = async () => {
        const guidance = reviseText.value.trim()
        if (guidance.length < 3) { toast('Say what you want changed first', 'err'); reviseText.focus(); return }
        reviseBtn.disabled = true; reviseBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Rewriting…'
        try {
          await axios.post(`/api/drafts/${d.id}/revise`, { guidance, draft_text: text.value }, { timeout: 90000 })
          toast('Rewritten — review the new draft')
          refresh()
        } catch (err) {
          toast(err.response?.data?.error || err.message, 'err')
          reviseBtn.disabled = false; reviseBtn.innerHTML = '<i class="fas fa-rotate mr-1"></i>Rewrite with these changes'
        }
      }
      reviseBtn.onclick = go
      reviseText.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') go() })
    }
    document.getElementById('copy-draft-btn').onclick = async () => {
      await navigator.clipboard.writeText(text.value)
      toast('Reply copied to clipboard')
    }
    const pick = document.getElementById('template-pick')
    if (pick) {
      loadTemplates().then((list) => {
        const groups = {}
        for (const t of list) (groups[t.category] ||= []).push(t)
        pick.innerHTML = '<option value="">Insert template…</option>' + Object.entries(groups).map(([cat, ts]) => `<optgroup label="${esc(cat)}">${ts.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}</optgroup>`).join('')
      })
      pick.onchange = () => {
        const t = templatesCache.find((x) => x.id === Number(pick.value)); pick.value = ''
        if (!t) return
        if (text.value.trim() && text.value.trim() !== d.draft_text.trim() && !confirm('Replace your unsaved edits with this template?')) return
        text.value = fillTemplate(t.body, kase)
        ind.textContent = 'Template inserted — fill in any [placeholders], then Save edits to run the checks'
        text.focus()
      }
    }
    document.getElementById('approve-btn')?.addEventListener('click', () => {
      if (text.value.trim() !== d.draft_text.trim() || (notes.value || '') !== (d.staff_notes || '')) {
        return toast('Save your edits before approving', 'err')
      }
      act(() => axios.post(`/api/drafts/${d.id}/approve`), 'Draft approved')
    })
    document.getElementById('unapprove-btn')?.addEventListener('click', () => act(() => axios.post(`/api/drafts/${d.id}/unapprove`), 'Approval withdrawn'))
    document.getElementById('send-btn')?.addEventListener('click', () => {
      const modal = document.createElement('div')
      modal.id = 'send-confirm'
      modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50'
      modal.innerHTML = `
        <div class="bg-white rounded-xl shadow-xl max-w-2xl w-full p-6">
          <h3 class="font-bold text-lg mb-1"><i class="fas fa-paper-plane mr-2 text-emerald-700"></i>Send this reply now?</h3>
          <p class="text-sm text-slate-600 mb-3">This will email the customer through Amazon's messaging system from the connected mailbox. It cannot be recalled.</p>
          <dl class="text-sm grid grid-cols-4 gap-y-1 mb-3">
            <dt class="text-slate-500">From</dt><dd class="col-span-3 font-mono text-xs" id="send-from">connected mailbox</dd>
            <dt class="text-slate-500">To</dt><dd class="col-span-3 font-mono text-xs break-all">${esc(kase.customer_reply_to)}</dd>
            <dt class="text-slate-500">Case</dt><dd class="col-span-3">${esc(kase.case_ref)} · ${esc(kase.subject)}</dd>
            <dt class="text-slate-500">Approved by</dt><dd class="col-span-3">${esc(d.approved_by_name || ME.name + ' (on send)')} ${d.needs_manager ? '<span class="text-violet-700">(manager)</span>' : ''}</dd>
          </dl>
          <pre class="message-body text-sm bg-slate-50 border border-slate-200 rounded-md p-3 max-h-64 overflow-auto font-sans">${esc(text.value.trim())}</pre>
          ${text.value.trim() !== d.draft_text.trim() ? '<p class="text-xs text-amber-700 mt-2"><i class="fas fa-pen mr-1"></i>Includes your unsaved edits — they are saved, re-checked and approved as part of sending.</p>' : ''}
          <div class="mt-4 flex justify-end gap-2">
            <button id="send-cancel" class="px-4 py-2 rounded-md border border-slate-300 text-sm">Cancel</button>
            <button id="send-now" class="px-4 py-2 rounded-md bg-emerald-700 text-white text-sm font-medium"><i class="fas fa-paper-plane mr-1"></i>Send now</button>
          </div>
        </div>`
      document.body.appendChild(modal)
      if (kase.mailbox_email) { const el = modal.querySelector('#send-from'); if (el) el.textContent = `${kase.mailbox_email} (${kase.mailbox_label || 'mailbox'})` }
      else axios.get('/api/gmail/status').then(({ data }) => { const el = modal.querySelector('#send-from'); if (el && data.connection) el.textContent = `${data.connection.email_address} (default mailbox)` }).catch(() => {})
      modal.querySelector('#send-cancel').onclick = () => modal.remove()
      modal.querySelector('#send-now').onclick = async () => {
        const b = modal.querySelector('#send-now'); b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Sending…'
        try {
          await axios.post(`/api/drafts/${d.id}/send`, { confirm_text: text.value.trim(), final_text: text.value.trim(), staff_notes: notes.value }, { timeout: 60000 })
          modal.remove(); toast('Reply sent to the customer'); refresh()
        } catch (err) {
          b.disabled = false; b.innerHTML = '<i class="fas fa-paper-plane mr-1"></i>Send now'
          toast(err.response?.data?.error || err.message, 'err')
        }
      }
    })
    document.getElementById('record-sent-btn')?.addEventListener('click', () => {
      if (!confirm('Confirm you have sent this exact reply to the customer via Amazon. ReplyIQ will log it on the thread.')) return
      act(() => axios.post(`/api/drafts/${d.id}/record-sent`), 'Recorded as sent')
    })
    document.getElementById('discard-btn')?.addEventListener('click', () => {
      if (!confirm('Discard this draft?')) return
      act(() => axios.post(`/api/drafts/${d.id}/discard`), 'Draft discarded')
    })

    // Unsaved-change hint
    const dirty = () => { ind.textContent = 'Unsaved changes'; ind.className = 'text-xs text-amber-600' }
    text.addEventListener('input', dirty)
    notes.addEventListener('input', dirty)
  }

  async function generate(caseId, mode) {
    const btn = document.getElementById('generate-btn')
    btn.disabled = true
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Drafting with gpt-5.5…'
    try {
      await axios.post(`/api/cases/${caseId}/drafts`, { mode: mode || 'customer' }, { timeout: 120000 })
      toast('Draft generated — review before approving')
      renderCase(caseId)
    } catch (err) {
      toast(err.response?.data?.error || err.message, 'err')
      btn.disabled = false
      btn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-1"></i>Generate draft'
    }
  }

  // ---------- STAFF ADMIN (managers) ----------
  async function renderStaff() {
    if (!isManager) return navigate('/')
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading staff…</p>`
    let users
    try {
      ;({ data: { users } } = await axios.get('/api/auth/users'))
    } catch (err) {
      return renderError(err)
    }
    app.innerHTML = `
      <section id="staff-section">
        <h1 class="text-2xl font-bold mb-1">Staff</h1>
        <p class="text-sm text-slate-500 mb-4">Managers can approve any draft, including those flagged <em>needs manager</em>. Agents can approve ordinary drafts only.</p>
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div class="lg:col-span-2 bg-white rounded-xl shadow-sm overflow-hidden">
            <table class="w-full text-sm">
              <thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr><th class="px-4 py-3">Name</th><th class="px-4 py-3">Email</th><th class="px-4 py-3">Role</th><th class="px-4 py-3">Last login</th><th class="px-4 py-3">Status</th></tr>
              </thead>
              <tbody>
                ${users.map((u) => `
                  <tr class="border-b border-slate-100" data-user-id="${u.id}">
                    <td class="px-4 py-3 font-medium">${esc(u.name)}${u.id === ME.id ? ' <span class="text-xs text-slate-400">(you)</span>' : ''}</td>
                    <td class="px-4 py-3 text-slate-600">${esc(u.email)}</td>
                    <td class="px-4 py-3">
                      <select data-role class="field-input py-1" style="width:auto" ${u.id === ME.id ? 'disabled' : ''}>
                        <option value="agent" ${u.role === 'agent' ? 'selected' : ''}>agent</option>
                        <option value="manager" ${u.role === 'manager' ? 'selected' : ''}>manager</option>
                      </select>
                    </td>
                    <td class="px-4 py-3 text-slate-500">${u.last_login_at ? dayjs(u.last_login_at).fromNow() : 'never'}</td>
                    <td class="px-4 py-3">
                      <button data-toggle class="text-xs px-2 py-1 rounded-md ${u.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-600'}" ${u.id === ME.id ? 'disabled' : ''}>${u.is_active ? 'active' : 'deactivated'}</button>
                      <button data-reset class="text-xs px-2 py-1 rounded-md border border-slate-300 ml-1" title="Set a new password">reset pw</button>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <form id="new-user-form" class="bg-white rounded-xl shadow-sm p-5 space-y-3">
            <h2 class="font-semibold">Add staff member</h2>
            <div><label class="field-label">Name</label><input name="name" required class="field-input"></div>
            <div><label class="field-label">Work email</label><input name="email" type="email" required class="field-input"></div>
            <div><label class="field-label">Role</label><select name="role" class="field-input"><option value="agent">agent</option><option value="manager">manager</option></select></div>
            <div><label class="field-label">Initial password (10+ chars)</label><input name="password" type="text" minlength="10" required class="field-input font-mono"></div>
            <button class="w-full py-2 rounded-md bg-slate-900 text-white text-sm font-medium">Create</button>
          </form>
        </div>
      </section>`

    app.querySelector('#new-user-form').onsubmit = async (e) => {
      e.preventDefault()
      const f = e.target
      try {
        await axios.post('/api/auth/users', { name: f.name.value, email: f.email.value, role: f.role.value, password: f.password.value })
        toast('Staff member created')
        renderStaff()
      } catch (err) {
        toast(err.response?.data?.error || err.message, 'err')
      }
    }
    app.querySelectorAll('tr[data-user-id]').forEach((tr) => {
      const id = tr.dataset.userId
      const patch = async (body, msg) => {
        try { await axios.patch(`/api/auth/users/${id}`, body); toast(msg); renderStaff() } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      }
      tr.querySelector('[data-role]').onchange = (e) => patch({ role: e.target.value }, 'Role updated')
      tr.querySelector('[data-toggle]').onclick = (e) => patch({ is_active: e.target.textContent.trim() !== 'active' }, 'Status updated')
      tr.querySelector('[data-reset]').onclick = () => {
        const pw = prompt('New password (10+ characters). The user will be signed out.')
        if (pw) patch({ password: pw }, 'Password reset')
      }
    })
  }

  // ---------- GMAIL (connection + sync status) ----------
  async function renderGmail() {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</p>`
    let st
    try { ;({ data: st } = await axios.get('/api/gmail/status')) } catch (err) { return renderError(err) }
    const q = new URLSearchParams(location.search)
    const flash = q.get('ok') ? `<div class="mb-4 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-2 text-sm"><i class="fas fa-circle-check mr-1"></i>${esc(q.get('ok'))}</div>`
      : q.get('error') ? `<div class="mb-4 rounded-md bg-red-50 border border-red-200 text-red-800 px-4 py-2 text-sm"><i class="fas fa-circle-xmark mr-1"></i>${esc(q.get('error'))}</div>` : ''
    const boxes = st.mailboxes || (st.connection ? [{ ...st.connection, id: 1, label: 'Mailbox', enabled: true, is_default: true, cases: null }] : [])
    const mailboxCard = (m) => `
      <div class="rounded-lg border ${m.enabled ? 'border-slate-200' : 'border-dashed border-slate-300 opacity-70'} p-4 mailbox-card" data-mailbox="${m.id}">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="pill ${m.label.toLowerCase() === 'manager' ? 'bg-violet-100 text-violet-800' : 'bg-sky-100 text-sky-800'}"><i class="fas ${m.label.toLowerCase() === 'manager' ? 'fa-user-shield' : 'fa-headset'} mr-1"></i>${esc(m.label)}</span>
          ${m.is_default ? '<span class="pill bg-emerald-100 text-emerald-800" title="Used for cases that did not come through a mailbox">default</span>' : ''}
          ${!m.enabled ? '<span class="pill bg-slate-200 text-slate-700">paused</span>' : ''}
          <span class="ml-auto text-[11px] text-slate-400">${m.cases != null ? `${m.cases} case${m.cases === 1 ? '' : 's'}` : ''}</span>
        </div>
        <div class="font-medium text-sm break-all">${esc(m.email_address)}</div>
        <dl class="text-xs text-slate-500 mt-1 space-y-0.5">
          <div>Connected ${fmtDateTime(m.connected_at)} by ${esc(m.connected_by_name || '—')}</div>
          <div>Last sync: ${m.last_sync_at ? dayjs(m.last_sync_at).fromNow() : 'never'} ${m.last_sync_status === 'error' ? `<span class="text-red-700">— ${esc(m.last_sync_error || 'error')}</span>` : m.last_sync_status === 'partial' ? `<span class="text-amber-700">— ${esc(m.last_sync_error || 'partial')}</span>` : m.last_sync_status === 'ok' ? `<span class="text-emerald-700">OK${m.last_sync_new_msgs ? ` · ${m.last_sync_new_msgs} new` : ''}</span>` : ''}</div>
        </dl>
        <div class="mt-3 flex flex-wrap gap-2 text-xs">
          <button data-act="sync" class="px-2 py-1 rounded-md bg-slate-900 text-white"><i class="fas fa-rotate mr-1"></i>Sync this mailbox</button>
          ${isManager && st.multi_mailbox ? `
            <select data-act="import" class="field-input py-1 text-xs mt-0" style="width:auto"><option value="">Import history…</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select>
            <button data-act="rename" class="px-2 py-1 rounded-md border border-slate-300"><i class="fas fa-pen mr-1"></i>Rename</button>
            ${m.is_default ? '' : '<button data-act="default" class="px-2 py-1 rounded-md border border-slate-300">Make default</button>'}
            <button data-act="toggle" class="px-2 py-1 rounded-md border border-slate-300">${m.enabled ? '<i class="fas fa-pause mr-1"></i>Pause' : '<i class="fas fa-play mr-1"></i>Resume'}</button>
            <button data-act="reconnect" class="px-2 py-1 rounded-md border border-slate-300" title="Refresh Google permission for this address"><i class="fab fa-google mr-1"></i>Reconnect</button>` : ''}
          ${isManager ? '<button data-act="disconnect" class="px-2 py-1 rounded-md border border-red-300 text-red-700">Disconnect</button>' : ''}
        </div>
      </div>`
    app.innerHTML = `
      <section id="gmail-section">
        <h1 class="text-2xl font-bold mb-1"><i class="fab fa-google mr-2 text-slate-400"></i>Gmail mailboxes</h1>
        <p class="text-sm text-slate-500 mb-4">ReplyIQ reads Amazon customer messages from every connected mailbox every ${st.poll_interval_minutes} minutes. Replies go out from the <strong>same mailbox the customer wrote to</strong>. Email is only ever sent when a member of staff presses <strong>Send to customer</strong> on an approved draft.</p>
        ${flash}
        ${!st.configured ? `<div class="mb-4 rounded-md bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 text-sm"><i class="fas fa-triangle-exclamation mr-1"></i>${esc(st.configError)}</div>` : ''}
        ${!st.multi_mailbox ? `<div class="mb-4 rounded-md bg-amber-50 border border-amber-200 text-amber-900 px-4 py-3 text-sm"><i class="fas fa-database mr-1"></i>To connect more than one mailbox, run <code>db/migrations/0013_multi_mailbox.sql</code> in Supabase, then reload.</div>` : ''}
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div class="lg:col-span-1 space-y-4">
            <div class="bg-white rounded-xl shadow-sm p-5 space-y-3">
              <h2 class="font-semibold">Connected mailboxes <span class="text-xs font-normal text-slate-400">(${boxes.length})</span></h2>
              ${boxes.length ? boxes.map(mailboxCard).join('') : '<p class="text-sm text-slate-600">No mailbox connected yet.</p>'}
              ${isManager ? `
              <div class="pt-3 border-t border-slate-100">
                <div class="text-xs font-semibold text-slate-600 mb-2">${boxes.length ? 'Add another mailbox' : 'Connect a mailbox'}</div>
                <div class="flex gap-2">
                  <select id="connect-label" class="field-input py-1.5 text-sm mt-0" ${st.multi_mailbox ? '' : 'disabled'}>
                    <option value="Manager" ${boxes.some((b) => b.label === 'Manager') ? 'disabled' : ''}>Manager</option>
                    <option value="Agent" ${boxes.some((b) => b.label === 'Agent') ? 'disabled' : ''}>Agent</option>
                    <option value="Returns">Returns</option><option value="Mailbox">Other</option>
                  </select>
                  <button id="connect" ${st.configured && (st.multi_mailbox || !boxes.length) ? '' : 'disabled'} class="px-4 py-1.5 rounded-md bg-slate-900 text-white text-sm whitespace-nowrap disabled:opacity-50"><i class="fab fa-google mr-1"></i>Connect Gmail</button>
                </div>
                <p class="mt-2 text-[11px] text-slate-400">You will be asked to sign in to Google <em>as that mailbox</em> and allow read + send. The token is stored encrypted.</p>
              </div>` : '<p class="text-xs text-slate-500">A manager connects mailboxes.</p>'}
            </div>
            ${boxes.length ? `<div class="bg-white rounded-xl shadow-sm p-5">
              <h2 class="font-semibold mb-2 text-sm">All mailboxes</h2>
              <div class="flex flex-wrap gap-2">
                <button id="sync-now" class="px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm"><i class="fas fa-rotate mr-1"></i>Sync all now</button>
                ${isManager ? '<button id="tone-backfill" class="px-3 py-1.5 rounded-md border border-slate-300 text-sm" title="Label customer messages that have no tone yet"><i class="fas fa-tags mr-1"></i>Label tones</button>' : ''}
                ${isManager ? '<button id="att-backfill" class="px-3 py-1.5 rounded-md border border-slate-300 text-sm" title="Record photo/PDF attachments on messages imported before attachments were tracked"><i class="fas fa-paperclip mr-1"></i>Scan attachments</button>' : ''}
                ${isManager && boxes.length > 1 ? '<button id="dedupe-btn" class="px-3 py-1.5 rounded-md border border-slate-300 text-sm" title="The same Amazon email arrives in every mailbox. Remove copies imported twice before cross-mailbox de-duplication was added."><i class="fas fa-clone mr-1"></i>Remove duplicates</button>' : ''}
              </div>
            </div>` : ''}
          </div>
          <div class="lg:col-span-2 bg-white rounded-xl shadow-sm overflow-hidden">
            <div class="px-5 py-3 border-b border-slate-100 font-semibold">Recent sync runs</div>
            <table class="w-full text-sm">
              <thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th class="px-4 py-2">When</th><th class="px-4 py-2">Mailbox</th><th class="px-4 py-2">Trigger</th><th class="px-4 py-2">Threads</th><th class="px-4 py-2">New msgs</th><th class="px-4 py-2">New cases</th><th class="px-4 py-2">Result</th></tr></thead>
              <tbody>${st.recent_runs.length ? st.recent_runs.map((r) => `<tr class="border-b border-slate-100"><td class="px-4 py-2 whitespace-nowrap">${fmtDateTime(r.started_at)}</td><td class="px-4 py-2 text-xs">${r.mailbox_label ? `<span class="font-medium">${esc(r.mailbox_label)}</span><div class="text-slate-400">${esc(r.mailbox_email || '')}</div>` : '<span class="text-slate-400">—</span>'}</td><td class="px-4 py-2">${esc(r.trigger)}</td><td class="px-4 py-2">${r.threads_seen ?? '—'}</td><td class="px-4 py-2">${r.messages_new ?? '—'}</td><td class="px-4 py-2">${r.cases_new ?? '—'}</td><td class="px-4 py-2 ${r.status === 'error' ? 'text-red-700' : r.status === 'partial' ? 'text-amber-700' : 'text-emerald-700'}" title="${esc(r.error || '')}">${esc(r.status || 'running')}${r.status === 'partial' ? ' <span class="text-[10px]">(rate limited, resumes)</span>' : ''}</td></tr>`).join('') : '<tr><td colspan="7" class="px-4 py-6 text-center text-slate-400">No runs yet</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </section>`
    const connectWith = async (label) => {
      try { const { data } = await axios.post('/api/gmail/connect', { label }); location.href = data.url } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
    }
    const runImport = async (days, mailboxId, el) => {
      if (!confirm(`Import Amazon customer threads from the last ${days} days${mailboxId ? ' for this mailbox' : ''} as cases? Threads already imported are skipped.`)) { if (el) el.value = ''; return }
      if (el) el.disabled = true
      let total = { c: 0, m: 0 }, rounds = 0
      try {
        for (;;) {
          const { data } = await axios.post('/api/gmail/sync', { days, ...(mailboxId ? { mailbox_id: mailboxId } : {}) }, { timeout: 120000 })
          total.c += data.casesNew; total.m += data.messagesNew; rounds++
          if (!data.remaining || rounds > 80) { toast(`Importing… ${total.c} case(s), ${total.m} message(s) so far, ${data.remaining} thread(s) left`); break }
          if (data.rateLimited) {
            // Gmail allows a fixed number of units per minute per user; wait it out rather than fail the import.
            for (let w = 65; w > 0; w -= 5) { toast(`Gmail per-minute limit reached — waiting ${w}s, then continuing (${total.c} case(s) so far, ${data.remaining} thread(s) left)`); await new Promise((r) => setTimeout(r, 5000)) }
          } else {
            toast(`Importing… ${total.c} case(s), ${total.m} message(s) so far, ${data.remaining} thread(s) left`)
            await new Promise((r) => setTimeout(r, 1500)) // ~12 threads per round → stay well under the per-minute quota
          }
        }
        toast(`Import complete: ${total.c} new case(s), ${total.m} new message(s)`)
      } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      history.replaceState({}, '', '/gmail'); renderGmail()
    }
    app.querySelectorAll('.mailbox-card [data-act]').forEach((b) => {
      const id = Number(b.closest('.mailbox-card').dataset.mailbox)
      const m = boxes.find((x) => x.id === id)
      const patch = async (body, msg) => { try { await axios.patch(`/api/gmail/mailboxes/${id}`, body); toast(msg); renderGmail() } catch (err) { toast(err.response?.data?.error || err.message, 'err') } }
      if (b.dataset.act === 'import') { b.onchange = () => { const d = Number(b.value); if (d) runImport(d, id, b) }; return }
      b.onclick = async () => {
        switch (b.dataset.act) {
          case 'sync': b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Syncing…'
            try { const { data } = await axios.post('/api/gmail/sync', { mailbox_id: id }, { timeout: 120000 }); toast(`${m.label}: ${data.messagesNew} new message(s), ${data.casesNew} new case(s)`) } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
            history.replaceState({}, '', '/gmail'); renderGmail(); break
          case 'rename': { const l = prompt('Label for this mailbox (e.g. Manager, Agent, Returns)', m.label); if (l && l.trim()) patch({ label: l.trim() }, 'Renamed'); break }
          case 'default': patch({ is_default: true }, `${m.label} is now the default mailbox`); break
          case 'toggle': patch({ enabled: !m.enabled }, m.enabled ? 'Mailbox paused — it will not be polled' : 'Mailbox resumed'); break
          case 'reconnect': connectWith(m.label); break
          case 'disconnect':
            if (!confirm(`Disconnect ${m.email_address}? Its cases stay in ReplyIQ; syncing and sending from this address stop until reconnected.`)) return
            try { await axios.post('/api/gmail/disconnect', { mailbox_id: id }); toast('Disconnected'); history.replaceState({}, '', '/gmail'); renderGmail() } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
        }
      }
    })
    app.querySelector('#connect')?.addEventListener('click', () => connectWith(document.getElementById('connect-label')?.value || 'Mailbox'))
    app.querySelector('#tone-backfill')?.addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true
      let total = 0, rounds = 0
      try {
        for (;;) {
          b.innerHTML = `<i class="fas fa-spinner fa-spin mr-1"></i>Labelling… ${total} done`
          const { data } = await axios.post('/api/gmail/tone-backfill', { limit: 20 }, { timeout: 120000 })
          total += data.labelled; rounds++
          if (!data.remaining || !data.labelled || rounds > 40) { toast(`Tone labels: ${total} message(s) labelled, ${data.remaining} remaining`); break }
        }
      } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      renderGmail()
    })
    app.querySelector('#dedupe-btn')?.addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true
      try {
        const { data } = await axios.post('/api/gmail/dedupe', { apply: false })
        if (!data.duplicates) { toast('No duplicate messages found'); b.disabled = false; return }
        const sample = data.sample.slice(0, 6).map((x) => `${x.case_ref}: "${x.preview}…" (${x.reason})`).join('\n')
        if (!confirm(`Found ${data.duplicates} duplicate message(s) imported from two mailboxes.\n\nThe earliest copy is kept; the later copy is removed. Examples:\n${sample}\n\nRemove them now?`)) { b.disabled = false; return }
        const r = await axios.post('/api/gmail/dedupe', { apply: true })
        toast(`Removed ${r.data.removed} duplicate message(s)`)
      } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      renderGmail()
    })
    app.querySelector('#att-backfill')?.addEventListener('click', async (e) => {
      e.target.disabled = true
      let total = 0, rounds = 0
      try {
        for (;;) {
          const { data } = await axios.post('/api/gmail/attachment-backfill', {}, { timeout: 120000 })
          total += data.attachments; rounds++
          toast(`Scanning… ${total} attachment(s) found, ${data.remaining} message(s) left`)
          if (!data.remaining || rounds > 40) break
        }
        toast(`Scan complete: ${total} attachment(s) recorded`)
      } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      renderGmail()
    })
    app.querySelector('#sync-now')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Syncing…'
      try { const { data } = await axios.post('/api/gmail/sync', {}, { timeout: 120000 }); const per = (data.mailboxes || []).map((x) => `${x.label}: ${x.error ? 'error' : x.messagesNew + ' new'}`).join(' · '); toast(`Sync done: ${data.messagesNew} new message(s), ${data.casesNew} new case(s)${per ? ' — ' + per : ''}`) } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      history.replaceState({}, '', '/gmail'); renderGmail()
    })
  }


  // ---------- INBOX (3-pane: ticket list | conversation+draft) ----------
  let inboxCases = [], inboxNow = null
  let toneFilter = new Set(JSON.parse(localStorage.getItem('riq.tones') || '[]'))
  const selected = new Set()
  const TONE_CHIPS = [...Object.keys(TONE_META), 'none']
  function toneFilterBar() {
    return `<div id="tone-filter" class="px-3 py-1.5 border-b border-slate-100 flex flex-wrap gap-1 items-center">
      ${TONE_CHIPS.map((t) => `<button data-tone="${t}" class="tone tone-${t} ${toneFilter.size && !toneFilter.has(t) ? 'opacity-30' : ''}" style="cursor:pointer" title="Toggle">${t === 'none' ? 'NO LABEL' : TONE_META[t].word}</button>`).join('')}
      ${toneFilter.size ? '<button id="tone-clear" class="text-[10px] text-slate-500 underline ml-1">clear</button>' : ''}
    </div>`
  }
  function wireToneFilter() {
    document.querySelectorAll('#tone-filter [data-tone]').forEach((b) => (b.onclick = () => { const t = b.dataset.tone; toneFilter.has(t) ? toneFilter.delete(t) : toneFilter.add(t); localStorage.setItem('riq.tones', JSON.stringify([...toneFilter])); document.getElementById('tone-filter').outerHTML = toneFilterBar(); wireToneFilter(); filterInboxList() }))
    document.getElementById('tone-clear')?.addEventListener('click', () => { toneFilter.clear(); localStorage.setItem('riq.tones', '[]'); document.getElementById('tone-filter').outerHTML = toneFilterBar(); wireToneFilter(); filterInboxList() })
  }
  let inboxShellFilter = null
  async function renderInbox(caseId) {
    const shell = document.getElementById('inbox-list')
    if (shell && inboxShellFilter !== listFilter) {
      // Same inbox shell, different folder → update the heading/select and reload the list
      inboxShellFilter = listFilter
      const name = document.getElementById('inbox-folder-name'); if (name) name.innerHTML = `<i class="fas ${FOLDER_ICON[listFilter] || ''} mr-1 text-slate-400"></i>${esc((folderList().find(([v]) => v === listFilter) || ['', listFilter])[1])}`
      const sel = document.getElementById('inbox-filter'); if (sel) sel.value = listFilter
      selected.clear(); await loadInboxList()
    }
    if (!shell) {
      inboxShellFilter = listFilter
      app.innerHTML = `
        <section class="inbox ${caseId ? 'show-detail' : ''}">
          <div class="pane pane-list">
            <div class="px-3 py-2 border-b border-slate-100 flex items-center justify-between gap-2">
              <h1 class="font-semibold text-sm"><i class="fas fa-inbox mr-1 text-slate-400"></i>Inbox <span class="text-slate-400 font-normal">/</span> <span id="inbox-folder-name"><i class="fas ${FOLDER_ICON[listFilter] || ''} mr-1 text-slate-400"></i>${esc((folderList().find(([v]) => v === listFilter) || ['', listFilter])[1])}</span></h1>
              <select id="inbox-filter" class="field-input py-1 text-xs mt-0" style="width:auto" title="Folder">
                ${folderList().map(([v, l]) => `<option value="${v}" ${listFilter === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            ${toneFilterBar()}
            <div id="bulk-bar" class="hidden px-3 py-2 border-b border-slate-200 bg-slate-50 text-xs">
              <div class="flex items-center justify-between mb-1"><span><strong id="bulk-count">0</strong> selected</span><button id="bulk-clear" class="text-slate-500 underline">clear</button></div>
              <div class="flex flex-wrap gap-1">
                <button data-bulk="resolve" class="px-2 py-1 rounded bg-emerald-600 text-white"><i class="fas fa-check mr-1"></i>Mark resolved</button>
                <select data-bulk-select="status" class="field-input py-1 text-xs mt-0" style="width:auto"><option value="">Set status…</option><option value="open">Open</option><option value="awaiting_customer">Awaiting customer</option><option value="update_customer">Update customer</option></select>
                <select data-bulk-select="assign" class="field-input py-1 text-xs mt-0" style="width:auto"><option value="">Assign to…</option><option value="__none">Unassigned</option></select>
                <select data-bulk-select="tone" class="field-input py-1 text-xs mt-0" style="width:auto"><option value="">Change tone…</option>${Object.entries(TONE_META).map(([v, m]) => `<option value="${v}">${m.word}</option>`).join('')}</select>
                ${isManager ? '<button data-bulk="archive" class="px-2 py-1 rounded border border-slate-300 text-slate-700"><i class="fas fa-box-archive mr-1"></i>Archive</button>' : ''}
              </div>
              <div class="mt-1 text-[10px] text-slate-400"><i class="fas fa-shield-halved"></i> Bulk actions never send email. Resolve skips open A-to-Z / chargeback, battery flags and drafts awaiting a manager.</div>
            </div>
            <div class="px-3 py-1 text-[10px] text-slate-400 border-b border-slate-100 flex items-center justify-between"><span>Overdue → <span class="tone tone-angry">ANGRY</span>/<span class="tone tone-dispute">DISPUTE</span> → by deadline</span><label class="flex items-center gap-1 cursor-pointer"><input type="checkbox" id="select-all"> all visible</label></div>
            <div id="inbox-list" class="pane-scroll"><p class="p-4 text-sm text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</p></div>
            <div id="inbox-count" class="px-3 py-1.5 text-[10px] text-slate-400 border-t border-slate-100"></div>
          </div>
          <div class="pane pane-detail"><div id="inbox-detail" class="pane-scroll">
            <div class="h-full flex items-center justify-center text-slate-400 text-sm p-10 text-center"><div><i class="fas fa-comments text-4xl mb-3 block text-slate-200"></i>Select a conversation</div></div>
          </div></div>
        </section>`
      document.getElementById('inbox-filter').onchange = (e) => { navigate(`/inbox/${e.target.value}`) }
      wireToneFilter()
      wireBulkBar()
      await loadInboxList()
    }
    if (caseId) renderCase(caseId)
    else document.querySelector('.inbox')?.classList.remove('show-detail')
  }
  async function loadInboxList() {
    try { const { data } = await axios.get('/api/cases', { params: { status: listFilter } }); inboxCases = data.cases; inboxNow = dayjs(data.now) } catch (err) { return renderError(err) }
    filterInboxList()
  }
  function filterInboxList() {
    const el = document.getElementById('inbox-list'); if (!el) return
    const q = searchTerm
    const rows = inboxCases.filter((k) => (!q || [k.order_id, k.customer_first_name, k.customer_last_name, k.subject, k.case_ref].some((v) => String(v || '').toLowerCase().includes(q))) && (!toneFilter.size || toneFilter.has(k.tone || 'none')))
    const cur = Number((location.pathname.match(/^\/cases\/(\d+)$/) || [])[1])
    el.innerHTML = rows.length ? rows.map((k) => {
      const d = deadlineInfo(k, inboxNow)
      const pri = k.tone === 'angry' || k.tone === 'dispute' || k.battery_flag || d.urgency === 0 ? 'high' : d.urgency === 1 || k.open_atoz || k.open_chargebacks ? 'medium' : 'low'
      return `<a href="/cases/${k.id}" data-link data-case-id="${k.id}" class="ticket-item ${k.id === cur ? 'active' : ''} ${d.urgency === 0 ? 'overdue' : ''}">
        <div class="flex items-start justify-between gap-2">
          <label class="flex items-start gap-2 min-w-0" onclick="event.stopPropagation()"><input type="checkbox" data-select="${k.id}" class="mt-1" ${selected.has(k.id) ? 'checked' : ''}><span class="text-sm font-medium leading-snug line-clamp-2">${esc(k.subject)}</span></label>
          <span class="pill pill-${pri}">${pri.toUpperCase()}</span>
        </div>
        <div class="mt-0.5 text-[11px] text-slate-500">${esc(k.customer_first_name)} ${esc(k.customer_last_name || '')} · <span class="font-mono">${esc(k.order_id || k.case_ref)}</span></div>
        <div class="mt-1 flex items-center justify-between gap-2 text-[10px]">
          <span class="flex items-center gap-1 flex-wrap">${statusBadge(k.status)}${toneChip(k.tone)}${k.open_atoz ? '<span class="pill" style="background:#ede9fe;color:#6d28d9">A-to-Z</span>' : ''}${k.open_returns ? '<span class="pill" style="background:#cffafe;color:#155e75">RETURN</span>' : ''}${k.open_chargebacks ? '<span class="pill" style="background:#ffe4e6;color:#9f1239">CHARGEBACK</span>' : ''}${k.battery_flag ? '<span class="pill" style="background:#dc2626;color:#fff"><i class="fas fa-fire"></i></span>' : ''}${k.carrier_status ? `<span class="pill ${k.carrier_status === 'sla_breach' || k.carrier_update_due ? 'bg-sky-600 text-white' : 'bg-sky-100 text-sky-800'}" title="Carrier: ${esc(k.carrier_status.replace(/_/g, ' '))}${k.carrier_update_due ? ' — news for the customer' : ''}"><i class="fas fa-truck-fast"></i>${k.carrier_update_due ? ' NEWS' : ''}</span>` : k.carrier_issue ? '<span class="pill bg-amber-100 text-amber-800" title="Customer reports a delivery problem"><i class="fas fa-truck-fast"></i>?</span>' : ''}</span>
          <span class="${d.cls} whitespace-nowrap"><i class="far fa-clock"></i> ${esc(d.label)}</span>
        </div>
      </a>`
    }).join('') : inboxCases.length
      ? `<div class="p-6 text-sm text-slate-500 text-center"><i class="fas fa-filter mr-1"></i>${inboxCases.length} conversation${inboxCases.length === 1 ? '' : 's'} in this folder, hidden by your ${toneFilter.size && q ? 'tone filter and search' : toneFilter.size ? 'tone filter' : 'search'}.<br><button id="inbox-show-all" class="mt-2 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">Show all ${inboxCases.length}</button></div>`
      : '<p class="p-6 text-sm text-slate-400 text-center">Nothing in this folder.</p>'
    document.getElementById('inbox-show-all')?.addEventListener('click', () => {
      toneFilter.clear(); localStorage.setItem('riq.tones', '[]'); searchTerm = ''
      const si = document.getElementById('global-search'); if (si) si.value = ''
      const tf = document.getElementById('tone-filter'); if (tf) { tf.outerHTML = toneFilterBar(); wireToneFilter() }
      filterInboxList()
    })
    const c = document.getElementById('inbox-count'); if (c) c.textContent = `${rows.length} of ${inboxCases.length} conversation(s)`
    el.querySelectorAll('[data-select]').forEach((cb) => { cb.onclick = (e) => { e.stopPropagation(); const id = Number(cb.dataset.select); cb.checked ? selected.add(id) : selected.delete(id); updateBulkBar() } })
    const sa = document.getElementById('select-all'); if (sa) { sa.checked = rows.length > 0 && rows.every((k) => selected.has(k.id)); sa.onchange = () => { rows.forEach((k) => (sa.checked ? selected.add(k.id) : selected.delete(k.id))); filterInboxList() } }
    updateBulkBar()
  }
  function updateBulkBar() {
    const bar = document.getElementById('bulk-bar'); if (!bar) return
    bar.classList.toggle('hidden', selected.size === 0)
    document.getElementById('bulk-count').textContent = selected.size
  }
  async function wireBulkBar() {
    const bar = document.getElementById('bulk-bar'); if (!bar) return
    try { const { data } = await axios.get('/api/cases/' + (inboxCases[0]?.id || 1)); const sel = bar.querySelector('[data-bulk-select="assign"]'); (data.staff || []).forEach((u) => { const o = document.createElement('option'); o.value = u.id; o.textContent = u.name; sel.appendChild(o) }) } catch {}
    document.getElementById('bulk-clear').onclick = () => { selected.clear(); filterInboxList() }
    const run = async (action, value) => {
      const ids = [...selected]
      const label = { resolve: 'mark as resolved', status: `set status to ${value}`, assign: 'assign', tone: `set tone to ${value}`, archive: 'archive' }[action]
      if (!confirm(`${label} ${ids.length} case(s)?`)) return
      try {
        const { data } = await axios.post('/api/cases/bulk', { ids, action, value })
        showBulkResult(data)
        selected.clear(); await loadInboxList(); refreshBadges()
        const cur = Number((location.pathname.match(/^\/cases\/(\d+)$/) || [])[1]); if (cur && ids.includes(cur)) renderCase(cur)
      } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
    }
    bar.querySelectorAll('[data-bulk]').forEach((b) => (b.onclick = () => run(b.dataset.bulk)))
    bar.querySelectorAll('[data-bulk-select]').forEach((sel) => (sel.onchange = () => { if (!sel.value) return; const v = sel.value === '__none' ? null : sel.value; const a = sel.dataset.bulkSelect; sel.value = ''; run(a, v) }))
  }
  function showBulkResult(r) {
    const verb = { resolve: 'resolved', status: 'updated', assign: 'assigned', tone: 'relabelled', archive: 'archived' }[r.action] || 'done'
    if (!r.skipped.length) return toast(`${r.done.length} case(s) ${verb}`)
    const modal = document.createElement('div')
    modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50'
    modal.innerHTML = `<div class="bg-white rounded-xl shadow-xl max-w-lg w-full p-5">
      <h3 class="font-bold mb-1">${r.done.length} ${verb}, ${r.skipped.length} skipped</h3>
      <p class="text-xs text-slate-500 mb-3">These need individual attention and were left unchanged:</p>
      <ul class="text-sm space-y-1 max-h-72 overflow-auto">${r.skipped.map((s) => `<li class="flex gap-2"><a href="/cases/${s.id}" data-link class="font-mono text-xs text-sky-700 hover:underline whitespace-nowrap">${esc(s.case_ref || '#' + s.id)}</a><span class="text-slate-700">${esc(s.reason)}</span></li>`).join('')}</ul>
      <div class="mt-4 text-right"><button id="bulk-ok" class="px-4 py-2 rounded-md bg-slate-900 text-white text-sm">OK</button></div></div>`
    document.body.appendChild(modal)
    modal.querySelector('#bulk-ok').onclick = () => modal.remove()
    modal.addEventListener('click', (e) => { if (e.target.closest('a[data-link]')) modal.remove() })
  }

  // ---------- DASHBOARD ----------
  async function renderDashboard() {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading dashboard…</p>`
    let cases, counts, events = []
    try {
      const [a, b, e1, e2, e3] = await Promise.all([axios.get('/api/cases', { params: { status: 'active' } }), axios.get('/api/events/counts'), axios.get('/api/events', { params: { kind: 'atoz' } }), axios.get('/api/events', { params: { kind: 'chargeback' } }), axios.get('/api/events', { params: { kind: 'return' } })])
      cases = a.data.cases; inboxNow = dayjs(a.data.now); counts = b.data; events = [...e1.data.events, ...e2.data.events, ...e3.data.events]
    } catch (err) { return renderError(err) }
    const now = inboxNow
    const overdue = cases.filter((k) => deadlineInfo(k, now).urgency === 0)
    const due4h = cases.filter((k) => deadlineInfo(k, now).urgency === 1)
    const hot = cases.filter((k) => k.tone === 'angry' || k.tone === 'dispute')
    const battery = cases.filter((k) => k.battery_flag)
    const needsMgr = cases.filter((k) => k.latest_draft_needs_manager && k.latest_draft_status === 'draft')
    const alerts = [...overdue.map((k) => ({ k, t: 'Reply overdue', cls: 'text-red-700' })), ...battery.map((k) => ({ k, t: 'Battery / heat safety', cls: 'text-red-700' })), ...hot.filter((k) => !overdue.includes(k)).map((k) => ({ k, t: `${TONE_META[k.tone].word} tone`, cls: 'text-violet-700' }))].slice(0, 8)
    const toneCounts = Object.keys(TONE_META).map((t) => [t, cases.filter((k) => k.tone === t).length])
    const total = cases.length || 1
    const eventsDue = events.filter((e) => e.deadline_at && !['won', 'lost', 'closed', 'refunded'].includes(e.status)).sort((a, b) => new Date(a.deadline_at) - new Date(b.deadline_at)).slice(0, 6)
    app.innerHTML = `
      <section id="dashboard">
        <h1 class="text-2xl font-bold">Dashboard</h1>
        <p class="text-sm text-slate-500 mb-4">Saigates Ltd · Amazon UK customer service · ${now.format('ddd DD MMM, HH:mm')}</p>
        ${alerts.length ? `<div class="mb-4 rounded-xl border border-red-200 bg-red-50 p-4">
          <div class="font-semibold text-red-800 mb-1"><i class="fas fa-triangle-exclamation mr-1"></i>${alerts.length} item${alerts.length === 1 ? '' : 's'} need attention now</div>
          <ul class="text-sm grid sm:grid-cols-2 gap-x-6 gap-y-1">${alerts.map(({ k, t, cls }) => `<li class="flex gap-2 min-w-0"><span class="${cls} font-medium whitespace-nowrap">${t}:</span><a href="/cases/${k.id}" data-link class="truncate hover:underline">${esc(k.subject)} <span class="text-slate-400 font-mono text-xs">${esc(k.order_id || k.case_ref)}</span></a></li>`).join('')}</ul>
          <a href="/inbox" data-link class="inline-block mt-3 px-3 py-1.5 rounded-md bg-red-600 text-white text-sm font-medium">Open inbox →</a>
        </div>` : '<div class="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><i class="fas fa-circle-check mr-1"></i>Nothing overdue and no hot conversations. Nice.</div>'}
        <div id="carrier-strip"></div>
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <div class="kpi" style="--kpi:#2563eb"><div class="l">Open conversations</div><div class="v">${counts.messages}</div><div class="text-xs text-slate-500">${due4h.length} due within 4h</div></div>
          <div class="kpi" style="--kpi:#dc2626"><div class="l">Overdue replies</div><div class="v ${overdue.length ? 'text-red-700' : ''}">${overdue.length}</div><div class="text-xs text-slate-500">24h Amazon target</div></div>
          <div class="kpi" style="--kpi:#7c3aed"><div class="l">A-to-Z · Chargebacks</div><div class="v">${counts.atoz} · ${counts.chargebacks}</div><div class="text-xs text-slate-500">${counts.returns} open return${counts.returns === 1 ? '' : 's'}</div></div>
          <div class="kpi" style="--kpi:#f59e0b"><div class="l">Awaiting manager</div><div class="v">${needsMgr.length}</div><div class="text-xs text-slate-500">drafts needing approval</div></div>
        </div>
        <div class="grid lg:grid-cols-3 gap-4">
          <div class="lg:col-span-2 bg-white rounded-xl shadow-sm p-4">
            <h2 class="font-semibold mb-3">Amazon deadlines</h2>
            ${eventsDue.length ? `<table class="riq"><thead class="text-left text-[10px] uppercase text-slate-500"><tr><th class="px-2 py-1">Due</th><th class="px-2 py-1">Type</th><th class="px-2 py-1">Order</th><th class="px-2 py-1">Amount</th><th class="px-2 py-1">Status</th></tr></thead><tbody>
              ${eventsDue.map((e) => { const d = deadlineInfo({ status: 'open', effective_deadline: e.deadline_at }, now); return `<tr class="border-t border-slate-100"><td class="px-2 py-2 ${d.cls} whitespace-nowrap">${esc(d.label)}</td><td class="px-2 py-2">${esc(EVENT_LABEL[e.kind] || e.kind)}</td><td class="px-2 py-2"><a href="/cases/${e.case_id}" data-link class="font-mono text-xs text-sky-700 hover:underline">${esc(e.order_id)}</a></td><td class="px-2 py-2">${e.amount ? '£' + Number(e.amount).toFixed(2) : '—'}</td><td class="px-2 py-2 text-xs">${esc(e.status)}</td></tr>` }).join('')}
            </tbody></table>` : '<p class="text-sm text-slate-400">No open Amazon deadlines.</p>'}
          </div>
          <div class="bg-white rounded-xl shadow-sm p-4">
            <h2 class="font-semibold mb-3">Customer tone (open)</h2>
            ${toneCounts.map(([t, n]) => `<div class="flex items-center gap-2 mb-2 text-xs">${toneChip(t)}<div class="flex-1 h-2 rounded bg-slate-100 overflow-hidden"><div class="h-2 tone-${t}" style="width:${Math.round((n / total) * 100)}%;background:currentColor"></div></div><span class="w-6 text-right text-slate-600">${n}</span></div>`).join('')}
            <p class="text-[10px] text-slate-400 mt-2">${cases.filter((k) => !k.tone).length} unlabelled</p>
          </div>
        </div>
      </section>`
    if (carrierUI) carrierUI.dashboardStrip().then((html) => { const el = document.getElementById('carrier-strip'); if (el) el.innerHTML = html })
  }


  // ---------- REPLY POLICY (read-only view of reply_instructions.md — the exact text the AI follows) ----------
  async function renderPolicy() {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading policy…</p>`
    let d
    try { ;({ data: d } = await axios.get('/api/policy')) } catch (err) { return renderError(err) }
    const html = window.marked ? marked.parse(d.markdown) : `<pre class="whitespace-pre-wrap">${esc(d.markdown)}</pre>`
    app.innerHTML = `
      <section id="policy">
        <div class="rounded-xl bg-gradient-to-r from-indigo-900 to-violet-700 text-white p-6 mb-4">
          <span class="text-[10px] px-2 py-0.5 rounded-full bg-white/20">Policy reference</span>
          <h1 class="text-2xl font-bold mt-2">Reply policy</h1>
          <p class="text-sm text-indigo-100">This is <code>reply_instructions.md</code> exactly as sent to <strong>${esc(d.model)}</strong> for every draft. The guardrail checks mirror its "Never" list. Edit the file in the repo to change behaviour — the UI cannot change it.</p>
        </div>
        <article class="bg-white rounded-xl shadow-sm p-6 prose prose-sm max-w-none policy-doc">${html}</article>
      </section>`
  }

  // ---------- SETTINGS (status only — secrets never leave the server) ----------
  async function renderSettings() {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</p>`
    let st, gm
    try { ;[{ data: st }, { data: gm }] = await Promise.all([axios.get('/api/settings'), axios.get('/api/gmail/status')]) } catch (err) { return renderError(err) }
    const row = (k, v) => `<div class="flex justify-between gap-4 py-2 border-b border-slate-100 text-sm"><span class="text-slate-500">${k}</span><span class="text-right font-medium">${v}</span></div>`
    const ok = (b, y = 'Configured', n = 'Not configured') => (b ? `<span class="text-emerald-700"><i class="fas fa-circle-check mr-1"></i>${y}</span>` : `<span class="text-red-700"><i class="fas fa-circle-xmark mr-1"></i>${n}</span>`)
    app.innerHTML = `
      <section id="settings">
        <h1 class="text-2xl font-bold">Settings</h1>
        <p class="text-sm text-slate-500 mb-4">System configuration and integrations. Keys are stored as Cloudflare secrets and are never shown here.</p>
        <div class="grid lg:grid-cols-2 gap-4">
          <div class="bg-white rounded-xl shadow-sm p-5">
            <h2 class="font-semibold mb-2"><i class="fas fa-robot mr-2 text-slate-400"></i>AI</h2>
            ${row('OpenAI API key', ok(st.openai_configured))}
            ${row('Draft model', `<code>${esc(st.draft_model)}</code>`)}
            ${row('Tone model', `<code>${esc(st.tone_model)}</code>`)}
            ${row('Data retention at OpenAI', `<code>store: ${st.openai_store}</code> — nothing kept`)}
            ${row('Sent to the model', 'first name, redacted thread, case fields, Amazon events')}
            ${row('System prompt', `<code>reply_instructions.md</code>${isManager ? ' + <a href="/settings/prompt" data-link class="text-sky-700 hover:underline">custom prompt</a>' : ''} + <a href="/knowledge" data-link class="text-sky-700 hover:underline">knowledge-base rules</a>`)}
            ${row('Never sent', 'surname, email, phone, address, internal notes, attachments')}
          </div>
          ${isManager ? `<div class="bg-white rounded-xl shadow-sm p-5">
            <h2 class="font-semibold mb-2"><i class="fas fa-feather-pointed mr-2 text-slate-400"></i>Custom system prompt <span class="pill bg-violet-100 text-violet-800 ml-1">managers only</span></h2>
            <p class="text-sm text-slate-600">Company background, voice and house style for the drafting model. Placed <strong>after</strong> the policy file and <strong>before</strong> knowledge-base rules, so the policy always wins. Versioned — every save is kept and can be rolled back.</p>
            <div id="prompt-summary" class="text-xs text-slate-500 mt-2">checking…</div>
            <a href="/settings/prompt" data-link class="inline-block mt-3 px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm"><i class="fas fa-pen mr-1"></i>Open editor</a>
          </div>` : ''}
          <div class="bg-white rounded-xl shadow-sm p-5">
            <h2 class="font-semibold mb-2"><i class="fas fa-paper-plane mr-2 text-slate-400"></i>Sending controls</h2>
            <div class="flex items-center justify-between py-2 border-b border-slate-100 text-sm"><span><strong>Auto-send</strong><br><span class="text-xs text-slate-500">AI sends replies without a human</span></span><span class="px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 text-xs font-semibold">OFF — by design</span></div>
            <ul class="mt-3 text-sm space-y-1 text-slate-700">
              <li><i class="fas fa-check text-emerald-600 mr-1"></i>Only <em>approved</em> drafts can be sent</li>
              <li><i class="fas fa-check text-emerald-600 mr-1"></i>Drafts flagged <em>needs manager</em> require a manager's approval</li>
              <li><i class="fas fa-check text-emerald-600 mr-1"></i>Text must match the approved version exactly</li>
              <li><i class="fas fa-check text-emerald-600 mr-1"></i>All guardrail checks must pass</li>
              <li><i class="fas fa-check text-emerald-600 mr-1"></i>Seller Central / chargeback statements can never be emailed</li>
              <li><i class="fas fa-check text-emerald-600 mr-1"></i>One send per draft, logged with who/when</li>
            </ul>
          </div>
          <div class="bg-white rounded-xl shadow-sm p-5">
            <h2 class="font-semibold mb-2"><i class="fab fa-google mr-2 text-slate-400"></i>Gmail</h2>
            ${row('Mailbox', gm.connected ? esc(gm.connection.email_address) : ok(false, '', 'Not connected'))}
            ${row('Last sync', gm.connection?.last_sync_at ? dayjs(gm.connection.last_sync_at).fromNow() : '—')}
            ${row('Polling', `every ${gm.poll_interval_minutes} min`)}
            ${row('Scopes', gm.scopes.map((x) => `<code class="text-xs">${esc(x.split('/').pop())}</code>`).join(' '))}
            <a href="/gmail" data-link class="inline-block mt-3 text-sm text-sky-700 hover:underline">Manage connection →</a>
          </div>
          <div class="bg-white rounded-xl shadow-sm p-5">
            <h2 class="font-semibold mb-2"><i class="fab fa-amazon mr-2 text-slate-400"></i>Amazon SP-API</h2>
            ${row('Credentials', `<span id="spapi-state">checking…</span>`)}
            ${row('App type', 'Private, self-authorised')}
            ${row('Roles', 'Inventory &amp; Order Tracking · Buyer Solicitation')}
            ${row('Data requested', 'Order status, items, prices, packages/tracking — <strong>never</strong> buyer or address data')}
            ${row('Review requests', 'Solicitations API only · 7–30 days after delivery · once per order')}
            ${isManager ? '<button id="spapi-test" class="mt-3 text-sm px-3 py-1.5 rounded-md border border-slate-300">Test connection</button> <span id="spapi-test-result" class="text-xs ml-2"></span>' : ''}
            <p class="mt-2 text-[10px] text-slate-400">Secrets: SPAPI_LWA_CLIENT_ID · SPAPI_LWA_CLIENT_SECRET · SPAPI_REFRESH_TOKEN (Cloudflare → Workers → replyiq → Settings → Variables &amp; Secrets)</p>
          </div>
          <div class="bg-white rounded-xl shadow-sm p-5">
            <h2 class="font-semibold mb-2"><i class="fas fa-server mr-2 text-slate-400"></i>Platform</h2>
            ${row('Hosting', esc(st.hosting))}
            ${row('Database', esc(st.database))}
            ${row('Attachments (Amazon rules)', `${st.attachments.types.join(', ')} · ≤${st.attachments.max_files} files · ≤${st.attachments.max_message_mb} MB/message`)}
            ${row('Case deletion', 'Disabled at database level — archive only')}
          </div>
        </div>
      </section>`
    if (isManager) axios.get('/api/prompt').then(({ data }) => { const el = document.getElementById('prompt-summary'); if (!el) return; el.innerHTML = data.migration_needed ? `<span class="text-amber-700"><i class="fas fa-database mr-1"></i>Run <code>db/migrations/${esc(data.migration_needed)}</code> first</span>` : data.current && data.current.body.trim() ? `<span class="text-emerald-700"><i class="fas fa-circle-check mr-1"></i>v${data.current.version} in force</span> · ${data.current.body.trim().length} chars · saved ${dayjs(data.current.created_at).fromNow()} by ${esc(data.current.created_by_name || '—')}` : '<span class="text-slate-500">No custom prompt yet — the model gets the policy file and knowledge base only.</span>' }).catch(() => {})
    axios.get('/api/spapi/status').then(({ data }) => { const el = document.getElementById('spapi-state'); if (el) el.innerHTML = data.configured ? '<span class="text-emerald-700"><i class="fas fa-circle-check mr-1"></i>Configured</span>' : '<span class="text-amber-700"><i class="fas fa-circle-exclamation mr-1"></i>Not configured</span>' }).catch(() => {})
    document.getElementById('spapi-test')?.addEventListener('click', async (e) => {
      const out = document.getElementById('spapi-test-result'); e.target.disabled = true; out.textContent = 'testing…'
      try { const { data } = await axios.post('/api/spapi/test'); out.innerHTML = data.ok ? `<span class="text-emerald-700">✓ ${esc(data.detail)}</span>` : `<span class="text-red-700">✗ ${esc(data.detail)}</span>` } catch (err) { out.innerHTML = `<span class="text-red-700">${esc(err.response?.data?.error || err.message)}</span>` }
      e.target.disabled = false
    })
  }

  // ---------- CUSTOM SYSTEM PROMPT EDITOR (managers only; versioned; test before save) ----------
  async function renderPromptEditor() {
    if (!isManager) return navigate('/settings')
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</p>`
    let d, cases = []
    try {
      ;[{ data: d }, { data: { cases } }] = await Promise.all([axios.get('/api/prompt'), axios.get('/api/cases', { params: { status: 'active' } })])
    } catch (err) { return renderError(err) }
    const cur = d.current
    const curText = cur ? cur.body : ''
    const MAX = d.max_chars
    app.innerHTML = `
      <section id="prompt-editor">
        <div class="flex flex-wrap items-end justify-between gap-4 mb-4">
          <div><h1 class="text-2xl font-bold"><i class="fas fa-feather-pointed mr-2 text-slate-400"></i>Custom system prompt</h1>
            <p class="text-sm text-slate-500">Describe the company, the voice and the house style. The model receives: <code>reply_instructions.md</code> → <strong>this text</strong> → knowledge-base rules. The policy file always wins on a conflict and the guardrail checks still run on every draft.</p></div>
          <a href="/settings" data-link class="text-sm text-sky-700 hover:underline"><i class="fas fa-arrow-left mr-1"></i>Settings</a>
        </div>
        ${d.migration_needed ? `<div class="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><i class="fas fa-database mr-1"></i>Run <code>db/migrations/${esc(d.migration_needed)}</code> in the Supabase SQL Editor, then reload. Drafting works without it (no custom prompt is applied).</div>` : ''}
        <div class="grid lg:grid-cols-3 gap-4">
          <div class="lg:col-span-2 space-y-4">
            <div class="bg-white rounded-xl shadow-sm p-5">
              <div class="flex items-center justify-between mb-2">
                <div class="text-sm">${cur && curText.trim() ? `<span class="pill bg-emerald-100 text-emerald-800">v${cur.version} in force</span> <span class="text-xs text-slate-500 ml-1">saved ${dayjs(cur.created_at).fromNow()} by ${esc(cur.created_by_name || '—')}${cur.note ? ` · “${esc(cur.note)}”` : ''}</span>` : '<span class="pill bg-slate-200 text-slate-700">No custom prompt yet</span>'}</div>
                <span id="pe-count" class="text-xs text-slate-400">${curText.trim().length}/${MAX}</span>
              </div>
              <textarea id="pe-body" rows="14" maxlength="${MAX}" class="field-input font-mono text-[13px] leading-relaxed" placeholder="Example:
Saigates Ltd is a small family-run business in the UK selling professionally renewed iPhones on Amazon. Every phone is tested with Dr.Fone before dispatch and comes with a 12-month warranty.

Voice: warm, calm and plain. Short sentences. Use the customer's first name once at the start. Avoid jargon and exclamation marks. Never blame the customer or the courier.

House style: open with a one-line acknowledgement of the problem, then the next step, then what happens after that. End with the sign-off from the policy.">${esc(curText)}</textarea>
              <div id="pe-check" class="text-xs mt-2 text-slate-400">Checked against the Never list as you type. Leave empty to remove the custom prompt.</div>
              <div class="flex flex-wrap items-end gap-2 mt-3">
                <div class="flex-1 min-w-[12rem]"><label class="field-label">Change note (optional)</label><input id="pe-note" class="field-input" placeholder="e.g. Added house style section"></div>
                <button id="pe-save" class="px-4 py-2 rounded-md bg-slate-900 text-white text-sm font-medium"><i class="fas fa-floppy-disk mr-1"></i>Save as new version</button>
              </div>
            </div>
            <div class="bg-white rounded-xl shadow-sm p-5">
              <h2 class="font-semibold mb-1"><i class="fas fa-flask mr-2 text-slate-400"></i>Test on a case before saving</h2>
              <p class="text-xs text-slate-500 mb-3">Generates a throwaway draft with the text above. Nothing is stored and the case is not touched.</p>
              <div class="flex flex-wrap gap-2 items-end">
                <div class="flex-1 min-w-[14rem]"><label class="field-label">Case</label><select id="pe-case" class="field-input">${cases.map((k) => `<option value="${k.id}">${esc(k.case_ref)} · ${esc(k.subject).slice(0, 60)} (${esc(k.customer_first_name || '')})</option>`).join('')}</select></div>
                <div><label class="field-label">Mode</label><select id="pe-mode" class="field-input"><option value="customer">Customer reply</option><option value="seller_central_atoz">A-to-Z statement</option><option value="seller_central_return">Return statement</option><option value="chargeback_evidence">Chargeback evidence</option></select></div>
                <button id="pe-test" class="px-4 py-2 rounded-md bg-violet-600 text-white text-sm font-medium"><i class="fas fa-play mr-1"></i>Test</button>
              </div>
              <div id="pe-test-out" class="mt-3"></div>
            </div>
            <div class="bg-white rounded-xl shadow-sm p-5">
              <button id="pe-preview-btn" class="text-sm text-sky-700 hover:underline"><i class="fas fa-eye mr-1"></i>Preview the full system message (policy + this text + knowledge base)</button>
              <pre id="pe-preview" class="hidden mt-3 text-[11px] whitespace-pre-wrap bg-slate-50 border border-slate-200 rounded-md p-3 max-h-[32rem] overflow-auto"></pre>
            </div>
          </div>
          <div class="space-y-4">
            <div class="bg-white rounded-xl shadow-sm p-4">
              <h2 class="font-semibold mb-2 text-sm"><i class="fas fa-clock-rotate-left mr-2 text-slate-400"></i>Version history</h2>
              ${d.history.length ? `<ol class="space-y-2 text-xs">${d.history.map((h, i) => `<li class="border border-slate-200 rounded-md p-2 ${i === 0 ? 'bg-emerald-50 border-emerald-200' : ''}" data-v="${h.version}">
                <div class="flex items-center gap-2"><strong>v${h.version}</strong>${i === 0 ? '<span class="pill bg-emerald-100 text-emerald-800">current</span>' : ''}${h.restored_from ? `<span class="pill bg-slate-100 text-slate-600">from v${h.restored_from}</span>` : ''}<span class="ml-auto text-slate-400">${dayjs(h.created_at).format('DD MMM HH:mm')}</span></div>
                <div class="text-slate-500 mt-0.5">${esc(h.created_by_name || '—')}${h.note ? ` · ${esc(h.note)}` : ''} · ${h.body.trim().length} chars${h.used_in_drafts ? ` · ${h.used_in_drafts} draft${h.used_in_drafts === 1 ? '' : 's'}` : ''}</div>
                <div class="text-slate-600 mt-1 line-clamp-2">${esc(h.body.trim().slice(0, 140) || '(empty — no custom prompt)')}</div>
                <div class="mt-1.5 flex gap-2"><button data-act="view" class="text-sky-700 hover:underline">View</button>${i !== 0 ? `<button data-act="load" class="text-sky-700 hover:underline">Load into editor</button><button data-act="rollback" class="text-amber-700 hover:underline">Roll back to this</button>` : ''}</div>
              </li>`).join('')}</ol>` : '<p class="text-xs text-slate-400">No versions yet.</p>'}
            </div>
            <div class="bg-white rounded-xl shadow-sm p-4 text-xs text-slate-600 space-y-2">
              <div class="font-semibold text-slate-700"><i class="fas fa-lightbulb mr-1 text-amber-500"></i>What goes here</div>
              <ul class="list-disc pl-4 space-y-1"><li>Who Saigates is and what you sell</li><li>Voice and tone (warm, calm, plain)</li><li>Structure of a good reply</li><li>Things to avoid saying (beyond the policy)</li></ul>
              <div class="font-semibold text-slate-700 pt-1">Put elsewhere</div>
              <ul class="list-disc pl-4 space-y-1"><li>Individual facts or situational rules → <a href="/knowledge" data-link class="text-sky-700 hover:underline">Knowledge base</a></li><li>Changes to warranty lanes or the Never list → <code>reply_instructions.md</code> (ask the developer)</li></ul>
            </div>
          </div>
        </div>
      </section>`
    const body = document.getElementById('pe-body'), check = document.getElementById('pe-check'), count = document.getElementById('pe-count')
    let t, lastOk = true
    const runCheck = async () => {
      count.textContent = `${body.value.trim().length}/${MAX}`
      try { const { data } = await axios.post('/api/prompt/check', { body: body.value }); lastOk = !data.problems.length; check.innerHTML = data.problems.length ? data.problems.map((p) => `<div class="text-red-700"><i class="fas fa-circle-xmark mr-1"></i>${esc(p)}</div>`).join('') : body.value.trim() ? '<span class="text-emerald-700"><i class="fas fa-circle-check mr-1"></i>Passes the policy checks</span>' : '<span class="text-slate-400">Empty — saving removes the custom prompt.</span>' } catch {}
    }
    body.oninput = () => { clearTimeout(t); t = setTimeout(runCheck, 350) }
    document.getElementById('pe-save').onclick = async (e) => {
      e.target.disabled = true
      try { const { data } = await axios.post('/api/prompt', { body: body.value, note: document.getElementById('pe-note').value }); toast(`Saved as v${data.version} — used from the next draft`); renderPromptEditor() } catch (err) { toast(err.response?.data?.problems?.[0] || err.response?.data?.error || err.message, 'err'); e.target.disabled = false }
    }
    document.getElementById('pe-test').onclick = async (e) => {
      const out = document.getElementById('pe-test-out'); e.target.disabled = true
      out.innerHTML = '<p class="text-sm text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Generating a test draft (not saved)…</p>'
      try {
        const { data } = await axios.post('/api/prompt/test', { body: body.value, case_id: Number(document.getElementById('pe-case').value), mode: document.getElementById('pe-mode').value })
        out.innerHTML = `<div class="rounded-lg border border-violet-200 bg-violet-50 p-3">
          <div class="flex flex-wrap items-center gap-2 text-xs mb-2"><span class="pill bg-violet-100 text-violet-800"><i class="fas fa-flask mr-1"></i>TEST — not saved</span><span class="pill ${data.check_result === 'PASS' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}">${data.check_result}</span>${data.needs_manager ? `<span class="pill bg-amber-100 text-amber-800">needs manager: ${esc(data.needs_manager_reason)}</span>` : ''}<span class="pill pill-${data.urgency === 'high' ? 'high' : data.urgency === 'low' ? 'low' : 'medium'}">${esc(data.urgency)}</span><span class="text-slate-500 ml-auto">lane: ${esc(data.lane)} · ${esc(data.case.case_ref)}${data.compared_to_version ? ` · current is v${data.compared_to_version}` : ''}</span></div>
          <div class="message-body text-sm bg-white rounded-md p-3 border border-slate-200">${esc(data.draft_text)}</div>
          ${data.staff_notes ? `<div class="text-xs text-slate-600 mt-2"><strong>Staff notes:</strong> ${esc(data.staff_notes)}</div>` : ''}
          ${data.server_findings.length ? `<ul class="text-xs mt-2 space-y-0.5">${data.server_findings.map((f) => `<li class="${f.severity === 'fail' ? 'text-red-700' : 'text-amber-700'}"><i class="fas ${f.severity === 'fail' ? 'fa-circle-xmark' : 'fa-triangle-exclamation'} mr-1"></i>${esc(f.rule)}: ${esc(f.detail)}</li>`).join('')}</ul>` : ''}
        </div>`
      } catch (err) { out.innerHTML = `<p class="text-sm text-red-700">${esc(err.response?.data?.problems?.[0] || err.response?.data?.error || err.message)}</p>` }
      e.target.disabled = false
    }
    document.getElementById('pe-preview-btn').onclick = async () => {
      const pre = document.getElementById('pe-preview')
      if (!pre.classList.contains('hidden')) { pre.classList.add('hidden'); return }
      try { const { data } = await axios.get('/api/prompt/preview', { params: { body: body.value } }); pre.textContent = `(${data.chars} characters · policy file + ${data.parts.custom_prompt_chars} chars custom + ${data.parts.kb_rules} knowledge-base rule${data.parts.kb_rules === 1 ? '' : 's'})\n\n${data.system_prompt}`; pre.classList.remove('hidden') } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
    }
    app.querySelectorAll('[data-v] [data-act]').forEach((b) => {
      b.onclick = async () => {
        const v = Number(b.closest('[data-v]').dataset.v); const h = d.history.find((x) => x.version === v)
        if (b.dataset.act === 'view') { alert(`Version ${v}\n\n${h.body || '(empty)'}`); return }
        if (b.dataset.act === 'load') { body.value = h.body; runCheck(); body.scrollIntoView({ behavior: 'smooth', block: 'start' }); toast(`v${v} loaded into the editor — not saved yet`); return }
        if (!confirm(`Roll back to version ${v}? This creates a new version with v${v}'s text; nothing is deleted.`)) return
        try { const { data } = await axios.post(`/api/prompt/rollback/${v}`); toast(`Rolled back — saved as v${data.version}`); renderPromptEditor() } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      }
    })
  }

  // ---------- REPLY TEMPLATES (ready-to-use short replies; inserted into the draft editor, then checked as usual) ----------
  let templatesCache = []
  async function loadTemplates(force) {
    if (templatesCache.length && !force) return templatesCache
    try { const { data } = await axios.get('/api/templates'); templatesCache = data.templates || [] } catch { templatesCache = [] }
    return templatesCache
  }
  // Fill what we safely know; everything else stays as a visible [placeholder] for the agent.
  function fillTemplate(body, kase) {
    return body.replace(/\[Name\]/g, kase?.customer_first_name || '[Name]').replace(/\[tracking\]/g, kase?.tracking_number || '[tracking]')
  }
  async function renderTemplates() {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading templates…</p>`
    let d
    try { ;({ data: d } = await axios.get('/api/templates', { params: isManager ? { all: 1 } : {} })) } catch (err) { return renderError(err) }
    templatesCache = d.templates.filter((t) => t.status === 'active')
    const groups = {}
    for (const t of d.templates) (groups[t.category] ||= []).push(t)
    const form = (t) => `
      <form id="tpl-form" class="bg-white rounded-xl shadow-sm p-5 space-y-3" data-id="${t ? t.id : ''}">
        <h2 class="font-semibold">${t ? `Edit “${esc(t.title)}”` : 'Add a template'}</h2>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="field-label">Title</label><input name="title" required class="field-input" value="${esc(t?.title || '')}"></div>
          <div><label class="field-label">Category</label><select name="category" class="field-input">${d.categories.map((c) => `<option value="${c}" ${t?.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        </div>
        <div><label class="field-label">Reply text (use [Name], [Address], [date/time], [tracking], [reference] as placeholders)</label><textarea name="body" rows="12" required class="field-input font-sans leading-relaxed">${esc(t?.body || 'Dear [Name],\n\nThank you for your message.\n\n\n\nIf you need any further help, please let us know.\n\nKind regards,\nCustomer Support Team')}</textarea></div>
        <div class="flex gap-2">
          <button class="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm font-medium">${t ? 'Save changes' : 'Add template'}</button>
          ${t ? `<button type="button" id="tpl-cancel" class="px-3 py-2 rounded-md border border-slate-300 text-sm">Cancel</button>` : ''}
        </div>
        <p class="text-[11px] text-slate-400">Templates go through the same content checks as knowledge-base rules, and every draft built from one is still guardrail-checked before approval.</p>
      </form>`
    app.innerHTML = `
      <section id="templates">
        <div class="flex flex-wrap items-end justify-between gap-4 mb-4">
          <div><h1 class="text-2xl font-bold"><i class="fas fa-file-lines mr-2 text-slate-400"></i>Reply templates</h1><p class="text-sm text-slate-500">Ready-to-send short replies. In a case, choose <em>Insert template…</em> under the draft to drop one in, fill the [placeholders], save and approve as usual.</p></div>
        </div>
        ${d.migration_needed ? `<div class="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><i class="fas fa-database mr-1"></i>Run <code>db/migrations/${esc(d.migration_needed)}</code> in Supabase, then reload.</div>` : ''}
        <div class="grid lg:grid-cols-3 gap-4">
          <div class="lg:col-span-2 space-y-4">
            ${Object.entries(groups).map(([cat, ts]) => `<div><h2 class="text-xs uppercase tracking-wider text-slate-500 mb-2">${esc(cat)}</h2><div class="space-y-2">${ts.map((t) => `
              <article class="bg-white rounded-xl shadow-sm p-4 tpl-card ${t.status === 'retired' ? 'opacity-60' : ''}" data-id="${t.id}">
                <div class="flex items-center gap-2 mb-1"><h3 class="font-semibold">${esc(t.title)}</h3>${t.status === 'retired' ? '<span class="pill bg-slate-200 text-slate-700">retired</span>' : ''}<span class="ml-auto text-[10px] text-slate-400">${esc(t.slug)}</span></div>
                <pre class="text-sm text-slate-700 whitespace-pre-wrap font-sans leading-relaxed max-h-40 overflow-auto">${esc(t.body)}</pre>
                <div class="flex gap-2 mt-3 text-xs">
                  <button data-act="copy" class="px-2 py-1 rounded-md border border-slate-300"><i class="far fa-copy mr-1"></i>Copy</button>
                  ${isManager ? `<button data-act="edit" class="px-2 py-1 rounded-md border border-slate-300"><i class="fas fa-pen mr-1"></i>Edit</button>
                  <button data-act="${t.status === 'active' ? 'retire' : 'restore'}" class="px-2 py-1 rounded-md border border-slate-300">${t.status === 'active' ? '<i class="fas fa-box-archive mr-1"></i>Retire' : '<i class="fas fa-rotate-left mr-1"></i>Restore'}</button>` : ''}
                </div>
              </article>`).join('')}</div></div>`).join('') || '<div class="bg-white rounded-xl shadow-sm p-8 text-center text-slate-500 text-sm">No templates yet.</div>'}
          </div>
          <div class="space-y-4">${isManager ? `<div id="tpl-form-wrap">${form(null)}</div>` : ''}
            <div class="bg-white rounded-xl shadow-sm p-4 text-xs text-slate-600 space-y-1"><div class="font-semibold text-slate-700"><i class="fas fa-lightbulb mr-1 text-amber-500"></i>Placeholders</div><p><code>[Name]</code> and <code>[tracking]</code> are filled automatically from the case when inserted. Anything else in square brackets stays visible so you remember to replace it.</p></div>
          </div>
        </div>
      </section>`
    const wireForm = (t) => {
      const f = document.getElementById('tpl-form'); if (!f) return
      f.onsubmit = async (e) => {
        e.preventDefault()
        try {
          if (t) await axios.patch(`/api/templates/${t.id}`, { title: f.title.value, category: f.category.value, body: f.body.value })
          else await axios.post('/api/templates', { title: f.title.value, category: f.category.value, body: f.body.value })
          toast(t ? 'Template updated' : 'Template added'); renderTemplates()
        } catch (err) { toast(err.response?.data?.problems?.[0] || err.response?.data?.error || err.message, 'err') }
      }
      document.getElementById('tpl-cancel')?.addEventListener('click', () => { document.getElementById('tpl-form-wrap').innerHTML = form(null); wireForm(null) })
    }
    wireForm(null)
    app.querySelectorAll('.tpl-card [data-act]').forEach((b) => {
      b.onclick = async () => {
        const id = Number(b.closest('.tpl-card').dataset.id); const t = d.templates.find((x) => x.id === id)
        if (b.dataset.act === 'copy') { await navigator.clipboard.writeText(t.body); toast('Template copied'); return }
        if (b.dataset.act === 'edit') { document.getElementById('tpl-form-wrap').innerHTML = form(t); wireForm(t); document.getElementById('tpl-form').scrollIntoView({ behavior: 'smooth' }); return }
        try { await axios.patch(`/api/templates/${id}`, { status: b.dataset.act === 'retire' ? 'retired' : 'active' }); toast(b.dataset.act === 'retire' ? 'Template retired' : 'Template restored'); renderTemplates() } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      }
    })
  }

  // ---------- DECISION TREES (visual walk-through of the lanes in reply_instructions.md) ----------
  // Node shapes: { q, branches:[{label, next}] } decision · { do:[...], flags:{manager,urgency}, note } outcome · { step, next } action step.
  const CHECKLIST = ['Switch the phone off and remove the SIM (and eSIM if possible)', 'Back up and erase personal data; remove any PIN, passcode or screen lock', 'Remove the Apple ID / iCloud account and Find My', 'Package securely; include the supplied cable only if required', 'Keep proof of postage or collection confirmation (Royal Mail portal)']
  const MGR = { manager: true }
  const INSPECT = 'Once received, our technicians inspect the device. If the fault is confirmed as covered, we arrange the appropriate resolution (repair, replacement or refund depending on inspection and availability).'
  const TREES = [
    { id: 'step0', cat: 'Always first', title: 'Step 0 — check before any lane', icon: 'fa-shield-halved', section: 'Step 0 — check first', summary: 'Runs before every reply. Stops the draft or forces manager review.',
      root: { q: 'Is refund_issued = Yes, or is an A-to-z claim or chargeback open?', branches: [
        { label: 'Yes', next: { do: ['Short acknowledgement only: “Thank you for your message. We are looking into this and will update you shortly.”', 'Stop — do not use any other lane'], flags: MGR } },
        { label: 'No', next: { q: 'Does the customer mention the Consumer Rights Act, Trading Standards, legal action, a solicitor, Section 75, a chargeback or an A-to-z claim?', branches: [
          { label: 'Yes', next: { do: ['Reply calmly, state the seller position once, do not debate', 'Continue to the right lane', 'Flag for manager'], flags: MGR } },
          { label: 'No', next: { q: 'Swelling, lifting screen, burning, smoke or excessively hot (or battery_flag set)?', branches: [
            { label: 'Yes', next: { do: ['Follow the Safety lane', 'Manager review, urgency high'], flags: { manager: true, urgency: 'high' } } },
            { label: 'No', next: { do: ['Continue to the right lane below'] } } ] } } ] } } ] } },
    { id: 'fault', cat: 'Faults & defects', title: 'Fault / warranty claim — return first, inspect, then decide', icon: 'fa-screwdriver-wrench', section: 'Fault and warranty claims', summary: '12-month warranty from delivery. Never reject without inspection unless clearly out of warranty.',
      root: { q: 'Days since delivery? (typed date; Amazon “estimated” dates must be confirmed by staff first)', branches: [
        { label: '0–365 days', next: { step: 'Apologise, acknowledge the inconvenience. Ask for fault details / when it started / photos or a short video if missing. Suggest simple troubleshooting only where appropriate.', next: { q: 'Does the fault persist after troubleshooting?', branches: [
          { label: 'Yes', next: { q: 'Any physical damage (bent frame, cracked back, lifting screen) or third-party repair mentioned?', branches: [
            { label: 'No', next: { do: ['Arrange a return for inspection via the Royal Mail portal', INSPECT, ...CHECKLIST.map((c) => 'Return checklist: ' + c)] } },
            { label: 'Physical damage', next: { do: ['Stay neutral: “Physical damage can affect warranty eligibility … we cannot confirm the cause from messages alone, which is why the device must be inspected.”', 'Never say “you damaged it” or “this proves misuse”', 'Arrange a return for inspection', ...CHECKLIST.map((c) => 'Return checklist: ' + c)] } },
            { label: 'Repaired elsewhere', next: { do: ['“As the phone has already been repaired elsewhere before being inspected by us, we are unable to verify the original condition, the cause, or whether the fault would have been covered.”', 'Offer inspection; no admission'], flags: MGR } } ] } },
          { label: 'No / resolved', next: { do: ['Close politely; invite them to come back if it recurs'] } } ] } } },
        { label: 'Over 365 days', next: { step: '“The 12-month warranty period has now expired … we are unable to provide a free warranty repair, replacement or refund.” Offer a paid repair if suitable. A repair does not restart the warranty.', next: { q: 'Do they cite the Consumer Rights Act / repair warranty?', branches: [
          { label: 'Yes', next: { do: ['Stay calm, state the position once, do not debate, do not admit liability', 'Do not accept a return unless instructed'], flags: MGR } },
          { label: 'No', next: { do: ['Paid repair lane: price only if approved_repair_price is set'] } } ] } } } ] } },
    { id: 'safety', cat: 'Faults & defects', title: 'Safety — lifting screen, swelling, excessive heat', icon: 'fa-triangle-exclamation', section: 'Safety issues', summary: 'Short and calm. Avoid using/charging, photos, return for inspection. No lithium-battery lecture.',
      root: { step: '“Please avoid using or charging the phone while [the screen is lifting / it is getting excessively hot].”', next: { step: 'Request photos if not already provided', next: { q: 'Was the phone repaired elsewhere before we saw it?', branches: [
        { label: 'No', next: { do: ['Arrange a return for inspection (subject to inspection, no promise)', ...CHECKLIST.map((c) => 'Return checklist: ' + c)], flags: { manager: true, urgency: 'high' } } },
        { label: 'Yes', next: { do: ['“We are unable to verify the original condition of the device, the cause of the issue, or whether the fault would have been covered under the warranty.”'], flags: { manager: true, urgency: 'high' } } } ] } } } },
    { id: 'battery', cat: 'Faults & defects', title: 'Battery, charging and “Unknown Part”', icon: 'fa-battery-quarter', section: 'Battery, charging and "Unknown Part"', summary: 'Battery health varies within renewed standards; “Unknown Part” is normal after refurbishment. Never say “fake”.',
      root: { q: 'What is reported?', branches: [
        { label: 'Poor battery', next: { do: ['Ask for Settings › Battery › Battery Health & Charging › Maximum Capacity', 'Suggest: update iOS, check battery usage by app, avoid heavy use while charging', 'If still faulty: return for inspection. “If our inspection confirms a covered battery fault, we will arrange the appropriate warranty resolution.”'] } },
        { label: 'Charging problem', next: { do: ['Try a different compatible cable and adapter, check the port for debris, update iOS', 'Return for inspection if sudden shutdowns or battery jumps continue'] } },
        { label: '“Unknown Part” / non-genuine', next: { do: ['“The ‘Unknown Part’ notification can appear on refurbished iPhones where a component has been replaced during refurbishment. If you are experiencing a performance issue, we are happy to inspect the device.”', 'Never: fake, counterfeit, “Apple has confirmed”, “we will fit an original Apple battery”'] } },
        { label: 'Warm while charging', next: { do: ['“Overheating while charging is not expected as a general issue. Each device is checked before dispatch, including battery and charging.”', 'If excessively hot → Safety lane'] } } ] } },
    { id: 'refund', cat: 'Returns & refunds', title: 'Return / refund request', icon: 'fa-sterling-sign', section: 'Return and refund requests', summary: 'Never promise a refund before inspection unless staff confirmed it.',
      root: { q: 'What are they asking?', branches: [
        { label: 'Full refund', next: { do: ['“We have noted your request for a full refund. Once the device has been received and inspected, we will process the appropriate resolution.”', 'If asked “will I get a full refund?”: same condition as received, no physical damage, accessories included, Apple ID removed → “we would expect to process a full refund”', 'Deductions only if damaged, missing accessories or still linked to iCloud', ...CHECKLIST.map((c) => 'Return checklist: ' + c)] } },
        { label: 'Change of mind', next: { q: 'Within 30 days of delivery?', branches: [ { label: 'Yes', next: { do: ['Accept the return through Amazon’s returns process', ...CHECKLIST.map((c) => 'Return checklist: ' + c)] } }, { label: 'Over 30 days', next: { do: ['Do not refuse in the reply; note the policy neutrally', 'Flag for manager'], flags: MGR } } ] } },
        { label: 'Partial refund', next: { q: 'Has staff set an amount?', branches: [ { label: 'No', next: { do: ['Do not offer an amount; offer a return instead'] } }, { label: '≤ £15', next: { do: ['Offer it as a goodwill gesture with two options: keep the device, or return it'] } }, { label: '> £15', next: { do: ['Draft may propose it but must not promise it'], flags: MGR } } ] } } ] } },
    { id: 'cosmetic', cat: 'Returns & refunds', title: 'Cosmetic condition complaint', icon: 'fa-mobile-screen', section: 'Cosmetic condition complaints', summary: 'Cosmetic signs vary within refurbished grading. Partial refund only if instructed. Do not negotiate endlessly.',
      root: { step: 'Acknowledge disappointment; explain cosmetic signs can vary within the grade', next: { q: 'Partial refund amount set by staff?', branches: [
        { label: 'Yes', next: { do: ['“As a gesture of goodwill, we can offer £[amount] if you are happy to keep the device. This is the highest partial refund we are able to offer as an alternative to returning the handset.”', 'Options: accept and keep, or return via Amazon'] } },
        { label: 'No', next: { do: ['Offer a return through Amazon’s returns process', ...CHECKLIST.map((c) => 'Return checklist: ' + c)] } } ] } } },
    { id: 'repeat', cat: 'Returns & refunds', title: 'Repeat fault after repair / replacement wanted first', icon: 'fa-rotate', section: 'Repeat fault after repair', summary: 'Apologise more strongly, priority handling. No replacement before the original is back.',
      root: { q: 'Situation?', branches: [
        { label: 'Same fault again', next: { do: ['Stronger apology, acknowledge frustration, offer priority handling', 'If instructed: “we would like to offer a replacement device as the next resolution, subject to the returned handset being received and checked.”', 'If model/colour unavailable: closest suitable alternative'] } },
        { label: 'Wants replacement before returning', next: { do: ['“We understand this is inconvenient, especially if this is your main phone. However, we are unable to send a replacement before receiving and inspecting the original device.”', INSPECT, 'Empathetic, not resistant'] } } ] } },
    { id: 'icloud', cat: 'Returns & refunds', title: 'iCloud / Apple ID / Activation Lock', icon: 'fa-lock', section: 'iCloud, Apple ID and Activation Lock', summary: 'Never ask for a password. Remove from account at iCloud.com › Find Devices.',
      root: { q: 'Where is the phone?', branches: [
        { label: 'Returned, still linked', next: { q: 'Removed within 2 business days?', branches: [ { label: 'Yes', next: { do: ['Complete processing / refund goes ahead'] } }, { label: 'No', next: { do: ['Flag for manager — the manager may hold the refund', 'If unlocked later, processing continues'], flags: MGR } } ] } },
        { label: 'Still with customer', next: { do: ['Steps: iCloud.com › sign in › Find Devices › choose the device › Remove from Account', 'Erase request stays pending until online; device must still be removed from the account', 'Data reassurance: we cannot access personal data; a passcode means your data cannot be accessed by us'] } } ] } },
    { id: 'inr', cat: 'Item not received', title: 'Item not received / delivery dispute', icon: 'fa-truck-ramp-box', section: 'Item not received and delivery disputes', summary: 'Neutral, Royal Mail investigation first. Never guarantee a refund, never say fraud or theft.',
      root: { q: 'What does Royal Mail tracking show?', branches: [
        { label: 'Delivered / signed', next: { step: 'Quote the tracking status (placeholders for date/name if unknown). Ask them to check household, neighbours, safe place, reception or concierge. Raise a Royal Mail investigation.', next: { q: 'Royal Mail outcome?', branches: [
          { label: 'Pending', next: { do: ['“We have raised this with Royal Mail under case reference [REFERENCE] and are waiting for their response. Please keep the packaging and any photos.”', 'Phone orders: they may be asked for a police crime reference number'] } },
          { label: 'Confirms correct delivery', next: { do: ['“Royal Mail has completed its investigation and confirmed the parcel was delivered to the correct address. As Royal Mail has not confirmed a loss or misdelivery, we are unable to issue a refund.”', 'If taken after delivery: suggest continuing with their police report', 'IMEI stays internal; no blacklisting threats'], flags: MGR } },
          { label: 'Confirms loss', next: { do: ['Arrange replacement or refund through Amazon'], flags: MGR } } ] } } },
        { label: 'In transit / attempted', next: { do: ['Give the status and next update. “Address inaccessible”: Royal Mail usually retries the next working day; options can be changed on the tracking page', 'Delivery windows are an aim, not a guarantee', 'Disputed attempt: updates come directly from Royal Mail; we can only see what their system records'] } },
        { label: 'Only charger received', next: { do: ['Ask them to keep packaging and contents; raise a courier investigation', 'Do not refund before it concludes; stay neutral'], flags: MGR } } ] } },
    { id: 'misc', cat: 'General', title: 'Accessories, SIM left in return, reviews, pre-sale', icon: 'fa-box-open', section: 'Accessories and packaging', summary: 'Quick lanes. No statutory wording in friendly replies.',
      root: { q: 'Topic?', branches: [
        { label: 'Box / cable', next: { do: ['Renewed phones may not come in the original retail box; the cable may be compatible rather than Apple-branded', 'Missing cable after repair: arrange a replacement compatible cable', 'Goodwill towards a cable only if staff set an amount'] } },
        { label: 'SIM left in return', next: { do: ['“Once we receive the returned device and it has been processed, we will remove the SIM card if it is still inside and keep it safe for return to you.” — no promise until received'] } },
        { label: 'Review / feedback joke', next: { do: ['Do not mention the review at all', 'Answer only the practical point: “You’re very welcome. Your order has now been dispatched using Royal Mail Tracked 24.”'] } },
        { label: 'Pre-sale / general', next: { do: ['Plain helpful answer; no policy or statutory wording', 'eSIM: iPhone 14 and newer. USB-C: iPhone 15 and newer; older use Lightning'] } } ] } },
  ]
  const NEVER = ['Admit liability or guarantee a refund/replacement before inspection', 'Accuse the customer: no “fraud”, “theft”, “you damaged it”, “this proves misuse”', 'Call a battery or part “fake” or “counterfeit”', 'Ask for a PIN, passcode, password, Apple ID password, code, ID document, phone number or email — or ask them to call us', 'Mention, ask for or offer anything for reviews or feedback', 'Say “no rights”, “no claim” or “not entitled”', 'Say “waterproof”; mention “refurbed” to Amazon customers', 'Reject a warranty claim without inspection (unless clearly out of warranty)', 'Give bank details except for an approved paid repair', 'Repeat internal notes (“looks like fraud”, “customer damaged it”) to the customer']
  function treeNode(n, depth = 0) {
    if (n.q) return `<div class="dt-node dt-q"><div class="dt-box dt-box-q"><i class="fas fa-code-branch mr-1"></i>${esc(n.q)}</div><div class="dt-branches">${n.branches.map((b) => `<div class="dt-branch"><span class="dt-label">${esc(b.label)}</span>${treeNode(b.next, depth + 1)}</div>`).join('')}</div></div>`
    if (n.step) return `<div class="dt-node"><div class="dt-box dt-box-step"><i class="fas fa-arrow-right mr-1"></i>${esc(n.step)}</div><div class="dt-then">${treeNode(n.next, depth + 1)}</div></div>`
    const f = n.flags || {}
    const checklist = n.do.filter((x) => x.startsWith('Return checklist: '))
    const rest = n.do.filter((x) => !x.startsWith('Return checklist: '))
    return `<div class="dt-node"><div class="dt-box dt-box-do ${f.manager ? 'dt-mgr' : ''}">
      <ul>${rest.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${checklist.length ? `<details class="mt-1"><summary class="cursor-pointer text-[11px] text-slate-500">Return checklist (${checklist.length})</summary><ul class="mt-1">${checklist.map((x) => `<li>${esc(x.replace('Return checklist: ', ''))}</li>`).join('')}</ul></details>` : ''}
      ${f.manager || f.urgency ? `<div class="dt-flags">${f.manager ? '<span class="pill bg-amber-100 text-amber-800"><i class="fas fa-user-shield mr-1"></i>needs_manager = true</span>' : ''}${f.urgency ? `<span class="pill pill-high ml-1">urgency = ${f.urgency}</span>` : ''}</div>` : ''}
    </div></div>`
  }
  let dtCat = 'All'
  let dtOpen = new Set(JSON.parse(localStorage.getItem('riq.dt.open') || '["step0"]'))
  function renderDecisionTrees() {
    const cats = ['All', ...new Set(TREES.map((t) => t.cat))]
    const shown = TREES.filter((t) => dtCat === 'All' || t.cat === dtCat)
    app.innerHTML = `
      <section id="decision-trees">
        <div class="flex flex-wrap items-end justify-between gap-4 mb-4">
          <div><h1 class="text-2xl font-bold"><i class="fas fa-sitemap mr-2 text-slate-400"></i>Decision Trees</h1><p class="text-sm text-slate-500">How each case type is handled, drawn from <a href="/policy" data-link class="text-sky-700 hover:underline">the reply policy</a>. The AI follows the same lanes; staff use these to check a draft or handle a case by hand.</p></div>
          <div class="flex flex-wrap gap-1 text-sm">${cats.map((c) => `<button data-cat="${esc(c)}" class="px-3 py-1.5 rounded-md ${dtCat === c ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300'}">${esc(c)}</button>`).join('')}</div>
        </div>
        <div class="mb-4 rounded-xl border border-red-200 bg-red-50 p-4">
          <div class="font-semibold text-red-800 mb-1"><i class="fas fa-ban mr-1"></i>Never — applies on every branch</div>
          <ul class="text-sm text-red-900 grid md:grid-cols-2 gap-x-6 gap-y-1 list-disc pl-5">${NEVER.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        </div>
        <div class="space-y-3">
          ${shown.map((t) => `<article class="bg-white rounded-xl shadow-sm dt-card" data-tree="${t.id}">
            <button class="w-full flex items-center gap-3 p-4 text-left dt-head">
              <span class="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-slate-100 text-slate-700 flex-shrink-0"><i class="fas ${t.icon}"></i></span>
              <span class="min-w-0 flex-1"><span class="block font-semibold">${esc(t.title)}</span><span class="block text-xs text-slate-500">${esc(t.summary)}</span></span>
              <span class="pill bg-slate-100 text-slate-600 hidden sm:inline">${esc(t.cat)}</span>
              <i class="fas fa-chevron-${dtOpen.has(t.id) ? 'up' : 'down'} text-slate-400 text-xs"></i>
            </button>
            <div class="dt-body px-4 pb-4 ${dtOpen.has(t.id) ? '' : 'hidden'}">
              <div class="text-[11px] text-slate-400 mb-2"><i class="fas fa-book mr-1"></i>Policy section: <em>${esc(t.section)}</em></div>
              <div class="dt-tree">${treeNode(t.root)}</div>
            </div>
          </article>`).join('')}
        </div>
      </section>`
    app.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => { dtCat = b.dataset.cat; renderDecisionTrees() }))
    app.querySelectorAll('.dt-head').forEach((b) => (b.onclick = () => {
      const id = b.closest('.dt-card').dataset.tree
      dtOpen.has(id) ? dtOpen.delete(id) : dtOpen.add(id)
      localStorage.setItem('riq.dt.open', JSON.stringify([...dtOpen]))
      b.nextElementSibling.classList.toggle('hidden'); b.querySelector('.fa-chevron-up, .fa-chevron-down').className = `fas fa-chevron-${dtOpen.has(id) ? 'up' : 'down'} text-slate-400 text-xs`
    }))
  }

  // ---------- KNOWLEDGE BASE (staff rules appended to the AI prompt after reply_instructions.md) ----------
  let kbShow = localStorage.getItem('riq.kb.show') || 'live'
  const KB_KIND_META = { rule: { label: 'Rule', icon: 'fa-gavel', cls: 'bg-blue-100 text-blue-800' }, fact: { label: 'Fact', icon: 'fa-circle-info', cls: 'bg-emerald-100 text-emerald-800' }, example: { label: 'Phrasing', icon: 'fa-quote-left', cls: 'bg-violet-100 text-violet-800' } }
  const KB_STATUS_META = { draft: { label: 'Awaiting manager', cls: 'bg-amber-100 text-amber-800' }, active: { label: 'Active — used by AI', cls: 'bg-emerald-100 text-emerald-800' }, rejected: { label: 'Rejected', cls: 'bg-red-100 text-red-800' }, retired: { label: 'Retired', cls: 'bg-slate-200 text-slate-700' } }
  const KB_MODES_LABEL = { all: 'Customer replies + Amazon statements', customer: 'Customer replies only', amazon: 'Amazon / Seller Central statements only' }
  async function renderKnowledge() {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading knowledge base…</p>`
    let d
    try { ;({ data: d } = await axios.get('/api/kb', { params: { status: kbShow } })) } catch (err) { return renderError(err) }
    const meta = d.meta
    const active = d.rules.filter((r) => r.status === 'active').length
    const pending = d.rules.filter((r) => r.status === 'draft').length
    const catLabel = (c) => c.replace(/_/g, ' ')
    const card = (r) => {
      const k = KB_KIND_META[r.kind] || KB_KIND_META.rule, s = KB_STATUS_META[r.status] || KB_STATUS_META.draft
      const canEdit = isManager || (r.status === 'draft' && r.created_by === ME.id)
      return `<article class="bg-white rounded-xl shadow-sm p-4 kb-card" data-id="${r.id}">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="pill ${k.cls}"><i class="fas ${k.icon} mr-1"></i>${k.label}</span>
          <span class="pill bg-slate-100 text-slate-700">${esc(catLabel(r.category))}</span>
          <span class="pill ${s.cls}">${s.label}</span>
          <span class="ml-auto text-[10px] text-slate-400">#${r.id} · order ${r.sort_order}${r.used_in_drafts ? ` · used in ${r.used_in_drafts} draft${r.used_in_drafts === 1 ? '' : 's'}` : ''}</span>
        </div>
        <h3 class="font-semibold">${esc(r.title)}</h3>
        <p class="text-sm text-slate-700 mt-1 whitespace-pre-wrap">${esc(r.rule_text)}</p>
        <p class="text-[11px] text-slate-400 mt-2"><i class="fas fa-sliders mr-1"></i>${KB_MODES_LABEL[r.modes] || r.modes} · added by ${esc(r.created_by_name || '—')} ${dayjs(r.created_at).fromNow()}${r.approved_by_name ? ` · approved by ${esc(r.approved_by_name)}` : ''}${r.review_note ? ` · <em>“${esc(r.review_note)}”</em>` : ''}</p>
        <div class="flex flex-wrap gap-2 mt-3 text-xs">
          ${canEdit && ['draft', 'active'].includes(r.status) ? `<button data-act="edit" class="px-2 py-1 rounded-md border border-slate-300"><i class="fas fa-pen mr-1"></i>Edit</button>` : ''}
          ${isManager && r.status === 'draft' ? `<button data-act="activate" class="px-2 py-1 rounded-md bg-emerald-600 text-white"><i class="fas fa-check mr-1"></i>Approve &amp; activate</button><button data-act="reject" class="px-2 py-1 rounded-md border border-red-300 text-red-700"><i class="fas fa-xmark mr-1"></i>Reject</button>` : ''}
          ${isManager && r.status === 'active' ? `<button data-act="retire" class="px-2 py-1 rounded-md border border-slate-300 text-slate-700"><i class="fas fa-box-archive mr-1"></i>Retire</button>` : ''}
          ${isManager && ['rejected', 'retired'].includes(r.status) ? `<button data-act="activate" class="px-2 py-1 rounded-md border border-emerald-300 text-emerald-700"><i class="fas fa-rotate-left mr-1"></i>Re-activate</button>` : ''}
        </div>
      </article>`
    }
    const form = (r) => `
      <form id="kb-form" class="bg-white rounded-xl shadow-sm p-5 space-y-3" data-id="${r ? r.id : ''}">
        <h2 class="font-semibold">${r ? `Edit rule #${r.id}` : 'Add to the knowledge base'}</h2>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="field-label">Type</label><select name="kind" class="field-input">${meta.kinds.map((k) => `<option value="${k}" ${r?.kind === k ? 'selected' : ''}>${KB_KIND_META[k].label}</option>`).join('')}</select></div>
          <div><label class="field-label">Category</label><select name="category" class="field-input">${meta.categories.map((k) => `<option value="${k}" ${r?.category === k ? 'selected' : ''}>${catLabel(k)}</option>`).join('')}</select></div>
        </div>
        <div><label class="field-label">Title (short)</label><input name="title" required minlength="3" maxlength="120" class="field-input" placeholder="e.g. iPhone 12 battery health promise" value="${esc(r?.title || '')}"></div>
        <div><label class="field-label">What the AI should know or do</label><textarea name="rule_text" required rows="5" maxlength="${meta.max_chars}" class="field-input" placeholder="Write it as an instruction or a fact, e.g. “All phones are sold with at least 85% battery health; say so if a customer asks about battery health.”">${esc(r?.rule_text || '')}</textarea><div id="kb-check" class="text-xs mt-1 text-slate-400">Checked against the Never list as you type.</div></div>
        <div><label class="field-label">Applies to</label><select name="modes" class="field-input">${meta.modes.map((m) => `<option value="${m}" ${r?.modes === m ? 'selected' : ''}>${KB_MODES_LABEL[m]}</option>`).join('')}</select></div>
        ${isManager ? `<div><label class="field-label">Order (lower = earlier in the prompt)</label><input name="sort_order" type="number" class="field-input" value="${r?.sort_order ?? 100}"></div>` : ''}
        <div class="flex gap-2">
          <button class="flex-1 py-2 rounded-md bg-slate-900 text-white text-sm font-medium">${r ? 'Save changes' : isManager ? 'Save as draft' : 'Propose rule'}</button>
          ${isManager && !r ? `<button type="button" id="kb-save-active" class="flex-1 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium">Save &amp; activate</button>` : ''}
          ${r ? `<button type="button" id="kb-cancel" class="px-3 py-2 rounded-md border border-slate-300 text-sm">Cancel</button>` : ''}
        </div>
        <p class="text-[11px] text-slate-400">${isManager ? 'Managers can activate rules. ' : 'Your rule is sent to a manager for approval before the AI uses it. '}Rules are appended to the prompt <strong>after</strong> <code>reply_instructions.md</code> and can never relax its “Never” list — the guardrail checks still run on every draft.</p>
      </form>`
    app.innerHTML = `
      <section id="knowledge">
        <div class="flex flex-wrap items-end justify-between gap-4 mb-4">
          <div><h1 class="text-2xl font-bold"><i class="fas fa-brain mr-2 text-slate-400"></i>Knowledge base</h1><p class="text-sm text-slate-500">Rules, facts and phrasing the drafting model must follow in addition to the reply policy. <strong>${active}</strong> active · <strong>${pending}</strong> awaiting approval · max ${meta.max_active} active.</p></div>
          <div class="flex gap-1 text-sm">${[['live', 'Active + pending'], ['active', 'Active'], ['draft', 'Pending'], ['all', 'All incl. retired']].map(([v, l]) => `<button data-show="${v}" class="px-3 py-1.5 rounded-md ${kbShow === v ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300'}">${l}</button>`).join('')}</div>
        </div>
        ${d.migration_needed ? `<div class="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><i class="fas fa-database mr-1"></i>The knowledge base table does not exist yet. Run <code>db/migrations/${d.migration_needed}</code> in the Supabase SQL Editor, then reload.</div>` : ''}
        <div class="grid lg:grid-cols-3 gap-4">
          <div class="lg:col-span-2 space-y-3" id="kb-list">
            ${d.rules.length ? d.rules.map(card).join('') : `<div class="bg-white rounded-xl shadow-sm p-8 text-center text-slate-500 text-sm">Nothing here yet. ${kbShow === 'live' ? 'Add the first rule on the right →' : ''}</div>`}
          </div>
          <div class="space-y-4">
            <div id="kb-form-wrap">${form(null)}</div>
            ${isManager ? `<div class="bg-white rounded-xl shadow-sm p-4"><button id="kb-preview-btn" class="text-sm text-sky-700 hover:underline"><i class="fas fa-eye mr-1"></i>Preview the exact text added to the prompt</button><pre id="kb-preview" class="hidden mt-3 text-[11px] whitespace-pre-wrap bg-slate-50 border border-slate-200 rounded-md p-3 max-h-96 overflow-auto"></pre></div>` : ''}
            <div class="bg-white rounded-xl shadow-sm p-4 text-xs text-slate-600 space-y-2">
              <div class="font-semibold text-slate-700"><i class="fas fa-lightbulb mr-1 text-amber-500"></i>Good knowledge-base items</div>
              <ul class="list-disc pl-4 space-y-1">
                <li><strong>Facts</strong> about what you sell: battery health guarantee, what is in the box, grading descriptions, charger type.</li>
                <li><strong>Rules</strong> for situations the policy does not cover: e.g. how to answer "is it unlocked?", what to say about Face ID repairs.</li>
                <li><strong>Phrasing</strong> you like: an opening line, how to word the six-sides photo request.</li>
              </ul>
              <div class="pt-1 text-slate-500">Items that ask for PINs/passwords/phone numbers, mention reviews, say "waterproof", refuse a return or contain bank details are rejected automatically.</div>
            </div>
          </div>
        </div>
      </section>`
    app.querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => { kbShow = b.dataset.show; localStorage.setItem('riq.kb.show', kbShow); renderKnowledge() }))
    const wireForm = (r) => {
      const f = document.getElementById('kb-form')
      const check = document.getElementById('kb-check')
      let t
      f.rule_text.oninput = () => {
        clearTimeout(t)
        t = setTimeout(async () => {
          try { const { data } = await axios.post('/api/kb/check', { rule_text: f.rule_text.value }); check.innerHTML = data.problems.length ? data.problems.map((p) => `<div class="text-red-700"><i class="fas fa-circle-xmark mr-1"></i>${esc(p)}</div>`).join('') : `<span class="text-emerald-700"><i class="fas fa-circle-check mr-1"></i>Passes the policy checks · ${f.rule_text.value.length}/${meta.max_chars}</span>` } catch {}
        }, 350)
      }
      const payload = (status) => ({ kind: f.kind.value, category: f.category.value, title: f.title.value, rule_text: f.rule_text.value, modes: f.modes.value, sort_order: f.sort_order ? Number(f.sort_order.value) : undefined, status })
      const submit = async (status) => {
        try {
          if (r) { await axios.patch(`/api/kb/${r.id}`, payload()); toast('Rule updated') }
          else { await axios.post('/api/kb', payload(status)); toast(status === 'active' ? 'Rule saved and activated' : isManager ? 'Saved as draft' : 'Proposed — a manager will review it') }
          refreshBadges(); renderKnowledge()
        } catch (err) { const p = err.response?.data?.problems; toast(p?.length ? p[0] : err.response?.data?.error || err.message, 'err') }
      }
      f.onsubmit = (e) => { e.preventDefault(); submit('draft') }
      document.getElementById('kb-save-active')?.addEventListener('click', () => submit('active'))
      document.getElementById('kb-cancel')?.addEventListener('click', () => { document.getElementById('kb-form-wrap').innerHTML = form(null); wireForm(null) })
    }
    wireForm(null)
    app.querySelectorAll('.kb-card [data-act]').forEach((b) => {
      b.onclick = async () => {
        const id = Number(b.closest('.kb-card').dataset.id)
        const r = d.rules.find((x) => x.id === id)
        const act = b.dataset.act
        if (act === 'edit') { document.getElementById('kb-form-wrap').innerHTML = form(r); wireForm(r); document.getElementById('kb-form').scrollIntoView({ behavior: 'smooth', block: 'start' }); return }
        let note
        if (act === 'reject' || act === 'retire') { note = prompt(act === 'reject' ? 'Why is this rule rejected? (shown to the author)' : 'Why is this rule being retired?'); if (note === null) return }
        try { await axios.post(`/api/kb/${id}/${act}`, { note }); toast(act === 'activate' ? 'Rule is now active — the AI will use it on the next draft' : `Rule ${act === 'reject' ? 'rejected' : 'retired'}`); refreshBadges(); renderKnowledge() } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      }
    })
    document.getElementById('kb-preview-btn')?.addEventListener('click', async () => {
      const pre = document.getElementById('kb-preview')
      try { const { data } = await axios.get('/api/kb/preview'); pre.textContent = `── Customer replies (${data.counts.customer} rules) ──${data.customer || '\n(none — prompt is reply_instructions.md only)'}\n\n── Amazon / Seller Central statements (${data.counts.amazon} rules) ──${data.amazon || '\n(none)'}`; pre.classList.toggle('hidden') } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
    })
  }

  function replyToBadge(e) {
    const st = e.reply_to_status || 'unverified'
    const cls = st === 'mailbox' ? 'bg-emerald-100 text-emerald-800' : st === 'noreply' ? 'bg-slate-200 text-slate-700' : 'bg-amber-100 text-amber-800'
    const label = st === 'mailbox' ? 'Reply-To is a real Amazon mailbox' : st === 'noreply' ? 'Reply-To is no-reply — paste into Seller Central' : 'Reply-To unverified — paste into Seller Central'
    return `<span class="pill ${cls}" title="${esc(e.reply_to || '')}"><i class="fas fa-at mr-1"></i>${label}</span>`
  }

  // ---------- TRACKERS: A-to-Z / Returns / Chargebacks ----------
  const TRACKER = {
    atoz: { title: 'A-to-Z Guarantee claims', icon: 'fa-scale-balanced', hint: 'Respond within 3 days once Amazon asks for information. Responses are pasted into Seller Central — never emailed to the no-reply address.' },
    return: { title: 'Return requests', icon: 'fa-rotate-left', hint: 'requested → received → inspected → refunded / closed. Heat or overheating in the reason applies the battery rule automatically.' },
    chargeback: { title: 'Chargebacks', icon: 'fa-credit-card', hint: 'Respond within 7 days. open → response sent → won / lost (debited). Evidence is pasted into Seller Central until the Reply-To address is verified.' },
  }
  let trackerShow = 'open'
  async function renderTracker(kind) {
    const t = TRACKER[kind]
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</p>`
    let data
    try { ;({ data } = await axios.get('/api/events', { params: { kind, status: trackerShow } })) } catch (err) { return renderError(err) }
    const now = dayjs(data.now)
    app.innerHTML = `
      <section id="tracker-${kind}">
        <div class="flex flex-wrap items-end justify-between gap-4 mb-4">
          <div><h1 class="text-2xl font-bold"><i class="fas ${t.icon} mr-2 text-slate-400"></i>${t.title}</h1><p class="text-sm text-slate-500">${t.hint}</p></div>
          <div class="flex gap-1 text-sm">${[['open', 'Open'], ['all', 'All']].map(([v, l]) => `<button data-show="${v}" class="px-3 py-1.5 rounded-md ${trackerShow === v ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300'}">${l}</button>`).join('')}</div>
        </div>
        <div class="bg-white rounded-xl shadow-sm overflow-hidden">
          <table class="riq">
            <thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>
              <th class="px-4 py-3">Deadline</th><th class="px-4 py-3">Order / Case</th><th class="px-4 py-3 hidden md:table-cell">Details</th><th class="px-4 py-3">Amount</th><th class="px-4 py-3">Status</th><th class="px-4 py-3 hidden lg:table-cell">Assigned / Draft</th>
            </tr></thead>
            <tbody>${data.events.length ? data.events.map((e) => {
              const closed = kind === 'return' ? ['refunded', 'closed'].includes(e.status) : ['won', 'lost', 'closed'].includes(e.status)
              const dl = e.deadline_at && !closed ? deadlineInfo({ status: 'open', effective_deadline: e.deadline_at }, now) : null
              return `<tr class="border-b border-slate-100 ${dl ? dl.row : ''}" data-event-id="${e.id}">
                <td class="px-4 py-3 whitespace-nowrap">${dl ? `<div class="${dl.cls}">${esc(dl.label)}</div><div class="text-xs text-slate-400">${fmtDateTime(e.deadline_at)}</div>` : `<span class="text-slate-400 text-xs">${e.deadline_at ? fmtDateTime(e.deadline_at) : 'none'}</span>`}</td>
                <td class="px-4 py-3"><a href="/cases/${e.case_id}" data-link class="font-mono text-xs text-sky-700 hover:underline">${esc(e.order_id)}</a><div class="text-xs text-slate-500">${esc(e.case_ref || '')} · ${esc(e.customer_first_name || '')} ${esc(e.customer_last_name || '')} ${toneChip(e.case_tone)}${e.battery_flag ? ' <span class="px-1.5 rounded bg-red-600 text-white text-[10px] font-semibold"><i class="fas fa-fire"></i> BATTERY</span>' : ''}</div><div class="text-xs text-slate-400">${esc(EVENT_LABEL[e.kind] || e.kind)} · received ${fmtDateTime(e.received_at)}</div></td>
                <td class="px-4 py-3 hidden md:table-cell text-xs text-slate-600 max-w-md">${kind === 'return' ? `<div><strong>${esc(e.product || e.item_description || '')}</strong></div><div>${esc(e.return_reason || '')}${e.policy_check ? ` · ${esc(e.policy_check)}` : ''}${e.authorisation ? ` · ${esc(e.authorisation)}` : ''}</div>${e.customer_comment ? `<div class="italic text-slate-500">“${esc(e.customer_comment)}”</div>` : ''}` : kind === 'chargeback' ? `<div><strong>${esc(e.item_description || '')}</strong></div><div>Ordered ${e.order_date ? fmtDate(e.order_date) : '—'}</div><div class="mt-1">${replyToBadge(e)}</div>` : `<div class="message-body">${esc(e.raw_excerpt || '')}</div>`}</td>
                <td class="px-4 py-3 whitespace-nowrap">${e.amount ? `£${Number(e.amount).toFixed(2)}` : '—'}</td>
                <td class="px-4 py-3"><select data-status class="field-input py-1 text-xs mt-0" style="width:auto">${data.statuses.map((s) => `<option value="${s}" ${e.status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select>${e.responded_at ? `<div class="text-[10px] text-slate-400 mt-1">responded ${fmtDateTime(e.responded_at)} by ${esc(e.responded_by_name || '')}</div>` : ''}</td>
                <td class="px-4 py-3 hidden lg:table-cell text-xs">${e.assigned_to_name ? `<i class="far fa-user mr-1 text-slate-400"></i>${esc(e.assigned_to_name)}` : '<span class="text-slate-300">unassigned</span>'}<div class="mt-1">${draftBadge(e.latest_draft_status, false)}</div></td>
              </tr>`
            }).join('') : `<tr><td colspan="6" class="px-4 py-8 text-center text-slate-500">Nothing here. New notices appear after the next Gmail sync.</td></tr>`}</tbody>
          </table>
        </div>
      </section>`
    app.querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => { trackerShow = b.dataset.show; renderTracker(kind) }))
    app.querySelectorAll('tr[data-event-id] [data-status]').forEach((sel) => {
      sel.onchange = async () => {
        try { await axios.patch(`/api/events/${sel.closest('tr').dataset.eventId}`, { status: sel.value }); toast('Status updated'); refreshBadges(); renderTracker(kind) } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      }
    })
  }

  function renderError(err) {
    const msg = err.response?.data?.error || err.message
    app.innerHTML = `<div class="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4"><i class="fas fa-circle-exclamation mr-2"></i>${esc(msg)} <a href="/" data-link class="underline ml-2">Back to queue</a></div>`
  }

  route()
})()
