import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GENESIS_HASH,
  canonicalJson,
  generateIdentity,
  keyFingerprint,
  merkleRoot,
  sha256Hex,
  signCanonical,
  verifyCanonical,
} from '../src/protocol/canonical.js'
import {
  attributeRequest,
  aggregateEvents,
  normalizeUsage,
  reconcile,
  totalOf,
} from '../src/protocol/attribution.js'
import { estimateTokens } from '../src/protocol/tokens.js'
import { createLedger } from '../src/protocol/ledger.js'
import { buildBatch, buildReceipt, verifyBatch, verifyReceipt } from '../src/protocol/batch.js'
import { computeLine, formatMicros, previewReward, settle, verifySettlement } from '../src/protocol/settlement.js'
import { buildDistributorManifest, verifyDistributorManifest } from '../src/protocol/distributor.js'
import {
  buildCapabilityIndex,
  canonicalPluginId,
  compatibleWith,
  lookupCapability,
  parseFormat1,
  satisfiesRange,
} from '../src/protocol/catalog.js'
import { validateUsageEvent } from '../src/protocol/schema.js'
import { buildDemoSeed } from '../src/demo/seed.js'

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'foundry-protocol-'))

function event(overrides = {}) {
  return {
    schema: 1,
    plugin_id: 'pkg:npm/dsh-excel-chat@1.2.0',
    publisher: 'ed25519:publisher',
    tool: 'excel_read',
    request_id: 'session:1:1',
    session_hash: 'a'.repeat(24),
    tokens: { input: 1200, output: 340, cacheRead: 800, cacheWrite: 0, reasoning: 0 },
    share: 1,
    bucket: 'base',
    meter_key: 'ed25519:meter',
    ts: 1793813045000,
    ...overrides,
  }
}

test('canonical JSON is stable and rejects non-finite numbers', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}')
  assert.equal(canonicalJson({ a: undefined, b: 2 }), '{"b":2}')
  assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/)
  const left = signCanonical({ b: 1, a: 2 }, generateIdentity().privateKey)
  const right = signCanonical({ a: 2, b: 1 }, generateIdentity().privateKey)
  assert.equal(typeof left, 'string')
  assert.equal(typeof right, 'string')
})

test('Ed25519 identity, fingerprint and signature round-trip', () => {
  const identity = generateIdentity()
  const fingerprint = keyFingerprint(identity.publicKey)
  assert.match(fingerprint, /^ed25519:[A-Za-z0-9_-]{22}$/)
  const signature = signCanonical({ hello: 'world' }, identity.privateKey)
  assert.equal(verifyCanonical({ hello: 'world' }, signature, identity.publicKey), true)
  assert.equal(verifyCanonical({ hello: 'tampered' }, signature, identity.publicKey), false)
  assert.equal(merkleRoot(['a', 'b']), merkleRoot(['a', 'b']))
  assert.notEqual(merkleRoot(['a', 'b']), merkleRoot(['b', 'a']))
})

test('normalizeUsage accepts provider and snake_case shapes', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 }), {
    input: 10, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0,
  })
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } }), {
    input: 10, output: 2, cacheRead: 5, cacheWrite: 0, reasoning: 0,
  })
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('中文'), 2)
})

test('three-bucket attribution never exceeds the request total', () => {
  const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 }
  const result = attributeRequest({
    usage,
    toolCalls: [
      { name: 'excel_read', owner: 'dsh-excel-chat', resultTokens: 400 },
      { name: 'chart_create', owner: 'dsh-chart-suite', resultTokens: 100 },
    ],
    capability: [{ pluginId: 'dsh-excel-chat', tokens: 50 }],
  })
  const attributed = result.rows.reduce((sum, row) => sum + totalOf(row.tokens), 0)
  assert.equal(attributed + totalOf(result.unattributed), totalOf(normalizeUsage(usage)))
  assert.equal(result.rows.some((row) => row.bucket === 'tool_result'), true)
  assert.equal(result.rows.some((row) => row.bucket === 'capability'), true)
  assert.equal(result.rows.some((row) => row.pluginId === 'dsh-chart-suite'), true)
  const shares = result.rows.reduce((sum, row) => sum + row.share, 0)
  assert.ok(shares <= 1.000001, `shares=${shares}`)
})

