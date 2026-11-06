/**
 * End-to-end demo: cold start -> recommendation -> auto install -> receipt ->
 * metered token -> signed batch -> settlement -> developer portal, plus the
 * settlement and the developer portal.
 *
 * Run: node src/demo/run.js
 *
 * Nothing here talks to a real DSH, npm or network service. The fake Host has
 * the same API shape as the real one, and the platform is the reference
 * implementation from this repository.
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportPublicKey, generateIdentity, randomId } from '../protocol/canonical.js'
import { buildDemoSeed } from './seed.js'
import { createPlatform } from '../platform/server.js'
import { createFakeHost, userMessage } from './host.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(here, '../../demo/out')
rmSync(out, { recursive: true, force: true })
mkdirSync(path.join(out, 'host'), { recursive: true })
mkdirSync(path.join(out, 'platform'), { recursive: true })

const step = (index, title, detail = '') => {
  console.log(`\n[${index}] ${title}${detail ? ` — ${detail}` : ''}`)
}

const json = async (url, options) => {
  const response = await fetch(url, options)
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}: ${text.slice(0, 300)}`)
  return body
}

const world = buildDemoSeed()
const platform = createPlatform({
  home: path.join(out, 'platform'),
  catalog: world.catalog,
  publishers: world.publishers,
  publisherByPlugin: world.publisherByPlugin,
})
const base = await platform.listen(0)
console.log(`Plugin Foundry demo platform: ${base}`)

/* ------------------------------ host identity ------------------------------ */

const identity = generateIdentity()
const installId = randomId('i')
const hostId = (await import('../protocol/canonical.js')).keyFingerprint(identity.publicKey)
mkdirSync(path.join(out, 'host'), { recursive: true })
writeFileSync(path.join(out, 'host', 'host-key.pem'), identity.privatePem, { mode: 0o600 })
writeFileSync(path.join(out, 'host', 'identity.json'), JSON.stringify({ installId }))

