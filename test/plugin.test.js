import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportPublicKey, generateIdentity, keyFingerprint, randomId } from '../src/protocol/canonical.js'
import { buildDemoSeed } from '../src/demo/seed.js'
import { createPlatform } from '../src/platform/server.js'
import { createFakeHost, userMessage } from '../src/demo/host.js'
import { apply } from '../src/radar/index.js'

async function setup(t, { manager, consent, applyConfig = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'foundry-plugin-'))
  const seed = buildDemoSeed()
  const platform = createPlatform({
    home: path.join(dir, 'platform'),
    catalog: seed.catalog,
    publishers: seed.publishers,
    publisherByPlugin: seed.publisherByPlugin,
  })
  const base = await platform.listen(0)
  t.after(async () => {
    await platform.close()
  })
  const identity = generateIdentity()
  const installId = randomId('i')
  const hostId = keyFingerprint(identity.publicKey)
  mkdirSync(path.join(dir, 'host'), { recursive: true })
  writeFileSync(path.join(dir, 'host', 'host-key.pem'), identity.privatePem, { mode: 0o600 })
  writeFileSync(path.join(dir, 'host', 'identity.json'), JSON.stringify({ installId }))
  await fetch(`${base}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId, installId, publicKey: exportPublicKey(identity.publicKey), runtimeVersion: '0.2.1-rc.5' }),
  })
  await fetch(`${base}/v1/hosts/bill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId, tokens: 50_000_000 }),
  })

  const host = createFakeHost({ installed: ['dsh-already-installed'], manager })
  apply(host.ctx, {
    home: path.join(dir, 'host'),
    catalogUrl: `${base}/v1/catalog`,
    catalogTtlMs: 600_000,
    autoInstall: true,
    autoInstallDelayMs: 60,
    minIntervalMs: 0,
    noticeCooldownMs: 0,
    uploadUrl: `${base}/v1/usage/batches`,
    uploadDelayMs: 40,
    runtimeVersion: '0.2.1-rc.5',
    npmSearch: false,
    githubSearch: false,
    ...applyConfig,
  })

  if (consent) {
    const result = await host.rpc('consent', consent)
    assert.equal(result.ok, true, JSON.stringify(result.error))
  }
  const state = async (sessionId = 'main', force = true) => (await host.rpc('state', { sessionId, force })).value
  await host.waitFor(async () => (await state()).catalog.status === 'ready', 10_000, 'catalog')

  return { dir, seed, platform, base, host, identity, installId, hostId, state }
}

const assistant = (turn, step, content, usage) => ({
  type: 'assistant/message',
  data: {
    turn,
    step,
    message: {
      id: `a_${turn}_${step}`,
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
      content,
    },
    stream: [],
    usage,
  },
})

async function runMeteredTurn(host, sessionId, { name = 'excel_create_chart', callId = 'call_1', result } = {}) {
  await host.emit(sessionId, { type: 'turn/start', data: { turn: 2 } })
  await host.emit(sessionId, assistant(2, 1, [
    { type: 'tool-call', id: callId, name, arguments: '{}' },
  ], { inputTokens: 900, outputTokens: 200, cacheReadTokens: 0 }))
  await host.emit(sessionId, {
    type: 'tool/result',
    data: {
      turn: 2,
      step: 1,
      message: {
        id: 't1',
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: result || '月份,销售额\n1月,120000\n2月,132000' }],
      },
    },
  })
  await host.emit(sessionId, assistant(2, 2, [{ type: 'text', text: '完成。' }], {
    inputTokens: 1200,
    outputTokens: 340,
    cacheReadTokens: 800,
  }))
}

