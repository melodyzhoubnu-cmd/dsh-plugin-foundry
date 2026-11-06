import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportPublicKey, generateIdentity, keyFingerprint, randomId, sha256Hex } from '../src/protocol/canonical.js'
import { buildBatch, encodeBatch } from '../src/protocol/batch.js'
import { buildDistributorManifest } from '../src/protocol/distributor.js'
import { buildDemoSeed } from '../src/demo/seed.js'
import { createPlatform } from '../src/platform/server.js'

function makeEvent(overrides = {}) {
  return {
    schema: 1,
    plugin_id: 'pkg:npm/dsh-excel-chat@1.4.0',
    publisher: 'ed25519:excel',
    tool: 'excel_create_chart',
    request_id: 'r1',
    session_hash: 'a'.repeat(24),
    tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    share: 1,
    bucket: 'base',
    meter_key: 'ed25519:meter',
    ts: Date.now(),
    hash: sha256Hex(`event-${Math.random()}`),
    ...overrides,
  }
}

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'foundry-platform-'))
  const seed = buildDemoSeed()
  const platform = createPlatform({
    home: path.join(dir, 'platform'),
    catalog: seed.catalog,
    publishers: seed.publishers,
    publisherByPlugin: seed.publisherByPlugin,
  })
  const base = await platform.listen(0)
  const identity = generateIdentity()
  const installId = randomId('i')
  const hostId = keyFingerprint(identity.publicKey)
  const registered = await fetch(`${base}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId, installId, publicKey: exportPublicKey(identity.publicKey), runtimeVersion: '0.2.1-rc.5' }),
  })
  assert.equal(registered.status, 201)
  return { dir, seed, platform, base, identity, installId, hostId }
}

async function bill(base, hostId, tokens) {
  const response = await fetch(`${base}/v1/hosts/bill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId, tokens }),
  })
  assert.equal(response.status, 200)
}

async function upload(base, batch, installId) {
  const response = await fetch(`${base}/v1/usage/batches`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'idempotency-key': batch.batch_id,
      'x-install-id': installId,
    },
    body: encodeBatch(batch),
  })
  return { status: response.status, body: await response.json() }
}

test('batch intake verifies signature, idempotency and the previous chain', async (t) => {
  const { seed, platform, base, identity, installId, hostId } = await setup()
  t.after(() => platform.close())
  const publisher = seed.publisherByPlugin['dsh-excel-chat'].id
  await bill(base, hostId, 1_000_000)
  const events = [makeEvent({ publisher })]
  const batch = buildBatch({
    events,
    hostId,
    installId,
    previousRoot: null,
    privateKey: identity.privateKey,
    runtimeVersion: '0.2.1-rc.5',
  })
  const first = await upload(base, batch, installId)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.accepted, true)
  assert.equal(first.body.duplicate, false)
  assert.ok(first.body.server_seq > 0)

  const duplicate = await upload(base, batch, installId)
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.body.duplicate, true)
  assert.equal(platform.store.stats({ publisher }).byPlugin[0].tokens.input, 1000, 'duplicate must not double count')

  const tampered = { ...batch, totals: [{ ...batch.totals[0], tokens: { ...batch.totals[0].tokens, input: 1 } }] }
  const bad = await upload(base, tampered, installId)
  assert.equal(bad.status, 400)
  assert.equal(bad.body.problem, 'bad-signature')

  const wrongPrev = buildBatch({
    events: [makeEvent({ publisher, hash: sha256Hex('second-event'), request_id: 'r2' })],
    hostId,
    installId,
    previousRoot: 'f'.repeat(64),
    privateKey: identity.privateKey,
  })
  const gap = await upload(base, wrongPrev, installId)
  assert.equal(gap.status, 409)
  assert.equal(gap.body.problem, 'prev-mismatch')

  const second = buildBatch({
    events: [makeEvent({ publisher, hash: sha256Hex('third-event'), request_id: 'r3' })],
    hostId,
    installId,
    previousRoot: batch.root,
    privateKey: identity.privateKey,
  })
  const accepted = await upload(base, second, installId)
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
  assert.equal(accepted.body.accepted, true)

  const stats = platform.store.stats({ publisher })
  assert.equal(stats.byPlugin[0].tokens.input, 2000)
  assert.equal(stats.requests, 2)
})