await json(`${base}/v1/hosts/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    hostId,
    installId,
    publicKey: exportPublicKey(identity.publicKey),
    runtimeVersion: '0.2.1-rc.5',
  }),
})
await json(`${base}/v1/hosts/bill`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ hostId, tokens: 50_000_000, period: { start: '2026-11-01', end: '2026-11-30' } }),
})
step(0, 'Host 注册与账单锚点', `${hostId.slice(0, 18)}… / ${installId}`)

/* -------------------------------- fake host -------------------------------- */

const host = createFakeHost({ installed: ['dsh-already-installed'] })
const { apply } = await import('../radar/index.js')
apply(host.ctx, {
  home: path.join(out, 'host'),
  catalogUrl: `${base}/v1/catalog`,
  catalogTtlMs: 600_000,
  allowInstall: true,
  autoInstall: true,
  autoInstallDelayMs: 80,
  autoDailyBudget: 3,
  minIntervalMs: 0,
  noticeCooldownMs: 0,
  uploadUrl: `${base}/v1/usage/batches`,
  uploadDelayMs: 60,
  npmSearch: false,
  githubSearch: false,
  externalDiscovery: false,
  uploadTimeoutMs: 5000,
  runtimeVersion: '0.2.1-rc.5',
  shareRate: 0.3,
  pricePerMTokens: 0.5,
})

const state = async (sessionId, force = true) => (await host.rpc('state', { sessionId, force })).value

await host.waitFor(async () => (await state('demo-main')).catalog.status === 'ready', 10_000, 'catalog')
const cold = await state('demo-main')
assert.equal(cold.consent.needsConsent, true)
assert.equal(cold.consent.policy, 'never')
step(1, '冷启授权前', `needsConsent=${cold.consent.needsConsent}, policy=${cold.consent.policy}`)

const consent = (await host.rpc('consent', { policy: 'all', reporting: 'contribute' })).value
assert.equal(consent.needsConsent, false)
assert.equal(consent.policy, 'all')
step(2, '冷启授权', `policy=${consent.policy}, reporting=${consent.reporting}`)

/* ----------------------------- distribution ----------------------------- */

await host.emit('demo-main', userMessage('帮我把 demo-sales.xlsx 做可视化，按月份画折线图'))
await host.waitFor(() => host.messagesOf('demo-main').length >= 2, 8000, 'recommend + install receipt')
assert.ok(host.installs.includes('dsh-excel-chat'), `installs=${host.installs.join(',')}`)
const notices = host.messagesOf('demo-main')
assert.match(notices[0], /正在自动安装/)
assert.match(notices[1], /本次任务安装了/)
assert.match(notices[1], /下一步可以直接使用/)
step(3, '任务内分发', `${notices.length} 条 developer/message；已安装 ${host.installs.join(', ')}`)

const profile = (await state('demo-main')).task
assert.ok(profile.taskTypes.some((type) => type.id === 'spreadsheet'))
assert.ok(profile.fileTypes.includes('.xlsx'))
assert.equal(profile.opportunity.type, 'recipe')
step(4, '任务画像', `${profile.label} · stage=${profile.stage} · opportunity=${profile.opportunity.type}`)

/* -------------------------------- metering -------------------------------- */

const assistantBase = (turn, stepNumber, content, usage) => ({
  type: 'assistant/message',
  data: {
    turn,
    step: stepNumber,
    message: {
      id: `a_${turn}_${stepNumber}`,
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
      content,
    },
    stream: [],
    usage,
  },
})

await host.emit('demo-main', { type: 'turn/start', data: { turn: 2 } })
await host.emit('demo-main', assistantBase(2, 1, [
  { type: 'tool-call', id: 'call_chart', name: 'excel_create_chart', arguments: '{"month":"1月"}' },
], { inputTokens: 900, outputTokens: 200, cacheReadTokens: 0 }))
await host.emit('demo-main', {
  type: 'tool/result',
  data: {
    turn: 2,
    step: 1,
    message: {
      id: 't_chart',
      role: 'tool',
      source: { kind: 'tool', callId: 'call_chart' },
      toolCallId: 'call_chart',
      content: [{ type: 'text', text: '月份,销售额\n1月,120000\n2月,132000\n3月,128500\n4月,141000\n5月,150000\n6月,162000' }],
    },
  },
})
await host.emit('demo-main', assistantBase(2, 2, [
  { type: 'text', text: '已按月份生成折线图，并写了一句趋势结论。' },
], { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800 }))

const report = (await host.rpc('report')).value
const excel = report.tokens.byPlugin.find((row) => row.plugin_id.includes('dsh-excel-chat'))
assert.ok(excel, 'token attribution must include dsh-excel-chat')
assert.ok(report.ledger.ok, `ledger chain must verify: ${JSON.stringify(report.ledger.problems)}`)
assert.ok(report.tokens.totals.input + report.tokens.totals.output > 0)
step(5, 'token 归因与账本', `${report.tokens.events} 条事件 · ${excel.tokens.input + excel.tokens.output + excel.tokens.cacheRead} token 归到 Excel 助手 · chain=${report.ledger.ok}`)

/* -------------------------------- upload -------------------------------- */

await host.waitFor(() => platform.store.batches().length > 0, 8000, 'batch upload')
const batches = platform.store.batches()
assert.ok(batches.every((batch) => batch.status === 'accepted' || batch.status === 'scaled'))
const reportAfterUpload = (await host.rpc('report')).value
step(6, '签名批次上传', `${batches.length} 个批次 · 最新 ${batches.at(-1).batch_id} · seq=${batches.at(-1).server_seq}`)

/* ------------------------------- settlement ------------------------------- */

const excelPublisher = world.publisherByPlugin['dsh-excel-chat'].id
const settlementResponse = await json(`${base}/v1/settlements?publisher=${encodeURIComponent(excelPublisher)}`)
assert.equal(settlementResponse.verified.ok, true, JSON.stringify(settlementResponse.verified))
writeFileSync(path.join(out, 'settlement.json'), JSON.stringify(settlementResponse.settlement, null, 2))
step(7, '结算单', `${settlementResponse.settlement.lines.length} 行 · 开发者所得 ${(settlementResponse.settlement.totals.developer_micros / 1e6).toFixed(6)} ${settlementResponse.settlement.currency}`)

/* -------------------------------- portal -------------------------------- */

const portalHtml = await (await fetch(`${base}/portal?publisher=${encodeURIComponent(excelPublisher)}`)).text()
assert.match(portalHtml, /Excel 对话助手/)
assert.match(portalHtml, /开发者所得/)
writeFileSync(path.join(out, 'portal.html'), portalHtml)
const portalJson = await json(`${base}/portal.json?publisher=${encodeURIComponent(excelPublisher)}`)
step(8, '开发者门户', `HTML ${portalHtml.length} 字节 · ${portalJson.by_plugin.length} 个插件`)

/* -------------------------------- summary -------------------------------- */

const summary = {
  generated_at: new Date().toISOString(),
  urls: { platform: base, portal: `${base}/portal?publisher=${encodeURIComponent(excelPublisher)}` },
  consent,
  task: profile,
  installs: host.installs,
  notices,
  report: {
    tokens: reportAfterUpload.tokens,
    ledger: reportAfterUpload.ledger,
    installs: reportAfterUpload.installs,
    batches: reportAfterUpload.batches,
  },
  settlement: settlementResponse.settlement,
  portal: { by_plugin: portalJson.by_plugin, by_day: portalJson.by_day },
}
writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))

console.log('\nDemo: PASS')
console.log(`  summary   ${path.relative(process.cwd(), path.join(out, 'summary.json'))}`)
console.log(`  portal    ${path.relative(process.cwd(), path.join(out, 'portal.html'))}`)
console.log(`  settle    ${path.relative(process.cwd(), path.join(out, 'settlement.json'))}`)
console.log(`  platform  ${base} (already closed for the demo)`)
await platform.close()