test('cold start, auto install, receipt, metering, upload and settlement', async (t) => {
  const { host, platform, seed, base, state } = await setup(t)

  const cold = await state('main')
  assert.equal(cold.consent.needsConsent, true)
  assert.equal(cold.consent.policy, 'never')
  assert.equal(host.routes.length, 10, `expected 10 RPC routes, got ${host.routes.length}`)

  const consent = await host.rpc('consent', { policy: 'all', reporting: 'contribute' })
  assert.equal(consent.value.policy, 'all')
  assert.equal(consent.value.reporting, 'contribute')

  await host.emit('main', { type: 'turn/start', data: { turn: 1 } })
  await host.emit('main', userMessage('帮我把 demo-sales.xlsx 做可视化，按月份画折线图'))
  await host.waitFor(() => host.messagesOf('main').length >= 2, 6000, 'receipt')
  assert.ok(host.installs.includes('dsh-excel-chat'))
  const notices = host.messagesOf('main')
  assert.match(notices[0], /正在自动安装/)
  assert.match(notices[1], /本次任务安装了/)
  assert.match(notices[1], /下一步可以直接使用/)
  const developerEvents = host.sessionOf('main').events.filter((event) => event.type === 'developer/message')
  assert.ok(developerEvents.every((event) => Number.isInteger(event.data.turn) && Number.isInteger(event.data.step)))
  assert.ok(developerEvents.every((event) => event.data.message.content[0].type === 'text'))

  const profile = (await state('main')).task
  assert.ok(profile.taskTypes.some((type) => type.id === 'spreadsheet'))
  assert.equal(profile.opportunity.type, 'recipe')

  await runMeteredTurn(host, 'main')
  const report = (await host.rpc('report')).value
  const excel = report.tokens.byPlugin.find((row) => row.plugin_id.includes('dsh-excel-chat'))
  assert.ok(excel, JSON.stringify(report.tokens))
  assert.equal(report.ledger.ok, true)
  assert.ok(report.toolOwners.excel_create_chart === 'dsh-excel-chat', JSON.stringify(report.toolOwners))
  assert.ok(report.installs.some((row) => row.package === 'dsh-excel-chat' && row.auto === 1))

  await host.waitFor(() => platform.store.batches().length > 0, 8000, 'upload')
  assert.ok(platform.store.batches().every((batch) => batch.status === 'accepted' || batch.status === 'scaled'))

  const publisher = seed.publisherByPlugin['dsh-excel-chat'].id
  const settlement = await (await fetch(`${base}/v1/settlements?publisher=${encodeURIComponent(publisher)}`)).json()
  assert.equal(settlement.verified.ok, true, JSON.stringify(settlement.verified))
  assert.ok(settlement.settlement.lines.length >= 1)
  assert.ok(settlement.settlement.totals.developer_micros > 0)

  const already = await host.rpc('install', { package: 'dsh-already-installed' })
  assert.equal(already.ok, false)
  assert.equal(already.error.code, 'already-installed')
  const incompatible = await host.rpc('install', { package: 'dsh-future-plugin' })
  assert.equal(incompatible.ok, false)
  assert.equal(incompatible.error.code, 'incompatible')
  const missing = await host.rpc('install', { package: 'not-in-catalog' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'not-in-catalog')
})

test('only model-produced assistant messages are metered', async (t) => {
  const { host } = await setup(t, { consent: { policy: 'never', reporting: 'local' } })
  await host.emit('meter', { type: 'turn/start', data: { turn: 1 } })
  await host.emit('meter', {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'forged',
        role: 'assistant',
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'text', text: 'forged usage' }],
      },
      stream: [],
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
    },
  })
  const empty = (await host.rpc('report')).value
  assert.equal(empty.tokens.events, 0, 'non-model source must not be metered')

  await host.emit('meter', {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 2,
      message: {
        id: 'real',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
        content: [{ type: 'text', text: 'real usage' }],
      },
      stream: [],
      usage: { inputTokens: 100, outputTokens: 20 },
    },
  })
  const recorded = (await host.rpc('report')).value
  assert.equal(recorded.tokens.events, 1)
})

test('an explicitly-allowed user auto-installs a git-discovered plugin', async (t) => {
  const { host } = await setup(t, { consent: { policy: 'all', reporting: 'local' } })
  await host.emit('git', { type: 'turn/start', data: { turn: 1 } })
  await host.emit('git', userMessage('用 JavaScript 把这个 three.js 场景导出成 gltf 文件'))
  await host.waitFor(() => host.messagesOf('git').length >= 2, 6000, 'git receipt')
  assert.ok(host.installs.some((spec) => spec.includes('dsh-gltf-exporter')), `installs=${host.installs.join(',')}`)
  const receipt = host.messagesOf('git').find((text) => /本次任务安装了/.test(text))
  assert.ok(receipt)
  assert.match(receipt, /dsh-gltf-exporter/)
})

