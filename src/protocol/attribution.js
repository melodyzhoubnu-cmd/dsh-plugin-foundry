/**
 * Token attribution.
 *
 * One request can touch several plugins. The protocol uses three
 * non-overlapping buckets:
 *
 *   base          request input/output/reasoning/cache, split across the
 *                 plugins whose tools appear in the request;
 *   tool_result   the tool's returned content, assigned to its owner;
 *   capability    capability signals and receipts injected by distribution,
 *                 assigned to the plugin they are about.
 *
 * The three buckets may not exceed the request's billable tokens. When they
 * do, every field is scaled down proportionally and the remainder is reported
 * as unattributed. Nothing here guesses an owner: an unmapped tool stays
 * unattributed.
 */
import { estimateTokens } from './tokens.js'

export const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']

export const EMPTY_TOKENS = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })

const INPUT_KEYS = ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'input']
const OUTPUT_KEYS = ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'output']
const CACHE_READ_KEYS = ['cacheReadTokens', 'cache_read_input_tokens', 'cacheRead', 'cachedTokens', 'cached_tokens']
const CACHE_WRITE_KEYS = ['cacheWriteTokens', 'cache_write_input_tokens', 'cacheWrite']
const REASONING_KEYS = ['reasoningTokens', 'reasoning_tokens', 'reasoning']

function firstNumber(source, keys) {
  if (!source || typeof source !== 'object') return 0
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value)
  }
  return 0
}

/** Accept the provider shapes DSH sees (TokenUsage, OpenAI-ish, snake_case). */
export function normalizeUsage(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const details = source.input_tokens_details || source.prompt_tokens_details || source.promptTokensDetails || {}
  const outputDetails = source.output_tokens_details || source.completion_tokens_details || {}
  const cacheRead = firstNumber(source, CACHE_READ_KEYS) || firstNumber(details, ['cached_tokens', 'cacheReadTokens'])
  return {
    input: firstNumber(source, INPUT_KEYS),
    output: firstNumber(source, OUTPUT_KEYS),
    cacheRead,
    cacheWrite: firstNumber(source, CACHE_WRITE_KEYS) || firstNumber(details, ['cache_write_tokens', 'cacheWriteTokens']),
    reasoning: firstNumber(source, REASONING_KEYS) || firstNumber(outputDetails, ['reasoning_tokens', 'reasoningTokens']),
  }
}

export function zeroTokens() {
  return { ...EMPTY_TOKENS }
}

export function tokensOf(value) {
  const source = value && typeof value === 'object' ? value : {}
  const out = {}
  for (const field of TOKEN_FIELDS) out[field] = Number.isFinite(source[field]) && source[field] > 0 ? Math.trunc(source[field]) : 0
  return out
}

export function totalOf(tokens) {
  return TOKEN_FIELDS.reduce((sum, field) => sum + (Number(tokens[field]) || 0), 0)
}

export function addTokens(target, source) {
  for (const field of TOKEN_FIELDS) target[field] = (target[field] || 0) + (Number(source[field]) || 0)
  return target
}

export function subtractTokens(target, source) {
  for (const field of TOKEN_FIELDS) target[field] = Math.max(0, (target[field] || 0) - (Number(source[field]) || 0))
  return target
}

export function scaleTokens(tokens, ratio) {
  const out = {}
  for (const field of TOKEN_FIELDS) out[field] = Math.round((Number(tokens[field]) || 0) * ratio)
  return out
}

/** Largest-remainder integer split; the sum is exactly `amount`. */
export function splitAmount(amount, weights) {
  const total = Math.max(0, Math.trunc(amount))
  const list = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0))
  const sum = list.reduce((acc, weight) => acc + weight, 0)
  if (sum === 0 || total === 0) return list.map(() => 0)
  const raw = list.map((weight) => (total * weight) / sum)
  const out = raw.map(Math.floor)
  let remainder = total - out.reduce((acc, value) => acc + value, 0)
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let i = 0; i < order.length && remainder > 0; i++) {
    out[order[i].index] += 1
    remainder -= 1
  }
  return out
}

function splitTokens(tokens, weights) {
  const fields = {}
  for (const field of TOKEN_FIELDS) fields[field] = splitAmount(tokens[field] || 0, weights)
  const rows = weights.map(() => ({}))
  for (const field of TOKEN_FIELDS) {
    rows.forEach((row, index) => {
      row[field] = fields[field][index]
    })
  }
  return rows
}

function mergeRows(rows) {
  const map = new Map()
  for (const row of rows) {
    if (!row || !row.pluginId) continue
    const key = `${row.pluginId}\u0000${row.bucket}`
    let target = map.get(key)
    if (!target) {
      target = { pluginId: row.pluginId, bucket: row.bucket, tokens: zeroTokens() }
      map.set(key, target)
    }
    addTokens(target.tokens, row.tokens)
  }
  return [...map.values()]
}

function scaleToLimits(rows, limits) {
  for (const field of TOKEN_FIELDS) {
    const used = rows.reduce((sum, row) => sum + (row.tokens[field] || 0), 0)
    const limit = limits[field] || 0
    if (used <= limit || used === 0) continue
    let assigned = 0
    rows.forEach((row, index) => {
      const value = row.tokens[field] || 0
      const scaled = index === rows.length - 1
        ? limit - assigned
        : Math.floor((value * limit) / used)
      row.tokens[field] = Math.max(0, Math.min(value, scaled))
      assigned += row.tokens[field]
    })
  }
  return rows
}