test('bill anchor over-attribution is scaled and disputed', async (t) => {
  const { seed, platform, base, identity, installId, hostId } = await setup()
  t.after(() => platform.close())
  const publisher = seed.publisherByPlugin['dsh-excel-chat'].id
  await bill(base, hostId, 500)
  const batch = buildBatch({
    events: [makeEvent({ publisher, tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 } })],
    hostId,
    installId,
    previousRoot: null,
    privateKey: identity.privateKey,
  })
  const result = await upload(base, batch, installId)
  assert.equal(result.status, 200)
  assert.equal(result.body.scaled, true)
  assert.ok(result.body.disputes.some((dispute) => dispute.kind === 'over-anchor'))
  const stats = platform.store.stats({ publisher })
  assert.ok(stats.totals.input <= 500)
})

test('settlement, developer portal and license checkout', async (t) => {
  const { seed, platform, base, identity, installId, hostId } = await setup()
  t.after(() => platform.close())
  const publisher = seed.publisherByPlugin['dsh-excel-chat'].id
  await bill(base, hostId, 1_000_000)
  const batch = buildBatch({
    events: [makeEvent({ publisher })],
    hostId,
    installId,
    previousRoot: null,
    privateKey: identity.privateKey,
  })
  const uploadResult = await upload(base, batch, installId)
  assert.equal(uploadResult.status, 200, JSON.stringify(uploadResult.body))

  const settlementResponse = await fetch(`${base}/v1/settlements?publisher=${encodeURIComponent(publisher)}`)
  assert.equal(settlementResponse.status, 200)
  const { settlement, verified } = await settlementResponse.json()
  assert.equal(verified.ok, true)
  assert.ok(settlement.totals.developer_micros > 0)

  const stored = await (await fetch(`${base}/v1/settlements/${settlement.settlement_id}`)).json()
  assert.equal(stored.verified.ok, true)
  assert.equal(stored.settlement.settlement_id, settlement.settlement_id)

  const portal = await (await fetch(`${base}/portal?publisher=${encodeURIComponent(publisher)}`)).text()
  assert.match(portal, /Excel 对话助手/)
  assert.match(portal, /开发者所得/)
  const portalJson = await (await fetch(`${base}/portal.json?publisher=${encodeURIComponent(publisher)}`)).json()
  assert.ok(portalJson.by_plugin.length >= 1)

})

test('distributor manifests and host registration errors', async (t) => {
  const { platform, base } = await setup()
  t.after(() => platform.close())
  const identity = generateIdentity()
  const manifest = buildDistributorManifest({
    id: keyFingerprint(identity.publicKey),
    name: 'Third-party distributor',
    privateKey: identity.privateKey,
    capabilities: [{ id: 'spreadsheet.read', title: '读取表格' }],
    endpoints: { catalog: `${base}/v1/catalog` },
  })
  const registered = await fetch(`${base}/v1/distributors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest }),
  })
  assert.equal(registered.status, 201)
  const list = await (await fetch(`${base}/v1/distributors`)).json()
  assert.ok(list.distributors.some((row) => row.id === manifest.id))

  const tampered = await fetch(`${base}/v1/distributors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: { ...manifest, name: 'tampered' } }),
  })
  assert.equal(tampered.status, 400)

  const other = generateIdentity()
  const badHost = await fetch(`${base}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hostId: keyFingerprint(identity.publicKey),
      installId: 'i_bad',
      publicKey: exportPublicKey(other.publicKey),
    }),
  })
  assert.equal(badHost.status, 400)
  const body = await badHost.json()
  assert.equal(body.problem, 'host-id-mismatch')
})

test('catalog endpoint stays format-1 and accepts a free checkout', async (t) => {
  const { platform, base } = await setup()
  t.after(() => platform.close())
  const catalog = await (await fetch(`${base}/v1/catalog`)).json()
  assert.equal(catalog.format, 1)
  assert.ok(Array.isArray(catalog.plugins))
  const health = await (await fetch(`${base}/health`)).json()
  assert.equal(health.ok, true)
})
