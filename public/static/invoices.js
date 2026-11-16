/* ReplyIQ — Invoice generator (moved in from the stand-alone Amazon Invoice Dashboard).
   Loaded before app.js; app.js calls window.RiqInvoices(helpers) once.
   Invoice numbers are the Zoho Inventory numbers, typed in by staff. The PDF is drawn here in the browser (jsPDF).
   Nothing on these screens is sent to OpenAI. */
window.RiqInvoices = function (h) {
  const { app, esc, toast, fmtDateTime, navigate, isManager } = h
  const err = (e) => toast(e.response?.data?.error || e.message, 'err')
  const SYM = { GBP: '£', USD: '$', EUR: '€' }
  const money = (cur, v) => (SYM[cur] || '') + Number(v || 0).toFixed(2)
  const today = () => dayjs().format('DD MMM YYYY')
  const isoDay = (v) => (v ? dayjs(v).format('ddd, D MMM YYYY') : '')
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

  // jsPDF is only needed here, so load it the first time an invoice is drawn.
  let pdfLibs = null
  function loadPdfLibs() {
    if (window.jspdf?.jsPDF?.API?.autoTable) return Promise.resolve()
    const add = (src) => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('Could not load the PDF library')); document.head.appendChild(s) })
    pdfLibs = pdfLibs || add('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js').then(() => add('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'))
    return pdfLibs
  }

  // Saved invoice row → the shape invoice-pdf.js draws. Uses the settings saved with the invoice, so a re-download is identical.
  async function drawPdf(inv) {
    await loadPdfLibs()
    const items = (inv.items || []).map((it) => ({ ...it, itemTotal: Number(it.total ?? it.itemTotal ?? 0), unitPrice: Number(it.unitPrice || 0) }))
    const itemsTotal = round2(items.reduce((n, it) => n + it.itemTotal, 0))
    const data = {
      invoiceNumber: inv.invoice_number, invoiceDate: inv.invoice_date, orderId: inv.order_id, sellerOrderId: inv.seller_order_id,
      purchaseDate: inv.purchase_date, shipDate: inv.ship_date, salesChannel: inv.sales_channel, buyerName: inv.buyer_name,
      buyerAddressLines: String(inv.buyer_address || '').split('\n').map((l) => l.trim()).filter(Boolean),
      currencySymbol: SYM[inv.currency] || '', items, itemsTotal, shippingCharge: Number(inv.shipping || 0), grandTotal: Number(inv.total || 0),
      notes: inv.notes, marginSchemeEnabled: inv.margin_scheme_enabled, termsAndConditions: inv.settings_snapshot?.terms_and_conditions,
    }
    return buildInvoicePdf(data, inv.settings_snapshot || {})
  }
  const fileName = (inv) => `${inv.invoice_number.replace(/[^\w.-]+/g, '_')}${inv.order_id ? '_' + inv.order_id : ''}.pdf`
  async function download(inv) { (await drawPdf(inv)).save(fileName(inv)) }
  async function asAttachment(inv) {
    const doc = await drawPdf(inv)
    const dataUri = doc.output('datauristring')
    const base64 = dataUri.slice(dataUri.indexOf(',') + 1)
    return { filename: fileName(inv), mime_type: 'application/pdf', base64, size: Math.floor(base64.length * 3 / 4) }
  }

  const TABS = [['new', 'Generate', '/invoices/new'], ['history', 'History', '/invoices'], ['settings', 'Settings', '/invoices/settings']]
  const header = (active) => `
    <div class="flex flex-wrap items-end justify-between gap-3 mb-2">
      <div><h1 class="text-2xl font-bold"><i class="fas fa-file-invoice mr-2 text-slate-400"></i>Invoices</h1>
      <p class="text-sm text-slate-500">Amazon order invoices for upload in Seller Central or to attach to a reply. Use the invoice number from Zoho Inventory.</p></div>
    </div>
    <nav class="flex gap-1 mb-4 border-b border-slate-200">${TABS.map(([k, l, href]) => `<a href="${href}" data-link class="px-3 py-2 text-sm -mb-px border-b-2 ${active === k ? 'border-slate-900 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'}">${l}</a>`).join('')}</nav>`
  const notReady = (e) => e.response?.status === 503 && e.response?.data?.migration
    ? `<div class="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"><i class="fas fa-database mr-1"></i>${esc(e.response.data.error)}</div>` : null

  // ───────── History ─────────
  let q = ''
  async function renderHistory() {
    app.innerHTML = header('history') + '<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</p>'
    let rows
    try { ;({ data: { invoices: rows } } = await axios.get('/api/invoices', { params: { q } })) } catch (e) { app.innerHTML = header('history') + (notReady(e) || ''); if (!notReady(e)) h.renderError(e); return }
    app.innerHTML = header('history') + `
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <input id="inv-q" class="field-input mt-0 text-sm" style="max-width:20rem" placeholder="Invoice number, order ID or buyer" value="${esc(q)}">
        <a href="/invoices/new" data-link class="ml-auto px-3 py-1.5 rounded-md text-sm font-medium bg-slate-900 text-white hover:bg-slate-700"><i class="fas fa-plus mr-1"></i>New invoice</a>
      </div>
      <div class="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table class="w-full text-sm min-w-[720px]">
          <thead class="text-left text-xs uppercase text-slate-500 border-b"><tr><th class="p-3">Invoice</th><th class="p-3">Order</th><th class="p-3">Buyer</th><th class="p-3">Invoice date</th><th class="p-3 text-right">Total</th><th class="p-3">Made by</th><th class="p-3"></th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr class="border-b last:border-0">
              <td class="p-3 font-mono font-semibold">${esc(r.invoice_number)}</td>
              <td class="p-3 font-mono text-xs">${esc(r.order_id || '—')}${r.case_id ? `<div><a href="/cases/${r.case_id}" data-link class="text-sky-700 hover:underline">${esc(r.case_ref || 'case')}</a></div>` : ''}</td>
              <td class="p-3">${esc(r.buyer_name || '—')}</td>
              <td class="p-3">${esc(r.invoice_date || '')}</td>
              <td class="p-3 text-right tabular-nums">${money(r.currency, r.total)}</td>
              <td class="p-3 text-xs text-slate-500">${esc(r.created_by_name || '—')}<div>${fmtDateTime(r.created_at)}</div></td>
              <td class="p-3 text-right whitespace-nowrap">
                <button data-dl="${r.id}" class="px-2 py-1 rounded border border-slate-300 text-xs hover:bg-slate-50"><i class="fas fa-download mr-1"></i>PDF</button>
                ${isManager ? `<button data-del="${r.id}" data-num="${esc(r.invoice_number)}" class="ml-1 px-2 py-1 text-xs text-slate-400 hover:text-red-700" title="Delete this record">Delete</button>` : ''}
              </td>
            </tr>`).join('') : `<tr><td colspan="7" class="p-6 text-center text-slate-500">${q ? 'No invoices match.' : 'No invoices yet.'}</td></tr>`}</tbody>
        </table>
      </div>`
    const qi = document.getElementById('inv-q'); let t
    qi.oninput = () => { clearTimeout(t); t = setTimeout(() => { q = qi.value.trim(); renderHistory().then(() => { const n = document.getElementById('inv-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length) }) }, 350) }
    app.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = async () => {
      try { const { data } = await axios.get(`/api/invoices/${b.dataset.dl}`); await download(data.invoice) } catch (e) { err(e) }
    }))
    app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => {
      if (b.dataset.armed) return axios.delete(`/api/invoices/${b.dataset.del}`).then(() => { toast('Deleted'); renderHistory() }).catch(err)
      b.dataset.armed = '1'; b.textContent = `Delete ${b.dataset.num}?`; b.className = 'ml-1 px-2 py-1 text-xs rounded bg-red-600 text-white'
      setTimeout(() => { if (document.body.contains(b)) { delete b.dataset.armed; b.textContent = 'Delete'; b.className = 'ml-1 px-2 py-1 text-xs text-slate-400 hover:text-red-700' } }, 4000)
    }))
  }

  // ───────── Generate ─────────
  const blankItem = () => ({ name: '', asin: '', sku: '', condition: 'Renewed', imei: '', quantity: 1, unitPrice: 0 })
  let form = null // current form state (kept while the page is open)

  async function renderNew() {
    const caseId = Number(new URLSearchParams(location.search).get('case')) || null
    app.innerHTML = header('new') + '<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</p>'
    let settings, pre = null
    try {
      ;({ data: { settings } } = await axios.get('/api/invoices/settings'))
      if (caseId) ({ data: pre } = await axios.get('/api/invoices/prefill', { params: { case_id: caseId } }))
    } catch (e) { app.innerHTML = header('new') + (notReady(e) || ''); if (!notReady(e)) h.renderError(e); return }
    if (!form || form.case_id !== caseId) {
      form = { case_id: caseId, case_ref: pre?.case?.case_ref || '', invoice_number: '', invoice_date: today(), order_id: pre?.order_id || '', seller_order_id: '',
        purchase_date: isoDay(pre?.order?.orderDate), ship_date: isoDay(pre?.order?.shipDate), sales_channel: 'Amazon.co.uk',
        buyer_name: pre?.buyer_name || '', buyer_address: pre?.buyer_address || '', currency: pre?.order?.currency || 'GBP', shipping: 0, notes: '',
        margin_scheme_enabled: settings.margin_scheme_enabled, raw_paste: '',
        items: (pre?.order?.items || []).map((it) => ({ name: it.title || '', asin: it.asin || '', sku: it.sku || '', condition: 'Renewed', imei: '', quantity: it.quantity || 1, unitPrice: Number(it.unitPrice || 0) })) }
      if (!form.items.length) form.items.push(blankItem())
      if (pre?.order?.grandTotal != null) { const items = form.items.reduce((n, it) => n + it.quantity * it.unitPrice, 0); form.shipping = Math.max(0, round2(Number(pre.order.grandTotal) - items)) }
      form.existing = pre?.existing || []
    }
    draw()
  }

  function totals() {
    const items = form.items.reduce((n, it) => n + round2((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0)), 0)
    return { items: round2(items), total: round2(items + (Number(form.shipping) || 0)) }
  }

  function draw() {
    const f = form, t = totals()
    const inp = (k, label, extra = '') => `<label class="block"><span class="field-label">${label}</span><input data-f="${k}" class="field-input" value="${esc(f[k] ?? '')}" ${extra}></label>`
    app.innerHTML = header('new') + `
      <section id="invoice-form" class="grid lg:grid-cols-3 gap-4">
        <div class="lg:col-span-2 space-y-4">
          ${f.case_id ? `<div class="text-sm rounded-md bg-sky-50 border border-sky-200 px-3 py-2"><i class="fas fa-link mr-1 text-sky-700"></i>From case <a href="/cases/${f.case_id}" data-link class="font-semibold underline">${esc(f.case_ref)}</a>. Order details and the customer were filled in from ReplyIQ; check them before saving.</div>` : ''}
          ${f.existing?.length ? `<div class="text-sm rounded-md bg-amber-50 border border-amber-300 px-3 py-2 text-amber-900"><i class="fas fa-triangle-exclamation mr-1"></i>This order already has ${f.existing.map((x) => `<button data-redl="${x.id}" class="font-mono font-semibold underline">${esc(x.invoice_number)}</button>`).join(', ')}. Download that instead unless you need a new one.</div>` : ''}
          <details class="bg-white rounded-xl shadow-sm p-4" ${f.case_id ? '' : 'open'}>
            <summary class="cursor-pointer font-semibold text-sm"><i class="far fa-clipboard mr-1 text-slate-400"></i>Paste the Seller Central "Order details" page${f.case_id ? ' (for the address, or anything missing)' : ''}</summary>
            <textarea id="inv-paste" class="field-input text-xs font-mono mt-2" rows="5" placeholder="Open the order in Seller Central, select all (Ctrl+A), copy, paste here">${esc(f.raw_paste)}</textarea>
            <button id="inv-parse" class="mt-2 px-3 py-1.5 rounded-md text-sm font-medium bg-slate-800 text-white hover:bg-slate-700"><i class="fas fa-wand-magic-sparkles mr-1"></i>Fill from paste</button>
            <span id="inv-parse-msg" class="ml-2 text-xs text-slate-500"></span>
          </details>
          <div class="bg-white rounded-xl shadow-sm p-4 grid sm:grid-cols-3 gap-3">
            ${inp('invoice_number', 'Invoice number (from Zoho) *', 'placeholder="e.g. INV-001234" class="font-mono"')}
            ${inp('invoice_date', 'Invoice date')}
            ${inp('order_id', 'Amazon order ID', 'placeholder="204-1234567-1234567"')}
            ${inp('purchase_date', 'Order date')}
            ${inp('ship_date', 'Ship date')}
            ${inp('sales_channel', 'Sales channel')}
            ${inp('seller_order_id', 'Seller order ID')}
            <label class="block"><span class="field-label">Currency</span><select data-f="currency" class="field-input">${['GBP', 'EUR', 'USD'].map((c) => `<option ${f.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          </div>
          <div class="bg-white rounded-xl shadow-sm p-4 grid sm:grid-cols-2 gap-3">
            ${inp('buyer_name', 'Bill to: name')}
            <label class="block sm:row-span-2"><span class="field-label">Address (one line each)</span><textarea data-f="buyer_address" class="field-input" rows="4">${esc(f.buyer_address)}</textarea></label>
          </div>
          <div class="bg-white rounded-xl shadow-sm p-4">
            <div class="flex items-center justify-between mb-2"><h2 class="font-semibold text-sm">Items</h2><button id="inv-add-item" class="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50"><i class="fas fa-plus mr-1"></i>Add item</button></div>
            <div class="overflow-x-auto"><table class="w-full text-sm" style="min-width:860px;table-layout:fixed">
              <thead class="text-left text-[11px] uppercase text-slate-500"><tr><th class="py-1 pr-2" style="width:30%">Product</th><th class="pr-2" style="width:11%">ASIN</th><th class="pr-2" style="width:13%">SKU</th><th class="pr-2" style="width:9%">Condition</th><th class="pr-2" style="width:14%">IMEI</th><th class="pr-2" style="width:5rem">Qty</th><th class="pr-2" style="width:6.5rem">Unit price</th><th class="text-right" style="width:5rem">Total</th><th style="width:1.5rem"></th></tr></thead>
              <tbody>${f.items.map((it, i) => `<tr class="align-top">
                <td class="py-1 pr-2"><textarea data-i="${i}" data-k="name" class="field-input mt-0 text-xs" rows="2">${esc(it.name)}</textarea></td>
                ${['asin', 'sku', 'condition', 'imei'].map((k) => `<td class="py-1 pr-2"><input data-i="${i}" data-k="${k}" class="field-input mt-0 text-xs ${k === 'imei' || k === 'asin' ? 'font-mono' : ''}" value="${esc(it[k] || '')}"></td>`).join('')}
                <td class="py-1 pr-2"><input data-i="${i}" data-k="quantity" type="number" min="0" class="field-input mt-0 text-xs" value="${esc(it.quantity)}"></td>
                <td class="py-1 pr-2"><input data-i="${i}" data-k="unitPrice" type="number" step="0.01" min="0" class="field-input mt-0 text-xs" value="${esc(it.unitPrice)}"></td>
                <td class="py-1 text-right tabular-nums text-xs pt-3" data-line="${i}">${money(f.currency, (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0))}</td>
                <td class="py-1 pl-1"><button data-rm="${i}" class="text-slate-400 hover:text-red-700 pt-2" title="Remove item">&times;</button></td></tr>`).join('')}</tbody>
            </table></div>
          </div>
          <div class="bg-white rounded-xl shadow-sm p-4"><label class="block"><span class="field-label">Notes on the invoice (optional)</span><textarea data-f="notes" class="field-input" rows="2">${esc(f.notes)}</textarea></label></div>
        </div>
        <aside class="space-y-4">
          <div class="bg-white rounded-xl shadow-sm p-4 lg:sticky lg:top-4 space-y-3">
            <dl class="text-sm grid grid-cols-2 gap-y-1">
              <dt class="text-slate-500">Items</dt><dd class="text-right tabular-nums" id="t-items">${money(f.currency, t.items)}</dd>
              <dt class="text-slate-500 self-center">Shipping</dt><dd class="text-right"><input data-f="shipping" type="number" step="0.01" min="0" class="field-input mt-0 text-sm text-right" style="width:6rem;display:inline-block" value="${esc(f.shipping)}"></dd>
              <dt class="font-semibold pt-1 border-t">Total</dt><dd class="text-right font-semibold tabular-nums pt-1 border-t" id="t-total">${money(f.currency, t.total)}</dd>
            </dl>
            <label class="flex items-start gap-2 text-sm"><input type="checkbox" data-f="margin_scheme_enabled" class="mt-1" ${f.margin_scheme_enabled ? 'checked' : ''}><span>Print the VAT Margin Scheme note (no VAT shown on this invoice)</span></label>
            <button id="inv-save" class="w-full px-4 py-2 rounded-md text-sm font-semibold bg-emerald-700 text-white hover:bg-emerald-800"><i class="fas fa-file-pdf mr-1"></i>Save &amp; download PDF</button>
            <div id="inv-done"></div>
            <p class="text-[11px] text-slate-500">Branding, the margin scheme note and terms come from <a href="/invoices/settings" data-link class="underline">invoice settings</a> and are saved with each invoice.</p>
          </div>
        </aside>
      </section>`
    wire()
  }

  function refreshTotals() {
    const t = totals()
    document.getElementById('t-items').textContent = money(form.currency, t.items)
    document.getElementById('t-total').textContent = money(form.currency, t.total)
    form.items.forEach((it, i) => { const el = app.querySelector(`[data-line="${i}"]`); if (el) el.textContent = money(form.currency, (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0)) })
  }

  function wire() {
    app.querySelectorAll('[data-f]').forEach((el) => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      form[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value
      if (el.dataset.f === 'shipping' || el.dataset.f === 'currency') refreshTotals()
    }))
    app.querySelectorAll('[data-i]').forEach((el) => el.addEventListener('input', () => { form.items[el.dataset.i][el.dataset.k] = el.value; if (['quantity', 'unitPrice'].includes(el.dataset.k)) refreshTotals() }))
    app.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { form.items.splice(Number(b.dataset.rm), 1); if (!form.items.length) form.items.push(blankItem()); draw() }))
    document.getElementById('inv-add-item').onclick = () => { form.items.push(blankItem()); draw() }
    app.querySelectorAll('[data-redl]').forEach((b) => (b.onclick = async () => { try { const { data } = await axios.get(`/api/invoices/${b.dataset.redl}`); await download(data.invoice) } catch (e) { err(e) } }))
    document.getElementById('inv-parse').onclick = () => {
      const raw = document.getElementById('inv-paste').value
      if (!raw.trim()) return toast('Paste the Order details page first', 'err')
      const p = window.parseAmazonOrderText(raw)
      const fill = (k, v) => { if (v) form[k] = v }
      form.raw_paste = raw
      fill('order_id', p.orderId); fill('seller_order_id', p.sellerOrderId); fill('purchase_date', p.purchaseDate); fill('ship_date', p.shipDate); fill('sales_channel', p.salesChannel)
      if (p.buyerName) { form.buyer_name = p.buyerName; form.buyer_address = p.buyerAddressLines.join('\n') }
      if (p.currency) form.currency = p.currency
      if (p.items.length) {
        // Keep any IMEIs already typed against the same ASIN/SKU.
        const imeis = new Map(form.items.filter((x) => x.imei).map((x) => [x.asin || x.sku, x.imei]))
        form.items = p.items.map((it) => ({ name: it.name, asin: it.asin, sku: it.sku, condition: it.condition || 'Renewed', imei: imeis.get(it.asin) || imeis.get(it.sku) || '', quantity: it.quantity, unitPrice: round2(it.unitPrice) }))
        form.shipping = p.shippingCharge || 0
      }
      draw()
      const msg = document.getElementById('inv-parse-msg')
      if (msg) msg.innerHTML = p.warnings.length ? `<span class="text-amber-700">${p.warnings.map(esc).join(' ')}</span>` : `<span class="text-emerald-700">Filled ${p.items.length} item${p.items.length === 1 ? '' : 's'} and the address.</span>`
      if (form.order_id && !form.case_id) axios.get(`/api/invoices/by-order/${encodeURIComponent(form.order_id)}`).then(({ data }) => { if (data.invoices?.length) { form.existing = data.invoices; draw() } }).catch(() => {})
    }
    document.getElementById('inv-save').onclick = save
  }

  async function save() {
    const f = form
    if (!String(f.invoice_number).trim()) { toast('Enter the invoice number from Zoho Inventory', 'err'); return app.querySelector('[data-f="invoice_number"]')?.focus() }
    if (!f.buyer_name.trim()) return toast('Add who the invoice is to (Bill to: name)', 'err')
    if (!f.buyer_address.trim()) return toast('Add the buyer address: paste the Order details page, or type it', 'err')
    if (f.items.some((it) => it.name.trim() && !(Number(it.unitPrice) > 0))) return toast('Every item needs a price', 'err')
    const btn = document.getElementById('inv-save'); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>Saving…'
    try {
      const t = totals()
      const items = f.items.filter((it) => it.name.trim()).map((it) => ({ ...it, quantity: Number(it.quantity) || 0, unitPrice: round2(it.unitPrice), total: round2((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0)) }))
      const { data } = await axios.post('/api/invoices', { ...f, items, shipping: round2(f.shipping), subtotal: t.items, total: t.total })
      const inv = data.invoice
      await download(inv)
      const done = document.getElementById('inv-done')
      btn.innerHTML = `<i class="fas fa-circle-check mr-1"></i>Saved ${esc(inv.invoice_number)}`; btn.className = 'w-full px-4 py-2 rounded-md text-sm font-semibold bg-slate-200 text-slate-600'
      done.innerHTML = `
        <div class="text-xs text-slate-600 space-y-2">
          <div>Downloaded <span class="font-mono">${esc(fileName(inv))}</span>. Upload it on the order in Seller Central (Upload invoice)${f.case_id ? ', or attach it to the reply:' : '.'}</div>
          ${f.case_id ? `<button id="inv-attach" class="w-full px-3 py-1.5 rounded-md text-sm font-medium bg-sky-600 text-white hover:bg-sky-700"><i class="fas fa-paperclip mr-1"></i>Attach to the reply on ${esc(f.case_ref)}</button>` : ''}
          <button id="inv-again" class="w-full px-3 py-1.5 rounded-md text-sm border border-slate-300 hover:bg-slate-50">Download again</button>
        </div>`
      document.getElementById('inv-again').onclick = () => download(inv).catch(err)
      const at = document.getElementById('inv-attach')
      if (at) at.onclick = async () => {
        try { h.queueCaseFile(f.case_id, await asAttachment(inv)); form = null; toast(`${inv.invoice_number} will be attached to the reply`); navigate(`/cases/${f.case_id}`) } catch (e) { err(e) }
      }
      form = { ...f, existing: [...(f.existing || []), inv] } // stay on the page; a second save needs a new number
    } catch (e) {
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-file-pdf mr-1"></i>Save &amp; download PDF'; err(e)
    }
  }

  // ───────── Settings ─────────
  async function renderSettings() {
    app.innerHTML = header('settings') + '<p class="text-slate-500"><i class="fas fa-spinner fa-spin mr-2"></i>Loading…</p>'
    let s
    try { ;({ data: { settings: s } } = await axios.get('/api/invoices/settings')) } catch (e) { app.innerHTML = header('settings') + (notReady(e) || ''); if (!notReady(e)) h.renderError(e); return }
    const ro = isManager ? '' : 'readonly'
    const inp = (k, label) => `<label class="block"><span class="field-label">${label}</span><input data-s="${k}" class="field-input" value="${esc(s[k] || '')}" ${ro}></label>`
    const area = (k, label, rows) => `<label class="block"><span class="field-label">${label}</span><textarea data-s="${k}" class="field-input text-sm" rows="${rows}" ${ro}>${esc(s[k] || '')}</textarea></label>`
    app.innerHTML = header('settings') + `
      <section id="invoice-settings" class="grid lg:grid-cols-2 gap-4">
        ${isManager ? '' : '<p class="lg:col-span-2 text-sm text-slate-500"><i class="fas fa-lock mr-1"></i>Only a manager can change these.</p>'}
        <div class="bg-white rounded-xl shadow-sm p-4 grid sm:grid-cols-2 gap-3">
          <h2 class="sm:col-span-2 font-semibold">Company</h2>
          ${inp('company_name', 'Company name')}${inp('vat_number', 'VAT number')}
          ${inp('address_line1', 'Address line 1')}${inp('address_line2', 'Address line 2')}
          ${inp('city', 'Town / city')}${inp('postcode', 'Postcode')}
          ${inp('country', 'Country')}${inp('company_number', 'Company number')}
          ${inp('email', 'Email')}${inp('phone', 'Phone')}
        </div>
        <div class="bg-white rounded-xl shadow-sm p-4 space-y-3">
          <h2 class="font-semibold">Branding</h2>
          <div class="flex items-center gap-4">
            <div class="w-40 h-16 rounded border border-dashed border-slate-300 flex items-center justify-center bg-slate-50 overflow-hidden">${s.logo_data_url ? `<img id="logo-preview" src="${esc(s.logo_data_url)}" class="max-h-16 max-w-40" alt="Logo">` : '<span id="logo-preview" class="text-xs text-slate-400">No logo</span>'}</div>
            ${isManager ? `<div class="space-y-1"><button id="logo-pick" class="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50">Choose logo (PNG/JPG)</button><input id="logo-file" type="file" accept="image/png,image/jpeg" class="hidden">${s.logo_data_url ? '<button id="logo-clear" class="block text-xs text-slate-400 hover:text-red-700">Remove logo</button>' : ''}</div>` : ''}
          </div>
          <label class="flex items-center gap-2 text-sm"><span class="field-label mb-0">Accent colour</span><input data-s="accent_color" type="color" value="${esc(s.accent_color || '#111827')}" ${isManager ? '' : 'disabled'}></label>
          ${area('footer_note', 'Footer note', 2)}
        </div>
        <div class="bg-white rounded-xl shadow-sm p-4 space-y-3 lg:col-span-2">
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" data-s="margin_scheme_enabled" ${s.margin_scheme_enabled ? 'checked' : ''} ${isManager ? '' : 'disabled'}>Tick "VAT Margin Scheme note" by default on new invoices</label>
          ${area('margin_scheme_note', 'VAT Margin Scheme note (printed on the invoice)', 3)}
          ${area('terms_and_conditions', 'Terms &amp; conditions (printed on every invoice)', 6)}
        </div>
        ${isManager ? '<div class="lg:col-span-2 flex justify-end"><button id="inv-settings-save" class="px-4 py-2 rounded-md text-sm font-semibold bg-slate-900 text-white hover:bg-slate-700">Save settings</button></div>' : ''}
      </section>`
    if (!isManager) return
    let logo = s.logo_data_url || ''
    document.getElementById('logo-pick').onclick = () => document.getElementById('logo-file').click()
    document.getElementById('logo-file').onchange = (e) => {
      const file = e.target.files[0]; if (!file) return
      if (file.size > 1024 * 1024) return toast('Logo must be under 1 MB', 'err')
      const r = new FileReader(); r.onload = () => { logo = r.result; const p = document.getElementById('logo-preview'); p.outerHTML = `<img id="logo-preview" src="${esc(logo)}" class="max-h-16 max-w-40" alt="Logo">` }; r.readAsDataURL(file)
    }
    document.getElementById('logo-clear')?.addEventListener('click', () => { logo = ''; document.getElementById('logo-preview').outerHTML = '<span id="logo-preview" class="text-xs text-slate-400">No logo</span>' })
    document.getElementById('inv-settings-save').onclick = async () => {
      const body = { logo_data_url: logo }
      app.querySelectorAll('[data-s]').forEach((el) => { body[el.dataset.s] = el.type === 'checkbox' ? el.checked : el.value })
      try { await axios.put('/api/invoices/settings', body); toast('Invoice settings saved') } catch (e) { err(e) }
    }
  }

  return { renderHistory, renderNew, renderSettings }
}
