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

  function toast(msg, kind = 'ok') {
    toastEl.textContent = msg
    toastEl.className = `fixed bottom-4 right-4 px-4 py-2 rounded-lg shadow-lg text-sm text-white ${kind === 'ok' ? 'bg-emerald-600' : 'bg-red-600'}`
    clearTimeout(toastEl._t)
    toastEl._t = setTimeout(() => toastEl.classList.add('hidden'), 2500)
  }

  // Deadline = 24h after last customer message. Returns display info.
  function deadlineInfo(kase, now) {
    if (kase.status === 'resolved') return { label: 'Resolved', cls: 'text-slate-500', row: 'row-resolved', urgency: 3 }
    const dl = dayjs(kase.reply_deadline)
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
    if (m) renderCase(Number(m[1]))
    else if (location.pathname === '/staff') renderStaff()
    else renderList()
  }

  // Session expired anywhere → back to login
  axios.interceptors.response.use(
    (r) => r,
    (err) => {
      if (err.response?.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname)
      return Promise.reject(err)
    }
  )
  document.getElementById('logout-btn').onclick = async () => {
    await axios.post('/api/auth/logout')
    location.href = '/login'
  }
  const ME = window.CURRENT_USER || { role: 'agent' }
  const isManager = ME.role === 'manager'

  // ---------- header clock ----------
  const clock = document.getElementById('header-clock')
  const tick = () => (clock.textContent = dayjs().format('ddd DD MMM · HH:mm'))
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
    const overdue = cases.filter((k) => k.status !== 'resolved' && dayjs(k.reply_deadline).isBefore(now)).length
    const urgent = cases.filter((k) => k.status !== 'resolved' && !dayjs(k.reply_deadline).isBefore(now) && dayjs(k.reply_deadline).diff(now, 'minute') < 240).length

    const filters = [['active', 'Active'], ['open', 'Open'], ['awaiting_customer', 'Awaiting customer'], ['resolved', 'Resolved'], ['all', 'All']]

    app.innerHTML = `
      <section id="case-list-section">
        <div class="flex flex-wrap items-end justify-between gap-4 mb-4">
          <div>
            <h1 class="text-2xl font-bold">Case queue</h1>
            <p class="text-sm text-slate-500">Sorted by reply deadline — 24 hours from the customer's latest message.</p>
          </div>
          <div class="flex items-center gap-3 text-sm">
            <span class="px-3 py-1 rounded-full bg-red-100 text-red-800"><i class="fas fa-triangle-exclamation mr-1"></i>${overdue} overdue</span>
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
                <th class="px-4 py-3 hidden md:table-cell">Customer</th>
                <th class="px-4 py-3 hidden lg:table-cell">Order / Device</th>
                <th class="px-4 py-3">Status</th>
                <th class="px-4 py-3 hidden sm:table-cell">Last message</th>
                <th class="px-4 py-3 hidden md:table-cell">Draft</th>
              </tr>
            </thead>
            <tbody id="case-rows">
              ${cases.length ? cases.map((k) => caseRow(k, now)).join('') : `<tr><td colspan="7" class="px-4 py-8 text-center text-slate-500">No cases match this filter.</td></tr>`}
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
    return `
      <tr data-case-id="${k.id}" class="case-row ${d.row} border-b border-slate-100 hover:bg-amber-50 cursor-pointer">
        <td class="px-4 py-3 whitespace-nowrap">
          <div class="${d.cls}">${esc(d.label)}</div>
          <div class="text-xs text-slate-400">${fmtDateTime(k.reply_deadline)}</div>
        </td>
        <td class="px-4 py-3">
          <div class="font-mono text-xs text-slate-500">${esc(k.case_ref)}</div>
          <div class="font-medium">${esc(k.subject)}</div>
        </td>
        <td class="px-4 py-3 hidden md:table-cell">${esc(k.customer_first_name)} ${esc(k.customer_last_name || '')}</td>
        <td class="px-4 py-3 hidden lg:table-cell">
          <div class="font-mono text-xs">${esc(k.order_id || '—')}</div>
          <div class="text-xs text-slate-500">${esc(k.device_model || '')}</div>
        </td>
        <td class="px-4 py-3">${statusBadge(k.status)}</td>
        <td class="px-4 py-3 hidden sm:table-cell text-slate-500 whitespace-nowrap">${dayjs(k.last_customer_message_at).from(now)} <span class="text-xs text-slate-400">(${k.message_count})</span></td>
        <td class="px-4 py-3 hidden md:table-cell text-xs">${draftBadge(draft, k.latest_draft_needs_manager)}</td>
      </tr>`
  }

  function draftBadge(status, needsManager) {
    if (!status) return '<span class="text-slate-400">none</span>'
    const cls = { draft: 'bg-amber-100 text-amber-800', approved: 'bg-emerald-100 text-emerald-800', sent: 'bg-slate-200 text-slate-700' }[status] || 'bg-slate-100 text-slate-600'
    return `<span class="px-2 py-0.5 rounded-full ${cls}">${esc(status)}</span>${needsManager && status === 'draft' ? ' <span class="px-2 py-0.5 rounded-full bg-violet-100 text-violet-800" title="Needs manager approval"><i class="fas fa-user-shield"></i></span>' : ''}`
  }

  // ---------- CASE SCREEN ----------
  async function renderCase(id) {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading case…</p>`
    let data
    try {
      ;({ data } = await axios.get(`/api/cases/${id}`))
    } catch (err) {
      return renderError(err)
    }
    const k = data.case
    const now = dayjs(data.now)
    const d = deadlineInfo(k, now)

    app.innerHTML = `
      <section id="case-screen">
        <a href="/" data-link class="text-sm text-slate-500 hover:text-slate-800"><i class="fas fa-arrow-left mr-1"></i>Back to queue</a>

        <header class="mt-2 mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div class="font-mono text-xs text-slate-500">${esc(k.case_ref)}</div>
            <h1 class="text-2xl font-bold">${esc(k.subject)}</h1>
            <div class="mt-1 flex items-center gap-3 text-sm">
              ${statusBadge(k.status)}
              <span class="${d.cls}"><i class="far fa-clock mr-1"></i>${esc(d.label)} · due ${fmtDateTime(k.reply_deadline)}</span>
            </div>
          </div>
          <div class="text-right text-sm">
            <label class="field-label">Case status</label>
            <select id="status-select" class="field-input mt-1" style="width:auto">
              ${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}" ${k.status === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
        </header>

        <div class="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <!-- Thread -->
          <article id="email-thread" class="lg:col-span-3 bg-white rounded-xl shadow-sm">
            <div class="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
              <h2 class="font-semibold"><i class="far fa-envelope mr-2 text-slate-400"></i>Email thread</h2>
              <span class="text-xs text-slate-500">${data.messages.length} message${data.messages.length === 1 ? '' : 's'}</span>
            </div>
            <div class="p-5 space-y-4">
              ${data.messages.map(messageCard).join('')}
            </div>
          </article>

          <!-- Right column -->
          <aside class="lg:col-span-2 space-y-6">
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
                  <label class="field-label" for="f-delivery_date">Delivery date</label>
                  <input id="f-delivery_date" name="delivery_date" type="date" class="field-input" value="${esc(k.delivery_date ? String(k.delivery_date).slice(0, 10) : '')}">
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
    renderDraftWorkspace(id, k, data.drafts)
  }

  function messageCard(m) {
    const inbound = m.direction === 'inbound'
    return `
      <div class="message ${inbound ? '' : 'ml-6'} rounded-lg border ${inbound ? 'border-slate-200 bg-slate-50' : 'border-amber-200 bg-amber-50'}">
        <div class="px-4 py-2 flex items-center justify-between text-xs border-b ${inbound ? 'border-slate-200' : 'border-amber-200'}">
          <span class="font-semibold ${inbound ? 'text-slate-700' : 'text-amber-800'}">
            <i class="fas ${inbound ? 'fa-arrow-down-long' : 'fa-arrow-up-long'} mr-1"></i>${esc(m.sender)}
          </span>
          <time class="text-slate-500" datetime="${esc(m.sent_at)}">${fmtDateTime(m.sent_at)}</time>
        </div>
        <div class="px-4 py-3 text-sm message-body">${esc(m.body)}</div>
      </div>`
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
      renderCase(id)
    })
  }

  // ---------- DRAFT WORKSPACE ----------
  const TREE_LABEL = {
    inr: 'Item not received', warranty: 'Warranty query', esim: 'eSIM / US variant', compatibility: 'Compatibility',
    battery: 'Battery complaint', safety: 'SAFETY CONCERN', authenticity: 'Authenticity / condition', missing_item: 'Missing / wrong item',
    change_of_mind: 'Change of mind', discount: 'Discount request', locked_return: 'Locked return (iCloud/FRP)', oow_repair: 'Out-of-warranty repair',
    fault_0_30: 'Device fault 0–30 days', fault_31_90: 'Device fault 31–90 days', fault_91_365: 'Device fault 91–365 days', refund_return: 'Refund / return request', other: 'Other',
  }

  function renderDraftWorkspace(caseId, kase, drafts) {
    const ws = document.getElementById('draft-workspace')
    const active = drafts.filter((d) => d.status !== 'discarded')
    const current = active[0] || null
    const history = active.slice(1)

    ws.innerHTML = `
      <div class="bg-white rounded-xl shadow-sm">
        <div class="px-5 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-semibold"><i class="fas fa-wand-magic-sparkles mr-2 text-slate-400"></i>Reply draft</h2>
          <div class="flex items-center gap-3 text-sm">
            <span class="text-xs text-slate-500 hidden sm:inline"><i class="fas fa-shield-halved mr-1"></i>Nothing is sent automatically</span>
            <button id="generate-btn" class="px-4 py-2 rounded-md bg-slate-900 text-white font-medium hover:bg-slate-800 disabled:opacity-50">
              <i class="fas fa-wand-magic-sparkles mr-1"></i>${current ? 'Generate new draft' : 'Generate draft'}
            </button>
          </div>
        </div>
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
                    <span>${draftBadge(d.status, d.needs_manager)} ${esc(TREE_LABEL[d.tree] || d.tree || '')} · ${fmtDateTime(d.created_at)} by ${esc(d.created_by_name || '—')}</span>
                    <span class="${d.check_result === 'PASS' ? 'text-emerald-700' : 'text-red-700'} font-semibold">${esc(d.check_result || '')}</span>
                  </div>
                  <div class="message-body text-sm text-slate-700 max-h-40 overflow-auto">${esc(d.draft_text)}</div>
                </div>`).join('')}
            </div>
          </details>` : ''}
      </div>`

    document.getElementById('generate-btn').onclick = () => generate(caseId)
    if (current) wireDraftEditor(caseId, kase, current)
  }

  function checkBadge(result) {
    return result === 'PASS'
      ? '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold"><i class="fas fa-circle-check"></i> PASS</span>'
      : '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-red-100 text-red-800 text-xs font-bold"><i class="fas fa-circle-xmark"></i> FAIL</span>'
  }

  function draftEditor(d, kase) {
    const server = d.server_findings || []
    const modelFindings = d.check_findings || []
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
            <span class="text-xs text-slate-500 ml-auto">${esc(TREE_LABEL[d.tree] || d.tree || '')} · ${esc(d.model || '')}</span>
          </div>
          <label class="field-label" for="draft-text">Customer-facing reply ${locked ? '(sent — read only)' : '(edit freely)'}</label>
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
                <button id="record-sent-btn" class="px-4 py-1.5 rounded-md text-sm font-medium bg-sky-600 text-white hover:bg-sky-700" title="Confirm you have pasted and sent this reply in Amazon Seller Central">
                  <i class="fas fa-paper-plane mr-1"></i>Mark as sent in Amazon
                </button>` : ''}
            </span>
          </div>
          <dl class="mt-3 text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
            <div>Generated ${fmtDateTime(d.created_at)} by ${esc(d.created_by_name || '—')}</div>
            ${d.edited_at ? `<div>Edited ${fmtDateTime(d.edited_at)} by ${esc(d.edited_by_name || '—')}</div>` : ''}
            ${d.approved_at ? `<div class="text-emerald-700">Approved ${fmtDateTime(d.approved_at)} by ${esc(d.approved_by_name || '—')}</div>` : ''}
            ${d.sent_recorded_at ? `<div class="text-sky-700">Sent ${fmtDateTime(d.sent_recorded_at)} by ${esc(d.sent_recorded_by_name || '—')}</div>` : ''}
          </dl>
        </div>

        <aside class="space-y-4">
          <section id="check-panel" class="rounded-lg border ${fails.length ? 'border-red-200 bg-red-50' : d.check_result === 'PASS' ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'} p-4">
            <h3 class="font-semibold text-sm mb-2"><i class="fas fa-list-check mr-1"></i>Guardrail check</h3>
            ${fails.length ? `<ul class="text-sm text-red-800 space-y-1 mb-2">${fails.map((f) => `<li><i class="fas fa-circle-xmark mr-1"></i>${esc(f.detail)}</li>`).join('')}</ul>` : ''}
            ${warns.length ? `<ul class="text-sm text-amber-800 space-y-1 mb-2">${warns.map((f) => `<li><i class="fas fa-triangle-exclamation mr-1"></i>${esc(f.detail)}</li>`).join('')}</ul>` : ''}
            ${!fails.length && !warns.length ? '<p class="text-sm text-emerald-800"><i class="fas fa-circle-check mr-1"></i>Server checks passed (no PII, no unsupported promises, tone OK).</p>' : ''}
            ${modelFindings.length ? `<details class="mt-2 text-xs"><summary class="cursor-pointer text-slate-600">Model self-check (${modelFindings.length})</summary><ul class="mt-1 space-y-1 text-slate-700">${modelFindings.map((f) => `<li>• ${esc(f)}</li>`).join('')}</ul></details>` : ''}
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
    const refresh = () => renderCase(caseId)

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

  async function generate(caseId) {
    const btn = document.getElementById('generate-btn')
    btn.disabled = true
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Drafting with gpt-5.5…'
    try {
      await axios.post(`/api/cases/${caseId}/drafts`, {}, { timeout: 120000 })
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

  function renderError(err) {
    const msg = err.response?.data?.error || err.message
    app.innerHTML = `<div class="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4"><i class="fas fa-circle-exclamation mr-2"></i>${esc(msg)} <a href="/" data-link class="underline ml-2">Back to queue</a></div>`
  }

  route()
})()
