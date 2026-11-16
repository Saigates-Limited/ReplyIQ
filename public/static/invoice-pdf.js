// Builds the branded invoice PDF using jsPDF + autotable.
// invoiceData: { invoiceNumber, invoiceDate, orderId, sellerOrderId, purchaseDate, shipDate,
//                salesChannel, buyerName, buyerAddressLines, currencySymbol, items, itemsTotal,
//                shippingCharge, grandTotal, notes, marginSchemeEnabled }
// settings: company branding settings object from API

function fmtMoney(symbol, n) {
  return symbol + Number(n || 0).toFixed(2)
}

function itemSubLine(it) {
  const parts = []
  if (it.asin) parts.push('ASIN: ' + it.asin)
  if (it.sku) parts.push('SKU: ' + it.sku)
  if (it.condition) parts.push('Condition: ' + it.condition)
  if (it.imei) parts.push('IMEI: ' + it.imei)
  return parts.join('  |  ')
}

async function buildInvoicePdf(invoiceData, settings) {
  const { jsPDF } = window.jspdf
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 40
  const FOOTER_RESERVED = 30
  let y = margin

  const accent = settings.accent_color || '#111827'
  const companyNameColor = '#374151' // dark grey (fixed, not the teal accent) per branding request

  // Ensures at least `neededHeight` pt of space remains below `currentY` on the current
  // page before drawing a new section; if not, starts a fresh page and returns the new Y.
  function ensureSpace(currentY, neededHeight) {
    if (currentY + neededHeight > pageHeight - FOOTER_RESERVED) {
      doc.addPage()
      return margin
    }
    return currentY
  }

  // --- Logo ---
  let logoBottom = y
  if (settings.logo_data_url) {
    try {
      const props = doc.getImageProperties(settings.logo_data_url)
      const maxW = 140, maxH = 60
      let w = maxW, h = (props.height / props.width) * w
      if (h > maxH) { h = maxH; w = (props.width / props.height) * h }
      doc.addImage(settings.logo_data_url, margin, y, w, h)
      logoBottom = y + h
    } catch (e) {
      console.warn('Could not add logo image', e)
    }
  }

  // --- Company info (top-left, below/beside logo) ---
  const companyStartY = settings.logo_data_url ? logoBottom + 14 : y
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.setTextColor(companyNameColor)
  doc.text(settings.company_name || 'Your Company', margin, companyStartY)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor('#4b5563')
  let cy = companyStartY + 14
  const companyLines = [
    settings.address_line1,
    settings.address_line2,
    [settings.city, settings.postcode].filter(Boolean).join(' '),
    settings.country
  ].filter(Boolean)
  companyLines.forEach(line => { doc.text(line, margin, cy); cy += 12 })
  if (settings.vat_number) { doc.text('VAT No: ' + settings.vat_number, margin, cy); cy += 12 }
  if (settings.company_number) { doc.text('Company No: ' + settings.company_number, margin, cy); cy += 12 }
  if (settings.email) { doc.text(settings.email, margin, cy); cy += 12 }
  if (settings.phone) { doc.text(settings.phone, margin, cy); cy += 12 }

  // --- Invoice title + meta (top-right) ---
  // Fixed two-column layout: label column is right-aligned ending at labelEndX,
  // value column is left-aligned starting at valueStartX. These two x-ranges never
  // overlap regardless of how long the label or value text is (long values wrap
  // onto extra lines instead of colliding with the label).
  const rightX = pageWidth - margin
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(accent)
  doc.text('INVOICE', rightX, margin + 10, { align: 'right' })

  const metaFontSize = 9
  const metaLineHeight = 12
  const valueColWidth = 180
  const labelEndX = rightX - valueColWidth - 8
  const valueStartX = rightX - valueColWidth

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(metaFontSize)
  doc.setTextColor('#374151')
  let my = margin + 32
  const metaRows = [
    ['Invoice #', invoiceData.invoiceNumber],
    ['Invoice Date', invoiceData.invoiceDate],
    ['Order ID', invoiceData.orderId],
    invoiceData.sellerOrderId ? ['Seller Order ID', invoiceData.sellerOrderId] : null,
    ['Order Date', invoiceData.purchaseDate],
    invoiceData.salesChannel ? ['Sales Channel', invoiceData.salesChannel] : null,
  ].filter(Boolean)

  metaRows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(metaFontSize)
    doc.text(label + ':', labelEndX, my, { align: 'right' })

    doc.setFont('helvetica', 'normal')
    const valueLines = doc.splitTextToSize(String(value || '-'), valueColWidth)
    valueLines.forEach((line, i) => {
      doc.text(line, valueStartX, my + i * metaLineHeight, { align: 'left' })
    })
    my += Math.max(1, valueLines.length) * metaLineHeight
  })

  // --- divider ---
  const afterHeaderY = Math.max(cy, my) + 10
  doc.setDrawColor(accent)
  doc.setLineWidth(1.2)
  doc.line(margin, afterHeaderY, pageWidth - margin, afterHeaderY)

  // --- Bill To ---
  let by = afterHeaderY + 24
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(10)
  doc.setTextColor('#111827')
  doc.text('BILL TO / SHIP TO', margin, by)
  by += 14
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor('#1f2937')
  doc.text(invoiceData.buyerName || '-', margin, by)
  by += 13
  ;(invoiceData.buyerAddressLines || []).forEach(line => {
    doc.text(line, margin, by)
    by += 13
  })

  // --- Items table ---
  const tableStartY = by + 16
  const symbol = invoiceData.currencySymbol || '£'

  const NAME_FONT_SIZE = 9.5
  const SUB_FONT_SIZE = 7.8
  const NAME_LINE_H = 11.5
  const SUB_LINE_H = 9.5
  const CELL_PAD = 6

  const body = invoiceData.items.map(it => {
    const sub = itemSubLine(it)
    // Encode name + sub as a single raw string separated by \n; we fully hand-render
    // this column ourselves (see didParseCell/didDrawCell below), so autotable's own
    // text renderer for this cell is disabled to avoid any risk of double-drawing.
    return [
      sub ? (it.name + '\n' + sub) : it.name,
      String(it.quantity),
      fmtMoney(symbol, it.unitPrice),
      fmtMoney(symbol, it.itemTotal)
    ]
  })

  doc.autoTable({
    startY: tableStartY,
    head: [['Item', 'Qty', 'Unit Price', 'Total']],
    body,
    margin: { left: margin, right: margin },
    rowPageBreak: 'avoid',
    styles: { font: 'helvetica', fontSize: 9.5, cellPadding: CELL_PAD, valign: 'top' },
    headStyles: { fillColor: accent, textColor: '#ffffff', fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 40, halign: 'center' },
      2: { cellWidth: 80, halign: 'right' },
      3: { cellWidth: 80, halign: 'right' }
    },
    didParseCell: (data) => {
      if (data.section !== 'body' || data.column.index !== 0) return
      const raw = String(data.cell.raw || '')
      const [name, sub] = raw.split('\n')
      const contentWidth = data.cell.styles.cellWidth === 'auto'
        ? (data.table.columns[0].wrappedWidth || 250)
        : data.cell.styles.cellWidth

      const nameLines = doc.setFont('helvetica', 'bold').setFontSize(NAME_FONT_SIZE).splitTextToSize(name || '', contentWidth - CELL_PAD * 2)
      const subLines = sub ? doc.setFont('helvetica', 'normal').setFontSize(SUB_FONT_SIZE).splitTextToSize(sub, contentWidth - CELL_PAD * 2) : []

      // Stash the pre-wrapped lines for didDrawCell so we render exactly what we measured.
      data.cell._nameLines = nameLines
      data.cell._subLines = subLines

      const requiredHeight = CELL_PAD * 2 + nameLines.length * NAME_LINE_H + (subLines.length ? 3 + subLines.length * SUB_LINE_H : 0)
      data.cell.styles.minCellHeight = Math.max(data.cell.styles.minCellHeight || 0, requiredHeight)

      // Suppress autotable's own default text draw for this cell — we render it ourselves
      // in didDrawCell. This is the fix for the earlier duplicate/overlapping text bug.
      data.cell.text = []
    },
    didDrawCell: (data) => {
      if (data.section !== 'body' || data.column.index !== 0) return
      const cell = data.cell
      const startX = cell.x + CELL_PAD
      let lineY = cell.y + CELL_PAD

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(NAME_FONT_SIZE)
      doc.setTextColor('#1f2937')
      ;(cell._nameLines || []).forEach(line => {
        lineY += NAME_LINE_H * 0.78
        doc.text(line, startX, lineY)
        lineY += NAME_LINE_H * 0.22
      })

      if (cell._subLines && cell._subLines.length) {
        lineY += 3
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(SUB_FONT_SIZE)
        doc.setTextColor('#6b7280')
        cell._subLines.forEach(line => {
          lineY += SUB_LINE_H * 0.78
          doc.text(line, startX, lineY)
          lineY += SUB_LINE_H * 0.22
        })
      }
    }
  })

  let finalY = doc.lastAutoTable.finalY + 16

  // --- Totals box ---
  const totalsX = pageWidth - margin - 200
  doc.setFontSize(10)
  const totalsRows = [
    ['Items Subtotal', fmtMoney(symbol, invoiceData.itemsTotal)],
  ]
  if (invoiceData.shippingCharge) {
    totalsRows.push(['Shipping', fmtMoney(symbol, invoiceData.shippingCharge)])
  }
  totalsRows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'normal')
    doc.setTextColor('#374151')
    doc.text(label, totalsX, finalY)
    doc.text(value, pageWidth - margin, finalY, { align: 'right' })
    finalY += 15
  })

  doc.setDrawColor('#d1d5db')
  doc.setLineWidth(0.7)
  doc.line(totalsX, finalY - 4, pageWidth - margin, finalY - 4)
  finalY += 10

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(accent)
  doc.text('Grand Total', totalsX, finalY)
  doc.text(fmtMoney(symbol, invoiceData.grandTotal), pageWidth - margin, finalY, { align: 'right' })
  finalY += 24

  // --- Notes (seller notes entered for this invoice) ---
  if (invoiceData.notes && invoiceData.notes.trim()) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor('#111827')
    doc.text('Notes', margin, finalY)
    finalY += 13
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor('#4b5563')
    const notesLines = invoiceData.notes.split('\n').flatMap(line =>
      doc.splitTextToSize(line, pageWidth - margin * 2)
    )
    notesLines.forEach(line => { doc.text(line, margin, finalY); finalY += 12 })
    finalY += 8
  }

  // --- VAT Margin Scheme note ---
  if (invoiceData.marginSchemeEnabled) {
    finalY += 6
    const boxTop = finalY
    doc.setFillColor('#fef9c3')
    doc.setDrawColor('#eab308')
    const noteText = settings.margin_scheme_note ||
      'This item is sold under the VAT Margin Scheme (VAT Notice 718). VAT has been accounted for on the margin and is not shown separately on this invoice.'
    const wrapped = doc.setFont('helvetica', 'normal').setFontSize(8.5).splitTextToSize(noteText, pageWidth - margin * 2 - 20)
    const boxHeight = wrapped.length * 11 + 24
    doc.roundedRect(margin, boxTop, pageWidth - margin * 2, boxHeight, 3, 3, 'FD')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor('#854d0e')
    doc.text('VAT MARGIN SCHEME NOTICE', margin + 10, boxTop + 15)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor('#78350f')
    doc.text(wrapped, margin + 10, boxTop + 29)
    finalY = boxTop + boxHeight + 20
  } else {
    finalY += 14
  }

  // --- Terms & Conditions ---
  const terms = (invoiceData.termsAndConditions || settings.terms_and_conditions || '').trim()
  if (terms) {
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    const termLines = terms.split('\n').flatMap(line =>
      line.trim() ? doc.splitTextToSize(line.trim(), pageWidth - margin * 2) : ['']
    )
    const headingHeight = 14
    const lineHeight = 10.5
    const blockHeight = headingHeight + termLines.length * lineHeight + 6

    finalY = ensureSpace(finalY, blockHeight)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor('#111827')
    doc.text('Terms & Conditions', margin, finalY)
    finalY += headingHeight

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor('#4b5563')
    termLines.forEach(line => {
      finalY = ensureSpace(finalY, lineHeight)
      doc.text(line, margin, finalY)
      finalY += lineHeight
    })
    finalY += 10
  }

  // --- Footer note ---
  if (settings.footer_note) {
    finalY = ensureSpace(finalY, 20)
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(9)
    doc.setTextColor('#6b7280')
    const footerWrapped = doc.splitTextToSize(settings.footer_note, pageWidth - margin * 2)
    doc.text(footerWrapped, margin, finalY)
    finalY += footerWrapped.length * 12
  }

  // --- Page footer ---
  const pageCount = doc.internal.getNumberOfPages()
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor('#9ca3af')
    doc.text(
      `${settings.company_name || ''}  •  Invoice ${invoiceData.invoiceNumber}  •  Page ${p} of ${pageCount}`,
      pageWidth / 2,
      doc.internal.pageSize.getHeight() - 20,
      { align: 'center' }
    )
  }

  return doc
}

window.buildInvoicePdf = buildInvoicePdf
