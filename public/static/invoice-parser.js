// Amazon Seller Central "Order details" page paste parser.
// Takes the raw text a user copy-pastes from the Order details screen and
// extracts structured order data for invoice generation.

const CURRENCY_SYMBOL_MAP = { '£': 'GBP', '$': 'USD', '€': 'EUR' }

function detectCurrency(text) {
  for (const sym of Object.keys(CURRENCY_SYMBOL_MAP)) {
    if (text.includes(sym)) return { symbol: sym, code: CURRENCY_SYMBOL_MAP[sym] }
  }
  return { symbol: '£', code: 'GBP' }
}

function moneyToNumber(str) {
  if (!str) return 0
  const cleaned = String(str).replace(/[^0-9.\-]/g, '')
  const n = parseFloat(cleaned)
  return isNaN(n) ? 0 : n
}

const NON_PRODUCT_LINES = new Set([
  'image', 'product name', 'more information', 'quantity', 'unit price', 'proceeds',
  'status', 'shipped', 'pending', 'cancelled', 'unshipped'
])

function isMeaningfulNameLine(line) {
  const t = line.trim()
  if (!t) return false
  if (NON_PRODUCT_LINES.has(t.toLowerCase())) return false
  return true
}

/**
 * Parses raw pasted Amazon order text into a structured order object.
 */
