/**
 * Server-rendered developer portal pages.
 *
 * These are ordinary HTML pages served by the reference platform, not Host UI
 * inside DSH. They share no theme tokens with the GUI on purpose: a developer
 * portal is a separate product surface.
 */
import { computeLine, formatMicros, resolveRates } from '../protocol/settlement.js'
import { totalOf } from '../protocol/attribution.js'

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const BASE_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f6f7fb;color:#16181d;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif}
a{color:#4059e8}
.wrap{max-width:1040px;margin:0 auto;padding:32px 20px 64px}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:24px}
h1{font-size:24px;line-height:1.25;margin:0 0 6px}
h2{font-size:16px;margin:32px 0 12px}
.sub{color:#666a75;font-size:13px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#e8ecff;color:#3146c9;font-size:12px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.card{background:#fff;border:1px solid #e6e8ef;border-radius:14px;padding:16px}
.card .label{font-size:12px;color:#6b7080;margin-bottom:6px}
.card .value{font-size:22px;font-weight:650;letter-spacing:-.01em}
.card .hint{font-size:12px;color:#8a8f9e;margin-top:4px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e6e8ef;border-radius:14px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;font-size:13px;border-bottom:1px solid #eef0f5;vertical-align:top}
th{background:#fafbfe;color:#5b606f;font-weight:600;font-size:12px}
tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.muted{color:#7b8090}
.chart{display:flex;align-items:flex-end;gap:6px;height:110px;background:#fff;border:1px solid #e6e8ef;border-radius:14px;padding:14px}
.bar{flex:1;min-width:8px;background:linear-gradient(180deg,#7b8cf7,#4059e8);border-radius:6px 6px 2px 2px;position:relative}
.bar span{position:absolute;bottom:-20px;left:0;right:0;text-align:center;font-size:10px;color:#8a8f9e}
.foot{margin-top:28px;color:#8a8f9e;font-size:12px;line-height:1.7}
.notice{background:#fff8e6;border:1px solid #f3dfae;border-radius:12px;padding:12px 14px;font-size:13px;color:#6d5313}
.ok{background:#eaf7ee;border:1px solid #bfe5c9;color:#1d6b36}
button{font:inherit;font-size:14px;padding:9px 18px;border-radius:10px;border:1px solid #4059e8;background:#4059e8;color:#fff;cursor:pointer}
input{font:inherit;padding:8px 10px;border:1px solid #d5d8e2;border-radius:9px;width:100%}
pre{background:#0f1420;color:#d7dcf5;padding:16px;border-radius:12px;overflow:auto;font-size:12px;line-height:1.55}
`

function page(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${BASE_CSS}</style></head><body><div class="wrap">${body}</div></body></html>`
}

export function renderPortal({
  publisher,
  publisherName,
  stats,
  settlements,
  batches,
  entries,
  hosts,
  rates = {},
  generatedAt = Date.now(),
}) {
  const entriesById = new Map()
  for (const entry of entries || []) {
    entriesById.set(entry.pluginId, entry)
    entriesById.set(`pkg:npm/${entry.name}@${entry.version}`, entry)
    entriesById.set(entry.name, entry)
  }
  const config = resolveRates(rates, '')
  const lines = (stats.byPlugin || []).map((row) => {
    const entry = entriesById.get(row.plugin_id) || null
    return {
      row,
      entry,
      line: computeLine(row, rates),
    }
  })
  const developerMicros = lines.reduce((sum, item) => sum + item.line.developer_micros, 0)
  const revenueMicros = lines.reduce((sum, item) => sum + item.line.revenue_micros, 0)
  const rebateTokens = lines.reduce((sum, item) => sum + item.line.rebate_tokens, 0)
  const maxDay = Math.max(1, ...(stats.byDay || []).map((day) => totalOf(day.tokens)))
  const settlementTotal = (settlements || []).reduce((sum, statement) => sum + (statement.totals ? statement.totals.developer_micros : 0), 0)
  const allDisputes = (batches || []).flatMap((batch) => (batch.disputes || []).map((dispute) => ({ batch, dispute })))

  const header = `
    <header>
      <div>
        <div class="badge">开发者门户 · 参考实现</div>
        <h1>${escapeHtml(publisherName || publisher || '开发者')}</h1>
        <div class="sub">${escapeHtml(publisher || '')} · 生成于 ${escapeHtml(new Date(generatedAt).toLocaleString('zh-CN'))}</div>
      </div>
      <div class="sub" style="text-align:right">平台只做计量、对账与 token 分成<br>自收费与交易由开发者自行处理</div>
    </header>`

  const cards = `
    <div class="grid">
      <div class="card"><div class="label">归因 token</div><div class="value">${totalOf(stats.totals).toLocaleString('en-US')}</div><div class="hint">${stats.requests} 次请求 · ${stats.tool_calls} 次工具调用</div></div>
      <div class="card"><div class="label">token 收入</div><div class="value">${formatMicros(revenueMicros, config.currency)}</div><div class="hint">按 ${escapeHtml(String(config.pricePerMTokens))} 微单位 / token</div></div>
      <div class="card"><div class="label">开发者所得</div><div class="value">${formatMicros(developerMicros, config.currency)}</div><div class="hint">分成比例 ${Math.round(config.shareRate * 100)}%</div></div>
      <div class="card"><div class="label">返点</div><div class="value">${rebateTokens.toLocaleString('en-US')}</div><div class="hint">token 配额 · 与分成互斥</div></div>
      <div class="card"><div class="label">已结算</div><div class="value">${formatMicros(settlementTotal, config.currency)}</div><div class="hint">${(settlements || []).length} 份结算单</div></div>
    </div>`

  const chart = (stats.byDay || []).length > 0
    ? `<h2>按日用量</h2><div class="chart">${stats.byDay.map((day) => {
      const height = Math.max(2, Math.round((totalOf(day.tokens) / maxDay) * 82))
      return `<div class="bar" style="height:${height}px" title="${escapeHtml(day.day)}: ${totalOf(day.tokens)} tokens"><span>${escapeHtml(day.day.slice(5))}</span></div>`
    }).join('')}</div>`
    : '<h2>按日用量</h2><div class="card muted">还没有已接受的批次。</div>'

  const table = lines.length > 0
    ? `<table>
        <thead><tr><th>插件</th><th>类目</th><th class="num">token</th><th class="num">请求</th><th class="num">工具调用</th><th>口径</th><th class="num">收入</th><th class="num">开发者所得</th><th class="num">返点</th></tr></thead>
        <tbody>${lines.map(({ row, entry, line }) => `
          <tr>
            <td><strong>${escapeHtml(entry ? entry.title : row.plugin_id)}</strong><div class="mono muted">${escapeHtml(row.plugin_id)}</div></td>
            <td>${escapeHtml((entry && entry.category) || '—')}</td>
            <td class="num">${totalOf(row.tokens).toLocaleString('en-US')}</td>
            <td class="num">${row.requests}</td>
            <td class="num">${row.tool_calls}</td>
            <td>${line.basis === 'rebate' ? '返点' : '分成'}</td>
            <td class="num">${formatMicros(line.revenue_micros, config.currency)}</td>
            <td class="num">${formatMicros(line.developer_micros, config.currency)}</td>
            <td class="num">${line.rebate_tokens.toLocaleString('en-US')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`
    : '<div class="card muted">还没有按插件的用量。等 Host 上报批次后再看。</div>'

  const settlementTable = (settlements || []).length > 0
    ? `<table><thead><tr><th>结算单</th><th>周期</th><th>口径</th><th class="num">token</th><th class="num">开发者所得</th><th class="mono">签名</th></tr></thead><tbody>${settlements.map((statement) => `
        <tr>
          <td class="mono">${escapeHtml(statement.settlement_id)}</td>
          <td>${escapeHtml(statement.period.start)} → ${escapeHtml(statement.period.end)}</td>
          <td>${(statement.lines || []).map((line) => line.basis).filter((basis, index, list) => list.indexOf(basis) === index).join(' / ') || '—'}</td>
          <td class="num">${totalOf(statement.totals.tokens).toLocaleString('en-US')}</td>
          <td class="num">${formatMicros(statement.totals.developer_micros, statement.currency)}</td>
          <td class="mono">${escapeHtml(String(statement.sig).slice(0, 18))}…</td>
        </tr>`).join('')}</tbody></table>`
    : '<div class="card muted">还没有结算单。调用 GET /v1/settlements 生成一份。</div>'

  const batchTable = (batches || []).length > 0
    ? `<table><thead><tr><th>批次</th><th>Host</th><th>周期</th><th class="num">事件</th><th>状态</th><th>争议</th></tr></thead><tbody>${batches.slice(-12).reverse().map((batch) => `
        <tr>
          <td class="mono">${escapeHtml(batch.batch_id)}</td>
          <td class="mono">${escapeHtml(batch.host_id.slice(0, 18))}…</td>
          <td>${escapeHtml(String(batch.period.start).slice(0, 10))}</td>
          <td class="num">${batch.event_count}</td>
          <td>${escapeHtml(batch.status)}</td>
          <td>${(batch.disputes || []).map((dispute) => escapeHtml(dispute.kind)).join(', ') || '—'}</td>
        </tr>`).join('')}</tbody></table>`
    : '<div class="card muted">还没有批次。</div>'

  const disputeBlock = allDisputes.length > 0
    ? `<h2>对账争议</h2><div class="notice">${allDisputes.map(({ batch, dispute }) => `${escapeHtml(batch.batch_id)}: ${escapeHtml(dispute.kind)}${dispute.attributed ? `（归因 ${dispute.attributed.tokens || dispute.attributed} > 账单 ${dispute.anchor}）` : ''}`).join('<br>')}</div>`
    : ''

  const hostBlock = (hosts || []).length > 0
    ? `<h2>Host</h2><table><thead><tr><th>Host</th><th>安装</th><th>运行时</th><th>注册时间</th></tr></thead><tbody>${hosts.map((host) => `
        <tr><td class="mono">${escapeHtml(host.hostId)}</td><td class="mono">${escapeHtml(host.installId)}</td><td>${escapeHtml(host.runtimeVersion || '—')}</td><td>${escapeHtml(new Date(host.registeredAt).toLocaleString('zh-CN'))}</td></tr>`).join('')}</tbody></table>`
    : ''

  return page('开发者门户', `${header}${cards}${chart}<h2>按插件</h2>${table}<h2>结算</h2>${settlementTable}${disputeBlock}<h2>批次</h2>${batchTable}${hostBlock}
    <div class="foot">计量只统计经过 DSH 工具管线的调用；未归因部分不计入任何开发者。结算口径为分成或返点，同一笔用量只取一种。<br>此页面是参考实现，数据来自本地 JSON 存储。</div>`)
}

export function renderMessage(title, text, tone = 'notice') {
  return page(title, `<header><div><h1>${escapeHtml(title)}</h1></div></header><div class="${tone}">${escapeHtml(text)}</div>`)
}

export function portalJson({ publisher, stats, settlements, batches, entries, rates }) {
  return {
    publisher,
    generated_at: Date.now(),
    totals: stats.totals,
    requests: stats.requests,
    tool_calls: stats.tool_calls,
    by_plugin: stats.byPlugin.map((row) => ({
      ...row,
      line: computeLine(row, rates),
    })),
    by_day: stats.byDay,
    settlements,
    batches,
    entries: (entries || []).map((entry) => ({ plugin_id: entry.pluginId, name: entry.name, title: entry.title, quality: entry.quality })),
  }
}
