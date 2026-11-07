/* ReplyIQ — Physical returns desk + "Refunds without return" UI (Phase 15).
   Loaded before app.js; app.js calls window.RiqReturns(helpers) once and uses what it returns.
   Nothing on these screens is ever sent to OpenAI (server-side guard). */
window.RiqReturns = function (h) {
  const { app, esc, toast, fmtDate, fmtDateTime, navigate, isManager } = h
  const err = (e) => toast(e.response?.data?.error || e.message, 'err')
  const money = (v) => (v == null || v === '' ? '—' : `£${Number(v).toFixed(2)}`)
  const ymd = (v) => (v ? String(v).slice(0, 10) : '')
  const opt = (map, cur, blank = '— choose —') => `<option value="">${blank}</option>` + Object.entries(map).map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`).join('')

  const STATUS_CLS = { expected: 'bg-slate-100 text-slate-700', received: 'bg-sky-100 text-sky-800', inspected: 'bg-indigo-100 text-indigo-800', outcome_agreed: 'bg-amber-100 text-amber-800', closed: 'bg-emerald-100 text-emerald-800' }
  const pill = (txt, cls) => `<span class="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${cls}">${txt}</span>`
  let L = null // labels from the server
  const lbl = (group, v) => (L && L[group] && L[group][v]) || v || '—'

  // ───────── sub-tabs under Returns ─────────
  const TABS = [['physical', 'Physical returns', '/returns'], ['notices', 'Amazon notices', '/returns/notices'], ['refunds', 'Refunds without return', '/returns/refunds'], ['reports', 'Reports', '/returns/reports']]
  function tabs(active, counts = {}) {
    return `<nav id="returns-tabs" class="flex flex-wrap gap-1 mb-4 border-b border-slate-200">${TABS.map(([k, l, href]) => `<a href="${href}" data-link class="px-3 py-2 text-sm -mb-px border-b-2 ${active === k ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'}">${l}${counts[k] ? ` <span class="ml-1 px-1.5 rounded-full text-[10px] font-bold ${k === 'refunds' ? 'bg-red-600 text-white' : 'bg-slate-200 text-slate-700'}">${counts[k]}</span>` : ''}</a>`).join('')}</nav>`
  }
  async function counts() {
    try { const { data } = await axios.get('/api/returns/summary'); return { physical: data.open, refunds: data.refund_alerts, _summary: data } } catch { return {} }
  }

  // ───────── Physical returns list ─────────
  const VIEWS = [['open', 'Open'], ['expected', 'Expected'], ['received', 'Received'], ['inspected', 'Inspected'], ['outcome_agreed', 'Outcome agreed'], ['overdue', 'Overdue'], ['manager', 'Needs manager'], ['closed', 'Closed'], ['all', 'All'], ['archived', 'Archived']]
  let view = (() => { try { return localStorage.getItem('riq.returnsView') || 'open' } catch { return 'open' } })()
  let q = ''

  async function renderDesk() {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading returns…</p>`
    let data, c
    try { ;[{ data }, c] = await Promise.all([axios.get('/api/returns', { params: { view, q } }), counts()]) } catch (e) { return h.renderError(e) }
    L = data.labels
    const s = c._summary || {}
    app.innerHTML = `
      <section id="returns-desk">
        <div class="flex flex-wrap items-end justify-between gap-4 mb-2">
          <div><h1 class="text-2xl font-bold"><i class="fas fa-rotate-left mr-2 text-slate-400"></i>Returns</h1><p class="text-sm text-slate-500">Expected → Received → Inspected → Outcome agreed → Closed. Red = received but no outcome after 2 working days.</p></div>
          <div class="flex flex-wrap gap-2">
            <button id="ret-new" class="px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm"><i class="fas fa-plus mr-1"></i>New return</button>
            ${isManager ? `<a href="/returns/import" data-link class="px-3 py-1.5 rounded-md border border-slate-300 text-sm bg-white"><i class="fas fa-file-import mr-1"></i>Import sheet</a>` : ''}
            <a href="/api/returns/export.csv" class="px-3 py-1.5 rounded-md border border-slate-300 text-sm bg-white" title="CSV of every return (filter by date on the Reports tab)"><i class="fas fa-file-csv mr-1"></i>Export</a>
          </div>
        </div>
        ${tabs('physical', c)}
        <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4 text-sm">
          ${[['Open', s.open, ''], ['Expected', s.expected, 'text-slate-600'], ['Received, no outcome', (s.received || 0) + (s.inspected || 0), 'text-sky-700'], ['Overdue', s.overdue, s.overdue ? 'text-red-700' : ''], ['Needs manager', s.manager, s.manager ? 'text-violet-700' : '']].map(([l, v, cls]) => `<div class="kpi bg-white rounded-xl shadow-sm p-3"><div class="text-xs text-slate-500">${l}</div><div class="text-2xl font-bold ${cls}">${v ?? 0}</div></div>`).join('')}
        </div>
        <div class="flex flex-wrap items-center gap-2 mb-3">
          <div class="flex flex-wrap gap-1 text-sm">${VIEWS.map(([v, l]) => `<button data-view="${v}" class="px-3 py-1.5 rounded-md ${view === v ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 hover:bg-slate-50'}">${l}</button>`).join('')}</div>
          <div class="relative ml-auto"><i class="fas fa-magnifying-glass absolute left-2.5 top-2.5 text-slate-400 text-xs"></i><input id="ret-q" class="field-input pl-7 py-1.5 text-sm mt-0" style="width:16rem" placeholder="Order ID, IMEI, tracking, SKU" value="${esc(q)}"></div>
        </div>
        <div class="bg-white rounded-xl shadow-sm overflow-hidden">
          <table class="riq"><thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>
            <th class="px-4 py-3">Order</th><th class="px-4 py-3">SKU / phones</th><th class="px-4 py-3 hidden md:table-cell">Reason</th><th class="px-4 py-3">Status</th><th class="px-4 py-3 hidden lg:table-cell">Days</th><th class="px-4 py-3 hidden lg:table-cell">Received</th><th class="px-4 py-3 hidden md:table-cell">Outcome</th>
          </tr></thead><tbody>${data.returns.length ? data.returns.map((r) => `
            <tr class="border-b border-slate-100 hover:bg-slate-50 cursor-pointer ${r.overdue ? 'bg-red-50' : ''}" data-ret="${r.id}">
              <td class="px-4 py-3"><div class="font-mono text-xs text-sky-700">${esc(r.order_id)}</div><div class="text-xs text-slate-500">${esc(r.case_ref || '')} ${r.customer_first_name ? '· ' + esc(r.customer_first_name) : r.legacy_customer_name ? '· ' + esc(r.legacy_customer_name) : ''}</div>
                ${r.is_repeat ? '<span class="pill" style="background:#fde68a;color:#78350f"><i class="fas fa-repeat"></i> REPEAT RETURN</span>' : ''}${r.battery_flag ? ' <span class="pill" style="background:#dc2626;color:#fff"><i class="fas fa-fire"></i></span>' : ''}${r.refund_event_status ? ` <span class="pill ${['alert', 'chasing', 'claim_filed'].includes(r.refund_event_status) ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-600'}" title="Amazon refund email on this order"><i class="fas fa-money-bill-transfer"></i> refund ${esc(r.refund_event_status)}</span>` : ''}</td>
              <td class="px-4 py-3 text-xs"><div class="font-medium">${esc(r.sku || '—')}</div><div class="text-slate-500">${r.quantity} phone${r.quantity === 1 ? '' : 's'}${r.imeis ? ` · <span class="font-mono">${esc(r.imeis)}</span>` : ''}</div></td>
              <td class="px-4 py-3 hidden md:table-cell text-xs text-slate-600">${esc(r.reasons ? r.reasons.split(', ').map((x) => lbl('reason', x)).join(', ') : r.amazon_reason || '—')}</td>
              <td class="px-4 py-3">${pill(lbl('status', r.status), STATUS_CLS[r.status] || '')}${r.overdue ? '<div class="text-[10px] text-red-700 font-semibold mt-1"><i class="far fa-clock"></i> overdue</div>' : ''}${r.manager_items ? '<div class="text-[10px] text-violet-700 font-semibold mt-1"><i class="fas fa-user-shield"></i> needs manager</div>' : ''}${r.lock_deadline_at ? `<div class="text-[10px] ${r.lock_overdue ? 'text-red-700' : 'text-amber-700'} mt-1"><i class="fas fa-lock"></i> unlock by ${fmtDate(r.lock_deadline_at)}</div>` : ''}</td>
              <td class="px-4 py-3 hidden lg:table-cell text-xs text-slate-600">${r.days_since_order != null ? `${r.days_since_order}d since order` : ''}${r.days_since_delivery != null ? `<div>${r.days_since_delivery}d since delivery</div>` : ''}</td>
              <td class="px-4 py-3 hidden lg:table-cell text-xs text-slate-600">${r.received_at ? `${fmtDate(r.received_at)}<div class="text-slate-400">${esc(r.received_by_name || 'import')}</div>` : '—'}</td>
              <td class="px-4 py-3 hidden md:table-cell text-xs">${r.outcomes ? r.outcomes.split(', ').map((x) => lbl('outcome', x)).join(', ') : '<span class="text-slate-300">—</span>'}</td>
            </tr>`).join('') : `<tr><td colspan="7" class="px-4 py-8 text-center text-slate-500">${q ? 'No returns match.' : 'Nothing in this view. Returns appear automatically when Amazon authorises one, or press New return.'}</td></tr>`}</tbody></table>
        </div>
      </section>`
    app.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => { view = b.dataset.view; try { localStorage.setItem('riq.returnsView', view) } catch {} ; renderDesk() }))
    app.querySelectorAll('tr[data-ret]').forEach((tr) => (tr.onclick = () => navigate(`/returns/${tr.dataset.ret}`)))
    const qi = document.getElementById('ret-q'); let t = 0; qi.oninput = () => { clearTimeout(t); t = setTimeout(() => { q = qi.value.trim(); renderDesk().then(() => { const n = document.getElementById('ret-q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length) } }) }, 350) }
    document.getElementById('ret-new').onclick = newReturnModal
  }

  // ───────── New return (manual Expected / Received) ─────────
  async function newReturnModal(prefill = {}) {
    let lk = { skus: [], suppliers: [] }
    try { ;({ data: lk } = await axios.get('/api/returns/lookups')) } catch (e) { return err(e) }
    const m = document.createElement('div'); m.className = 'fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50'
    m.innerHTML = `<div class="bg-white rounded-xl shadow-xl max-w-lg w-full p-5">
      <h3 class="font-bold text-lg mb-3"><i class="fas fa-rotate-left mr-2 text-slate-400"></i>New return</h3>
      <div class="grid grid-cols-2 gap-3 text-sm">
        <label class="col-span-2">Order ID<input data-f="order_id" class="field-input font-mono" placeholder="123-1234567-1234567" value="${esc(prefill.order_id || '')}"></label>
        <label>SKU<select data-f="sku" class="field-input"><option value="">— choose —</option>${lk.skus.filter((s) => s.active).map((s) => `<option value="${esc(s.sku)}" ${prefill.sku === s.sku ? 'selected' : ''}>${esc(s.sku)}${s.model ? ' · ' + esc(s.model) : ''}</option>`).join('')}</select></label>
        <label>Phones in parcel<input data-f="quantity" type="number" min="1" max="10" class="field-input" value="1"></label>
        <label>Order date<input data-f="order_date" type="date" class="field-input"></label>
        <label>Delivery date<input data-f="delivery_date" type="date" class="field-input"></label>
        <label class="col-span-2">Return tracking<input data-f="return_tracking" class="field-input font-mono"></label>
        <label class="col-span-2">IMEI (first phone, optional)<input data-f="imei" class="field-input font-mono" inputmode="numeric" placeholder="15 digits"></label>
        <label class="col-span-2 flex items-center gap-2"><input type="checkbox" data-f="received"> Parcel is already here (mark Received now)</label>
      </div>
      <div class="mt-4 flex justify-end gap-2"><button data-cancel class="px-4 py-2 rounded-md border border-slate-300 text-sm">Cancel</button><button data-save class="px-4 py-2 rounded-md bg-slate-900 text-white text-sm">Create</button></div></div>`
    document.body.appendChild(m)
    m.querySelector('[data-cancel]').onclick = () => m.remove()
    m.querySelector('[data-save]').onclick = async () => {
      const v = (n) => m.querySelector(`[data-f="${n}"]`)
      const body = { order_id: v('order_id').value.trim(), sku: v('sku').value || null, quantity: Number(v('quantity').value) || 1, order_date: v('order_date').value || null, delivery_date: v('delivery_date').value || null, return_tracking: v('return_tracking').value.trim() || null, imei: v('imei').value.trim() || null, received: v('received').checked }
      try { const { data } = await axios.post('/api/returns', body); m.remove(); toast('Return created'); navigate(`/returns/${data.return.id}`) } catch (e) { err(e) }
    }
  }


  // ───────── Return detail ─────────
  async function renderReturn(id) {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading return…</p>`
    let data, lk
    try { ;[{ data }, { data: lk }] = await Promise.all([axios.get(`/api/returns/${id}`), axios.get('/api/returns/lookups')]) } catch (e) { return h.renderError(e) }
    L = data.labels
    const r = data.return
    const st = r.status
    const steps = ['expected', 'received', 'inspected', 'outcome_agreed', 'closed']
    const stepIdx = steps.indexOf(st)
    const locked = st === 'closed'
    const supplierOpts = (cur) => `<option value="">— choose —</option>` + lk.suppliers.filter((x) => x.active || x.code === cur).map((x) => `<option value="${esc(x.code)}" ${cur === x.code ? 'selected' : ''}>${esc(x.code)}${x.label ? ' · ' + esc(x.label) : ''}</option>`).join('')
    const skuOpts = (cur) => `<option value="">— choose —</option>` + lk.skus.filter((x) => x.active || x.sku === cur).map((x) => `<option value="${esc(x.sku)}" ${cur === x.sku ? 'selected' : ''}>${esc(x.sku)}${x.model ? ' · ' + esc(x.model) : ''}</option>`).join('') + (cur && !lk.skus.some((x) => x.sku === cur) ? `<option value="${esc(cur)}" selected>${esc(cur)} (not in list — review)</option>` : '')

    const itemCard = (it) => {
      const dis = locked ? 'disabled' : ''
      const mgr = it.needs_manager && !it.manager_cleared_at
      return `<section class="bg-white rounded-xl shadow-sm p-4 ${mgr ? 'ring-2 ring-violet-300' : ''}" data-item="${it.id}">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 class="font-semibold"><i class="fas fa-mobile-screen mr-1 text-slate-400"></i>Phone ${it.item_no}${it.imei ? ` <span class="font-mono text-sm text-slate-600 ml-2">${esc(it.imei)}</span>` : ''}</h3>
          <div class="flex flex-wrap gap-1 text-[11px]">
            ${it.imei_matches === 'no' ? pill('IMEI does NOT match dispatched', 'bg-red-100 text-red-800') : it.imei_matches === 'yes' ? pill('IMEI matches', 'bg-emerald-100 text-emerald-800') : ''}
            ${it.same_imei_returns?.length ? pill(`<i class="fas fa-repeat"></i> same IMEI returned before (${it.same_imei_returns.map((x) => '#' + x.return_id).join(', ')})`, 'bg-amber-100 text-amber-900') : ''}
            ${it.frp_lock ? pill(`<i class="fas fa-lock"></i> Activation lock${it.lock_deadline_at ? ' · unlock by ' + fmtDate(it.lock_deadline_at) : ''}`, new Date(it.lock_deadline_at) < new Date() ? 'bg-red-600 text-white' : 'bg-amber-100 text-amber-900') : ''}
            ${mgr ? pill(`<i class="fas fa-user-shield"></i> Needs manager`, 'bg-violet-100 text-violet-800') : it.manager_cleared_at ? pill(`<i class="fas fa-check"></i> Manager OK (${esc(it.manager_cleared_by_name || '')})`, 'bg-emerald-100 text-emerald-800') : ''}
          </div>
        </div>
        ${mgr ? `<div class="mb-3 rounded-md border border-violet-200 bg-violet-50 p-2 text-xs text-violet-900"><i class="fas fa-user-shield mr-1"></i>${esc(it.manager_reason || '')}${isManager ? ` <button data-clear="${it.id}" class="ml-2 px-2 py-0.5 rounded bg-violet-700 text-white">Approve as manager</button>` : ' — ask a manager'}</div>` : ''}
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div class="col-span-2 md:col-span-4 text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100 pb-1">Receiving</div>
          <label>IMEI<input data-p="imei" class="field-input font-mono" inputmode="numeric" maxlength="20" value="${esc(it.imei || '')}" ${dis}></label>
          <label>IMEI matches dispatched<select data-p="imei_matches" class="field-input" ${dis}>${['unknown', 'yes', 'no'].map((v) => `<option value="${v}" ${it.imei_matches === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <div class="col-span-2 md:col-span-4 text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100 pb-1 mt-1">Inspection</div>
          <label>Reason<select data-p="reason_category" class="field-input" ${dis}>${opt(L.reason, it.reason_category)}</select></label>
          <label>Cable<select data-p="cable" class="field-input" ${dis}>${opt(L.cable, it.cable)}</select></label>
          <label>FRP / iCloud lock<select data-p="frp_lock" class="field-input" ${dis}><option value="" ${it.frp_lock == null ? 'selected' : ''}>— unknown —</option><option value="true" ${it.frp_lock === true ? 'selected' : ''}>Yes — locked</option><option value="false" ${it.frp_lock === false ? 'selected' : ''}>No</option></select></label>
          <label>Battery health %<input data-p="battery_health" type="number" min="0" max="100" class="field-input" value="${it.battery_health ?? ''}" ${dis}></label>
          <label class="col-span-2">Fault found<input data-p="fault_found" class="field-input" value="${esc(it.fault_found || '')}" ${dis}></label>
          <label>Supplier code<select data-p="supplier_code" class="field-input" ${dis}>${supplierOpts(it.supplier_code)}</select></label>
          <label>Photos<div class="field-input bg-slate-50 text-xs flex flex-wrap gap-1 items-center min-h-[2.4rem]">${(it.photos || []).map((p) => `<a href="/api/gmail/attachments/${p.attachment_id}" target="_blank" class="attachment-chip"><i class="fas fa-image"></i>${esc(p.filename || 'photo')}</a>`).join('')}${locked ? '' : `<button data-photo="${it.id}" class="text-sky-700 underline">+ link customer photo</button>`}</div></label>
          <div class="col-span-2 md:col-span-4 text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100 pb-1 mt-1">Outcome</div>
          <label>Outcome<select data-p="outcome" class="field-input" ${dis}>${opt(L.outcome, it.outcome)}</select></label>
          <label>Refund amount £<input data-p="refund_amount" type="number" step="0.01" min="0" class="field-input" value="${it.refund_amount ?? ''}" ${dis}></label>
          <label>Replacement IMEI<input data-p="replacement_imei" class="field-input font-mono" inputmode="numeric" value="${esc(it.replacement_imei || '')}" ${dis}></label>
          <label>Replacement sent<input data-p="replacement_sent_on" type="date" class="field-input" value="${ymd(it.replacement_sent_on)}" ${dis}></label>
          <label>Repair completed<input data-p="repair_completed_on" type="date" class="field-input" value="${ymd(it.repair_completed_on)}" ${dis}></label>
          <label>CMS refund ticket<input data-p="cms_ticket" class="field-input font-mono" value="${esc(it.cms_ticket || '')}" ${dis}></label>
          <label>Compensation / invoice no.<input data-p="compensation_ref" class="field-input font-mono" value="${esc(it.compensation_ref || '')}" ${dis}></label>
          <label>Returned phone goes to<select data-p="stock_disposition" class="field-input" ${dis}>${opt(L.disposition, it.stock_disposition)}</select></label>
          <label class="col-span-2 md:col-span-4">Notes (this phone)<textarea data-p="notes" rows="2" class="field-input text-xs" ${dis}>${esc(it.notes || '')}</textarea></label>
        </div>
        <div class="mt-2 text-[10px] text-slate-400 flex flex-wrap gap-x-4">${it.inspected_at ? `<span>Inspected ${fmtDateTime(it.inspected_at)} by ${esc(it.inspected_by_name || '—')}</span>` : ''}${it.outcome_at ? `<span>Outcome ${fmtDateTime(it.outcome_at)} by ${esc(it.outcome_by_name || '—')}</span>` : ''}<span data-saved="${it.id}" class="text-emerald-700 opacity-0 transition-opacity">saved</span></div>
      </section>`
    }

    app.innerHTML = `
      <section id="return-screen">
        <a href="/returns" data-link class="text-sm text-slate-500 hover:text-slate-800"><i class="fas fa-arrow-left mr-1"></i>All returns</a>
        <header class="mt-2 mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div class="font-mono text-xs text-slate-500">Return #${r.id}${r.case_ref ? ` · <a href="/cases/${r.case_id}" data-link class="text-sky-700 hover:underline">${esc(r.case_ref)} — open conversation</a>` : ''}</div>
            <h1 class="text-2xl font-bold font-mono">${esc(r.order_id)}</h1>
            <div class="mt-1 flex flex-wrap items-center gap-2 text-sm">${pill(lbl('status', st), STATUS_CLS[st])}
              ${r.overdue ? pill('<i class="far fa-clock"></i> OVERDUE — no outcome after 2 working days', 'bg-red-600 text-white') : ''}
              ${r.is_repeat ? pill(`<i class="fas fa-repeat"></i> REPEAT RETURN${r.repeat_reason ? ' (same ' + r.repeat_reason + ')' : ''}`, 'bg-amber-200 text-amber-900') : ''}
              ${r.battery_flag ? pill('<i class="fas fa-fire"></i> BATTERY / HEAT', 'bg-red-600 text-white') : ''}
              ${r.review_flags?.length ? pill(`<i class="fas fa-flag"></i> ${r.review_flags.length} import item(s) to review`, 'bg-orange-100 text-orange-800') : ''}
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-sm">
            ${st === 'expected' ? `<button id="ret-receive" class="px-4 py-2 rounded-md bg-sky-600 text-white font-medium"><i class="fas fa-box-open mr-1"></i>Received</button>` : ''}
            ${['received', 'inspected', 'outcome_agreed'].includes(st) ? `<button id="ret-close" class="px-4 py-2 rounded-md bg-emerald-700 text-white font-medium" ${r.items_without_outcome || r.manager_items ? 'disabled title="Every phone needs an outcome and any manager flags cleared first"' : ''}><i class="fas fa-check mr-1"></i>Close return</button>` : ''}
            ${st === 'closed' ? `<button id="ret-reopen" class="px-3 py-2 rounded-md border border-slate-300">Reopen</button>` : ''}
            ${isManager ? (r.archived_at ? `<button id="ret-archive" data-un="1" class="px-3 py-2 rounded-md border border-slate-300 text-sm" title="Bring this return back into the lists"><i class="fas fa-box-open mr-1"></i>Unarchive</button>` : `<button id="ret-archive" class="px-3 py-2 rounded-md text-slate-600 hover:bg-slate-100" title="Archive (keeps phones, photos and history; hides from lists). Returns are never deleted."><i class="fas fa-box-archive"></i></button>`) : ''}
          </div>
        </header>
        <ol class="flex flex-wrap gap-1 mb-5 text-xs">${steps.map((s, i) => `<li class="flex items-center gap-1 px-2.5 py-1 rounded-full ${i < stepIdx ? 'bg-emerald-100 text-emerald-800' : i === stepIdx ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-400'}">${i < stepIdx ? '<i class="fas fa-check"></i>' : `<span class="font-bold">${i + 1}</span>`} ${lbl('status', s)}</li>`).join('<li class="text-slate-300 self-center">›</li>')}</ol>

        <div class="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <div class="xl:col-span-2 space-y-4">
            ${r.items.map(itemCard).join('')}
            ${locked ? '' : `<button id="ret-add-item" class="text-sm text-sky-700 underline"><i class="fas fa-plus mr-1"></i>Add another phone to this parcel</button>`}
            <section class="bg-white rounded-xl shadow-sm p-4">
              <h3 class="font-semibold mb-2"><i class="fas fa-note-sticky mr-1 text-slate-400"></i>Notes (whole return)</h3>
              <textarea id="ret-notes" rows="3" class="field-input text-sm" ${locked ? 'disabled' : ''}>${esc(r.notes || '')}</textarea>
              ${r.review_flags?.length ? `<div class="mt-2 rounded-md border border-orange-200 bg-orange-50 p-2 text-xs text-orange-900"><div class="font-semibold mb-1"><i class="fas fa-flag mr-1"></i>From the sheet import — please check:</div><ul class="list-disc pl-4">${r.review_flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
            </section>
          </div>
          <aside class="space-y-4">
            <section class="bg-white rounded-xl shadow-sm p-4 text-sm">
              <h3 class="font-semibold mb-2"><i class="fab fa-amazon mr-1 text-slate-400"></i>Order</h3>
              <dl class="grid grid-cols-3 gap-y-1.5 text-xs">
                <dt class="text-slate-500">Marketplace</dt><dd class="col-span-2">${esc(r.marketplace || '—')}</dd>
                <dt class="text-slate-500">SKU</dt><dd class="col-span-2"><select id="ret-sku" class="field-input py-1 text-xs mt-0" ${locked ? 'disabled' : ''}>${skuOpts(r.sku)}</select></dd>
                <dt class="text-slate-500">ASIN</dt><dd class="col-span-2 font-mono">${esc(r.asin || '—')}</dd>
                <dt class="text-slate-500">Quantity</dt><dd class="col-span-2">${r.quantity}</dd>
                <dt class="text-slate-500">Order date</dt><dd class="col-span-2"><input id="ret-order-date" type="date" class="field-input py-1 text-xs mt-0" value="${ymd(r.order_date)}" ${locked ? 'disabled' : ''}>${r.days_since_order != null ? `<span class="text-slate-400 ml-1">${r.days_since_order}d ago</span>` : ''}</dd>
                <dt class="text-slate-500">Delivered</dt><dd class="col-span-2"><input id="ret-delivery-date" type="date" class="field-input py-1 text-xs mt-0" value="${ymd(r.delivery_date)}" ${locked ? 'disabled' : ''}>${r.days_since_delivery != null ? `<span class="text-slate-400 ml-1">${r.days_since_delivery}d ago (warranty clock)</span>` : ''}</dd>
                <dt class="text-slate-500">Amazon reason</dt><dd class="col-span-2">${esc(r.amazon_reason || '—')}</dd>
                ${r.customer_comment ? `<dt class="text-slate-500">Customer said</dt><dd class="col-span-2 italic">“${esc(r.customer_comment)}”</dd>` : ''}
                <dt class="text-slate-500">Outbound tracking</dt><dd class="col-span-2 font-mono">${esc(r.outbound_tracking || '—')}</dd>
                <dt class="text-slate-500">Return tracking</dt><dd class="col-span-2"><input id="ret-tracking" class="field-input py-1 text-xs mt-0 font-mono" value="${esc(r.return_tracking || '')}" ${locked ? 'disabled' : ''}></dd>
                <dt class="text-slate-500">Received</dt><dd class="col-span-2">${r.received_at ? `${fmtDateTime(r.received_at)}<br><span class="text-slate-400">by ${esc(r.received_by_name || 'import')}</span>` : '—'}</dd>
                ${r.closed_at ? `<dt class="text-slate-500">Closed</dt><dd class="col-span-2">${fmtDateTime(r.closed_at)} by ${esc(r.closed_by_name || '—')}</dd>` : ''}
                ${r.legacy_customer_name ? `<dt class="text-slate-500">Customer (sheet)</dt><dd class="col-span-2">${esc(r.legacy_customer_name)}</dd>` : ''}
              </dl>
            </section>
            ${r.refund_events?.length ? `<section class="bg-white rounded-xl shadow-sm p-4 text-sm">
              <h3 class="font-semibold mb-2"><i class="fas fa-money-bill-transfer mr-1 text-slate-400"></i>Amazon refund email${r.refund_events.length > 1 ? 's' : ''}</h3>
              ${r.refund_events.map((e) => `<div class="text-xs border-t border-slate-100 pt-2 mt-2 first:border-0 first:pt-0 first:mt-0"><div><strong>${esc(e.currency)} ${Number(e.amount).toFixed(2)}</strong> · ${esc(e.refund_reason || '—')}${e.is_partial ? ' · <span class="text-amber-700 font-semibold">PARTIAL</span>' : ''}</div><div class="text-slate-500">${fmtDate(e.received_at)} · ${esc(e.spc_ref || '')}</div><div class="mt-1">${pill(esc(e.status), ['alert', 'chasing', 'claim_filed'].includes(e.status) ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700')} <a href="/returns/refunds" data-link class="text-sky-700 underline ml-1">refund check</a></div></div>`).join('')}
            </section>` : ''}
            ${r.related?.length ? `<section class="bg-white rounded-xl shadow-sm p-4 text-sm">
              <h3 class="font-semibold mb-2 text-amber-800"><i class="fas fa-repeat mr-1"></i>Other returns on this order / IMEI</h3>
              ${r.related.map((x) => `<a href="/returns/${x.id}" data-link class="block text-xs py-1 border-t border-slate-100 first:border-0 hover:text-sky-700">#${x.id} · ${lbl('status', x.status)} · ${x.received_at ? 'received ' + fmtDate(x.received_at) : 'created ' + fmtDate(x.created_at)}</a>`).join('')}
            </section>` : ''}
          </aside>
        </div>
      </section>`

    // wiring
    const reload = () => renderReturn(id)
    document.getElementById('ret-receive')?.addEventListener('click', () => receiveModal(r, reload))
    document.getElementById('ret-close')?.addEventListener('click', async () => { if (!confirm('Close this return? Refund issued / replacement or repair dispatched.')) return; try { await axios.patch(`/api/returns/${id}`, { status: 'closed' }); toast('Return closed'); h.refreshBadges(); reload() } catch (e) { err(e) } })
    document.getElementById('ret-reopen')?.addEventListener('click', async () => { try { await axios.patch(`/api/returns/${id}`, { status: 'outcome_agreed' }); toast('Reopened'); reload() } catch (e) { err(e) } })
    document.getElementById('ret-archive')?.addEventListener('click', async (e) => { const un = e.currentTarget.dataset.un === '1'; if (!un && !confirm('Archive this return? Nothing is deleted — it is hidden from the lists and counts and can be unarchived.')) return; try { await axios.post(`/api/returns/${id}/${un ? 'unarchive' : 'archive'}`); toast(un ? 'Return restored' : 'Return archived'); h.refreshBadges(); un ? reload() : navigate('/returns') } catch (e) { err(e) } })
    document.getElementById('ret-add-item')?.addEventListener('click', async () => { try { await axios.post(`/api/returns/${id}/items`); reload() } catch (e) { err(e) } })
    const patchReturn = async (body) => { try { await axios.patch(`/api/returns/${id}`, body); toast('Saved') } catch (e) { err(e); reload() } }
    document.getElementById('ret-notes')?.addEventListener('change', (e) => patchReturn({ notes: e.target.value }))
    document.getElementById('ret-tracking')?.addEventListener('change', (e) => patchReturn({ return_tracking: e.target.value }))
    document.getElementById('ret-sku')?.addEventListener('change', (e) => patchReturn({ sku: e.target.value }))
    document.getElementById('ret-order-date')?.addEventListener('change', (e) => patchReturn({ order_date: e.target.value }).then(reload))
    document.getElementById('ret-delivery-date')?.addEventListener('change', (e) => patchReturn({ delivery_date: e.target.value }).then(reload))
    app.querySelectorAll('[data-item] [data-p]').forEach((el) => {
      el.addEventListener('change', async () => {
        const itemId = el.closest('[data-item]').dataset.item
        try {
          const { data: res } = await axios.patch(`/api/returns/items/${itemId}`, { [el.dataset.p]: el.value })
          const sv = app.querySelector(`[data-saved="${itemId}"]`); if (sv) { sv.style.opacity = 1; setTimeout(() => (sv.style.opacity = 0), 1200) }
          const rule = res.rule || {}
          if (rule.managerReasons?.length) toast(`<i class="fas fa-user-shield mr-1"></i>${esc(rule.managerReasons.join(' · '))}`, 'err', true)
          else if (rule.flags?.length) toast(rule.flags.join(' · '))
          // status / flags may have moved → re-render
          if (['reason_category', 'cable', 'frp_lock', 'outcome', 'refund_amount', 'imei', 'fault_found', 'notes'].includes(el.dataset.p) || res.return.status !== st) reload()
        } catch (e) { const f = e.response?.data?.fields; toast(f ? Object.entries(f).map(([k, v]) => `${k}: ${v}`).join('; ') : e.response?.data?.error || e.message, 'err'); el.classList.add('border-red-500') }
      })
    })
    app.querySelectorAll('[data-clear]').forEach((b) => (b.onclick = async () => { try { await axios.post(`/api/returns/items/${b.dataset.clear}/manager-clear`); toast('Approved'); reload() } catch (e) { err(e) } }))
    app.querySelectorAll('[data-photo]').forEach((b) => (b.onclick = () => photoPicker(r, Number(b.dataset.photo), reload)))
  }

  function receiveModal(r, done) {
    const m = document.createElement('div'); m.className = 'fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50'
    const n = r.items.length
    m.innerHTML = `<div class="bg-white rounded-xl shadow-xl max-w-lg w-full p-5">
      <h3 class="font-bold text-lg mb-1"><i class="fas fa-box-open mr-2 text-sky-600"></i>Parcel received</h3>
      <p class="text-xs text-slate-500 mb-3">Date and your name are recorded automatically. IMEIs are checked (15 digits + check digit) — a typo is refused rather than stored.</p>
      <label class="text-sm">Return tracking<input data-f="tracking" class="field-input font-mono" value="${esc(r.return_tracking || '')}"></label>
      <div class="mt-3 space-y-2">${Array.from({ length: n }, (_, i) => `<div class="grid grid-cols-5 gap-2 text-sm"><label class="col-span-3">IMEI phone ${i + 1}<input data-imei="${i}" class="field-input font-mono" inputmode="numeric" placeholder="15 digits" value="${esc(r.items[i]?.imei || '')}"></label><label class="col-span-2">Matches dispatched?<select data-match="${i}" class="field-input"><option value="unknown">unknown</option><option value="yes">yes</option><option value="no">no</option></select></label></div>`).join('')}</div>
      <div class="mt-4 flex justify-end gap-2"><button data-cancel class="px-4 py-2 rounded-md border border-slate-300 text-sm">Cancel</button><button data-save class="px-4 py-2 rounded-md bg-sky-600 text-white text-sm font-medium"><i class="fas fa-check mr-1"></i>Mark received</button></div></div>`
    document.body.appendChild(m)
    m.querySelector('[data-cancel]').onclick = () => m.remove()
    m.querySelector('[data-save]').onclick = async () => {
      const imeis = Array.from({ length: n }, (_, i) => m.querySelector(`[data-imei="${i}"]`).value.trim() || null)
      const imei_matches = Array.from({ length: n }, (_, i) => m.querySelector(`[data-match="${i}"]`).value)
      try { const { data } = await axios.post(`/api/returns/${r.id}/receive`, { return_tracking: m.querySelector('[data-f="tracking"]').value.trim() || null, imeis, imei_matches }); m.remove(); toast(data.flags?.length ? data.flags.join(' · ') : 'Marked received'); h.refreshBadges(); done() } catch (e) { err(e) }
    }
  }

  async function photoPicker(r, itemId, done) {
    if (!r.case_id) return toast('No case linked — photos come from the customer conversation', 'err')
    let atts = []
    try { const { data } = await axios.get(`/api/cases/${r.case_id}`); atts = (data.attachments || []).filter((a) => /^image\//i.test(a.mime_type)) } catch (e) { return err(e) }
    if (!atts.length) return toast('No customer photos on this case yet', 'err')
    const m = document.createElement('div'); m.className = 'fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50'
    m.innerHTML = `<div class="bg-white rounded-xl shadow-xl max-w-2xl w-full p-5"><h3 class="font-bold mb-3">Link a customer photo to phone</h3><div class="flex flex-wrap gap-2">${atts.map((a) => `<button data-a="${a.id}" class="block border border-slate-200 rounded-md p-1 hover:border-sky-500"><img src="/api/gmail/attachments/${a.id}" class="h-28 w-36 object-cover rounded"><div class="text-[10px] text-slate-500 mt-1 max-w-[9rem] truncate">${esc(a.filename)}</div></button>`).join('')}</div><div class="mt-3 text-right"><button data-cancel class="px-4 py-2 rounded-md border border-slate-300 text-sm">Cancel</button></div></div>`
    document.body.appendChild(m)
    m.querySelector('[data-cancel]').onclick = () => m.remove()
    m.querySelectorAll('[data-a]').forEach((b) => (b.onclick = async () => { try { await axios.post(`/api/returns/items/${itemId}/photos`, { attachment_id: Number(b.dataset.a) }); m.remove(); done() } catch (e) { err(e) } }))
  }

  // ───────── Amazon notices tab (existing return_request tracker with the sub-tabs on top) ─────────
  async function renderNotices() {
    await h.renderTracker('return')
    const sec = app.querySelector('section'); if (!sec) return
    const c = await counts()
    sec.insertAdjacentHTML('afterbegin', tabs('notices', c))
  }

  // ───────── Refunds without return ─────────
  const RSTATUS_CLS = { open: 'bg-slate-100 text-slate-600', ok: 'bg-emerald-100 text-emerald-800', alert: 'bg-red-100 text-red-800', chasing: 'bg-amber-100 text-amber-800', claim_filed: 'bg-violet-100 text-violet-800', recovered: 'bg-emerald-100 text-emerald-800', written_off: 'bg-slate-200 text-slate-700' }
  const RVIEWS = [['alerts', 'Open alerts'], ['unchecked', 'Not checked yet'], ['ok', 'OK'], ['closed', 'Recovered / written off'], ['all', 'All']]
  let rview = 'alerts'
  async function renderRefunds() {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading refunds…</p>`
    let data, c
    try { ;[{ data }, c] = await Promise.all([axios.get('/api/refunds', { params: { view: rview } }), counts()]) } catch (e) { return h.renderError(e) }
    const RL = data.result_labels || {}, SL = data.status_labels || {}
    const lr = data.last_run, bc = data.backcheck
    const runLine = lr ? `Last check ${fmtDateTime(lr.started_at)} — ${esc(lr.status)}${lr.summary ? ` · ${esc(summarise(lr.summary))}` : ''}` : 'No daily check has run yet (07:00 UK every day).'
    const bcLine = bc ? (bc.done ? `90-day back-check complete (started ${esc(bc.started || '')}).` : `90-day back-check in progress: ${bc.offset ?? 0} of 90 days covered (15-day windows, one per daily run; paused on Gmail rate limits).`) : 'Back-check over the last 90 days has not started yet — it runs with the first daily check.'
    app.innerHTML = `
      <section id="refunds-desk">
        <div class="flex flex-wrap items-end justify-between gap-4 mb-2">
          <div><h1 class="text-2xl font-bold"><i class="fas fa-money-bill-transfer mr-2 text-slate-400"></i>Refunds without return</h1><p class="text-sm text-slate-500">Amazon "Refund Initiated" emails (${esc(data.mailbox)}) checked daily at 07:00 UK against dispatch and received returns. Alerts clear automatically once the phone is marked Received. Nothing here is sent to customers, Amazon or OpenAI.</p></div>
          ${isManager ? `<div class="flex flex-wrap gap-2"><button id="rf-check" class="px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm"><i class="fas fa-play mr-1"></i>Run check now</button><button id="rf-back" class="px-3 py-1.5 rounded-md border border-slate-300 bg-white text-sm" title="Fetch the next 15-day window of past refund emails"><i class="fas fa-clock-rotate-left mr-1"></i>Back-check step</button></div>` : ''}
        </div>
        ${tabs('refunds', c)}
        <div class="bg-white rounded-xl shadow-sm p-3 mb-4 text-xs text-slate-600 flex flex-wrap gap-x-6 gap-y-1"><span><i class="fas fa-rotate mr-1 text-slate-400"></i>${runLine}</span><span><i class="fas fa-history mr-1 text-slate-400"></i>${bcLine}</span></div>
        <div class="flex flex-wrap gap-1 text-sm mb-3">${RVIEWS.map(([v, l]) => `<button data-rview="${v}" class="px-3 py-1.5 rounded-md ${rview === v ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 hover:bg-slate-50'}">${l}</button>`).join('')}</div>
        <div class="bg-white rounded-xl shadow-sm overflow-hidden">
          <table class="riq"><thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>
            <th class="px-4 py-3">Order</th><th class="px-4 py-3">Refund</th><th class="px-4 py-3 hidden md:table-cell">Reason</th><th class="px-4 py-3">Check result</th><th class="px-4 py-3 hidden lg:table-cell">Days</th><th class="px-4 py-3">Status</th><th class="px-4 py-3 hidden lg:table-cell">Notes</th>
          </tr></thead><tbody>${data.refunds.length ? data.refunds.map((r) => {
            const isAlert = ['alert', 'chasing', 'claim_filed'].includes(r.status)
            const items = Array.isArray(r.refund_items) ? r.refund_items : []
            return `<tr class="border-b border-slate-100 ${isAlert ? 'bg-red-50/60' : ''}" data-rf="${r.id}">
              <td class="px-4 py-3 align-top"><div class="font-mono text-xs text-sky-700">${esc(r.order_id)}</div><div class="text-xs text-slate-500">${esc(r.sku || items[0]?.sku || '—')}${r.is_partial ? ' · <span class="font-semibold text-amber-700">partial</span>' : ''}${r.needs_manager ? ' · <span class="font-semibold text-violet-700">manager</span>' : ''}</div>
                <div class="text-xs mt-1 flex flex-wrap gap-2">${r.case_id ? `<a href="/cases/${r.case_id}" data-link class="text-sky-700 hover:underline"><i class="fas fa-folder-open"></i> ${esc(r.case_ref || 'case')}</a>` : '<span class="text-slate-400">no case</span>'}${r.return_id ? `<a href="/returns/${r.return_id}" data-link class="text-sky-700 hover:underline"><i class="fas fa-box"></i> return ${lbl('status', r.return_status)}</a>` : `<button data-newret="${r.id}" class="text-slate-500 hover:text-slate-800"><i class="fas fa-plus"></i> return</button>`}<button data-src="${r.id}" class="text-slate-500 hover:text-slate-800" title="Show the Gmail message this came from and what the parser read"><i class="fas fa-envelope-open-text"></i> source</button></div></td>
              <td class="px-4 py-3 align-top text-xs"><div class="font-semibold">${r.currency === 'GBP' || !r.currency ? '£' : esc(r.currency) + ' '}${Number(r.amount ?? 0).toFixed(2)}</div><div class="text-slate-500">${fmtDate(r.received_at)}</div>${r.spc_ref ? `<div class="font-mono text-[10px] text-slate-400">${esc(r.spc_ref)}</div>` : ''}</td>
              <td class="px-4 py-3 align-top hidden md:table-cell text-xs">${esc(r.refund_reason || '—')}</td>
              <td class="px-4 py-3 align-top text-xs ${isAlert ? 'text-red-800 font-medium' : 'text-slate-600'}">${r.reconcile_result ? esc(RL[r.reconcile_result] || r.reconcile_result) : '<span class="text-slate-400">not checked yet</span>'}${r.return_tracking || r.outbound_tracking ? `<div class="font-mono text-[10px] text-slate-500 mt-1">${r.return_tracking ? 'return ' + esc(r.return_tracking) : 'out ' + esc(r.outbound_tracking)}</div>` : ''}</td>
              <td class="px-4 py-3 align-top hidden lg:table-cell text-xs ${isAlert && r.days_outstanding > 7 ? 'text-red-700 font-semibold' : 'text-slate-600'}">${r.days_outstanding}d</td>
              <td class="px-4 py-3 align-top text-xs">${isAlert ? `<select data-rstatus class="field-input text-xs py-1 mt-0 min-w-[9rem]">${['alert', 'chasing', 'recovered', 'claim_filed', 'written_off'].map((s) => `<option value="${s}" ${r.status === s ? 'selected' : ''} ${!isManager && ['claim_filed', 'written_off'].includes(s) ? 'disabled' : ''}>${esc(SL[s] || s)}${!isManager && ['claim_filed', 'written_off'].includes(s) ? ' (manager)' : ''}</option>`).join('')}</select>` : pill(esc(SL[r.status] || r.status), RSTATUS_CLS[r.status] || '')}${r.alert_updated_by_name ? `<div class="text-[10px] text-slate-400 mt-1">${esc(r.alert_updated_by_name)} · ${fmtDate(r.alert_updated_at)}</div>` : ''}</td>
              <td class="px-4 py-3 align-top hidden lg:table-cell"><textarea data-rnotes rows="2" class="field-input text-xs mt-0 w-full min-w-[12rem]" placeholder="Notes (saved on blur)">${esc(r.alert_notes || '')}</textarea></td>
            </tr>`
          }).join('') : `<tr><td colspan="7" class="px-4 py-8 text-center text-slate-500">${rview === 'alerts' ? 'No open alerts — every refund Amazon has initiated matches a received return or an undispatched order.' : 'Nothing in this view.'}</td></tr>`}</tbody></table>
        </div>
      </section>`
    app.querySelectorAll('[data-rview]').forEach((b) => (b.onclick = () => { rview = b.dataset.rview; renderRefunds() }))
    const save = async (tr, body) => { try { await axios.patch(`/api/refunds/${tr.dataset.rf}`, body); toast('Saved'); h.refreshBadges(); if (body.status) renderRefunds() } catch (e) { err(e); renderRefunds() } }
    app.querySelectorAll('[data-rstatus]').forEach((s) => (s.onchange = () => save(s.closest('tr'), { status: s.value })))
    app.querySelectorAll('[data-rnotes]').forEach((t) => { const orig = t.value; t.onblur = () => { if (t.value !== orig) save(t.closest('tr'), { notes: t.value }) } })
    app.querySelectorAll('[data-src]').forEach((b) => (b.onclick = () => sourceModal(b.dataset.src)))
    app.querySelectorAll('[data-newret]').forEach((b) => (b.onclick = () => { const r = data.refunds.find((x) => String(x.id) === b.dataset.newret); newReturnModal({ order_id: r.order_id, sku: r.sku, case_id: r.case_id }) }))
    const busy = (btn, fn) => async () => { btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Working…'; try { await fn() } catch (e) { err(e) } finally { btn.disabled = false; btn.innerHTML = old; renderRefunds() } }
    const ck = document.getElementById('rf-check'); if (ck) ck.onclick = busy(ck, async () => { const { data: d } = await axios.post('/api/refunds/check'); toast(summarise(d.summary || d), 'ok') })
    const bk = document.getElementById('rf-back'); if (bk) bk.onclick = busy(bk, async () => { const { data: d } = await axios.post('/api/refunds/backcheck', {}); toast(d.note ? d.note : `Window ${esc(d.window || '')}: ${d.messagesNew ?? 0} new, ${d.dup ?? 0} already known${d.rateLimited ? ' · Gmail rate-limited, will resume' : ''}${d.done ? ' · back-check complete' : ''}`, 'ok') })
  }
  async function sourceModal(id) {
    const m = document.createElement('div'); m.className = 'fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50'
    m.innerHTML = `<div class="bg-white rounded-xl shadow-xl max-w-3xl w-full p-5 max-h-[90vh] overflow-auto"><p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Fetching the Gmail message…</p></div>`
    document.body.appendChild(m); m.onclick = (e) => { if (e.target === m) m.remove() }
    let d
    try { ;({ data: d } = await axios.get(`/api/refunds/${id}/source`, { timeout: 60000 })) } catch (e) { m.remove(); return err(e) }
    const kv = (o) => Object.entries(o || {}).map(([k, v]) => `<div class="flex gap-2 py-0.5 border-b border-slate-100"><span class="w-28 shrink-0 text-slate-500">${esc(k)}</span><span class="font-mono break-all">${esc(typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—'))}</span></div>`).join('')
    const msg = d.message
    m.firstElementChild.innerHTML = `<div class="flex items-start justify-between gap-3 mb-3"><h3 class="font-bold text-lg"><i class="fas fa-envelope-open-text mr-2 text-slate-400"></i>Source of refund event #${id}</h3><button data-x class="text-slate-500 hover:text-slate-800"><i class="fas fa-xmark text-lg"></i></button></div>
      ${msg ? `<div class="rounded-lg border ${d.mismatch ? 'border-red-300 bg-red-50' : 'border-emerald-200 bg-emerald-50'} p-3 text-sm mb-3">
          <div class="font-semibold ${d.mismatch ? 'text-red-800' : 'text-emerald-800'}"><i class="fas ${d.mismatch ? 'fa-triangle-exclamation' : 'fa-circle-check'} mr-1"></i>${d.mismatch ? 'Parser result differs from what is stored — see Re-parsed below' : 'Re-parsing the live email gives the same result as stored'}</div>
          <div class="text-xs text-slate-600 mt-1">Found in <strong>${esc(d.found_in)}</strong>${d.tried.length ? ` (not in: ${d.tried.map((t) => esc(t.mailbox)).join(', ')})` : ''}</div></div>
        <h4 class="font-semibold text-sm mt-2 mb-1">Gmail message</h4><div class="text-xs">${kv({ subject: msg.subject, from: msg.from, to: msg.to, date: msg.date, received: fmtDateTime(msg.internal_date), labels: msg.labels.join(', ') })}</div>
        <a href="${esc(msg.web_link)}" target="_blank" rel="noopener" class="inline-block mt-1 text-xs text-sky-700 hover:underline"><i class="fas fa-arrow-up-right-from-square mr-1"></i>Open in Gmail (${esc(d.found_in)})</a>
        <div class="grid md:grid-cols-2 gap-3 mt-3 text-xs"><div><h4 class="font-semibold text-sm mb-1">Stored (at ingest)</h4>${kv(d.stored.parsed)}</div><div><h4 class="font-semibold text-sm mb-1">Re-parsed now</h4>${kv(d.reparsed)}</div></div>
        <details class="mt-3"><summary class="cursor-pointer text-sm font-medium">Email text as the parser saw it</summary><pre class="mt-2 text-[11px] whitespace-pre-wrap bg-slate-50 rounded p-2 max-h-72 overflow-auto">${esc(msg.body_excerpt)}</pre></details>`
      : `<div class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm mb-3"><div class="font-semibold text-amber-900"><i class="fas fa-triangle-exclamation mr-1"></i>Message not fetchable from any connected mailbox</div><p class="text-xs text-amber-900 mt-1">${esc(d.note)}</p><ul class="text-xs mt-1">${d.tried.map((t) => `<li><strong>${esc(t.mailbox)}</strong>: ${esc(t.result)}</li>`).join('')}</ul></div>`}
      <h4 class="font-semibold text-sm mt-3 mb-1">Event record</h4><div class="text-xs">${kv({ gmail_message_id: d.stored.gmail_message_id, gmail_thread_id: d.stored.gmail_thread_id, stored_from_mailbox: d.stored.mailbox ? `${d.stored.mailbox} (${d.stored.mailbox_label || ''})` : 'not recorded', email_received: fmtDateTime(d.stored.received_at), created_in_replyiq: fmtDateTime(d.stored.created_at) })}</div>
      ${!msg && d.stored.raw_excerpt ? `<details class="mt-3" open><summary class="cursor-pointer text-sm font-medium">Excerpt stored at ingest</summary><pre class="mt-2 text-[11px] whitespace-pre-wrap bg-slate-50 rounded p-2 max-h-72 overflow-auto">${esc(d.stored.raw_excerpt)}</pre></details>` : ''}`
    m.querySelector('[data-x]').onclick = () => m.remove()
  }
  function summarise(s) {
    if (!s || typeof s !== 'object') return String(s ?? '')
    const parts = []
    if (s.poll) parts.push(`${s.poll.messagesNew ?? 0} new refund email(s)${s.poll.rateLimited ? ' (Gmail rate-limited)' : ''}`)
    if (s.reconcile) parts.push(`${s.reconcile.checked ?? 0} checked, ${s.reconcile.alerts ?? 0} alert(s), ${s.reconcile.cleared ?? 0} cleared${s.reconcile.errors?.length ? `, ${s.reconcile.errors.length} error(s)` : ''}`)
    if (s.backcheck) parts.push(s.backcheck.done ? 'back-check complete' : `back-check ${s.backcheck.window ?? ''}: ${s.backcheck.messagesNew ?? 0} new`)
    else if ('backcheck' in s) parts.push('back-check already complete')
    if (s.error) parts.push('error: ' + s.error)
    return parts.join(' · ') || JSON.stringify(s)
  }

  // ───────── Import from the Google Sheet (manager) ─────────
  let importState = null // { csv, filename, preview, overrides }
  async function renderImport() {
    if (!isManager) { app.innerHTML = '<p class="text-slate-500">Managers only.</p>'; return }
    const st = importState
    let batches = []
    try { ;({ data: { batches } } = await axios.get('/api/returns/import/batches')) } catch {}
    app.innerHTML = `
      <section id="returns-import">
        <div class="mb-4"><a href="/returns" data-link class="text-sm text-slate-500 hover:text-slate-800"><i class="fas fa-arrow-left mr-1"></i>Returns</a><h1 class="text-2xl font-bold mt-1"><i class="fas fa-file-import mr-2 text-slate-400"></i>Import returns sheet</h1>
          <p class="text-sm text-slate-500">Step 1 is always a dry run: nothing is written until you press Commit. Rows with doubtful values (bad IMEI, unknown SKU, values in the wrong column) are listed for review — they still import, with the doubtful value moved to Notes and a review flag on the return. Customer names are dropped where a case already exists for the order.</p></div>
        <div class="bg-white rounded-xl shadow-sm p-4 mb-4">
          <div class="flex flex-wrap items-center gap-3"><input type="file" id="imp-file" accept=".csv,text/csv" class="text-sm"><button id="imp-dry" class="px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm" ${st?.csv ? '' : 'disabled'}><i class="fas fa-vial mr-1"></i>Dry run</button>${st?.filename ? `<span class="text-xs text-slate-500">${esc(st.filename)} · ${st.csv.split('\n').length - 1} line(s)</span>` : ''}</div>
          <p class="text-xs text-slate-400 mt-2">Expected columns: Order Date, Date of Return, Marketplace, Customer Name, Order ID, Item details, Reason, cable, Solution agreed, FRP, Notes, IMEI NO, SUPPLIER CODE, CMS REFUND TICKET NUMBER, COMPENSATION NUMBER/INVOICE. "Days since order" and "Resolution" are ignored (computed / replaced by status).</p>
        </div>
        ${st?.preview ? previewHtml(st) : ''}
        ${batches.length ? `<div class="bg-white rounded-xl shadow-sm p-4 mt-4"><h3 class="font-semibold text-sm mb-2">Previous runs</h3><table class="riq text-xs"><thead class="text-slate-500 text-left"><tr><th class="py-1 pr-3">When</th><th class="py-1 pr-3">File</th><th class="py-1 pr-3">Mode</th><th class="py-1 pr-3">Rows</th><th class="py-1 pr-3">Created</th><th class="py-1 pr-3">Updated</th><th class="py-1 pr-3">Review</th><th class="py-1">By</th></tr></thead><tbody>${batches.map((b) => `<tr class="border-t border-slate-100"><td class="py-1 pr-3">${fmtDateTime(b.created_at)}</td><td class="py-1 pr-3">${esc(b.filename || '—')}</td><td class="py-1 pr-3">${esc(b.mode)}</td><td class="py-1 pr-3">${b.row_count}</td><td class="py-1 pr-3">${b.created_count ?? '—'}</td><td class="py-1 pr-3">${b.updated_count ?? '—'}</td><td class="py-1 pr-3">${b.review_count}</td><td class="py-1">${esc(b.created_by_name || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </section>`
    const fi = document.getElementById('imp-file'), dry = document.getElementById('imp-dry')
    fi.onchange = () => { const f = fi.files[0]; if (!f) return; f.text().then((csv) => { importState = { csv, filename: f.name, preview: null, overrides: {} }; renderImport() }) }
    dry.onclick = () => runImport(false)
    const commit = document.getElementById('imp-commit'); if (commit) commit.onclick = () => { if (confirm(`Write ${st.preview.importable} return(s) to ReplyIQ? This cannot be undone from the screen.`)) runImport(true) }
    app.querySelectorAll('[data-skumap]').forEach((sel) => (sel.onchange = () => { if (sel.value) importState.overrides[sel.dataset.skumap] = sel.value; else delete importState.overrides[sel.dataset.skumap] }))
    const addSku = document.getElementById('imp-addsku'); if (addSku) addSku.onclick = async () => { const sku = prompt('New SKU (letters, digits, - . _):'); if (!sku) return; try { await axios.post('/api/returns/lookups/sku', { sku }); toast('SKU added'); runImport(false) } catch (e) { err(e) } }
  }
  async function runImport(commit) {
    const st = importState; if (!st) return
    const btn = document.getElementById(commit ? 'imp-commit' : 'imp-dry'); if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>' + (commit ? 'Writing…' : 'Checking…') }
    try {
      const { data } = await axios.post('/api/returns/import', { csv: st.csv, filename: st.filename, commit, sku_overrides: st.overrides })
      if (commit) { toast(`Imported: ${data.created} created, ${data.updated} updated, ${data.review_count ?? data.preview?.review_count ?? 0} flagged for review`, 'ok'); importState = null; h.refreshBadges(); navigate('/returns'); return }
      st.preview = data.preview || data
      try { ;({ data: st.lookups } = await axios.get('/api/returns/lookups')) } catch {}
      renderImport()
    } catch (e) { err(e); renderImport() }
  }
  function previewHtml(st) {
    const p = st.preview, skus = st.lookups?.skus || []
    const byField = {}; for (const r of p.review) byField[r.field] = (byField[r.field] || 0) + 1
    return `<div class="bg-white rounded-xl shadow-sm p-4">
      <div class="flex flex-wrap items-center justify-between gap-3 mb-3"><h2 class="font-semibold">Dry run — ${p.rows} row(s): <span class="text-emerald-700">${p.importable} importable</span>${p.unimportable ? `, <span class="text-red-700">${p.unimportable} without a valid order ID (skipped)</span>` : ''}, <span class="${p.review_count ? 'text-amber-700' : ''}">${p.review_count} value(s) to review</span></h2>
        <button id="imp-commit" class="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-sm" ${p.importable ? '' : 'disabled'}><i class="fas fa-check mr-1"></i>Commit import</button></div>
      ${p.unmatched_skus?.length ? `<div class="border border-amber-200 bg-amber-50 rounded-lg p-3 mb-3 text-sm"><div class="font-semibold text-amber-900 mb-1"><i class="fas fa-tag mr-1"></i>${p.unmatched_skus.length} SKU text(s) could not be matched — map them here or add the SKU, then re-run the dry run. Unmapped rows import with the SKU blank and the original text in Notes.</div>
        <div class="grid md:grid-cols-2 gap-2">${p.unmatched_skus.map((raw) => `<label class="flex items-center gap-2 text-xs"><span class="font-mono truncate max-w-[14rem]" title="${esc(raw)}">${esc(raw)}</span><i class="fas fa-arrow-right text-slate-400"></i><select data-skumap="${esc(raw)}" class="field-input text-xs py-1 mt-0 flex-1"><option value="">— leave unmatched —</option>${skus.map((s) => `<option value="${esc(s.sku)}" ${st.overrides[raw] === s.sku ? 'selected' : ''}>${esc(s.sku)}${s.model ? ' · ' + esc(s.model) : ''}</option>`).join('')}</select></label>`).join('')}</div>
        <button id="imp-addsku" class="mt-2 text-xs text-sky-700 hover:underline"><i class="fas fa-plus"></i> Add a SKU to the list</button></div>` : ''}
      ${Object.keys(byField).length ? `<div class="text-xs text-slate-600 mb-2">Review by column: ${Object.entries(byField).map(([f, n]) => `<span class="inline-block mr-2 px-2 py-0.5 rounded bg-slate-100">${esc(f)} <b>${n}</b></span>`).join('')}</div>` : ''}
      <details class="mb-3" ${p.review_count && p.review_count <= 60 ? 'open' : ''}><summary class="cursor-pointer text-sm font-medium">Review list (${p.review_count})</summary>
        <div class="overflow-auto max-h-96 mt-2"><table class="riq text-xs"><thead class="text-slate-500 text-left sticky top-0 bg-white"><tr><th class="py-1 pr-3">Row</th><th class="py-1 pr-3">Order</th><th class="py-1 pr-3">Column</th><th class="py-1 pr-3">Value</th><th class="py-1">Why</th></tr></thead><tbody>${p.review.map((r) => `<tr class="border-t border-slate-100"><td class="py-1 pr-3">${r.row}</td><td class="py-1 pr-3 font-mono">${esc(r.order_id || '—')}</td><td class="py-1 pr-3">${esc(r.field)}</td><td class="py-1 pr-3 font-mono max-w-xs truncate" title="${esc(r.value)}">${esc(r.value)}</td><td class="py-1 text-slate-600">${esc(r.reason)}</td></tr>`).join('') || '<tr><td colspan="5" class="py-2 text-slate-400">Nothing to review.</td></tr>'}</tbody></table></div></details>
      <details><summary class="cursor-pointer text-sm font-medium">Sample of cleaned rows (first ${p.sample.length})</summary>
        <table class="riq text-xs mt-2"><thead class="text-slate-500 text-left"><tr><th class="py-1 pr-3">Row</th><th class="py-1 pr-3">Order</th><th class="py-1 pr-3">SKU</th><th class="py-1 pr-3">Reason</th><th class="py-1 pr-3">Cable</th><th class="py-1 pr-3">Outcome</th><th class="py-1 pr-3">IMEI</th><th class="py-1">Returned</th></tr></thead><tbody>${p.sample.map((r) => `<tr class="border-t border-slate-100"><td class="py-1 pr-3">${r.row}</td><td class="py-1 pr-3 font-mono">${esc(r.order_id)}</td><td class="py-1 pr-3 ${String(r.sku).startsWith('?') ? 'text-amber-700' : ''}">${esc(r.sku || '—')}</td><td class="py-1 pr-3">${esc(lbl('reason', r.reason))}</td><td class="py-1 pr-3">${esc(lbl('cable', r.cable))}</td><td class="py-1 pr-3">${esc(lbl('outcome', r.outcome))}</td><td class="py-1 pr-3">${esc(r.imei)}</td><td class="py-1">${esc(r.return_date || '—')}</td></tr>`).join('')}</tbody></table></details>
    </div>`
  }

  // ───────── Reports ─────────
  let rfrom = '', rto = ''
  async function renderReports() {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading report…</p>`
    let data, c
    try { ;[{ data }, c] = await Promise.all([axios.get('/api/returns/reports', { params: { from: rfrom || undefined, to: rto || undefined } }), counts()]) } catch (e) { return h.renderError(e) }
    if (!L) { try { const { data: lk } = await axios.get('/api/returns/lookups'); L = lk.labels } catch {} }
    const qs = (rfrom || rto) ? `?${rfrom ? 'from=' + rfrom : ''}${rfrom && rto ? '&' : ''}${rto ? 'to=' + rto : ''}` : ''
    const table = (title, head, rows) => `<div class="bg-white rounded-xl shadow-sm p-4"><h3 class="font-semibold text-sm mb-2">${title}</h3>${rows.length ? `<table class="riq text-sm w-full"><thead class="text-xs text-slate-500 text-left"><tr>${head.map((x) => `<th class="py-1 pr-3">${x}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr class="border-t border-slate-100">${r.map((x, i) => `<td class="py-1 pr-3 ${i ? 'tabular-nums' : ''}">${x}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p class="text-xs text-slate-400">No data in this range.</p>'}</div>`
    const t = data.totals || {}, cb = data.cable || {}
    app.innerHTML = `
      <section id="returns-reports">
        <div class="flex flex-wrap items-end justify-between gap-4 mb-2">
          <div><h1 class="text-2xl font-bold"><i class="fas fa-chart-column mr-2 text-slate-400"></i>Returns reports</h1><p class="text-sm text-slate-500">Counts by date received (or created, for Expected returns). Return rate per supplier/model needs sales volumes — shown as counts until SP-API order totals are wired in.</p></div>
          <form id="rep-range" class="flex flex-wrap items-end gap-2 text-sm"><label>From<input type="date" name="from" class="field-input mt-0 py-1" value="${esc(rfrom)}"></label><label>To<input type="date" name="to" class="field-input mt-0 py-1" value="${esc(rto)}"></label><button class="px-3 py-1.5 rounded-md bg-slate-900 text-white">Apply</button><a href="/api/returns/export.csv${qs}" class="px-3 py-1.5 rounded-md border border-slate-300 bg-white"><i class="fas fa-file-csv mr-1"></i>Export CSV</a>${isManager ? `<a href="/api/returns/export.csv${qs}${qs ? '&' : '?'}include_names=1" class="px-3 py-1.5 rounded-md border border-slate-300 bg-white text-slate-600" title="Same export plus the customer-name column from the old sheet (legacy rows only). Managers only."><i class="fas fa-user-lock mr-1"></i>Export with legacy names</a>` : ''}</form>
        </div>
        ${tabs('reports', c)}
        <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4 text-sm">
          ${[['Returns', t.returns], ['Closed', t.closed], ['Missing cable', cb.missing, cb.missing ? 'text-amber-700' : ''], ['Cable damaged/burnt', cb.damaged, cb.damaged ? 'text-red-700' : ''], ['Repeat returns', data.repeat_returns, data.repeat_returns ? 'text-amber-700' : '']].map(([l, v, cls]) => `<div class="kpi bg-white rounded-xl shadow-sm p-3"><div class="text-xs text-slate-500">${l}</div><div class="text-2xl font-bold ${cls || ''}">${v ?? 0}</div></div>`).join('')}
        </div>
        <div class="grid md:grid-cols-2 gap-4">
          ${table('By supplier code', ['Supplier', 'Returns', 'Faulty'], data.by_supplier.map((r) => [esc(r.supplier_code || '— not set —'), r.returns, r.faulty]))}
          ${table('By model / SKU', ['Model', 'SKU', 'Returns'], data.by_model.map((r) => [esc(r.model || '—'), `<span class="font-mono text-xs">${esc(r.sku || '—')}</span>`, r.returns]))}
          ${table('Reasons', ['Reason', 'Phones'], data.by_reason.map((r) => [esc(lbl('reason', r.reason_category) || '— not set —'), r.n]))}
          ${table('Outcomes', ['Outcome', 'Phones', 'Refunded'], data.by_outcome.map((r) => [esc(lbl('outcome', r.outcome) || '— not set —'), r.n, money(r.refunded)]))}
        </div>
      </section>`
    document.getElementById('rep-range').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); rfrom = f.get('from') || ''; rto = f.get('to') || ''; renderReports() }
  }

  // ───────── Case screen panel ─────────
  async function mountCasePanel(caseId, k) {
    const el = document.getElementById('returns-panel'); if (!el) return
    let data
    try { ;({ data } = await axios.get(`/api/returns/for-case/${caseId}`)) } catch { el.innerHTML = ''; return }
    if (data.migration_needed) { el.innerHTML = ''; return }
    L = L || data.labels
    const rows = data.returns || []
    el.innerHTML = `<div class="bg-white rounded-xl shadow-sm p-4">
      <div class="flex items-center justify-between mb-2"><h3 class="font-semibold text-sm"><i class="fas fa-box mr-1 text-slate-400"></i>Physical return${rows.length === 1 ? '' : 's'}</h3><button id="rp-new" class="text-xs text-sky-700 hover:underline"><i class="fas fa-plus"></i> ${rows.length ? 'Another' : 'Expect a return'}</button></div>
      ${rows.length ? rows.map((r) => `<a href="/returns/${r.id}" data-link class="block border border-slate-200 rounded-lg p-2 mb-2 hover:border-sky-400 ${r.overdue ? 'bg-red-50' : ''}">
          <div class="flex items-center justify-between gap-2">${pill(lbl('status', r.status), STATUS_CLS[r.status] || '')}<span class="text-xs text-slate-500">${r.received_at ? 'received ' + fmtDate(r.received_at) : r.created_at ? 'expected since ' + fmtDate(r.created_at) : ''}</span></div>
          <div class="text-xs text-slate-600 mt-1">${esc(r.sku || '—')} · ${r.quantity} phone${r.quantity === 1 ? '' : 's'}${r.imeis ? ` · <span class="font-mono">${esc(r.imeis)}</span>` : ''}${r.outcomes ? ` · ${esc(r.outcomes.split(', ').map((x) => lbl('outcome', x)).join(', '))}` : ''}</div>
          ${r.is_repeat ? '<div class="text-[11px] font-semibold text-amber-800 mt-1"><i class="fas fa-repeat"></i> Repeat return</div>' : ''}${r.overdue ? '<div class="text-[11px] font-semibold text-red-700 mt-1"><i class="far fa-clock"></i> Received, no outcome after 2 working days</div>' : ''}${r.manager_items ? '<div class="text-[11px] font-semibold text-violet-700 mt-1"><i class="fas fa-user-shield"></i> Needs manager</div>' : ''}
        </a>`).join('') : '<p class="text-xs text-slate-400">No return on this order yet. One is created automatically when Amazon sends a return authorisation.</p>'}
    </div>`
    document.getElementById('rp-new').onclick = () => newReturnModal({ order_id: k?.order_id, case_id: caseId, sku: k?.sku })
  }

  // ───────── Dashboard strip (needs-attention lines) ─────────
  async function dashboardLines() {
    try {
      const { data: s } = await axios.get('/api/returns/summary')
      const lines = []
      if (s.refund_alerts) lines.push({ href: '/returns/refunds', cls: 'text-red-700', icon: 'fa-money-bill-transfer', text: `${s.refund_alerts} refund${s.refund_alerts === 1 ? '' : 's'} issued by Amazon with no phone back` })
      if (s.overdue) lines.push({ href: '/returns', cls: 'text-red-700', icon: 'fa-box-open', text: `${s.overdue} return${s.overdue === 1 ? '' : 's'} received with no outcome after 2 working days` })
      if (s.manager) lines.push({ href: '/returns', cls: 'text-violet-700', icon: 'fa-user-shield', text: `${s.manager} return${s.manager === 1 ? '' : 's'} waiting for manager approval` })
      return lines
    } catch { return [] }
  }

  return { renderDesk, renderReturn, renderNotices, renderRefunds, renderImport, renderReports, newReturnModal, mountCasePanel, dashboardLines, tabs, counts, STATUS_CLS, pill, money, ymd, opt, lbl, get L() { return L }, set L(v) { L = v } }
}