test('unmapped tools stay unattributed', () => {
  const result = attributeRequest({ usage: { inputTokens: 100, outputTokens: 20 }, toolCalls: [{ name: 'x', owner: null }] })
  assert.equal(result.rows.length, 0)
  assert.equal(totalOf(result.unattributed), 120)
})

test('aggregateEvents merges per plugin and counts requests', () => {
  const rows = aggregateEvents([
    event({ plugin_id: 'pkg:npm/a@1', tokens: { input: 10, output: 5 }, request_id: 'r1', bucket: 'base' }),
    event({ plugin_id: 'pkg:npm/a@1', tokens: { input: 7 }, request_id: 'r1', bucket: 'tool_result' }),
    event({ plugin_id: 'pkg:npm/b@1', tokens: { input: 3 }, request_id: 'r2', bucket: 'base' }),
    event({ plugin_id: null, tokens: { input: 2 }, request_id: 'r3', bucket: 'base' }),
  ])
  const a = rows.byPlugin.find((row) => row.plugin_id === 'pkg:npm/a@1')
  assert.equal(a.tokens.input, 17)
  assert.equal(a.requests, 1)
  assert.equal(a.tool_calls, 1)
  assert.equal(rows.unattributed.input, 2)
  assert.equal(reconcile(100, 120).ok, true)
  assert.equal(reconcile(120, 100).ok, false)
})

test('append-only ledger detects edits and gaps', () => {
  const dir = tmp()
  const ledger = createLedger({ dir })
  ledger.append(event({ request_id: 'r1' }))
  ledger.append(event({ request_id: 'r2' }))
  ledger.append(event({ request_id: 'r3' }))
  const verified = ledger.verify()
  assert.equal(verified.ok, true, JSON.stringify(verified.problems))
  assert.equal(verified.count, 3)
  assert.notEqual(verified.root, GENESIS_HASH)

  const file = ledger.file
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  const tampered = JSON.parse(lines[1])
  tampered.tokens.input = 1
  lines[1] = JSON.stringify(tampered)
  writeFileSync(file, lines.join('\n') + '\n')
  const broken = createLedger({ dir }).verify()
  assert.equal(broken.ok, false)
  assert.ok(broken.problems.some((problem) => problem.problem === 'hash-mismatch'))
})

test('batch and receipt signatures verify and reject tampering', () => {
  const identity = generateIdentity()
  const dir = tmp()
  const ledger = createLedger({ dir })
  const first = ledger.append(event({ request_id: 'r1' }))
  const second = ledger.append(event({ request_id: 'r2', bucket: 'tool_result', tokens: { input: 20 } }))
  const batch = buildBatch({
    events: [first, second],
    hostId: keyFingerprint(identity.publicKey),
    installId: 'i_test',
    previousRoot: null,
    privateKey: identity.privateKey,
    runtimeVersion: '0.2.1-rc.5',
  })
  assert.equal(verifyBatch(batch, identity.publicKey).ok, true)
  const tampered = { ...batch, totals: [{ ...batch.totals[0], tokens: { input: 1 } }] }
  assert.equal(verifyBatch(tampered, identity.publicKey).ok, false)
  const receipt = buildReceipt({ batch, events: [first, second], privateKey: identity.privateKey })
  assert.equal(verifyReceipt(receipt, identity.publicKey).ok, true)
  assert.equal(receipt.event_count, 2)
})

