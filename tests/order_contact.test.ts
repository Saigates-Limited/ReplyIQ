// Invoice prefill: buyer name + delivery address from Orders v2026-01-01 (BUYER,RECIPIENT).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchOrderContact } from '../src/spapi'

const env: any = { SPAPI_LWA_CLIENT_ID: 'a', SPAPI_LWA_CLIENT_SECRET: 'b', SPAPI_REFRESH_TOKEN: 'c' }
function stub(order: any, status = 200) {
  const urls: string[] = []
  globalThis.fetch = (async (u: any) => {
    urls.push(String(u))
    if (String(u).includes('api.amazon.com/auth')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))
    return new Response(JSON.stringify(status === 200 ? { order } : { errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] }), { status })
  }) as any
  return urls
}

test('maps name and UK address, asks only for BUYER,RECIPIENT', async () => {
  const urls = stub({ buyer: { buyerName: 'Christopher P' }, recipient: { deliveryAddress: { name: 'Christopher Pitt', addressLine1: '18 Neasham Drive', city: 'Darlington', districtOrCounty: 'County Durham', postalCode: 'DL1 4LG', countryCode: 'GB' } } })
  const c = await fetchOrderContact(env, '204-8021934-0768344')
  assert.equal(c.name, 'Christopher Pitt')
  assert.deepEqual(c.addressLines, ['18 Neasham Drive', 'Darlington', 'County Durham', 'DL1 4LG', 'United Kingdom'])
  assert.match(urls.at(-1)!, /includedData=BUYER,RECIPIENT$/)
})

test('missing role → SpapiError 403', async () => {
  stub(null, 403)
  await assert.rejects(fetchOrderContact(env, '204-8021934-0768344'), (e: any) => e.status === 403)
})