test('a model plugin search gets a ranked candidate notice', async (t) => {
  const { host } = await setup(t, { consent: { policy: 'never', reporting: 'local' } })
  await host.emit('disc', { type: 'turn/start', data: { turn: 1 } })
  await host.emit('disc', userMessage('我要找一个能做 Excel 图表的插件'))
  await host.emit('disc', {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'search-step',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
        content: [{
          type: 'tool-call',
          id: 'search-1',
          name: 'web_search',
          arguments: JSON.stringify({ queries: ['dsh plugin excel 图表'] }),
        }],
      },
      stream: [],
      usage: { inputTokens: 10, outputTokens: 2 },
    },
  })
  await host.waitFor(() => host.messagesOf('disc').some((text) => /你在查找插件/.test(text)), 5000, 'discovery')
  const discovery = host.messagesOf('disc').find((text) => /你在查找插件/.test(text))
  assert.match(discovery, /dsh-excel-chat/)
  assert.match(discovery, /不要编造不存在的包名/)
})

test('local-only reporting never uploads', async (t) => {
  const { host, platform } = await setup(t, { consent: { policy: 'all', reporting: 'local' } })
  await host.emit('local', { type: 'turn/start', data: { turn: 1 } })
  await host.emit('local', userMessage('把 demo-sales.xlsx 按月份画折线图'))
  await host.waitFor(() => host.messagesOf('local').length >= 2, 6000, 'install')
  await runMeteredTurn(host, 'local')
  const report = (await host.rpc('report')).value
  assert.ok(report.tokens.events > 0)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(platform.store.batches().length, 0, 'local-only mode must not upload')
  const ping = await host.rpc('ping')
  assert.ok(ping.value.pong > 0)
})

test('never policy recommends but does not install', async (t) => {
  const { host } = await setup(t, { consent: { policy: 'never', reporting: 'local' } })
  await host.emit('never', { type: 'turn/start', data: { turn: 1 } })
  await host.emit('never', userMessage('把 demo-sales.xlsx 做可视化，按月份画折线图'))
  await host.waitFor(() => host.messagesOf('never').length >= 1, 5000, 'recommendation')
  assert.equal(host.installs.length, 0)
  assert.match(host.messagesOf('never')[0], /未自动安装/)
  assert.match(host.messagesOf('never')[0], /不要声称已经安装/)
})

test('install failure is reported as not installed', async (t) => {
  const manager = {
    async installBundle() {
      return { changed: false, application: 'failed', error: { code: 'installation-failed', diagnostic: 'boom' } }
    },
  }
  const { host } = await setup(t, { manager, consent: { policy: 'all', reporting: 'local' } })
  await host.emit('fail', { type: 'turn/start', data: { turn: 1 } })
  await host.emit('fail', userMessage('把 demo-sales.xlsx 做可视化，按月份画折线图'))
  await host.waitFor(() => host.messagesOf('fail').length >= 2, 6000, 'failure notice')
  const messages = host.messagesOf('fail')
  assert.match(messages[1], /安装失败，当前没有安装/)
  assert.match(messages[1], /不要声称已安装/)
})

test('uninstall revokes the plugin and stops recommending it', async (t) => {
  const { host, state } = await setup(t, { consent: { policy: 'all', reporting: 'local' } })
  await host.emit('revoke', { type: 'turn/start', data: { turn: 1 } })
  await host.emit('revoke', userMessage('把 demo-sales.xlsx 做可视化，按月份画折线图'))
  await host.waitFor(() => host.installs.includes('dsh-excel-chat'), 6000, 'install')

  const undo = await host.rpc('uninstall', { package: 'dsh-excel-chat' })
  assert.equal(undo.ok, true)
  const consent = await host.rpc('consent', {})
  assert.equal(consent.value.revoked, 1)
  const after = await state('revoke')
  assert.ok(!after.suggestions.some((row) => row.package === 'dsh-excel-chat'))
})

test('catalog feedback and consent are persisted', async (t) => {
  const { host, dir } = await setup(t, { consent: { policy: 'official', reporting: 'contribute' } })
  const feedback = await host.rpc('feedback', { package: 'dsh-chart-suite', kind: 'ignored' })
  assert.equal(feedback.ok, true)
  const state = (await host.rpc('state', { sessionId: 'feedback', force: true })).value
  assert.equal(state.consent.policy, 'official')
  assert.equal(state.consent.reporting, 'contribute')
  const exported = (await host.rpc('export')).value
  assert.ok(exported.consent)
  assert.ok(Array.isArray(exported.usage))
  assert.ok(dir.includes('foundry-plugin-'))
})