function parseAmazonOrderText(raw) {
  const text = raw.replace(/\r\n/g, '\n')
  const lines = text.split('\n').map(l => l.trim())
  const currency = detectCurrency(text)

  const result = {
    orderId: '',
    sellerOrderId: '',
    purchaseDate: '',
    shipByDate: '',
    shipDate: '',
    deliverBy: '',
    salesChannel: '',
    shippingService: '',
    fulfilment: '',
    buyerName: '',
    buyerAddressLines: [],
    trackingId: '',
    carrier: '',
    dispatchFrom: '',
    currency: currency.code,
    currencySymbol: currency.symbol,
    items: [],
    itemsTotal: 0,
    shippingCharge: 0,
    grandTotal: 0,
    warnings: []
  }

  // --- Order ID ---
  let m = text.match(/Order ID:\s*#\s*([0-9\-]+)/i)
  if (m) result.orderId = m[1].trim()

  // --- Seller Order ID ---
  m = text.match(/Seller Order ID:\s*#\s*([^\n\r]*?)(?:\s*Edit)?$/im)
  if (m && m[1].trim()) result.sellerOrderId = m[1].trim()

  // --- Purchase date ---
  m = text.match(/Purchase date:\s*\t?\s*([^\n]+)/i)
  if (m) result.purchaseDate = m[1].trim()

  // --- Ship by ---
  m = text.match(/Ship by:\s*\t?\s*([^\n]+)/i)
  if (m) result.shipByDate = m[1].trim()

  // --- Deliver by ---
  m = text.match(/Deliver by:\s*\t?\s*([^\n]+)/i)
  if (m) result.deliverBy = m[1].trim()

  // --- Sales channel ---
  m = text.match(/Sales channel:\s*\t?\s*([^\n]+)/i)
  if (m) result.salesChannel = m[1].trim()

  // --- Shipping service ---
  m = text.match(/Shipping service:\s*\t?\s*([^\n]+)/i)
  if (m) result.shippingService = m[1].trim()

  // --- Fulfilment ---
  m = text.match(/Fulfilment:\s*\t?\s*([^\n]+)/i)
  if (m) result.fulfilment = m[1].trim()

  // --- Ship date (from package/consignment section) ---
  m = text.match(/Ship date\s*([A-Za-z]{3},\s*\d{1,2}\s*[A-Za-z]{3}\s*\d{4})/i)
  if (m) result.shipDate = m[1].trim()

  // --- Tracking ID ---
  m = text.match(/Tracking ID\s*([A-Za-z0-9]+)/i)
  if (m) result.trackingId = m[1].trim()

  // --- Carrier ---
  m = text.match(/Shipping Carrier\s*([^\n]+)/i)
  if (m) result.carrier = m[1].replace(/Tracking ID.*$/i, '').trim()

  // --- Dispatch from ---
  m = text.match(/Dispatch from\s*([^\n]+)/i)
  if (m) result.dispatchFrom = m[1].trim()

  // --- Ship to block ---
  const shipToIdx = lines.findIndex(l => /^ship to$/i.test(l))
  if (shipToIdx !== -1) {
    const addrLines = []
    for (let i = shipToIdx + 1; i < lines.length; i++) {
      const l = lines[i]
      if (!l) continue
      if (/^Address Type:/i.test(l)) break
      if (/^Contact Buyer:/i.test(l)) break
      addrLines.push(l)
      if (addrLines.length > 10) break
    }
    if (addrLines.length > 0) {
      result.buyerName = addrLines[0]
      result.buyerAddressLines = addrLines.slice(1)
    }
  }

  // --- Items: find blocks anchored on "ASIN:" lines ---
  const itemsByOrderItemId = {}
  const itemsOrder = []

  for (let i = 0; i < lines.length; i++) {
    const asinMatch = lines[i].match(/^ASIN:\s*(\S+)/i)
    if (!asinMatch) continue

    // Find product name: nearest preceding non-empty meaningful line
    let name = ''
    for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
      if (isMeaningfulNameLine(lines[j])) {
        name = lines[j]
        break
      }
    }

    let sku = '', condition = '', orderItemId = '', qty = 1, unitPrice = null, itemTotal = null

    // Scan forward a limited window for the rest of the block's metadata
    let k = i + 1
    let scanned = 0
    while (k < lines.length && scanned < 12) {
      const l = lines[k]
      let mm
      if ((mm = l.match(/^SKU:\s*(.+)$/i))) sku = mm[1].trim()
      else if ((mm = l.match(/^Condition:\s*(.+)$/i))) condition = mm[1].trim()
      else if ((mm = l.match(/^Order Item ID:\s*(\S+)/i))) orderItemId = mm[1].trim()
      else if ((mm = l.match(/^(\d+)\s+([£$€][\d,.]+)/))) {
        qty = parseInt(mm[1])
        unitPrice = moneyToNumber(mm[2])
      } else if ((mm = l.match(/^(\d+)$/)) && orderItemId) {
        // Quantity line without a price on the same line (package-section repeat)
        qty = parseInt(mm[1])
      } else if ((mm = l.match(/^Item total:\s*[£$€]?([\d,.]+)/i))) {
        itemTotal = moneyToNumber(mm[1])
        break // end of this block
      }
      k++
      scanned++
    }

    if (!orderItemId) continue // not a real item block

    const existing = itemsByOrderItemId[orderItemId]
    if (existing) {
      // Merge: fill in any missing fields from this repeated occurrence
      if (!existing.unitPrice && unitPrice != null) existing.unitPrice = unitPrice
      if (existing.itemTotal == null && itemTotal != null) existing.itemTotal = itemTotal
      if (!existing.name && name) existing.name = name
    } else {
      itemsByOrderItemId[orderItemId] = {
        name: name || 'Item',
        asin: asinMatch[1].trim(),
        sku,
        condition,
        orderItemId,
        quantity: qty || 1,
        unitPrice: unitPrice,
        itemTotal: itemTotal
      }
      itemsOrder.push(orderItemId)
    }
  }

  result.items = itemsOrder.map(id => {
    const it = itemsByOrderItemId[id]
    if (it.itemTotal == null && it.unitPrice != null) it.itemTotal = it.unitPrice * it.quantity
    if (it.unitPrice == null && it.itemTotal != null) it.unitPrice = it.quantity ? it.itemTotal / it.quantity : it.itemTotal
    it.unitPrice = it.unitPrice || 0
    it.itemTotal = it.itemTotal || 0
    return it
  })

  // --- Totals ---
  m = text.match(/Items total:\s*\t?\s*[£$€]?([\d,.]+)/i)
  const itemsTotalParsed = m ? moneyToNumber(m[1]) : null

  m = text.match(/Grand total:\s*\t?\s*[£$€]?([\d,.]+)/i)
  const grandTotalParsed = m ? moneyToNumber(m[1]) : null

  const computedItemsTotal = result.items.reduce((s, it) => s + it.itemTotal, 0)
  result.itemsTotal = itemsTotalParsed != null ? itemsTotalParsed : computedItemsTotal
  result.grandTotal = grandTotalParsed != null ? grandTotalParsed : result.itemsTotal
  result.shippingCharge = Math.max(0, +(result.grandTotal - result.itemsTotal).toFixed(2))

  if (result.items.length === 0) {
    result.warnings.push('No order items could be detected. Please check the pasted text or enter items manually.')
  }
  if (!result.orderId) {
    result.warnings.push('Order ID not detected.')
  }
  if (!result.buyerName) {
    result.warnings.push('Buyer name/address not detected.')
  }

  return result
}

window.parseAmazonOrderText = parseAmazonOrderText