/**
 * @param {object} request
 * @param {object} request.usage normalized or provider-shaped usage
 * @param {Array<{name: string, owner: string|null, resultTokens?: number}>} request.toolCalls
 * @param {Array<{pluginId: string, tokens: number}|{pluginId: string, text: string}>} request.capability
 * @param {'size'|'count'} request.strategy
 */
export function attributeRequest({ usage, toolCalls = [], capability = [], strategy = 'size' } = {}) {
  const tokens = normalizeUsage(usage)
  const limits = { ...tokens }
  const total = totalOf(tokens)
  const rows = []

  const owners = new Map()
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!call || typeof call.owner !== 'string' || !call.owner) continue
    const resultTokens = Math.max(0, Math.trunc(call.resultTokens || 0))
    const weight = strategy === 'size' ? 1 + Math.sqrt(resultTokens) : 1
    owners.set(call.owner, (owners.get(call.owner) || 0) + weight)
  }
  if (owners.size > 0) {
    const weights = [...owners.values()]
    const pluginIds = [...owners.keys()]
    const splits = splitTokens(tokens, weights)
    splits.forEach((part, index) => {
      rows.push({ pluginId: pluginIds[index], bucket: 'base', tokens: part })
    })
  }

  const byOwner = new Map()
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!call || typeof call.owner !== 'string' || !call.owner) continue
    const resultTokens = Math.max(0, Math.trunc(call.resultTokens || 0))
    if (resultTokens <= 0) continue
    byOwner.set(call.owner, (byOwner.get(call.owner) || 0) + resultTokens)
  }
  for (const [pluginId, resultTokens] of byOwner) {
    rows.push({ pluginId, bucket: 'tool_result', tokens: { ...zeroTokens(), input: resultTokens } })
  }

  for (const signal of Array.isArray(capability) ? capability : []) {
    if (!signal || typeof signal.pluginId !== 'string' || !signal.pluginId) continue
    const signalTokens = Number.isFinite(signal.tokens)
      ? Math.max(0, Math.trunc(signal.tokens))
      : estimateTokens(signal.text || '')
    if (signalTokens <= 0) continue
    rows.push({ pluginId: signal.pluginId, bucket: 'capability', tokens: { ...zeroTokens(), input: signalTokens } })
  }

  const merged = mergeRows(rows)
  scaleToLimits(merged, limits)
  const attributed = zeroTokens()
  const output = []
  for (const row of merged) {
    const rowTotal = totalOf(row.tokens)
    if (rowTotal <= 0) continue
    addTokens(attributed, row.tokens)
    output.push({ ...row, share: total > 0 ? roundShare(rowTotal / total) : 0 })
  }
  output.sort((a, b) => a.pluginId.localeCompare(b.pluginId) || a.bucket.localeCompare(b.bucket))
  const unattributed = { ...limits }
  subtractTokens(unattributed, attributed)
  return { rows: output, total, attributed, unattributed }
}

function roundShare(value) {
  return Math.round(value * 1e6) / 1e6
}

export function aggregateEvents(events) {
  const byPlugin = new Map()
  const unattributed = zeroTokens()
  for (const event of Array.isArray(events) ? events : []) {
    const tokens = tokensOf(event.tokens)
    if (!event.plugin_id) {
      addTokens(unattributed, tokens)
      continue
    }
    let row = byPlugin.get(event.plugin_id)
    if (!row) {
      row = {
        plugin_id: event.plugin_id,
        publisher: event.publisher || null,
        tokens: zeroTokens(),
        requests: new Set(),
        tool_calls: 0,
      }
      byPlugin.set(event.plugin_id, row)
    }
    addTokens(row.tokens, tokens)
    if (event.request_id) row.requests.add(event.request_id)
    if (event.bucket === 'tool_result') row.tool_calls += 1
  }
  const rows = [...byPlugin.values()]
    .map((row) => ({
      plugin_id: row.plugin_id,
      publisher: row.publisher,
      tokens: row.tokens,
      requests: row.requests.size,
      tool_calls: row.tool_calls,
    }))
    .sort((a, b) => a.plugin_id.localeCompare(b.plugin_id))
  return {
    byPlugin: rows,
    unattributed,
    totals: rows.reduce((sum, row) => addTokens(sum, row.tokens), zeroTokens()),
  }
}

/**
 * Last line of defence: a host's attribution in a period may not exceed the
 * provider's actual bill. The bill is the external anchor; a violation scales
 * every line and is reported as a dispute instead of silently accepted.
 */
export function reconcile(attributedTotal, billTokens) {
  const attributed = Math.max(0, Math.trunc(attributedTotal))
  const anchor = billTokens === null || billTokens === undefined ? null : Math.max(0, Math.trunc(billTokens))
  if (anchor === null) return { ok: true, anchor: null, ratio: 1, dispute: null }
  if (attributed <= anchor) return { ok: true, anchor, ratio: anchor > 0 ? attributed / anchor : 1, dispute: null }
  return {
    ok: false,
    anchor,
    ratio: anchor / attributed,
    dispute: {
      kind: 'over-anchor',
      attributed,
      anchor,
      excess: attributed - anchor,
    },
  }
}

/** Scale every aggregated row so the attributed sum matches `ratio`. */
export function scaleAggregates(rows, ratio) {
  const out = []
  for (const row of rows) {
    const tokens = scaleTokens(row.tokens, ratio)
    const total = totalOf(tokens)
    if (total <= 0) continue
    out.push({ ...row, tokens })
  }
  return out
}