test('settlement: share and rebate are exclusive and recomputable', () => {
  const identity = generateIdentity()
  const shareLine = computeLine({ plugin_id: 'pkg:npm/x@1', publisher: 'p', tokens: { input: 800000, output: 200000 }, requests: 2, tool_calls: 1 }, { basis: 'share', shareRate: 0.3, pricePerMTokens: 0.5 })
  assert.equal(shareLine.revenue_micros, 500000)
  assert.equal(shareLine.developer_micros, 150000)
  const rebateLine = computeLine({ plugin_id: 'pkg:npm/x@1', publisher: 'p', tokens: { input: 1000000 } }, { basis: 'rebate', rebateRate: 0.1 })
  assert.equal(rebateLine.rebate_tokens, 100000)
  assert.equal(rebateLine.developer_micros, 0)

  const statement = settle({
    publisher: 'p',
    period: { start: '2026-11-01T00:00:00.000Z', end: '2026-11-02T00:00:00.000Z' },
    totals: [
      { plugin_id: 'pkg:npm/x@1', publisher: 'p', tokens: { input: 1000000 }, requests: 1, tool_calls: 0 },
      { plugin_id: 'pkg:npm/y@1', publisher: 'p', tokens: { input: 1000000 }, requests: 1, tool_calls: 0 },
    ],
    rates: { plugins: { 'pkg:npm/y@1': { basis: 'rebate', rebateRate: 0.1 } } },
    meterKey: keyFingerprint(identity.publicKey),
    privateKey: identity.privateKey,
  })
  assert.equal(verifySettlement(statement, identity.publicKey).ok, true)
  assert.equal(statement.lines.find((line) => line.plugin_id === 'pkg:npm/x@1').basis, 'share')
  assert.equal(statement.lines.find((line) => line.plugin_id === 'pkg:npm/y@1').basis, 'rebate')
  assert.equal(statement.totals.developer_micros, 150000)
  assert.equal(statement.totals.rebate_tokens, 100000)
  assert.equal(formatMicros(150000), '$0.15')
  const tampered = { ...statement, totals: { ...statement.totals, developer_micros: 1 } }
  assert.equal(verifySettlement(tampered, identity.publicKey).ok, false)
  assert.equal(previewReward({ input: 1000000 }, { mode: 'rebate', rebateRate: 0.1 }).rebateTokens, 100000)
})

test('distributor manifest is self-signed and verifiable', () => {
  const identity = generateIdentity()
  const manifest = buildDistributorManifest({
    id: keyFingerprint(identity.publicKey),
    name: 'Third-party distributor',
    privateKey: identity.privateKey,
    capabilities: [{ id: 'spreadsheet.read', title: '读取表格' }],
    endpoints: { catalog: 'https://example.com/catalog.json' },
  })
  assert.equal(verifyDistributorManifest(manifest).ok, true)
  assert.equal(verifyDistributorManifest({ ...manifest, name: 'tampered' }).ok, false)
})

test('catalog parsing, compatibility and capability index', () => {
  const { catalog } = buildDemoSeed()
  const parsed = parseFormat1(catalog)
  assert.ok(parsed.entries.length >= 10)
  const excel = parsed.entries.find((entry) => entry.name === 'dsh-excel-chat')
  assert.equal(excel.pluginId, canonicalPluginId({ name: 'dsh-excel-chat', version: excel.version, integrity: excel.integrity }))
  assert.equal(compatibleWith('>=0.2.1', '0.2.1-rc.5'), true)
  assert.equal(compatibleWith('>=0.3.0', '0.2.1-rc.5'), false)
  assert.equal(satisfiesRange('^0.2.1', '0.2.9'), true)
  assert.equal(satisfiesRange('^0.2.1', '0.3.0'), false)
  const index = buildCapabilityIndex(parsed.entries)
  const chart = lookupCapability(index, 'chart.create')
  assert.ok(chart.providers.some((provider) => provider.name === 'dsh-excel-chat'))
})

test('schema rejects malformed usage events', () => {
  assert.equal(validateUsageEvent(event()).ok, true)
  assert.equal(validateUsageEvent({ ...event(), schema: 2 }).ok, false)
  assert.equal(validateUsageEvent({ ...event(), tokens: { input: -1 } }).ok, false)
  assert.equal(validateUsageEvent({ ...event(), bucket: 'guess' }).ok, false)
  assert.equal(validateUsageEvent({ ...event(), share: 2 }).ok, false)
})
