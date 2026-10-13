/* ReplyIQ frontend — case list + case screen. Talks only to /api/*. */
(function () {
  const app = document.getElementById('app')
  const toastEl = document.getElementById('toast')

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  const fmtDate = (d) => (d ? dayjs(d).format('DD MMM YYYY') : '—')
  const fmtDateTime = (d) => (d ? dayjs(d).format('DD MMM YYYY, HH:mm') : '—')
  const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—')
  const STATUS_LABEL = { open: 'Open', awaiting_customer: 'Awaiting customer', resolved: 'Resolved' }
  const STATUS_CLASS = {
    open: 'bg-blue-100 text-blue-800',
    awaiting_customer: 'bg-violet-100 text-violet-800',
    resolved: 'bg-slate-200 text-slate-700',
  }

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
    setActiveNav(m || p === '/inbox' ? 'messages' : p === '/atoz' ? 'atoz' : p === '/returns' ? 'returns' : p === '/chargebacks' ? 'chargebacks' : p === '/gmail' ? 'gmail' : p === '/staff' ? 'staff' : p === '/policy' ? 'policy' : p === '/settings' ? 'settings' : 'dashboard')
    refreshBadges()
    document.getElementById('sidebar')?.classList.remove('open')
    if (m) renderInbox(Number(m[1]))
    else if (p === '/inbox') renderInbox(null)
    else if (p === '/staff') renderStaff()
    else if (p === '/gmail') renderGmail()
    else if (p === '/policy') renderPolicy()
    else if (p === '/settings') renderSettings()
    else if (p === '/atoz') renderTracker('atoz')
    else if (p === '/returns') renderTracker('return')
    else if (p === '/chargebacks') renderTracker('chargeback')
    else renderDashboard()
  }
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'))
  let searchTerm = ''
  document.getElementById('global-search')?.addEventListener('input', (e) => {
    searchTerm = e.target.value.trim().toLowerCase()
    if (!location.pathname.startsWith('/inbox') && !location.pathname.startsWith('/cases/')) navigate('/inbox')
    else filterInboxList()
  })
  function setActiveNav(name) {
    document.querySelectorAll('.nav-tab').forEach((a) => a.classList.toggle('active', a.dataset.nav === name))
  }
  let badgeTimer = 0
  async function refreshBadges() {
    clearTimeout(badgeTimer)
    try {
      const { data } = await axios.get('/api/events/counts')
      const set = (k, v) => { const el = document.querySelector(`[data-badge="${k}"]`); if (el) el.textContent = v ? String(v) : '' }
      set('atoz', data.atoz); set('returns', data.returns); set('chargebacks', data.chargebacks); set('messages', data.messages)
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

  // ---------- header clock ----------
  const clock = document.getElementById('header-clock')
  const tick = () => { if (clock) clock.textContent = dayjs().format('ddd DD MMM · HH:mm') }
  tick(); setInterval(tick, 30000)

  // ---------- CASE LIST ----------
  let listFilter = localStorage.getItem('riq.filter') || 'active'

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

    const filters = [['active', 'Active'], ['open', 'Open'], ['awaiting_customer', 'Awaiting customer'], ['resolved', 'Resolved'], ['all', 'All'], ...(isManager ? [['archived', 'Archived']] : [])]

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
          <!-- Conversation (chat view: customer left, us right, Amazon notices centred) -->
          <article id="conversation" class="2xl:col-span-3 bg-white rounded-xl shadow-sm border border-slate-100">
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
            ${k.battery_flag ? '<div class="px-5 py-2 text-xs bg-red-600 text-white rounded-b-xl"><i class="fas fa-fire mr-1"></i><strong>Battery / heat flag:</strong> stop using &amp; charging, Royal Mail label with UN3481 marking, manager approval, high urgency.</div>' : ''}
          </article>

          <!-- Right column -->
          <aside class="2xl:col-span-2 space-y-4">
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

            <section id="customer-panel" class="bg-white rounded-xl shadow-sm p-5">
              <h2 class="font-semibold mb-3"><i class="far fa-user mr-2 text-slate-400"></i>Customer</h2>
              <dl class="text-sm grid grid-cols-3 gap-y-2">
                <dt class="text-slate-500">Name</dt><dd class="col-span-2">${esc(k.customer_first_name)} ${esc(k.customer_last_name || '')}</dd>
                <dt class="text-slate-500">Email</dt><dd class="col-span-2 break-all">${esc(k.customer_email || '—')}</dd>
                <dt class="text-slate-500">Phone</dt><dd class="col-span-2">${esc(k.customer_phone || '—')}</dd>
                <dt class="text-slate-500">Address</dt><dd class="col-span-2">${esc(k.customer_address || '—')}</dd>
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

        <section id="draft-workspace" class="mt-6"></section>
      </section>`

    wireFields(id)
    wireTicket(id, k)
    wireAmazonOrder(id, k)
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
      const img = /^image\/(jpeg|png|gif|webp)$/.test(a.mime_type)
      const warn = a.amazon_allowed ? '' : '<span class="ml-1 text-[9px] px-1 rounded bg-amber-100 text-amber-800" title="Amazon would not accept this type if sent back">not Amazon-allowed</span>'
      return img
        ? `<a href="${url}" target="_blank" rel="noopener" class="block"><img src="${url}" alt="${esc(a.filename)}" loading="lazy" class="max-h-40 max-w-[220px] rounded-md border border-slate-200 object-cover bg-slate-100"><div class="text-[10px] text-slate-500 mt-0.5">${esc(a.filename)} · ${fmtSize(a.size_bytes)}${warn}</div></a>`
        : `<a href="${url}" target="_blank" rel="noopener" class="attachment-chip"><i class="fas ${a.mime_type === 'application/pdf' ? 'fa-file-pdf text-red-600' : 'fa-paperclip'}"></i>${esc(a.filename)} <span class="text-slate-400">${fmtSize(a.size_bytes)}</span>${warn}</a>`
    }).join('')}</div><div class="text-[9px] text-slate-400 mt-1"><i class="fas fa-lock"></i> Attachments are shown to staff only — never sent to the AI</div>`
  }

  function chatItems(messages, events, attachments) {
    const attsByMsg = {}
    for (const a of attachments || []) (attsByMsg[a.message_id] ||= []).push(a)
    const evById = Object.fromEntries((events || []).map((e) => [e.id, e]))
    let lastDay = ''
    return messages.map((m) => {
      const day = dayjs(m.sent_at).format('ddd DD MMM YYYY')
      const sep = day !== lastDay ? `<div class="day-sep">${day}</div>` : ''
      lastDay = day
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
            ${locked ? '' : `<button id="save-draft-btn" class="px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-sm"><i class="far fa-floppy-disk mr-1"></i>Save edits</button>`}
            <button id="copy-draft-btn" class="px-3 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-sm"><i class="far fa-copy mr-1"></i>Copy reply</button>
            <span id="draft-save-indicator" class="text-xs text-slate-400"></span>
            <span class="ml-auto flex items-center gap-2">
              ${d.status === 'draft' ? `
                <button id="discard-btn" class="px-3 py-1.5 rounded-md text-sm text-slate-500 hover:text-red-700">Discard</button>
                <button id="approve-btn" ${canApprove ? '' : 'disabled'} class="px-4 py-1.5 rounded-md text-sm font-medium ${canApprove ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-slate-200 text-slate-500 cursor-not-allowed'}"
                  title="${!canApprove ? (fails.length ? 'Fix failing checks first' : d.needs_manager ? 'Only a manager can approve this draft' : '') : ''}">
                  <i class="fas fa-check mr-1"></i>Approve
                </button>` : ''}
              ${d.status === 'approved' ? `
                <button id="unapprove-btn" class="px-3 py-1.5 rounded-md text-sm text-slate-500 hover:text-slate-800">Withdraw approval</button>
                ${(!d.mode || d.mode === 'customer') && kase.source === 'gmail' && kase.customer_reply_to ? `
                <button id="send-btn" class="px-4 py-1.5 rounded-md text-sm font-medium bg-emerald-700 text-white hover:bg-emerald-800">
                  <i class="fas fa-paper-plane mr-1"></i>Send to customer
                </button>` : `
                <button id="record-sent-btn" class="px-4 py-1.5 rounded-md text-sm font-medium bg-sky-600 text-white hover:bg-sky-700" title="Confirm you have pasted this into Amazon Seller Central">
                  <i class="fas fa-paste mr-1"></i>Mark as sent in Seller Central
                </button>`}` : ''}
              ${d.status === 'sending' ? '<span class="text-sm text-slate-500"><i class="fas fa-spinner fa-spin mr-1"></i>Sending…</span>' : ''}
            </span>
          </div>
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
    document.getElementById('copy-draft-btn').onclick = async () => {
      await navigator.clipboard.writeText(text.value)
      toast('Reply copied to clipboard')
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
            <dt class="text-slate-500">Approved by</dt><dd class="col-span-3">${esc(d.approved_by_name || '—')} ${d.needs_manager ? '<span class="text-violet-700">(manager)</span>' : ''}</dd>
          </dl>
          <pre class="message-body text-sm bg-slate-50 border border-slate-200 rounded-md p-3 max-h-64 overflow-auto font-sans">${esc(d.draft_text)}</pre>
          <div class="mt-4 flex justify-end gap-2">
            <button id="send-cancel" class="px-4 py-2 rounded-md border border-slate-300 text-sm">Cancel</button>
            <button id="send-now" class="px-4 py-2 rounded-md bg-emerald-700 text-white text-sm font-medium"><i class="fas fa-paper-plane mr-1"></i>Send now</button>
          </div>
        </div>`
      document.body.appendChild(modal)
      axios.get('/api/gmail/status').then(({ data }) => { const el = modal.querySelector('#send-from'); if (el && data.connection) el.textContent = data.connection.email_address }).catch(() => {})
      modal.querySelector('#send-cancel').onclick = () => modal.remove()
      modal.querySelector('#send-now').onclick = async () => {
        const b = modal.querySelector('#send-now'); b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Sending…'
        try {
          await axios.post(`/api/drafts/${d.id}/send`, { confirm_text: d.draft_text }, { timeout: 60000 })
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
    const c = st.connection
    app.innerHTML = `
      <section id="gmail-section">
        <h1 class="text-2xl font-bold mb-1"><i class="fab fa-google mr-2 text-slate-400"></i>Gmail connection</h1>
        <p class="text-sm text-slate-500 mb-4">ReplyIQ reads Amazon customer messages from the connected mailbox every ${st.poll_interval_minutes} minutes. Email is only ever sent when a member of staff presses <strong>Send to customer</strong> on an approved draft.</p>
        ${flash}
        ${!st.configured ? `<div class="mb-4 rounded-md bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 text-sm"><i class="fas fa-triangle-exclamation mr-1"></i>${esc(st.configError)}</div>` : ''}
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div class="bg-white rounded-xl shadow-sm p-5">
            <h2 class="font-semibold mb-3">Mailbox</h2>
            ${st.connected ? `
              <dl class="text-sm space-y-1">
                <div><dt class="text-slate-500 inline">Account:</dt> <dd class="inline font-medium">${esc(c.email_address)}</dd></div>
                <div><dt class="text-slate-500 inline">Connected:</dt> <dd class="inline">${fmtDateTime(c.connected_at)} by ${esc(c.connected_by_name || '—')}</dd></div>
                <div><dt class="text-slate-500 inline">Last sync:</dt> <dd class="inline">${c.last_sync_at ? dayjs(c.last_sync_at).fromNow() : 'never'} ${c.last_sync_status === 'error' ? `<span class="text-red-700">— ${esc(c.last_sync_error || 'error')}</span>` : c.last_sync_status === 'ok' ? '<span class="text-emerald-700">OK</span>' : ''}</dd></div>
              </dl>
              <div class="mt-4 flex gap-2">
                <button id="sync-now" class="px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm"><i class="fas fa-rotate mr-1"></i>Sync now</button>
                ${isManager ? `<select id="import-days" class="field-input py-1 text-sm" style="width:auto"><option value="">Import history…</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select>` : ''}
                ${isManager ? '<button id="tone-backfill" class="px-3 py-1.5 rounded-md border border-slate-300 text-sm" title="Label older customer messages with a tone (AI, gpt-6-luna)"><i class="fas fa-tags mr-1"></i>Label tones</button>' : ''}
                ${isManager ? '<button id="tone-backfill" class="px-3 py-1.5 rounded-md border border-slate-300 text-sm" title="Label customer messages that have no tone yet"><i class="fas fa-tags mr-1"></i>Label tones</button>' : ''}
                ${isManager ? '<button id="att-backfill" class="px-3 py-1.5 rounded-md border border-slate-300 text-sm" title="One-off: record photo/PDF attachments on messages imported before attachments were tracked"><i class="fas fa-paperclip mr-1"></i>Scan attachments</button>' : ''}
                ${isManager ? '<button id="disconnect" class="px-3 py-1.5 rounded-md border border-slate-300 text-sm text-red-700">Disconnect</button>' : ''}
              </div>` : `
              <p class="text-sm text-slate-600 mb-4">No mailbox connected.</p>
              ${isManager ? `<button id="connect" ${st.configured ? '' : 'disabled'} class="px-4 py-2 rounded-md bg-slate-900 text-white text-sm disabled:opacity-50"><i class="fab fa-google mr-1"></i>Connect Gmail</button>` : '<p class="text-xs text-slate-500">A manager needs to connect the mailbox.</p>'}`}
            <p class="mt-4 text-xs text-slate-400">Permissions requested: read mail, send mail. The sign-in token is stored encrypted.</p>
          </div>
          <div class="lg:col-span-2 bg-white rounded-xl shadow-sm overflow-hidden">
            <div class="px-5 py-3 border-b border-slate-100 font-semibold">Recent sync runs</div>
            <table class="w-full text-sm">
              <thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th class="px-4 py-2">When</th><th class="px-4 py-2">Trigger</th><th class="px-4 py-2">Threads</th><th class="px-4 py-2">New msgs</th><th class="px-4 py-2">New cases</th><th class="px-4 py-2">Result</th></tr></thead>
              <tbody>${st.recent_runs.length ? st.recent_runs.map((r) => `<tr class="border-b border-slate-100"><td class="px-4 py-2 whitespace-nowrap">${fmtDateTime(r.started_at)}</td><td class="px-4 py-2">${esc(r.trigger)}</td><td class="px-4 py-2">${r.threads_seen ?? '—'}</td><td class="px-4 py-2">${r.messages_new ?? '—'}</td><td class="px-4 py-2">${r.cases_new ?? '—'}</td><td class="px-4 py-2 ${r.status === 'error' ? 'text-red-700' : 'text-emerald-700'}" title="${esc(r.error || '')}">${esc(r.status || 'running')}</td></tr>`).join('') : '<tr><td colspan="6" class="px-4 py-6 text-center text-slate-400">No runs yet</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </section>`
    app.querySelector('#connect')?.addEventListener('click', async () => {
      try { const { data } = await axios.post('/api/gmail/connect'); location.href = data.url } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
    })
    app.querySelector('#disconnect')?.addEventListener('click', async () => {
      if (!confirm('Disconnect the Gmail mailbox? Syncing and sending will stop until reconnected.')) return
      try { await axios.post('/api/gmail/disconnect'); toast('Disconnected'); history.replaceState({}, '', '/gmail'); renderGmail() } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
    })
    app.querySelector('#import-days')?.addEventListener('change', async (e) => {
      const days = Number(e.target.value); if (!days) return
      if (!confirm(`Import all Amazon customer threads from the last ${days} days as cases? Threads already imported are skipped.`)) { e.target.value = ''; return }
      e.target.disabled = true
      let total = { c: 0, m: 0 }, rounds = 0
      try {
        for (;;) {
          const { data } = await axios.post('/api/gmail/sync', { days }, { timeout: 120000 })
          total.c += data.casesNew; total.m += data.messagesNew; rounds++
          toast(`Importing… ${total.c} case(s), ${total.m} message(s) so far, ${data.remaining} thread(s) left`)
          if (!data.remaining || rounds > 60) break
        }
        toast(`Import complete: ${total.c} new case(s), ${total.m} new message(s)`)
      } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      history.replaceState({}, '', '/gmail'); renderGmail()
    })
    app.querySelector('#tone-backfill')?.addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Labelling…'
      let total = 0, rounds = 0
      try {
        for (;;) {
          const { data } = await axios.post('/api/gmail/tone-backfill', { limit: 20 }, { timeout: 120000 })
          total += data.labelled; rounds++
          toast(`Labelled ${total} so far, ${data.remaining} left`)
          if (!data.remaining || !data.labelled || rounds > 30) break
        }
        toast(`Tone labels done: ${total} message(s) labelled`)
      } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
      renderGmail()
    })
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
      try { const { data } = await axios.post('/api/gmail/sync', {}, { timeout: 120000 }); toast(`Sync done: ${data.messagesNew} new message(s), ${data.casesNew} new case(s)`) } catch (err) { toast(err.response?.data?.error || err.message, 'err') }
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
  async function renderInbox(caseId) {
    if (!document.getElementById('inbox-list')) {
      app.innerHTML = `
        <section class="inbox ${caseId ? 'show-detail' : ''}">
          <div class="pane pane-list">
            <div class="px-3 py-2 border-b border-slate-100 flex items-center justify-between gap-2">
              <h1 class="font-semibold text-sm"><i class="fas fa-inbox mr-1 text-slate-400"></i>Inbox</h1>
              <select id="inbox-filter" class="field-input py-1 text-xs mt-0" style="width:auto">
                ${[['active', 'Active'], ['open', 'Open'], ['awaiting_customer', 'Awaiting customer'], ['resolved', 'Resolved'], ['all', 'All'], ...(isManager ? [['archived', 'Archived']] : [])].map(([v, l]) => `<option value="${v}" ${listFilter === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            ${toneFilterBar()}
            <div id="bulk-bar" class="hidden px-3 py-2 border-b border-slate-200 bg-slate-50 text-xs">
              <div class="flex items-center justify-between mb-1"><span><strong id="bulk-count">0</strong> selected</span><button id="bulk-clear" class="text-slate-500 underline">clear</button></div>
              <div class="flex flex-wrap gap-1">
                <button data-bulk="resolve" class="px-2 py-1 rounded bg-emerald-600 text-white"><i class="fas fa-check mr-1"></i>Mark resolved</button>
                <select data-bulk-select="status" class="field-input py-1 text-xs mt-0" style="width:auto"><option value="">Set status…</option><option value="open">Open</option><option value="awaiting_customer">Awaiting customer</option></select>
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
      document.getElementById('inbox-filter').onchange = (e) => { listFilter = e.target.value; localStorage.setItem('riq.filter', listFilter); selected.clear(); loadInboxList() }
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
          <span class="flex items-center gap-1 flex-wrap">${statusBadge(k.status)}${toneChip(k.tone)}${k.open_atoz ? '<span class="pill" style="background:#ede9fe;color:#6d28d9">A-to-Z</span>' : ''}${k.open_returns ? '<span class="pill" style="background:#cffafe;color:#155e75">RETURN</span>' : ''}${k.open_chargebacks ? '<span class="pill" style="background:#ffe4e6;color:#9f1239">CHARGEBACK</span>' : ''}${k.battery_flag ? '<span class="pill" style="background:#dc2626;color:#fff"><i class="fas fa-fire"></i></span>' : ''}</span>
          <span class="${d.cls} whitespace-nowrap"><i class="far fa-clock"></i> ${esc(d.label)}</span>
        </div>
      </a>`
    }).join('') : '<p class="p-6 text-sm text-slate-400 text-center">No conversations match.</p>'
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
            ${row('Never sent', 'surname, email, phone, address, internal notes, attachments')}
          </div>
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
    axios.get('/api/spapi/status').then(({ data }) => { const el = document.getElementById('spapi-state'); if (el) el.innerHTML = data.configured ? '<span class="text-emerald-700"><i class="fas fa-circle-check mr-1"></i>Configured</span>' : '<span class="text-amber-700"><i class="fas fa-circle-exclamation mr-1"></i>Not configured</span>' }).catch(() => {})
    document.getElementById('spapi-test')?.addEventListener('click', async (e) => {
      const out = document.getElementById('spapi-test-result'); e.target.disabled = true; out.textContent = 'testing…'
      try { const { data } = await axios.post('/api/spapi/test'); out.innerHTML = data.ok ? `<span class="text-emerald-700">✓ ${esc(data.detail)}</span>` : `<span class="text-red-700">✗ ${esc(data.detail)}</span>` } catch (err) { out.innerHTML = `<span class="text-red-700">${esc(err.response?.data?.error || err.message)}</span>` }
      e.target.disabled = false
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
