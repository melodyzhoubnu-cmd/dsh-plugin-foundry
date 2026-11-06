/**
 * Settlement: turn attributable tokens into a developer payout in one basis.
 *
 * Two bases, never both for the same usage:
 *   share   attributed token revenue × developer share, paid as money;
 *   rebate  attributed tokens × rebate rate, paid as token credit.
 *
 * Money is integer micro-units (1e-6 of the currency) so a statement has no
 * floating point drift and can be recomputed by any third party.
 */
import { randomId, signCanonical, verifyCanonical } from './canonical.js'
import { addTokens, tokensOf, totalOf, zeroTokens } from './attribution.js'
import { assertValid, validateSettlement } from './schema.js'

export const DEFAULT_RATES = Object.freeze({
  currency: 'USD',
  defaultBasis: 'share',
  shareRate: 0.3,
  // Micro-units per attributed token. 0.5 means USD 0.50 per 1M tokens.
  pricePerMTokens: 0.5,
  rebateRate: 0.1,
  plugins: {},
})

export function resolveRates(rates, pluginId) {
  const base = { ...DEFAULT_RATES, ...(rates && typeof rates === 'object' ? rates : {}) }
  const override = base.plugins && base.plugins[pluginId] ? base.plugins[pluginId] : {}
  const merged = { ...base, ...override }
  const requestedBasis = merged.basis || merged.mode
  merged.basis = requestedBasis === 'rebate' ? 'rebate' : merged.defaultBasis === 'rebate' ? 'rebate' : 'share'
  merged.shareRate = clamp(merged.shareRate, 0, 1, DEFAULT_RATES.shareRate)
  merged.rebateRate = clamp(merged.rebateRate, 0, 1, DEFAULT_RATES.rebateRate)
  merged.pricePerMTokens = clamp(merged.pricePerMTokens, 0, 1e6, DEFAULT_RATES.pricePerMTokens)
  merged.currency = typeof merged.currency === 'string' && merged.currency ? merged.currency : 'USD'
  return merged
}

function clamp(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * @param {{tokens: object, requests?: number, tool_calls?: number, plugin_id: string, publisher?: string}} row
 */
export function computeLine(row, rates) {
  const config = resolveRates(rates, row.plugin_id)
  const tokens = tokensOf(row.tokens)
  const total = totalOf(tokens)
  const line = {
    plugin_id: row.plugin_id,
    publisher: row.publisher || '',
    tokens,
    requests: Number(row.requests) || 0,
    tool_calls: Number(row.tool_calls) || 0,
    basis: config.basis,
    revenue_micros: 0,
    developer_micros: 0,
    rebate_tokens: 0,
    share_rate: config.shareRate,
    rebate_rate: config.rebateRate,
    price_per_mtokens: config.pricePerMTokens,
  }
  if (config.basis === 'share') {
    line.revenue_micros = Math.round(total * config.pricePerMTokens)
    line.developer_micros = Math.round(line.revenue_micros * config.shareRate)
  } else {
    line.rebate_tokens = Math.round(total * config.rebateRate)
  }
  return line
}

export function settle({
  publisher,
  period,
  totals,
  rates = DEFAULT_RATES,
  meterKey,
  privateKey,
  now = Date.now(),
  currency,
} = {}) {
  const merged = mergeTotals(totals)
  const lines = merged
    .filter((row) => !publisher || row.publisher === publisher)
    .map((row) => computeLine(row, rates))
    .sort((a, b) => a.plugin_id.localeCompare(b.plugin_id))
  const totalsOut = lines.reduce(
    (acc, line) => {
      addTokens(acc.tokens, line.tokens)
      acc.revenue_micros += line.revenue_micros
      acc.developer_micros += line.developer_micros
      acc.rebate_tokens += line.rebate_tokens
      acc.requests += line.requests
      acc.tool_calls += line.tool_calls
      return acc
    },
    { tokens: zeroTokens(), revenue_micros: 0, developer_micros: 0, rebate_tokens: 0, requests: 0, tool_calls: 0 },
  )
  const resolvedCurrency = typeof currency === 'string' && currency ? currency : resolveRates(rates, '').currency
  const payload = {
    schema: 1,
    settlement_id: `s_${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}_${String(publisher || 'all').replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'all'}_${randomId('', 3)}`,
    publisher: publisher || 'all',
    meter_key: meterKey,
    currency: resolvedCurrency,
    period,
    created_at: now,
    lines,
    totals: totalsOut,
  }
  const statement = { ...payload, sig: signCanonical(payload, privateKey) }
  assertValid(validateSettlement(statement), 'settlement')
  return statement
}

export function verifySettlement(statement, publicKey) {
  const shape = validateSettlement(statement)
  if (!shape.ok) return { ok: false, errors: shape.errors, reason: 'invalid-shape' }
  const body = { ...statement }
  delete body.sig
  if (!verifyCanonical(body, statement.sig, publicKey)) return { ok: false, errors: [], reason: 'bad-signature' }
  const recomputed = statement.lines.reduce(
    (acc, line) => {
      addTokens(acc.tokens, line.tokens)
      acc.revenue_micros += line.revenue_micros
      acc.developer_micros += line.developer_micros
      acc.rebate_tokens += line.rebate_tokens
      return acc
    },
    { tokens: zeroTokens(), revenue_micros: 0, developer_micros: 0, rebate_tokens: 0 },
  )
  for (const field of ['revenue_micros', 'developer_micros', 'rebate_tokens']) {
    if (recomputed[field] !== statement.totals[field]) return { ok: false, errors: [], reason: `totals-${field}` }
  }
  if (totalOf(recomputed.tokens) !== totalOf(statement.totals.tokens)) {
    return { ok: false, errors: [], reason: 'totals-tokens' }
  }
  return { ok: true, errors: [], reason: null }
}

function mergeTotals(totals) {
  const map = new Map()
  for (const row of Array.isArray(totals) ? totals : []) {
    if (!row || !row.plugin_id) continue
    let target = map.get(row.plugin_id)
    if (!target) {
      target = { plugin_id: row.plugin_id, publisher: row.publisher || '', tokens: zeroTokens(), requests: 0, tool_calls: 0 }
      map.set(row.plugin_id, target)
    }
    addTokens(target.tokens, tokensOf(row.tokens))
    target.requests += Number(row.requests) || 0
    target.tool_calls += Number(row.tool_calls) || 0
    if (!target.publisher && row.publisher) target.publisher = row.publisher
  }
  return [...map.values()]
}

/** Local, unsigned preview used by `report` before anything is uploaded. */
export function previewReward(tokens, reward = {}) {
  const config = resolveRates(reward.rates || reward, reward.pluginId || '')
  const total = typeof tokens === 'number' ? tokens : totalOf(tokens)
  if (config.basis === 'rebate') {
    return {
      basis: 'rebate',
      rebateTokens: Math.round(total * config.rebateRate),
      rebateRate: config.rebateRate,
      currency: config.currency,
    }
  }
  const revenueMicros = Math.round(total * config.pricePerMTokens)
  return {
    basis: 'share',
    revenueMicros,
    developerMicros: Math.round(revenueMicros * config.shareRate),
    shareRate: config.shareRate,
    currency: config.currency,
  }
}

const SYMBOLS = { USD: '$', CNY: '¥', EUR: '€', GBP: '£', JPY: '¥' }

export function formatMicros(micros, currency = 'USD') {
  const value = (Number(micros) || 0) / 1e6
  const symbol = SYMBOLS[currency] || ''
  const text = value >= 1 ? value.toFixed(2) : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return `${symbol}${text}${symbol ? '' : ` ${currency}`}`
}
