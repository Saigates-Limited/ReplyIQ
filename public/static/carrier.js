/* ReplyIQ — Carrier desk UI (Royal Mail / DPD / FedEx / Evri investigations and claims).
   Loaded before app.js; app.js calls window.RiqCarrier(helpers) once and uses what it returns. */
window.RiqCarrier = function (h) {
  const { app, esc, toast, fmtDate, fmtDateTime, navigate, isManager } = h
  const err = (e) => toast(e.response?.data?.error || e.message, 'err')

  const STATUS_CLS = {
    to_raise: 'bg-sky-100 text-sky-800',
    awaiting_carrier: 'bg-blue-100 text-blue-800',
    sla_breach: 'bg-red-600 text-white',
    action_needed: 'bg-amber-100 text-amber-800',
    claim_form_needed: 'bg-orange-100 text-orange-800',
    claim_submitted: 'bg-violet-100 text-violet-800',
    escalated: 'bg-violet-100 text-violet-800',
    paid: 'bg-emerald-100 text-emerald-800',
    partially_paid: 'bg-emerald-100 text-emerald-800',
    rejected: 'bg-rose-100 text-rose-800',
    closed: 'bg-slate-200 text-slate-700',
  }
  const STATUS_LABEL = {
    to_raise: 'Ready to raise', awaiting_carrier: 'Awaiting carrier', sla_breach: 'Carrier overdue', action_needed: 'Action needed from us',
    claim_form_needed: 'Claim to submit', claim_submitted: 'Claim submitted', escalated: 'Escalated', paid: 'Paid', partially_paid: 'Partially paid', rejected: 'Rejected', closed: 'Closed',
  }
  const ISSUE_LABEL = {
    lost: 'Lost / no tracking update', delivered_not_received: 'Delivered but not received', empty_parcel: 'Empty parcel / contents missing', damaged: 'Damaged in transit',
    wrong_item: 'Wrong item', pod_request: 'Proof of delivery request', return_to_sender: 'Return to sender', postage_refund: 'Postage refund', other: 'Other',
  }
  const KIND_LABEL = { investigation: 'Investigation email', chase: 'Chase email', challenge: 'Challenge email', info_reply: 'Reply with information', claim_pack: 'Claim pack', postage_refund: 'Postage refund request' }
  const CARRIER_ICON = { royal_mail: 'fa-envelope', dpd: 'fa-truck', fedex: 'fa-plane', evri: 'fa-box', other: 'fa-truck-fast' }
  const money = (v) => (v == null || v === '' ? '—' : `£${Number(v).toFixed(2)}`)
  const chip = (s) => `<span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${STATUS_CLS[s] || 'bg-slate-100 text-slate-700'}">${esc(STATUS_LABEL[s] || s)}</span>`
  const parcelName = (k) => `<i class="fas ${CARRIER_ICON[k.carrier] || 'fa-truck'} mr-1 text-slate-400"></i>${esc(k.carrier_label || k.carrier)} <span class="font-mono">${esc(k.tracking || '—')}</span>`
  const lastRef = (k) => (k.carrier_refs || []).slice(-1)[0]

  // ───────── Draft review modal (one click = approve + send) ─────────
  async function openDraft(ccId, draftId, opts = {}) {
    let data
    try { ;({ data } = await axios.get(`/api/carrier/cases/${ccId}`)) } catch (e) { return err(e) }
    const k = data.carrier_case
    const d = (data.drafts || []).find((x) => x.id === draftId)
    if (!d) return toast('That draft is no longer available', 'err')
    const pack = d.kind === 'claim_pack'
    const queueTxt = opts.queue ? ` <span class="text-xs font-normal text-slate-500">· ${opts.index + 1} of ${opts.queue.length}</span>` : ''
    const blockedMgr = d.needs_manager && !isManager
    const modal = document.createElement('div')
    modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center p-2 sm:p-4 z-50'
    modal.innerHTML = `
      <div class="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[95vh] flex flex-col" role="dialog" aria-label="Review carrier email">
        <div class="px-5 py-3 border-b border-slate-100 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="font-semibold">${esc(KIND_LABEL[d.kind] || d.kind)}${queueTxt}</div>
            <div class="text-xs text-slate-500 mt-0.5">${parcelName(k)} · ${chip(k.display_status)} · ${esc(k.issue_label)}${lastRef(k) ? ` · case ${esc(lastRef(k))}` : ''}${k.case_ref ? ` · <a href="/cases/${k.case_id}" data-link class="underline">${esc(k.case_ref)}</a>` : ''}</div>
          </div>
          <button data-x class="text-slate-400 hover:text-slate-700 text-lg" aria-label="Close"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="p-5 overflow-auto space-y-3">
          ${d.missing?.length ? `<div class="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900"><i class="fas fa-circle-exclamation mr-1"></i><strong>Check before sending:</strong> ${d.missing.map(esc).join(' · ')}</div>` : ''}
          ${d.auto_created ? '<div class="text-[11px] text-slate-500"><i class="fas fa-robot mr-1"></i>Prepared automatically because the carrier\'s reply time passed. Nothing is sent until you press the button.</div>' : ''}
          ${pack ? `<div class="rounded-md bg-violet-50 border border-violet-200 px-3 py-2 text-xs text-violet-900"><i class="fas fa-paste mr-1"></i>A claim pack is pasted into the carrier's claims portal, not emailed. Copy it, submit the claim, then record it below.</div>` : `
          <div><label class="field-label">To</label><input data-f="to_address" class="field-input font-mono text-sm" value="${esc(d.to_address || '')}" placeholder="carrier email address"></div>`}
          <div><label class="field-label">${pack ? 'Title' : 'Subject'}</label><input data-f="subject" class="field-input text-sm" value="${esc(d.subject)}"></div>
          <div><label class="field-label">${pack ? 'Claim pack' : 'Email'}</label><textarea data-f="body" rows="16" class="field-input font-mono text-xs leading-relaxed">${esc(d.body)}</textarea></div>
          ${pack ? `<div class="grid grid-cols-2 gap-3"><div><label class="field-label">Claim reference (from the portal)</label><input data-claim-ref class="field-input" placeholder="optional"></div><div><label class="field-label">Amount claimed (£)</label><input data-claimed type="number" step="0.01" min="0" class="field-input" value="${esc(k.claimed ?? k.value ?? '')}"></div></div>` : ''}
          ${blockedMgr ? '<div class="text-xs text-violet-800 bg-violet-50 border border-violet-200 rounded-md px-3 py-2"><i class="fas fa-user-shield mr-1"></i>This one needs a manager to approve and send.</div>' : ''}
          <p class="text-[10px] text-slate-400"><i class="fas fa-lock mr-1"></i>Written from a template on our server — the customer's name and address go to the carrier only and never to the AI. Emails can only be sent to carrier addresses.</p>
        </div>
        <div class="px-5 py-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
          <div class="flex gap-2">
            <button data-discard class="text-xs px-3 py-2 rounded-md border border-slate-300 text-slate-600 hover:text-red-700">Discard</button>
            <button data-save class="text-xs px-3 py-2 rounded-md border border-slate-300 text-slate-700 hidden">Save changes</button>
            ${opts.queue ? '<button data-skip class="text-xs px-3 py-2 rounded-md border border-slate-300 text-slate-700">Skip</button>' : ''}
          </div>
          ${pack
            ? `<div class="flex gap-2"><button data-copy class="text-sm px-3 py-2 rounded-md border border-slate-300"><i class="far fa-copy mr-1"></i>Copy</button><button data-submitted class="text-sm px-4 py-2 rounded-md bg-violet-600 text-white font-medium"><i class="fas fa-check mr-1"></i>Mark claim submitted</button></div>`
            : `<button data-send ${blockedMgr ? 'disabled' : ''} class="text-sm px-4 py-2 rounded-md bg-emerald-600 text-white font-medium disabled:opacity-50"><i class="fas fa-paper-plane mr-1"></i>Approve &amp; send</button>`}
        </div>
      </div>`
    document.body.appendChild(modal)
    const f = (n) => modal.querySelector(`[data-f="${n}"]`)
    const current = () => ({ to_address: f('to_address')?.value.trim() ?? d.to_address, subject: f('subject').value.trim(), body: f('body').value.trim() })
    const dirty = () => { const c = current(); return c.subject !== d.subject.trim() || c.body !== d.body.trim() || (!pack && c.to_address !== (d.to_address || '')) }
    const saveBtn = modal.querySelector('[data-save]')
    const sendBtn = modal.querySelector('[data-send]')
    const syncBtn = () => { saveBtn.classList.toggle('hidden', !dirty()); if (sendBtn && !blockedMgr) sendBtn.innerHTML = `<i class="fas fa-paper-plane mr-1"></i>Approve &amp; send${current().to_address ? ` to ${esc(current().to_address)}` : ''}` }
    modal.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', syncBtn)); syncBtn()
    const close = () => modal.remove()
    const next = () => { close(); if (opts.queue && opts.index + 1 < opts.queue.length) { const n = opts.queue[opts.index + 1]; openDraft(n.ccId, n.draftId, { ...opts, index: opts.index + 1 }) } else opts.onDone?.() }
    const save = async () => { const { data: r } = await axios.patch(`/api/carrier/drafts/${d.id}`, current()); Object.assign(d, r.draft); syncBtn(); return r.draft }
    modal.querySelector('[data-x]').onclick = () => { close(); opts.onDone?.() }
    modal.addEventListener('click', (e) => { if (e.target.closest('a[data-link]')) close() })
    modal.querySelector('[data-skip]')?.addEventListener('click', next)
    saveBtn.onclick = async () => { try { await save(); toast('Saved') } catch (e) { err(e) } }
    modal.querySelector('[data-discard]').onclick = async () => { if (!confirm('Discard this draft?')) return; try { await axios.post(`/api/carrier/drafts/${d.id}/discard`); toast('Discarded'); next() } catch (e) { err(e) } }
    modal.querySelector('[data-copy]')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(`${f('subject').value}\n\n${f('body').value}`); toast('Copied — paste it into the claims portal') } catch { f('body').select(); document.execCommand('copy'); toast('Copied') } })
    modal.querySelector('[data-submitted]')?.addEventListener('click', async (e) => {
      e.target.disabled = true
      try { if (dirty()) await save(); await axios.post(`/api/carrier/cases/${ccId}/claim-submitted`, { claim_ref: modal.querySelector('[data-claim-ref]').value.trim(), claimed: modal.querySelector('[data-claimed]').value }); toast('Claim recorded — decision clock started'); next() } catch (ex) { err(ex); e.target.disabled = false }
    })
    sendBtn?.addEventListener('click', async () => {
      sendBtn.disabled = true; sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Sending…'
      try {
        if (dirty()) await save()
        const c = current()
        await axios.post(`/api/carrier/drafts/${d.id}/send`, { confirm_to: c.to_address, confirm_subject: c.subject, confirm_body: c.body }, { timeout: 30000 })
        toast(`Sent to ${c.to_address}`); h.refreshBadges?.(); next()
      } catch (e) { err(e); sendBtn.disabled = false; syncBtn() }
    })
  }

  // ───────── Case screen panel ─────────
  async function mountCasePanel(caseId, kase) {
    const el = document.getElementById('carrier-panel')
    if (!el) return
    let data
    try { ;({ data } = await axios.get(`/api/carrier/for-case/${caseId}`)) } catch { el.remove(); return }
    if (data.migration_needed) { el.innerHTML = '<p class="text-xs text-slate-400">Carrier desk: run migration 0015 to enable.</p>'; return }
    const ccs = data.carrier_cases || []
    const det = data.detection
    const pf = data.prefill || {}
    const openOnes = ccs.filter((k) => !['paid', 'partially_paid', 'rejected', 'closed'].includes(k.status))
    if (!ccs.length && !det && !pf.tracking) { el.classList.add('hidden'); return }
    el.classList.remove('hidden')
    const issueSel = (val) => `<select data-issue class="field-input py-1 text-xs mt-0">${Object.entries(ISSUE_LABEL).map(([v, l]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${l}</option>`).join('')}</select>`
    const offer = !openOnes.length ? `
      <div class="rounded-lg border ${det ? 'border-amber-300 bg-amber-50' : 'border-slate-200'} p-3 text-sm">
        ${det ? `<div class="text-amber-900 text-xs mb-2"><i class="fas fa-triangle-exclamation mr-1"></i><strong>Customer reports: ${esc(det.label)}</strong>${det.phrase ? ` — “${esc(det.phrase)}”` : ''}</div>` : ''}
        <div class="text-xs text-slate-600 mb-2">${pf.tracking ? `<span class="font-mono">${esc(pf.tracking)}</span>${pf.carrier ? ` · ${esc(pf.carrier.replace('_', ' '))}` : ''}${pf.package_status ? ` · Amazon: ${esc(pf.package_status)}` : ''}${pf.delivered_at ? ` ${fmtDate(pf.delivered_at)}` : pf.promised_by ? ` · promised by ${fmtDate(pf.promised_by)}` : ''}` : 'No tracking number yet — fetch the Amazon order or type it in Case details.'}</div>
        <div class="mb-2"><label class="field-label">Delivery address <span class="normal-case font-normal">(goes to the carrier only, never to the AI — helps them check the GPS scan)</span></label><input data-addr class="field-input mt-0 text-xs" value="${esc(kase.customer_address || '')}" placeholder="optional: house, street, town, postcode"></div>
        <div class="flex flex-wrap items-center gap-2">${issueSel(det?.issue || 'lost')}<button data-open class="px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs font-medium" ${pf.tracking || kase.tracking_number ? '' : 'disabled'}><i class="fas fa-magnifying-glass mr-1"></i>Open carrier investigation</button></div>
      </div>` : ''
    el.innerHTML = `
      <div class="flex items-center justify-between mb-2"><h2 class="font-semibold"><i class="fas fa-truck-fast mr-2 text-slate-400"></i>Carrier</h2><a href="/carriers" data-link class="text-xs text-slate-500 hover:underline">Carrier desk →</a></div>
      <div class="space-y-2">
        ${ccs.map((k) => `
          <div class="rounded-lg border border-slate-200 p-3 text-sm">
            <div class="flex items-center justify-between gap-2"><a href="/carriers/${k.id}" data-link class="hover:underline min-w-0 truncate">${parcelName(k)}</a>${chip(k.display_status)}</div>
            <div class="text-xs text-slate-500 mt-1">${esc(k.issue_label)}${lastRef(k) ? ` · case ${esc(lastRef(k))}` : ''}${k.waiting_working_days != null && !['paid', 'partially_paid', 'rejected', 'closed'].includes(k.status) ? ` · waiting ${k.waiting_working_days} working day${k.waiting_working_days === 1 ? '' : 's'}` : ''}${k.sla_due_at && k.display_status !== 'sla_breach' && ['awaiting_carrier', 'claim_submitted', 'escalated'].includes(k.status) ? ` · reply due ${fmtDate(k.sla_due_at)}` : ''}</div>
            ${k.next_action ? `<div class="text-xs mt-1"><i class="fas fa-arrow-right mr-1 text-slate-400"></i>${esc(k.next_action)}</div>` : ''}
            ${k.last_event ? `<div class="text-[11px] text-slate-400 mt-1">Latest: ${esc(k.last_event)}</div>` : ''}
            ${k.customer_update_due ? `<div class="mt-2 rounded-md bg-sky-50 border border-sky-200 px-2 py-1.5 text-xs text-sky-900 flex flex-wrap items-center gap-2"><span><i class="fas fa-bullhorn mr-1"></i>New carrier news for the customer.</span><button data-cust-draft class="px-2 py-1 rounded bg-sky-600 text-white">Draft customer update</button><button data-told="${k.id}" class="underline">Already told</button></div>` : ''}
            ${(k.live_drafts || []).length ? `<div class="mt-2 flex flex-wrap gap-1">${k.live_drafts.map((d) => `<button data-draft="${d.id}" data-cc="${k.id}" class="px-2 py-1 rounded-md bg-emerald-600 text-white text-xs"><i class="fas ${d.kind === 'claim_pack' ? 'fa-paste' : 'fa-paper-plane'} mr-1"></i>Review ${esc((KIND_LABEL[d.kind] || d.kind).toLowerCase())}</button>`).join('')}</div>` : ''}
          </div>`).join('')}
        ${offer}
      </div>`
    el.querySelectorAll('[data-draft]').forEach((b) => (b.onclick = () => openDraft(Number(b.dataset.cc), Number(b.dataset.draft), { onDone: () => h.renderCase(caseId) })))
    el.querySelectorAll('[data-told]').forEach((b) => (b.onclick = async () => { try { await axios.patch(`/api/carrier/cases/${b.dataset.told}`, { customer_update_due: false }); h.renderCase(caseId) } catch (e) { err(e) } }))
    el.querySelectorAll('[data-cust-draft]').forEach((b) => (b.onclick = () => h.generate(caseId, 'customer')))
    el.querySelector('[data-open]')?.addEventListener('click', async (e) => {
      const issue = el.querySelector('[data-issue]').value
      const addr = el.querySelector('[data-addr]')?.value.trim() ?? ''
      const go = async (force) => {
        e.target.disabled = true
        try {
          if (addr !== (kase.customer_address || '')) await axios.patch(`/api/cases/${caseId}`, { customer_address: addr })
          const { data: r } = await axios.post('/api/carrier/open', { case_id: caseId, issue, force }, { timeout: 30000 })
          toast(r.created ? 'Investigation prepared — review and send' : 'Parcel already on the carrier desk')
          if (r.draft_id) openDraft(r.carrier_case_id, r.draft_id, { onDone: () => h.renderCase(caseId) })
          else h.renderCase(caseId)
        } catch (ex) {
          const d = ex.response?.data
          if (d?.code === 'too_early' && confirm(d.error)) return go(true)
          err(ex)
        } finally { e.target.disabled = false }
      }
      go(false)
    })
  }

  // ───────── Carrier desk page ─────────
  let deskView = (() => { try { return localStorage.getItem('riq.carrierView') || 'chase' } catch { return 'chase' } })()
  const VIEWS = [['chase', 'Chase now'], ['on_us', 'Needs us'], ['waiting', 'Waiting'], ['open', 'All open'], ['closed', 'Closed'], ['all', 'Everything']]

  async function renderDesk() {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading carrier desk…</p>`
    let s, list
    try {
      const [a, b] = await Promise.all([axios.get('/api/carrier/summary'), axios.get('/api/carrier/cases', { params: { view: deskView } })])
      s = a.data; list = b.data
    } catch (e) { return h.renderError(e) }
    if (s.migration_needed) { app.innerHTML = '<div class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Run <code>db/migrations/0015_carrier_desk.sql</code> in the Supabase SQL editor to switch on the carrier desk.</div>'; return }
    const ready = list.cases.flatMap((k) => (k.live_drafts || []).filter((d) => d.kind !== 'claim_pack' && (!d.needs_manager || isManager)).map((d) => ({ ccId: k.id, draftId: d.id })))
    app.innerHTML = `
      <section id="carrier-desk">
        <div class="flex flex-wrap items-end justify-between gap-3 mb-4">
          <div><h1 class="text-2xl font-bold"><i class="fas fa-truck-fast mr-2 text-slate-400"></i>Carrier desk</h1>
            <p class="text-sm text-slate-500">Investigations and claims with Royal Mail, DPD, FedEx and Evri. Carrier replies are read every 15 minutes; chases are prepared automatically when a reply is late. Nothing is sent without your click.</p></div>
          <div class="flex flex-wrap gap-2 text-sm">
            ${ready.length ? `<button id="cd-queue" class="px-3 py-2 rounded-md bg-emerald-600 text-white font-medium"><i class="fas fa-paper-plane mr-1"></i>Review ${ready.length} ready email${ready.length === 1 ? '' : 's'}</button>` : ''}
            <button id="cd-sync" class="px-3 py-2 rounded-md border border-slate-300 bg-white"><i class="fas fa-rotate mr-1"></i>Check carrier mail</button>
            <button id="cd-new" class="px-3 py-2 rounded-md border border-slate-300 bg-white"><i class="fas fa-plus mr-1"></i>Add parcel</button>
            <button id="cd-settings" class="px-3 py-2 rounded-md border border-slate-300 bg-white" title="Carrier desk settings"><i class="fas fa-gear"></i></button>
          </div>
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-4">
          <div class="kpi" style="--kpi:#2563eb"><div class="l">Open parcels</div><div class="v">${s.open}</div><div class="text-xs text-slate-500">${Object.entries(s.by_carrier).map(([c, n]) => `${esc(c)} ${n}`).join(' · ') || '—'}</div></div>
          <div class="kpi" style="--kpi:#dc2626"><div class="l">Chase now</div><div class="v ${s.chase_now ? 'text-red-700' : ''}">${s.chase_now}</div><div class="text-xs text-slate-500">carrier reply overdue</div></div>
          <div class="kpi" style="--kpi:#f59e0b"><div class="l">Needs us</div><div class="v">${s.on_us}</div><div class="text-xs text-slate-500">raise, reply or claim</div></div>
          <div class="kpi" style="--kpi:#0ea5e9"><div class="l">Tell the customer</div><div class="v">${s.customer_updates_due}</div><div class="text-xs text-slate-500">carrier news to pass on</div></div>
          <div class="kpi" style="--kpi:#7c3aed"><div class="l">At risk</div><div class="v">${money(s.at_risk)}</div><div class="text-xs text-slate-500">value of open parcels</div></div>
          <div class="kpi" style="--kpi:#16a34a"><div class="l">Recovered</div><div class="v">${money(s.recovered)}</div><div class="text-xs text-slate-500">paid by carriers to date</div></div>
        </div>
        <div class="flex flex-wrap gap-1 mb-3 text-sm">${VIEWS.map(([v, l]) => `<button data-view="${v}" class="px-3 py-1.5 rounded-md ${deskView === v ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300'}">${l}</button>`).join('')}</div>
        <div class="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table class="riq w-full text-sm">
            <thead class="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr>
              <th class="px-4 py-3">Status</th><th class="px-4 py-3">Parcel</th><th class="px-4 py-3 hidden md:table-cell">Issue</th><th class="px-4 py-3">Waiting</th><th class="px-4 py-3 hidden lg:table-cell">Next step</th><th class="px-4 py-3 hidden sm:table-cell">Value / paid</th><th class="px-4 py-3"></th>
            </tr></thead>
            <tbody>${list.cases.length ? list.cases.map((k) => `
              <tr class="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" data-cc="${k.id}">
                <td class="px-4 py-3">${chip(k.display_status)}${k.customer_update_due ? '<div class="mt-1"><span class="pill bg-sky-100 text-sky-800 text-[10px]"><i class="fas fa-bullhorn"></i> tell customer</span></div>' : ''}</td>
                <td class="px-4 py-3"><div>${parcelName(k)}</div><div class="text-xs text-slate-500">${k.order_id ? `<span class="font-mono">${esc(k.order_id)}</span>` : ''}${k.case_ref ? ` · <a href="/cases/${k.case_id}" data-link class="underline" onclick="event.stopPropagation()">${esc(k.case_ref)}</a>` : ''}${lastRef(k) ? ` · case ${esc(lastRef(k))}` : ''}</div></td>
                <td class="px-4 py-3 hidden md:table-cell text-xs">${esc(k.issue_label)}${k.product ? `<div class="text-slate-400 truncate max-w-[14rem]">${esc(k.product)}</div>` : ''}</td>
                <td class="px-4 py-3 whitespace-nowrap text-xs">${k.waiting_working_days != null && !['paid', 'partially_paid', 'rejected', 'closed'].includes(k.status) ? `<span class="${k.display_status === 'sla_breach' ? 'deadline-overdue font-semibold' : ''}">${k.waiting_working_days} wd</span>` : '—'}${k.sla_due_at && ['awaiting_carrier', 'claim_submitted', 'escalated'].includes(k.status) ? `<div class="text-slate-400">due ${fmtDate(k.sla_due_at)}</div>` : ''}</td>
                <td class="px-4 py-3 hidden lg:table-cell text-xs max-w-sm">${esc(k.next_action || '')}${k.last_event ? `<div class="text-slate-400 truncate">${esc(k.last_event)}</div>` : ''}</td>
                <td class="px-4 py-3 hidden sm:table-cell whitespace-nowrap text-xs">${money(k.value)}${k.paid ? `<div class="text-emerald-700">paid ${money(k.paid)}</div>` : ''}</td>
                <td class="px-4 py-3 text-right whitespace-nowrap">${(k.live_drafts || []).map((d) => `<button data-draft="${d.id}" data-ccid="${k.id}" class="px-2 py-1 rounded-md ${d.kind === 'claim_pack' ? 'bg-violet-600' : 'bg-emerald-600'} text-white text-xs mb-1"><i class="fas ${d.kind === 'claim_pack' ? 'fa-paste' : 'fa-paper-plane'} mr-1"></i>${d.kind === 'claim_pack' ? 'Claim' : d.kind === 'chase' ? 'Chase' : d.kind === 'investigation' ? 'Raise' : 'Email'}</button>`).join(' ')}</td>
              </tr>`).join('') : `<tr><td colspan="7" class="px-4 py-10 text-center text-slate-500">${deskView === 'chase' ? 'Nothing to chase. Every carrier is inside its reply time.' : 'Nothing here.'}</td></tr>`}</tbody>
          </table>
        </div>
        <p class="text-[11px] text-slate-400 mt-2">Reply times: Royal Mail 3 working days, DPD / FedEx / Evri 5, claim decisions 10 (England &amp; Wales bank holidays skipped; list runs to ${esc(s.bank_holidays_until || '')}).</p>
      </section>`
    app.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => { deskView = b.dataset.view; try { localStorage.setItem('riq.carrierView', deskView) } catch {} ; renderDesk() }))
    app.querySelectorAll('tr[data-cc]').forEach((tr) => (tr.onclick = (e) => { if (e.target.closest('button,a')) return; navigate(`/carriers/${tr.dataset.cc}`) }))
    app.querySelectorAll('[data-draft]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openDraft(Number(b.dataset.ccid), Number(b.dataset.draft), { onDone: renderDesk }) }))
    document.getElementById('cd-queue')?.addEventListener('click', () => openDraft(ready[0].ccId, ready[0].draftId, { queue: ready, index: 0, onDone: renderDesk }))
    document.getElementById('cd-sync').onclick = async (e) => {
      e.target.disabled = true; e.target.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Checking…'
      try { const { data: r } = await axios.post('/api/carrier/sync', {}, { timeout: 60000 }); toast(`${r.messagesNew} new carrier email(s)${r.prepared ? ` · ${r.prepared} email(s) prepared` : ''}${r.mailboxes ? '' : ' — no mailbox is set to receive carrier mail (Gmail page)'}`, r.mailboxes ? 'ok' : 'err'); renderDesk() } catch (ex) { err(ex); renderDesk() }
    }
    document.getElementById('cd-new').onclick = newParcel
    document.getElementById('cd-settings').onclick = settingsModal
  }

  function newParcel() {
    const modal = document.createElement('div')
    modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50'
    modal.innerHTML = `<div class="bg-white rounded-xl shadow-xl max-w-md w-full p-5 space-y-3">
      <h2 class="font-semibold">Add a parcel</h2>
      <p class="text-xs text-slate-500">For parcels with no Amazon conversation (eBay, Temu, B2B). For an Amazon customer, use <em>Open carrier investigation</em> on their case instead — it fills everything in.</p>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="field-label">Carrier</label><select data-n="carrier" class="field-input"><option value="royal_mail">Royal Mail</option><option value="dpd">DPD</option><option value="fedex">FedEx</option><option value="evri">Evri</option></select></div>
        <div><label class="field-label">Tracking number</label><input data-n="tracking" class="field-input font-mono"></div>
        <div><label class="field-label">Order reference</label><input data-n="order_id" class="field-input font-mono" placeholder="optional"></div>
        <div><label class="field-label">Value (£)</label><input data-n="value" type="number" step="0.01" class="field-input"></div>
        <div class="col-span-2"><label class="field-label">Issue</label><select data-n="issue" class="field-input">${Object.entries(ISSUE_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="col-span-2"><label class="field-label">Contents</label><input data-n="product" class="field-input" placeholder="e.g. Apple iPhone 13 128GB Blue"></div>
      </div>
      <div class="flex justify-end gap-2"><button data-cancel class="px-3 py-2 rounded-md border border-slate-300 text-sm">Cancel</button><button data-ok class="px-3 py-2 rounded-md bg-slate-900 text-white text-sm">Add &amp; draft investigation</button></div>
    </div>`
    document.body.appendChild(modal)
    modal.querySelector('[data-cancel]').onclick = () => modal.remove()
    modal.querySelector('[data-ok]').onclick = async () => {
      const v = Object.fromEntries([...modal.querySelectorAll('[data-n]')].map((el) => [el.dataset.n, el.value.trim()]))
      try { const { data: r } = await axios.post('/api/carrier/cases', v); modal.remove(); openDraft(r.carrier_case_id, r.draft_id, { onDone: renderDesk }) } catch (e) { err(e) }
    }
  }

  async function settingsModal() {
    let data
    try { ;({ data } = await axios.get('/api/carrier/settings')) } catch (e) { return err(e) }
    const s = data.settings
    const ro = isManager ? '' : 'disabled'
    const modal = document.createElement('div')
    modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center p-2 sm:p-4 z-50'
    modal.innerHTML = `<div class="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[95vh] overflow-auto p-5 space-y-4">
      <div class="flex items-center justify-between"><h2 class="font-semibold">Carrier desk settings</h2><button data-x class="text-slate-400"><i class="fas fa-xmark"></i></button></div>
      ${isManager ? '' : '<p class="text-xs text-slate-500">Only a manager can change these.</p>'}
      <section><h3 class="field-label mb-1">Mailboxes that receive carrier mail</h3>
        <div class="space-y-1 text-sm">${(data.mailboxes || []).map((m) => `<label class="flex items-center gap-2"><input type="checkbox" data-mb="${m.id}" ${m.carrier_mail ? 'checked' : ''} ${ro}> ${esc(m.label)} <span class="text-xs text-slate-500">${esc(m.email)}</span></label>`).join('') || '<p class="text-xs text-slate-500">No Gmail mailbox connected yet.</p>'}</div>
        <p class="text-[11px] text-slate-400 mt-1">Tick the mailbox that gets Royal Mail / DPD replies (e.g. the one that receives copies of ecom@saigates.com). Connect more mailboxes on the Gmail page.</p></section>
      <section class="grid sm:grid-cols-2 gap-3">
        <div><label class="field-label">Send carrier emails from mailbox</label><select data-s="send_mailbox_id" class="field-input" ${ro}><option value="">Automatic (first carrier mailbox)</option>${(data.mailboxes || []).map((m) => `<option value="${m.id}" ${s.send_mailbox_id === m.id ? 'selected' : ''}>${esc(m.label)} · ${esc(m.email)}</option>`).join('')}</select></div>
        <div><label class="field-label">"From" address (optional alias)</label><input data-s="from_address" class="field-input" value="${esc(s.from_address || '')}" placeholder="e.g. ecom@saigates.com" ${ro}><p class="text-[10px] text-slate-400 mt-0.5">Must be a verified "Send mail as" address in that Gmail account, or Gmail uses the account's own address.</p></div>
        <div><label class="field-label">From name</label><input data-s="from_name" class="field-input" value="${esc(s.from_name)}" ${ro}></div>
        <div><label class="field-label">Cc (comma separated)</label><input data-s="cc" class="field-input" value="${esc((s.cc || []).join(', '))}" ${ro}></div>
        <div class="sm:col-span-2"><label class="field-label">Signature (under the staff member's name)</label><textarea data-s="signature" rows="5" class="field-input text-xs font-mono" ${ro}>${esc(s.signature)}</textarea></div>
      </section>
      <section><h3 class="field-label mb-1">Carrier addresses</h3><div class="grid sm:grid-cols-2 gap-3">${Object.entries(data.defaults).filter(([id]) => id !== 'other').map(([id, d]) => `<div><label class="field-label">${esc(d.label)} <span class="normal-case font-normal">· reply ${d.reply_days} wd</span></label><input data-addr="${id}" class="field-input text-sm" value="${esc(s.addresses?.[id] || '')}" placeholder="${esc(d.to || 'not set — add one to email them')}" ${ro}></div>`).join('')}</div>
        <div class="mt-2"><label class="field-label">Extra allowed recipient domains</label><input data-s="extra_allowed_domains" class="field-input text-sm" value="${esc((s.extra_allowed_domains || []).join(', '))}" placeholder="e.g. a carrier account manager's domain" ${ro}></div></section>
      <section class="space-y-1 text-sm">
        <label class="flex items-center gap-2"><input type="checkbox" data-s="auto_open" ${s.auto_open ? 'checked' : ''} ${ro}> When a customer reports a delivery problem, prepare the investigation email automatically (still needs your click to send)</label>
        <label class="flex items-center gap-2"><input type="checkbox" data-s="auto_chase" ${s.auto_chase ? 'checked' : ''} ${ro}> When a carrier's reply is late, prepare a chase email automatically</label>
      </section>
      ${isManager ? `<section class="rounded-md border border-slate-200 p-3"><h3 class="field-label mb-1">Import from the old Carrier Claims Desk</h3><p class="text-xs text-slate-500 mb-2">Choose the <code>carrier-claims-export.json</code> file. Existing parcels are updated, nothing is deleted, nothing is sent.</p><input type="file" accept="application/json" data-import class="text-xs"></section>` : ''}
      <div class="flex justify-end gap-2"><button data-x class="px-3 py-2 rounded-md border border-slate-300 text-sm">Close</button>${isManager ? '<button data-save class="px-3 py-2 rounded-md bg-slate-900 text-white text-sm">Save</button>' : ''}</div>
    </div>`
    document.body.appendChild(modal)
    modal.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => modal.remove()))
    modal.querySelectorAll('[data-mb]').forEach((cb) => (cb.onchange = async () => { try { await axios.patch(`/api/gmail/mailboxes/${cb.dataset.mb}`, { carrier_mail: cb.checked }); toast('Mailbox updated') } catch (e) { err(e); cb.checked = !cb.checked } }))
    modal.querySelector('[data-import]')?.addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return
      try {
        const json = JSON.parse(await file.text())
        const cases = Array.isArray(json) ? json : json.cases
        if (!confirm(`Import ${cases?.length || 0} parcel(s)?`)) return
        const { data: r } = await axios.post('/api/carrier/import', { cases }, { timeout: 120000 })
        toast(`Imported: ${r.created} new, ${r.updated} updated${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`); modal.remove(); renderDesk()
      } catch (ex) { err(ex) }
    })
    modal.querySelector('[data-save]')?.addEventListener('click', async () => {
      const v = (n) => modal.querySelector(`[data-s="${n}"]`)
      const body = {
        send_mailbox_id: v('send_mailbox_id').value || null, from_address: v('from_address').value, from_name: v('from_name').value, cc: v('cc').value,
        signature: v('signature').value, extra_allowed_domains: v('extra_allowed_domains').value, auto_open: v('auto_open').checked, auto_chase: v('auto_chase').checked,
        addresses: Object.fromEntries([...modal.querySelectorAll('[data-addr]')].map((el) => [el.dataset.addr, el.value.trim()])),
      }
      try { await axios.put('/api/carrier/settings', body); toast('Settings saved'); modal.remove() } catch (e) { err(e) }
    })
  }

  // ───────── One parcel ─────────
  async function renderParcel(id) {
    app.innerHTML = `<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading parcel…</p>`
    let data
    try { ;({ data } = await axios.get(`/api/carrier/cases/${id}`)) } catch (e) { return h.renderError(e) }
    const k = data.carrier_case
    const live = data.drafts.filter((d) => ['draft', 'approved'].includes(d.status))
    const closed = ['paid', 'partially_paid', 'rejected', 'closed'].includes(k.status)
    const icon = (m) => (m.direction === 'outbound' ? 'fa-paper-plane text-emerald-600' : m.direction === 'note' ? 'fa-note-sticky text-slate-400' : m.kind === 'auto_ack' ? 'fa-robot text-slate-400' : /decision|settled/.test(m.kind) ? 'fa-gavel text-violet-600' : m.kind === 'info_request' ? 'fa-circle-question text-amber-600' : 'fa-envelope text-sky-600')
    const actions = [
      ['investigation', 'Investigation', !k.raised_at],
      ['chase', 'Chase', !!k.raised_at && !closed],
      ['info_reply', 'Reply with info', k.status === 'action_needed'],
      ['challenge', 'Challenge decision', k.status === 'rejected' || k.carrier_reply_type === 'decision'],
      ['claim_pack', 'Claim pack', ['claim_form_needed', 'rejected', 'awaiting_carrier', 'escalated'].includes(k.status)],
      ['postage_refund', 'Postage refund', k.issue === 'postage_refund'],
    ].filter(([, , show]) => show)
    const field = (name, label, val, type = 'text', extra = '') => `<div><label class="field-label">${label}</label><input data-p="${name}" type="${type}" ${type === 'number' ? 'step="0.01" min="0"' : ''} class="field-input text-sm ${extra}" value="${esc(val ?? '')}"></div>`
    app.innerHTML = `
      <section id="carrier-parcel">
        <a href="/carriers" data-link class="text-sm text-slate-500 hover:text-slate-800"><i class="fas fa-arrow-left mr-1"></i>Carrier desk</a>
        <header class="mt-2 mb-4 flex flex-wrap items-start justify-between gap-3">
          <div><h1 class="text-2xl font-bold">${parcelName(k)}</h1>
            <div class="mt-1 flex flex-wrap items-center gap-2 text-sm">${chip(k.display_status)}<span class="text-slate-500">${esc(k.issue_label)}</span>${k.case_ref ? `<a href="/cases/${k.case_id}" data-link class="text-xs px-2 py-0.5 rounded-full bg-slate-100 hover:bg-slate-200"><i class="fab fa-amazon mr-1"></i>${esc(k.case_ref)} · ${esc(k.customer_first_name || '')}</a>` : ''}${k.order_id ? `<span class="font-mono text-xs text-slate-500">${esc(k.order_id)}</span>` : ''}</div>
            ${k.next_action ? `<div class="mt-2 text-sm"><i class="fas fa-arrow-right mr-1 text-slate-400"></i>${esc(k.next_action)}${k.next_due ? ` <span class="text-slate-400">· ${fmtDate(k.next_due)}</span>` : ''}</div>` : ''}
          </div>
          <div class="flex flex-wrap gap-2">${live.map((d) => `<button data-draft="${d.id}" class="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm"><i class="fas fa-paper-plane mr-1"></i>Review ${esc((KIND_LABEL[d.kind] || d.kind).toLowerCase())}</button>`).join('')}</div>
        </header>
        <div class="grid grid-cols-1 xl:grid-cols-5 gap-4">
          <div class="xl:col-span-3 space-y-4">
            <div class="bg-white rounded-xl shadow-sm p-4">
              <h2 class="font-semibold mb-3">Timeline</h2>
              <ol class="space-y-3">${data.messages.length ? data.messages.map((m) => `
                <li class="flex gap-3"><i class="fas ${icon(m)} mt-1 w-4 text-center"></i><div class="min-w-0 flex-1">
                  <div class="text-xs text-slate-500">${fmtDateTime(m.sent_at)} · ${m.direction === 'outbound' ? `to ${esc(m.to_addr || '')}` : m.direction === 'note' ? 'note' : `from ${esc(m.from_addr || '')}`}${m.sent_by_name ? ` · ${esc(m.sent_by_name)}` : ''}</div>
                  <div class="text-sm font-medium">${esc(m.summary || (m.direction === 'inbound' ? m.kind_label : m.subject) || '')}</div>
                  ${m.body && m.direction !== 'note' ? `<details class="mt-1"><summary class="text-xs text-slate-500 cursor-pointer">${esc(m.subject || 'Show email')}</summary><div class="message-body text-xs text-slate-700 mt-1 p-2 rounded bg-slate-50 max-h-72 overflow-auto">${esc(m.body)}</div></details>` : m.direction === 'note' && m.body !== m.summary ? `<div class="text-xs text-slate-600">${esc(m.body)}</div>` : ''}
                </div></li>`).join('') : '<li class="text-sm text-slate-400">No emails yet.</li>'}</ol>
              <div class="mt-4 flex gap-2"><input id="cp-note" class="field-input mt-0 text-sm" placeholder="Add a note (phone call, portal update…)"><button id="cp-note-add" class="px-3 py-2 rounded-md border border-slate-300 text-sm whitespace-nowrap">Add note</button></div>
            </div>
            <div class="bg-white rounded-xl shadow-sm p-4">
              <h2 class="font-semibold mb-2">Prepare an email</h2>
              <div class="flex flex-wrap gap-2">${actions.map(([kind, label]) => `<button data-make="${kind}" class="px-3 py-1.5 rounded-md border border-slate-300 text-sm">${label}</button>`).join('') || '<span class="text-sm text-slate-400">Nothing to send for this status.</span>'}</div>
              ${data.drafts.filter((d) => d.status === 'sent').length ? `<details class="mt-3 text-sm"><summary class="cursor-pointer text-slate-600">${data.drafts.filter((d) => d.status === 'sent').length} sent</summary><ul class="mt-2 space-y-1 text-xs">${data.drafts.filter((d) => d.status === 'sent').map((d) => `<li>${fmtDateTime(d.sent_at)} · ${esc(KIND_LABEL[d.kind] || d.kind)} · ${esc(d.sent_by_name || '')}</li>`).join('')}</ul></details>` : ''}
            </div>
          </div>
          <aside class="xl:col-span-2 bg-white rounded-xl shadow-sm p-4">
            <div class="flex items-center justify-between mb-3"><h2 class="font-semibold">Details</h2><span id="cp-saved" class="text-xs text-emerald-600 opacity-0 transition-opacity">Saved</span></div>
            <div class="grid grid-cols-2 gap-3">
              <div><label class="field-label">Status</label><select data-p="status" class="field-input text-sm">${Object.entries(STATUS_LABEL).filter(([v]) => v !== 'sla_breach').map(([v, l]) => `<option value="${v}" ${k.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
              <div><label class="field-label">Issue</label><select data-p="issue" class="field-input text-sm">${Object.entries(ISSUE_LABEL).map(([v, l]) => `<option value="${v}" ${k.issue === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
              ${field('value', 'Value (£)', k.value, 'number')}${field('claimed', 'Claimed (£)', k.claimed, 'number')}
              ${field('paid', 'Paid (£)', k.paid, 'number')}${field('paid_on', 'Paid on', k.paid_on ? String(k.paid_on).slice(0, 10) : '', 'date')}
              ${field('posted_on', 'Posted', k.posted_on ? String(k.posted_on).slice(0, 10) : '', 'date')}${field('service', 'Service', k.service)}
              <div class="col-span-2">${field('product', 'Contents', k.product)}</div>
              <div class="col-span-2">${field('carrier_refs', 'Carrier case references', (k.carrier_refs || []).join(', '), 'text', 'font-mono')}</div>
              ${field('claim_ref', 'Claim reference', k.claim_ref, 'text', 'font-mono')}${field('order_id', 'Order reference', k.order_id, 'text', 'font-mono')}
              <div class="col-span-2"><label class="field-label">Notes</label><textarea data-p="notes" rows="3" class="field-input text-sm">${esc(k.notes || '')}</textarea></div>
            </div>
            <dl class="mt-4 grid grid-cols-2 gap-y-1 text-xs text-slate-500">
              <dt>Raised</dt><dd>${fmtDateTime(k.raised_at)}</dd><dt>Our last email</dt><dd>${fmtDateTime(k.last_us_at)}</dd>
              <dt>Carrier's last reply</dt><dd>${fmtDateTime(k.last_carrier_at)}${k.carrier_reply_type ? ` (${esc(k.carrier_reply_type.replace('_', ' '))})` : ''}</dd>
              <dt>Reply due</dt><dd>${fmtDate(k.sla_due_at)}</dd><dt>Source</dt><dd>${esc(k.source)}</dd>
            </dl>
          </aside>
        </div>
      </section>`
    const saved = document.getElementById('cp-saved')
    app.querySelectorAll('[data-p]').forEach((el) => (el.onchange = async () => {
      try { await axios.patch(`/api/carrier/cases/${id}`, { [el.dataset.p]: el.value }); saved.style.opacity = 1; setTimeout(() => (saved.style.opacity = 0), 1200); if (el.dataset.p === 'status') renderParcel(id) } catch (e) { err(e) }
    }))
    app.querySelectorAll('[data-draft]').forEach((b) => (b.onclick = () => openDraft(id, Number(b.dataset.draft), { onDone: () => renderParcel(id) })))
    app.querySelectorAll('[data-make]').forEach((b) => (b.onclick = async () => {
      try { const { data: r } = await axios.post(`/api/carrier/cases/${id}/drafts`, { kind: b.dataset.make }); openDraft(id, r.draft.id, { onDone: () => renderParcel(id) }) } catch (e) { err(e) }
    }))
    document.getElementById('cp-note-add').onclick = async () => {
      const t = document.getElementById('cp-note').value.trim(); if (!t) return
      try { await axios.post(`/api/carrier/cases/${id}/note`, { text: t }); renderParcel(id) } catch (e) { err(e) }
    }
  }

  // ───────── Dashboard strip + sidebar badge ─────────
  async function dashboardStrip() {
    try {
      const { data: s } = await axios.get('/api/carrier/summary')
      if (s.migration_needed || (!s.open && !s.recovered)) return ''
      return `<a href="/carriers" data-link class="block mb-4 rounded-xl border border-slate-200 bg-white p-4 hover:bg-slate-50">
        <div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span class="font-semibold"><i class="fas fa-truck-fast mr-1 text-slate-400"></i>Carrier desk</span>
          <span><strong class="${s.chase_now ? 'text-red-700' : ''}">${s.chase_now}</strong> to chase</span>
          <span><strong>${s.on_us}</strong> need us</span>
          <span><strong>${s.customer_updates_due}</strong> customer update${s.customer_updates_due === 1 ? '' : 's'}</span>
          <span><strong>${s.drafts_ready}</strong> email${s.drafts_ready === 1 ? '' : 's'} ready</span>
          <span class="text-slate-500">${money(s.at_risk)} at risk · ${money(s.recovered)} recovered</span>
        </div></a>`
    } catch { return '' }
  }
  async function badgeCount() {
    try { const { data: s } = await axios.get('/api/carrier/summary'); return (s.chase_now || 0) + (s.on_us || 0) + (s.customer_updates_due || 0) } catch { return 0 }
  }

  return { renderDesk, renderParcel, mountCasePanel, dashboardStrip, badgeCount, openDraft }
}
