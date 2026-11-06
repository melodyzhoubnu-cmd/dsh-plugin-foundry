#!/usr/bin/env node
/**
 * Read-only status for the installed Plugin Foundry Host.
 *
 * Usage: npm run status
 *        node scripts/foundry-status.js [--json]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { aggregateEvents, totalOf } from '../src/protocol/attribution.js'
import { createLedger } from '../src/protocol/ledger.js'
import { formatMicros, previewReward } from '../src/protocol/settlement.js'

const home = process.env.DSH_PLUGIN_FOUNDRY_HOME || path.join(os.homedir(), '.dsh', 'plugin-foundry')
const asJson = process.argv.includes('--json')

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const consent = readJson(path.join(home, 'consent.json'), { policy: 'never', reporting: 'local', needsConsent: true })
const preferences = readJson(path.join(home, 'preferences.json'), {})
const toolOwners = readJson(path.join(home, 'tool-owners.json'), {})
const installs = readJson(path.join(home, 'installs.json'), { installs: [] }).installs || []
const receipts = readJson(path.join(home, 'receipts.json'), { receipts: [] }).receipts || []
const batches = readJson(path.join(home, 'batches.json'), { batches: [] }).batches || []
const ledger = createLedger({ dir: path.join(home, 'ledger') })
const verification = ledger.verify()
const events = ledger.readAll()
const aggregate = aggregateEvents(events)
const catalogFiles = existsSync(path.join(home, 'cache'))
  ? readdirSync(path.join(home, 'cache')).filter((name) => name.startsWith('catalog-') && name.endsWith('.json'))
  : []
let catalog = null
if (catalogFiles.length > 0) {
  const file = path.join(home, 'cache', catalogFiles.sort().at(-1))
  const saved = readJson(file, null)
  if (saved) {
    catalog = {
      file,
      entries: Array.isArray(saved.entries) ? saved.entries.length : 0,
      fetchedAt: saved.fetchedAt || 0,
    }
  }
}

const byPlugin = aggregate.byPlugin.map((row) => ({
  ...row,
  reward: previewReward(row.tokens, { mode: 'share', shareRate: 0.3, pricePerMTokens: 0.5 }),
}))
const report = {
  home,
  consent: {
    policy: consent.policy,
    reporting: consent.reporting,
    needsConsent: consent.needsConsent !== false,
    never: (consent.never || []).length,
    revoked: (consent.revoked || []).length,
  },
  preferences,
  toolOwners,
  catalog,
  ledger: {
    ok: verification.ok,
    events: verification.count,
    root: verification.root,
    problems: verification.problems.slice(0, 5),
  },
  tokens: {
    attributed: totalOf(aggregate.totals),
    unattributed: totalOf(aggregate.unattributed),
    byPlugin,
  },
  installs,
  receipts: receipts.slice(0, 5),
  batches,
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const lines = []
lines.push('插件工坊 / Plugin Foundry — 本机状态')
lines.push(`目录: ${home}`)
lines.push('')
lines.push(`授权: policy=${report.consent.policy}  reporting=${report.consent.reporting}  needsConsent=${report.consent.needsConsent}`)
if (report.consent.needsConsent) lines.push('  → 刷新页面会弹出冷启授权卡；选完写入 consent.json')
if (report.consent.never > 0 || report.consent.revoked > 0) {
  lines.push(`  永久抑制: never=${report.consent.never}  revoked=${report.consent.revoked}`)
}
if (catalog) {
  lines.push(`目录缓存: ${catalog.entries} 条 · ${new Date(catalog.fetchedAt).toLocaleString('zh-CN')}`)
} else {
  lines.push('目录缓存: 尚未拉取（宿主启动后会自动拉取）')
}
lines.push('')
lines.push(`账本: ${verification.ok ? '校验通过' : '校验失败'} · ${verification.count} 条事件`)
if (!verification.ok) {
  for (const problem of verification.problems.slice(0, 5)) lines.push(`  ! ${JSON.stringify(problem)}`)
}
lines.push(`归因 token: ${report.tokens.attributed}  ·  未归因: ${report.tokens.unattributed}`)
for (const row of byPlugin.slice(0, 8)) {
  lines.push(`  ${row.plugin_id}  ${totalOf(row.tokens)} token  ${row.requests} 请求  ${row.tool_calls} 工具调用  预览 ${formatMicros(row.reward.developerMicros || 0)}`)
}
if (byPlugin.length === 0) lines.push('  （还没有归因事件：需要先用插件工具，并在 tool-owners.json 里有映射）')
lines.push('')
lines.push(`安装记录: ${installs.length}`)
for (const row of installs.slice(0, 5)) lines.push(`  ${row.package} · ${row.mode} · ${row.effective} · ${new Date(row.at).toLocaleString('zh-CN')}`)
lines.push(`工具归属映射: ${Object.keys(toolOwners).length} 条`)
for (const [tool, owner] of Object.entries(toolOwners).slice(0, 6)) lines.push(`  ${tool} -> ${owner}`)
lines.push(`批次: ${batches.length}`)
for (const row of batches.slice(-5)) lines.push(`  ${row.batch_id}  ${row.status}  ${row.event_count} 事件`)
lines.push('')
lines.push('提示: 这是只读检查。完整演示（含结算与开发者门户）运行 npm run demo。')
console.log(lines.join('\n'))
