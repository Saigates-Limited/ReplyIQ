/* ReplyIQ — Saisales.co.uk (Shopify) on the case page and in Settings.
   Loaded before app.js; app.js calls window.RiqShopify(helpers) once and uses what it returns.
   Every Shopify action (refund, return, label, receive) needs a confirmation screen on the page, never a browser pop-up. */
window.RiqShopify = function (h) {
  const { esc, toast, fmtDate, fmtDateTime, isManager } = h
  const err = (e) => toast(e.response?.data?.error || e.message, 'err')
  const money = (v) => (v == null || v === '' ? '—' : `£${Number(v).toFixed(2)}`)
  const pill = (txt, cls) => `<span class="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${cls}">${esc(txt)}</span>`
  const STATUS_CLS = (s) => /PAID|FULFILLED|DELIVERED|CLOSED|SUCCESS/.test(s) ? 'bg-emerald-100 text-emerald-800' : /REFUND|RETURN|OPEN|IN_TRANSIT|PARTIAL/.test(s) ? 'bg-amber-100 text-amber-800' : /CANCEL|DECLIN|FAIL/.test(s) ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700'
  const nice = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2))
  let status = null
  async function getStatus() { if (!status) try { ;({ data: status } = await axios.get('/api/shopify/status')) } catch { status = { configured: false } } return status }

  // On-page dialog: returns the element; buttons wired by the caller.
  function dialog(title, bodyHtml, actions) {
    const m = document.createElement('div'); m.className = 'fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50'
    m.innerHTML = `<div class="bg-white rounded-xl shadow-xl max-w-lg w-full p-5 max-h-[90vh] overflow-auto"><h3 class="font-bold text-lg mb-3">${title}</h3><div data-body>${bodyHtml}</div>
      <div data-msg class="text-sm text-red-700 mt-2"></div>
      <div class="mt-4 flex justify-end gap-2"><button data-cancel class="px-4 py-2 rounded-md border border-slate-300 text-sm">Cancel</button>${actions}</div></div>`
    document.body.appendChild(m)
    m.querySelector('[data-cancel]').onclick = () => m.remove()
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') m.remove() })
    return m
  }
  const busy = (b, on, label) => { b.disabled = on; if (label) b.innerHTML = on ? '<i class="fas fa-spinner fa-spin mr-1"></i>Working…' : label }

  // ───────── Case panel ─────────
  async function mountCasePanel(caseId, k) {
    const el = document.getElementById('shopify-panel'); if (!el) return
    if (k.channel !== 'shopify') { el.innerHTML = ''; el.classList.add('hidden'); return }
    el.classList.remove('hidden')
    el.innerHTML = `<div class="bg-white rounded-xl shadow-sm p-5"><h2 class="font-semibold mb-2"><i class="fab fa-shopify mr-2 text-emerald-600"></i>Saisales order</h2><p class="text-sm text-slate-500"><i class="fas fa-spinner fa-spin mr-1"></i>Checking Shopify…</p></div>`
    let d
    try { ;({ data: d } = await axios.get(`/api/shopify/cases/${caseId}`, { timeout: 30000 })) } catch (e) {
      const x = e.response?.data || {}
      el.innerHTML = `<div class="bg-white rounded-xl shadow-sm p-5"><h2 class="font-semibold mb-2"><i class="fab fa-shopify mr-2 text-emerald-600"></i>Saisales order</h2><p class="text-sm ${x.configured === false ? 'text-slate-500' : 'text-red-700'}">${esc(x.error || e.message)}</p>${x.configured === false && isManager ? '<a href="/settings" data-link class="text-xs underline">Settings → Shopify</a>' : ''}</div>`
      return
    }
    const st = await getStatus()
    const linkBox = `<div class="mt-3 flex gap-2"><input id="sp-link-name" class="field-input font-mono text-xs mt-0" placeholder="#1094" style="max-width:8rem"><button id="sp-link" class="text-xs px-2 py-1 rounded border border-slate-300">Link order</button></div>`
    const others = (d.other_orders || []).length ? `<div class="mt-2 text-xs text-slate-500">Other orders from this email: ${d.other_orders.map((x) => `<button data-link-order="${esc(x.name)}" class="font-mono underline">${esc(x.name)}</button> (${fmtDate(x.placed)}, ${money(x.total)})`).join(', ')}</div>` : ''
    if (!d.order) {
      el.innerHTML = `<div class="bg-white rounded-xl shadow-sm p-5"><h2 class="font-semibold mb-2"><i class="fab fa-shopify mr-2 text-emerald-600"></i>Saisales order</h2>
        <p class="text-sm text-slate-500">No Shopify order found for this customer. If they gave an order number, link it here. The AI will ask the customer for it otherwise.</p>${linkBox}${others}</div>`
      wireLink(caseId, el); return
    }
    const o = d.order, f = o.facts
    const ship = f.shipments.map((s) => `<div>${s.carrier ? esc(s.carrier) + ' ' : ''}<span class="font-mono">${esc(s.tracking || '—')}</span> ${s.status ? pill(nice(s.status), STATUS_CLS(s.status)) : ''}<span class="text-slate-400"> · sent ${fmtDate(s.sent)}${s.delivered ? ` · delivered ${fmtDate(s.delivered)}` : s.estimated ? ` · due ${fmtDate(s.estimated)}` : ''}</span></div>`).join('') || '—'
    const returns = o.returns.map((r) => `<div class="border border-slate-200 rounded-lg p-2 mb-2 text-xs" data-return="${esc(r.id)}">
        <div class="flex items-center justify-between gap-2"><strong>${esc(r.name)}</strong>${pill(nice(r.status), STATUS_CLS(r.status))}</div>
        <div class="text-slate-600 mt-1">${r.items.map((i) => `${esc(i.title)} ×${i.quantity}`).join(', ')} · opened ${fmtDate(r.created)}${r.closed ? ` · closed ${fmtDate(r.closed)}` : ''}</div>
        <div class="text-slate-600">${r.label ? `<i class="fas fa-tag mr-1"></i>Label added${r.label.tracking?.number ? ` · <span class="font-mono">${esc(r.label.tracking.number)}</span>` : ''}${r.label.label?.publicFileUrl ? ` · <a href="${esc(r.label.label.publicFileUrl)}" target="_blank" rel="noopener" class="underline">open</a>` : ''}` : '<span class="text-amber-700"><i class="fas fa-tag mr-1"></i>No label yet</span>'}</div>
        ${r.status === 'OPEN' ? `<div class="mt-2 flex flex-wrap gap-1">${r.label ? '' : '<button data-ract="label" class="px-2 py-1 rounded bg-slate-900 text-white">Add return label</button>'}<button data-ract="process" class="px-2 py-1 rounded border border-slate-300">Phone received</button>${r.label ? '' : '<button data-ract="cancel" class="px-2 py-1 rounded border border-slate-300 text-slate-500">Cancel return</button>'}</div>` : ''}
      </div>`).join('')
    const actions = (d.actions || []).slice(0, 6).map((a) => `<li class="${a.status === 'failed' ? 'text-red-700' : ''}">${fmtDateTime(a.created_at)} · ${esc(a.by || '—')} · ${esc(nice(a.kind))}${a.amount != null ? ' ' + money(a.amount) : ''}${a.status === 'failed' ? ` — failed: ${esc(a.error || '')}` : ''}</li>`).join('')
    el.innerHTML = `<div class="bg-white rounded-xl shadow-sm p-5">
      <div class="flex items-center justify-between mb-2"><h2 class="font-semibold"><i class="fab fa-shopify mr-2 text-emerald-600"></i>Saisales order <span class="font-mono">${esc(f.order)}</span></h2>
        <span class="flex gap-1"><a href="/invoices/new?case=${caseId}" data-link class="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50"><i class="fas fa-file-invoice mr-1"></i>Invoice</a><a href="${esc(o.admin_url)}" target="_blank" rel="noopener" class="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50">Shopify <i class="fas fa-up-right-from-square"></i></a></span></div>
      <dl class="grid grid-cols-3 gap-y-1 text-xs">
        <dt class="text-slate-500">Placed</dt><dd class="col-span-2">${fmtDate(f.placed)} <span class="text-slate-400">· ${esc(f.channel)}</span></dd>
        <dt class="text-slate-500">Status</dt><dd class="col-span-2 flex flex-wrap gap-1">${pill(nice(f.status.payment), STATUS_CLS(f.status.payment))}${pill(nice(f.status.fulfilment), STATUS_CLS(f.status.fulfilment))}${f.status.returns !== 'NO_RETURN' ? pill(nice(f.status.returns), STATUS_CLS(f.status.returns)) : ''}${f.status.cancelled ? pill('Cancelled', 'bg-red-100 text-red-800') : ''}</dd>
        <dt class="text-slate-500">Total</dt><dd class="col-span-2">${money(f.total)}${Number(f.refunded) > 0 ? ` · <span class="text-amber-700">refunded ${money(f.refunded)}</span>` : ''} <span class="text-slate-400">· ${esc(f.paid_via.join(', ') || '—')}</span></dd>
        <dt class="text-slate-500">Items</dt><dd class="col-span-2">${f.items.map((i) => `${esc(i.title)}${i.variant ? ` <span class="text-slate-400">(${esc(i.variant)})</span>` : ''}${i.qty > 1 ? ` ×${i.qty}` : ''} · ${money(i.unit_price)}`).join('<br>')}</dd>
        <dt class="text-slate-500">Shipped</dt><dd class="col-span-2">${ship}</dd>
        <dt class="text-slate-500">Deliver to</dt><dd class="col-span-2">${esc(o.shipping_address.join(', ') || '—')}</dd>
      </dl>
      ${f.refunds.length ? `<div class="mt-2 text-xs"><span class="text-slate-500">Refunds:</span> ${f.refunds.map((r) => `${money(r.amount)} on ${fmtDate(r.date)}`).join('; ')}</div>` : ''}
      ${o.manual_payment ? '<div class="mt-2 text-[11px] text-amber-800 bg-amber-50 rounded px-2 py-1"><i class="fas fa-triangle-exclamation mr-1"></i>Paid through another channel or manually: a refund here is recorded on Shopify but moves no money. Pay the customer back where they paid.</div>' : ''}
      <div class="mt-3 flex flex-wrap gap-2 text-xs">
        <button id="sp-refund" class="px-3 py-1.5 rounded-md bg-amber-600 text-white disabled:opacity-40" ${o.max_refundable > 0 ? '' : 'disabled'}><i class="fas fa-money-bill-transfer mr-1"></i>Refund${o.max_refundable != null ? ` <span class="opacity-80">(up to ${money(o.max_refundable)})</span>` : ''}</button>
        <button id="sp-return" class="px-3 py-1.5 rounded-md border border-slate-300 disabled:opacity-40" ${o.returnable.length ? '' : 'disabled'}><i class="fas fa-rotate-left mr-1"></i>Open a return</button>
      </div>
      ${returns ? `<h3 class="font-semibold text-sm mt-4 mb-2">Returns</h3>${returns}` : ''}
      ${actions ? `<h3 class="font-semibold text-xs mt-3 mb-1 text-slate-500">Done from ReplyIQ</h3><ul class="text-[11px] text-slate-600 space-y-0.5">${actions}</ul>` : ''}
      <details class="mt-3 text-xs text-slate-500"><summary class="cursor-pointer">Wrong order?</summary>${linkBox}${others}</details>
      <div class="mt-2 text-[10px] text-slate-400">${d.matched_by === 'linked' ? 'Linked to this case. ' : d.matched_by ? `Matched by ${esc(d.matched_by)}. ` : ''}The AI sees the order details above without the name, email or address.</div>
    </div>`
    wireLink(caseId, el)
    el.querySelector('#sp-refund').onclick = () => refundDialog(caseId, k, o, st)
    el.querySelector('#sp-return').onclick = () => returnDialog(caseId, o)
    el.querySelectorAll('[data-return] [data-ract]').forEach((b) => {
      const r = o.returns.find((x) => x.id === b.closest('[data-return]').dataset.return)
      b.onclick = () => (b.dataset.ract === 'label' ? labelDialog(caseId, o, r) : simpleReturnAction(caseId, o, r, b.dataset.ract))
    })
  }
  const reload = (caseId) => h.renderCase(caseId)

  function wireLink(caseId, el) {
    const go = async (name) => { try { await axios.post(`/api/shopify/cases/${caseId}/link`, { order_name: name }); toast(`Order ${name} linked`); reload(caseId) } catch (e) { err(e) } }
    const b = el.querySelector('#sp-link'); if (b) b.onclick = () => { const v = el.querySelector('#sp-link-name').value.trim(); if (v) go(v) }
    el.querySelectorAll('[data-link-order]').forEach((x) => (x.onclick = () => go(x.dataset.linkOrder)))
  }

  function refundDialog(caseId, k, o, st) {
    const limit = st?.agent_refund_limit ?? 15
    const key = newKey()
    const m = dialog('<i class="fas fa-money-bill-transfer mr-2 text-amber-600"></i>Refund on ' + esc(o.facts.order), `
      <div class="space-y-3 text-sm">
        <label class="block">Amount (£)<input data-f="amount" type="number" step="0.01" min="0.01" max="${o.max_refundable ?? ''}" class="field-input" placeholder="0.00"></label>
        <div class="flex gap-1 text-xs">${[5, 10, 15].map((v) => `<button data-q="${v}" class="px-2 py-1 rounded border border-slate-300">£${v}</button>`).join('')}${o.max_refundable ? `<button data-q="${o.max_refundable}" class="px-2 py-1 rounded border border-slate-300">Full ${money(o.max_refundable)}</button>` : ''}</div>
        <label class="block">Reason (saved on the Shopify refund)<input data-f="reason" class="field-input" placeholder="e.g. goodwill for cosmetic mark, return received and checked"></label>
        <label class="flex items-start gap-2 text-xs"><input type="checkbox" data-f="notify" class="mt-0.5"> <span>Let Shopify email the customer a refund confirmation. Leave unticked if you will tell them in your reply.</span></label>
        <p class="text-xs text-slate-500">${isManager ? 'Managers can refund any amount up to what was paid.' : `You can refund up to £${limit}. Above that, ask a manager.`} The money goes back to the original payment method (${esc(o.facts.paid_via.join(', ') || 'unknown')}).</p>
      </div>`, '<button data-next class="px-4 py-2 rounded-md bg-slate-900 text-white text-sm">Review</button>')
    const v = (n) => m.querySelector(`[data-f="${n}"]`)
    m.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => { v('amount').value = Number(b.dataset.q).toFixed(2) }))
    m.querySelector('[data-next]').onclick = () => {
      const amount = Math.round(Number(v('amount').value) * 100) / 100, reason = v('reason').value.trim(), notify = v('notify').checked
      const msg = m.querySelector('[data-msg]')
      if (!(amount > 0)) return (msg.textContent = 'Enter an amount')
      if (o.max_refundable != null && amount > o.max_refundable) return (msg.textContent = `The most that can be refunded is ${money(o.max_refundable)}`)
      if (!isManager && amount > limit) return (msg.textContent = `Refunds above £${limit} need a manager`)
      if (reason.length < 3) return (msg.textContent = 'Give a short reason')
      m.remove()
      const c2 = dialog('Confirm refund', `<p class="text-sm">Refund <strong>${money(amount)}</strong> to ${esc(k.customer_first_name || 'the customer')} on order <strong class="font-mono">${esc(o.facts.order)}</strong>, back to ${esc(o.facts.paid_via.join(', ') || 'the original payment')}?</p>
        <p class="text-xs text-slate-500 mt-2">Reason: ${esc(reason)}<br>${notify ? 'Shopify will email the customer a refund confirmation.' : 'Shopify will not email the customer.'}<br>This cannot be undone from ReplyIQ.</p>`,
        `<button data-go class="px-4 py-2 rounded-md bg-amber-600 text-white text-sm">Refund ${money(amount)}</button>`)
      const go = c2.querySelector('[data-go]')
      go.onclick = async () => {
        busy(go, true)
        try { const { data } = await axios.post(`/api/shopify/cases/${caseId}/refund`, { amount, confirm_amount: amount, reason, notify, key }, { timeout: 45000 }); c2.remove(); toast(`Refunded ${money(data.amount)} on ${o.facts.order}`); reload(caseId) }
        catch (e) { busy(go, false, `Refund ${money(amount)}`); c2.querySelector('[data-msg]').textContent = e.response?.data?.error || e.message }
      }
    }
  }

  function returnDialog(caseId, o) {
    const m = dialog('<i class="fas fa-rotate-left mr-2 text-slate-400"></i>Open a return on ' + esc(o.facts.order), `
      <div class="space-y-2 text-sm">${o.returnable.map((l, i) => `<label class="flex items-center gap-2"><input type="checkbox" data-line="${i}" ${o.returnable.length === 1 ? 'checked' : ''}> ${esc(l.title)}${l.quantity > 1 ? ` <input type="number" data-qty="${i}" min="1" max="${l.quantity}" value="${l.quantity}" class="field-input mt-0 w-16 text-xs">` : ''}</label>`).join('')}
        <label class="block">Reason<input data-f="note" class="field-input" placeholder="e.g. change of mind within 30 days, reported fault"></label>
        <p class="text-xs text-slate-500">This opens the return on Shopify only. Nothing is sent to the customer. Next, add the return label.</p></div>`,
      '<button data-go class="px-4 py-2 rounded-md bg-slate-900 text-white text-sm">Open return</button>')
    const go = m.querySelector('[data-go]')
    go.onclick = async () => {
      const lines = o.returnable.map((l, i) => ({ l, i })).filter(({ i }) => m.querySelector(`[data-line="${i}"]`).checked)
        .map(({ l, i }) => ({ fulfillment_line_item_id: l.fulfillmentLineItemId, quantity: Number(m.querySelector(`[data-qty="${i}"]`)?.value || l.quantity) }))
      if (!lines.length) return (m.querySelector('[data-msg]').textContent = 'Tick the item(s) coming back')
      busy(go, true)
      try { const { data } = await axios.post(`/api/shopify/cases/${caseId}/returns`, { lines, note: m.querySelector('[data-f="note"]').value }, { timeout: 45000 }); m.remove(); toast(`Return ${data.return.name} opened`); reload(caseId) }
      catch (e) { busy(go, false, 'Open return'); m.querySelector('[data-msg]').textContent = e.response?.data?.error || e.message }
    }
  }

  function labelDialog(caseId, o, r) {
    const m = dialog('<i class="fas fa-tag mr-2 text-slate-400"></i>Return label for ' + esc(r.name), `
      <div class="space-y-3 text-sm">
        <label class="block">Label PDF (Royal Mail Tracked Returns)<input data-f="file" type="file" accept="application/pdf,.pdf" class="field-input"></label>
        <label class="block">Return tracking number<input data-f="tracking" class="field-input font-mono" placeholder="e.g. RT123456789GB"></label>
        <label class="flex items-start gap-2 text-xs"><input type="checkbox" data-f="notify" class="mt-0.5"> <span>Let Shopify email the label to the customer now (with return instructions). Leave unticked to send it yourself in a reply.</span></label>
      </div>`, '<button data-go class="px-4 py-2 rounded-md bg-slate-900 text-white text-sm">Add label</button>')
    const go = m.querySelector('[data-go]')
    go.onclick = async () => {
      const msg = m.querySelector('[data-msg]')
      const file = m.querySelector('[data-f="file"]').files[0]
      if (!file) return (msg.textContent = 'Choose the label PDF')
      if (file.size > 5 * 1024 * 1024) return (msg.textContent = 'The PDF is over 5 MB')
      const notify = m.querySelector('[data-f="notify"]').checked
      if (notify && !go.dataset.ok) { go.dataset.ok = '1'; go.textContent = 'Add label and email the customer'; msg.className = 'text-sm text-amber-800 mt-2'; msg.textContent = 'Shopify will email this label to the customer. Press again to confirm.'; return }
      busy(go, true)
      try {
        const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(file) })
        await axios.post(`/api/shopify/cases/${caseId}/returns/label`, { return_id: r.id, pdf_base64: b64, filename: file.name, tracking_number: m.querySelector('[data-f="tracking"]').value, notify_customer: notify }, { timeout: 60000 })
        m.remove(); toast('Return label added'); reload(caseId)
      } catch (e) { busy(go, false, 'Add label'); msg.className = 'text-sm text-red-700 mt-2'; msg.textContent = e.response?.data?.error || e.message }
    }
  }

  function simpleReturnAction(caseId, o, r, act) {
    const title = act === 'process' ? `Phone received for ${esc(r.name)}?` : `Cancel ${esc(r.name)}?`
    const body = act === 'process'
      ? `<p class="text-sm">Marks the returned item(s) as received on Shopify and closes the return. The refund is a separate step: use <strong>Refund</strong> once the inspection outcome is agreed.</p><label class="block text-sm mt-3">Note<input data-f="note" class="field-input" placeholder="e.g. received, IMEI matches, no new damage"></label>`
      : '<p class="text-sm">Cancels the return on Shopify (only possible before a label or any processing). Nothing is sent to the customer.</p>'
    const m = dialog(title, body, `<button data-go class="px-4 py-2 rounded-md bg-slate-900 text-white text-sm">${act === 'process' ? 'Mark received' : 'Cancel return'}</button>`)
    const go = m.querySelector('[data-go]')
    go.onclick = async () => {
      busy(go, true)
      try { await axios.post(`/api/shopify/cases/${caseId}/returns/${act}`, { return_id: r.id, note: m.querySelector('[data-f="note"]')?.value || '' }, { timeout: 45000 }); m.remove(); toast(act === 'process' ? 'Return marked as received' : 'Return cancelled'); reload(caseId) }
      catch (e) { busy(go, false, act === 'process' ? 'Mark received' : 'Cancel return'); m.querySelector('[data-msg]').textContent = e.response?.data?.error || e.message }
    }
  }

  // ───────── Settings card ─────────
  async function settingsCard(el) {
    if (!el) return
    status = null
    const s = await getStatus()
    const row = (k, v) => `<div class="flex justify-between gap-3 py-1 border-b border-slate-100"><span class="text-slate-500">${k}</span><span class="text-right">${v}</span></div>`
    const boxes = (s.mailboxes || []).filter((m) => m.saisales_mail)
    el.innerHTML = `<h2 class="font-semibold mb-3"><i class="fab fa-shopify mr-2 text-emerald-600"></i>Shopify (Saisales.co.uk)</h2>
      <div class="text-sm">
        ${row('Store', s.configured ? `<span class="text-emerald-700"><i class="fas fa-circle-check mr-1"></i>${esc(s.shop || '')}</span>` : '<span class="text-amber-700"><i class="fas fa-circle-exclamation mr-1"></i>Not connected</span>')}
        ${row('Database', s.migration_applied ? '<span class="text-emerald-700">0029 applied</span>' : '<span class="text-amber-700">Run db/migrations/0029_shopify.sql</span>')}
        ${row('Mailboxes reading Saisales mail', boxes.length ? boxes.map((m) => esc(m.email)).join(', ') : '<span class="text-amber-700">none — switch it on under <a href="/gmail" data-link class="underline">Gmail</a></span>')}
        ${row('Saisales cases', s.cases ? `${s.cases.open} open · ${s.cases.cases} in all` : '—')}
      </div>
      ${isManager ? `<div class="grid sm:grid-cols-2 gap-3 mt-3 text-sm">
        <label class="sm:col-span-2">Saisales addresses customers write to<input id="ss-addresses" class="field-input" value="${esc((s.settings?.addresses || []).join(', '))}"></label>
        <label>Replies are sent from<input id="ss-from" class="field-input" value="${esc(s.settings?.from_address || '')}"></label>
        <label>Sender name<input id="ss-name" class="field-input" value="${esc(s.settings?.from_name || '')}"></label>
      </div>
      <p class="text-xs text-slate-500 mt-1">The "sent from" address must be a verified "Send mail as" address of the mailbox that reads Saisales mail (Gmail → Settings → Accounts).</p>
      <div class="mt-3 flex flex-wrap items-center gap-2"><button id="ss-save" class="text-sm px-3 py-1.5 rounded-md bg-slate-900 text-white">Save</button><button id="sp-test" class="text-sm px-3 py-1.5 rounded-md border border-slate-300" ${s.configured ? '' : 'disabled'}>Test connection</button><span id="sp-test-result" class="text-xs"></span></div>
      ${s.configured ? '' : `<details class="mt-3 text-xs text-slate-600"><summary class="cursor-pointer font-medium">How to connect</summary><ol class="list-decimal pl-5 mt-2 space-y-1">
        <li>In the Shopify Dev Dashboard (dev.shopify.com), create an app in the same organisation as the Saisales store.</li>
        <li>Give its version these Admin API access scopes: <code>${esc((s.scopes || []).join(', '))}</code>. Release the version and install the app on the Saisales store.</li>
        <li>From the app's Settings, copy the Client ID and Client secret. Add them as Worker secrets <code>SHOPIFY_CLIENT_ID</code> and <code>SHOPIFY_CLIENT_SECRET</code>, plus <code>SHOPIFY_SHOP</code> = the store's myshopify name (e.g. <code>a6fdb4</code>). Do not paste them anywhere else.</li>
        <li>Come back here and press Test connection.</li></ol></details>`}` : ''}`
    el.querySelector('#ss-save')?.addEventListener('click', async () => {
      try {
        await axios.patch('/api/shopify/settings', { addresses: el.querySelector('#ss-addresses').value.split(/[,\s]+/).filter(Boolean), from_address: el.querySelector('#ss-from').value, from_name: el.querySelector('#ss-name').value })
        toast('Saisales settings saved'); settingsCard(el)
      } catch (e) { err(e) }
    })
    el.querySelector('#sp-test')?.addEventListener('click', async (e) => {
      const out = el.querySelector('#sp-test-result'); e.target.disabled = true; out.textContent = 'testing…'
      try { const { data } = await axios.post('/api/shopify/test'); out.innerHTML = data.ok ? `<span class="text-emerald-700">✓ ${esc(data.detail)}</span>` : `<span class="text-red-700">✗ ${esc(data.detail)}</span>` } catch (x) { out.innerHTML = `<span class="text-red-700">${esc(x.response?.data?.error || x.message)}</span>` }
      e.target.disabled = false
    })
  }

  return { mountCasePanel, settingsCard }
}
