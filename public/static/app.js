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
    else renderList()
  }

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
        <td class="px-4 py-3 hidden md:table-cell text-xs">${draft ? `<span class="px-2 py-0.5 rounded-full ${draft === 'approved' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">${esc(draft)}</span>` : '<span class="text-slate-400">none</span>'}</td>
      </tr>`
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

            <section id="draft-panel" class="bg-white rounded-xl shadow-sm p-5">
              <h2 class="font-semibold mb-2"><i class="fas fa-wand-magic-sparkles mr-2 text-slate-400"></i>Reply draft</h2>
              <button id="generate-btn" disabled class="w-full px-4 py-2 rounded-md bg-slate-300 text-slate-600 cursor-not-allowed text-sm font-medium" title="Draft generation is coming in the next phase">
                <i class="fas fa-wand-magic-sparkles mr-1"></i>Generate draft
              </button>
              <p class="mt-2 text-xs text-slate-500">AI drafting (gpt-5.5) will be enabled in the next phase. Agents will review, edit and approve every draft — nothing is sent automatically.</p>
              ${data.drafts.length ? `<div class="mt-3 text-xs text-slate-500">${data.drafts.length} previous draft(s)</div>` : ''}
            </section>
          </aside>
        </div>
      </section>`

    wireFields(id)
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

  function renderError(err) {
    const msg = err.response?.data?.error || err.message
    app.innerHTML = `<div class="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4"><i class="fas fa-circle-exclamation mr-2"></i>${esc(msg)} <a href="/" data-link class="underline ml-2">Back to queue</a></div>`
  }

  route()
})()
