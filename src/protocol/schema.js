/**
 * Structural validators for the public protocol documents.
 *
 * These are intentionally dependency-free and conservative: a validator
 * answers "can a third party read this safely?", not "is this economically
 * correct". Economic checks (reconciliation, duplicate settlement) live in
 * settlement.js.
 */
import { GENESIS_HASH } from './canonical.js'

export class ProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.details = details
  }
}

const HEX64 = /^[0-9a-f]{64}$/
const HEX = /^[0-9a-f]+$/
const BUCKETS = new Set(['base', 'tool_result', 'capability'])
const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
const BASES = new Set(['share', 'rebate'])
const PRICING_MODELS = new Set(['free', 'one-time', 'subscription', 'pay-what-you-want', 'sponsor', 'external'])

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isString = (value) => typeof value === 'string'
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0
const isNonNegInt = (value) => Number.isInteger(value) && value >= 0
const isPositiveInt = (value) => Number.isInteger(value) && value > 0
const isHex64 = (value) => typeof value === 'string' && HEX64.test(value)
const isShare = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const isIsoDate = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value))

function add(errors, path, message) {
  errors.push({ path, message })
}

export function validateTokens(tokens, path, errors) {
  if (!isObject(tokens)) {
    add(errors, path, 'tokens must be an object')
    return false
  }
  let ok = true
  for (const field of TOKEN_FIELDS) {
    const value = tokens[field]
    if (value !== undefined && !isNonNegInt(value)) {
      add(errors, `${path}.${field}`, 'must be a non-negative integer')
      ok = false
    }
  }
  const any = TOKEN_FIELDS.some((field) => tokens[field] !== undefined)
  if (!any) add(errors, path, 'at least one token field is required')
  return ok && any
}

function requireString(object, key, path, errors, { allowEmpty = false, nullable = false } = {}) {
  const value = object[key]
  if (nullable && (value === null || value === undefined)) return
  if (!(allowEmpty ? isString(value) : isNonEmptyString(value))) {
    add(errors, `${path}.${key}`, 'must be a non-empty string')
  }
}

function requireInt(object, key, path, errors, { positive = false } = {}) {
  const value = object[key]
  const valid = positive ? isPositiveInt(value) : isNonNegInt(value)
  if (!valid) add(errors, `${path}.${key}`, positive ? 'must be a positive integer' : 'must be a non-negative integer')
}

function requireHash(object, key, path, errors) {
  if (!isHex64(object[key])) add(errors, `${path}.${key}`, 'must be a lowercase sha256 hex string')
}

function validatePeriod(period, path, errors, dateStrings = false) {
  if (!isObject(period)) {
    add(errors, path, 'period must be an object')
    return
  }
  const check = dateStrings ? isIsoDate : isNonNegInt
  if (!check(period.start)) add(errors, `${path}.start`, dateStrings ? 'must be an ISO date' : 'must be an epoch millisecond')
  if (!check(period.end)) add(errors, `${path}.end`, dateStrings ? 'must be an ISO date' : 'must be an epoch millisecond')
}

export function validateTotalRow(row, path, errors) {
  if (!isObject(row)) {
    add(errors, path, 'must be an object')
    return
  }
  requireString(row, 'plugin_id', path, errors)
  requireString(row, 'publisher', path, errors, { nullable: true })
  validateTokens(row.tokens, `${path}.tokens`, errors)
  requireInt(row, 'requests', path, errors)
  requireInt(row, 'tool_calls', path, errors)
}

export function validateUsageEvent(event) {
  const errors = []
  if (!isObject(event)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] }
  if (event.schema !== 1) add(errors, 'schema', 'must be 1')
  requireString(event, 'plugin_id', '', errors, { nullable: true })
  requireString(event, 'publisher', '', errors, { nullable: true })
  requireString(event, 'tool', '', errors, { nullable: true })
  requireString(event, 'request_id', '', errors)
  if (!isString(event.session_hash) || !HEX.test(event.session_hash) || event.session_hash.length < 8) {
    add(errors, 'session_hash', 'must be a hex string of at least 8 characters')
  }
  validateTokens(event.tokens, 'tokens', errors)
  if (!isShare(event.share)) add(errors, 'share', 'must be a number in [0, 1]')
  if (!BUCKETS.has(event.bucket)) add(errors, 'bucket', 'must be base, tool_result or capability')
  requireString(event, 'meter_key', '', errors, { nullable: true })
  requireInt(event, 'ts', '', errors, { positive: true })
  if (event.prev_hash !== undefined && !isHex64(event.prev_hash) && event.prev_hash !== GENESIS_HASH) {
    add(errors, 'prev_hash', 'must be a sha256 hex string')
  }
  if (event.hash !== undefined && !isHex64(event.hash)) add(errors, 'hash', 'must be a sha256 hex string')
  if (event.seq !== undefined && !isNonNegInt(event.seq)) add(errors, 'seq', 'must be a non-negative integer')
  return { ok: errors.length === 0, errors }
}

export function validateReceipt(receipt) {
  const errors = []
  if (!isObject(receipt)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] }
  if (receipt.schema !== 1) add(errors, 'schema', 'must be 1')
  for (const key of ['receipt_id', 'host_id', 'install_id', 'sig']) requireString(receipt, key, '', errors)
  validatePeriod(receipt.period, 'period', errors)
  requireHash(receipt, 'root', '', errors)
  requireInt(receipt, 'event_count', '', errors)
  if (!Array.isArray(receipt.totals)) add(errors, 'totals', 'must be an array')
  else receipt.totals.forEach((row, index) => validateTotalRow(row, `totals[${index}]`, errors))
  if (receipt.leaves !== undefined && !Array.isArray(receipt.leaves)) add(errors, 'leaves', 'must be an array of hashes')
  return { ok: errors.length === 0, errors }
}

export function validateBatch(batch) {
  const errors = []
  if (!isObject(batch)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] }
  if (batch.schema !== 1) add(errors, 'schema', 'must be 1')
  for (const key of ['batch_id', 'host_id', 'install_id', 'runtime_version', 'sig']) {
    requireString(batch, key, '', errors)
  }
  validatePeriod(batch.period, 'period', errors, true)
  requireHash(batch, 'root', '', errors)
  requireHash(batch, 'prev', '', errors)
  requireInt(batch, 'event_count', '', errors)
  requireInt(batch, 'created_at', '', errors, { positive: true })
  if (!Array.isArray(batch.totals)) add(errors, 'totals', 'must be an array')
  else batch.totals.forEach((row, index) => validateTotalRow(row, `totals[${index}]`, errors))
  if (batch.unattributed !== undefined) validateTokens(batch.unattributed, 'unattributed', errors)
  return { ok: errors.length === 0, errors }
}

export function validateSettlement(statement) {
  const errors = []
  if (!isObject(statement)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] }
  if (statement.schema !== 1) add(errors, 'schema', 'must be 1')
  for (const key of ['settlement_id', 'publisher', 'meter_key', 'currency', 'sig']) {
    requireString(statement, key, '', errors)
  }
  validatePeriod(statement.period, 'period', errors, true)
  requireInt(statement, 'created_at', '', errors, { positive: true })
  if (!Array.isArray(statement.lines)) add(errors, 'lines', 'must be an array')
  else {
    statement.lines.forEach((line, index) => {
      const path = `lines[${index}]`
      if (!isObject(line)) {
        add(errors, path, 'must be an object')
        return
      }
      requireString(line, 'plugin_id', path, errors)
      requireString(line, 'publisher', path, errors)
      validateTokens(line.tokens, `${path}.tokens`, errors)
      if (!BASES.has(line.basis)) add(errors, `${path}.basis`, 'must be share or rebate')
      requireInt(line, 'revenue_micros', path, errors)
      requireInt(line, 'developer_micros', path, errors)
      requireInt(line, 'rebate_tokens', path, errors)
    })
  }
  if (!isObject(statement.totals)) add(errors, 'totals', 'must be an object')
  return { ok: errors.length === 0, errors }
}

export function validateDistributorManifest(manifest) {
  const errors = []
  if (!isObject(manifest)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] }
  if (manifest.schema !== 1) add(errors, 'schema', 'must be 1')
  for (const key of ['id', 'name', 'public_key', 'sig']) requireString(manifest, key, '', errors)
  requireInt(manifest, 'issued_at', '', errors, { positive: true })
  if (!Array.isArray(manifest.capabilities)) add(errors, 'capabilities', 'must be an array')
  else {
    manifest.capabilities.forEach((item, index) => {
      if (!isObject(item)) add(errors, `capabilities[${index}]`, 'must be an object')
      else requireString(item, 'id', `capabilities[${index}]`, errors)
    })
  }
  if (!isObject(manifest.endpoints)) add(errors, 'endpoints', 'must be an object')
  return { ok: errors.length === 0, errors }
}

export function validateCatalogIndex(document) {
  const errors = []
  if (!isObject(document)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] }
  if (document.format !== 1) add(errors, 'format', 'must be 1')
  if (!Array.isArray(document.plugins)) add(errors, 'plugins', 'must be an array')
  else {
    document.plugins.forEach((plugin, index) => {
      const path = `plugins[${index}]`
      if (!isObject(plugin)) {
        add(errors, path, 'must be an object')
        return
      }
      requireString(plugin, 'name', path, errors)
      if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
        add(errors, `${path}.versions`, 'must be a non-empty array')
        return
      }
      plugin.versions.forEach((version, versionIndex) => {
        const versionPath = `${path}.versions[${versionIndex}]`
        if (!isObject(version)) {
          add(errors, versionPath, 'must be an object')
          return
        }
        requireString(version, 'version', versionPath, errors)
      })
    })
  }
  return { ok: errors.length === 0, errors }
}

export function validateCapabilityIndex(index) {
  const errors = []
  if (!isObject(index)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] }
  if (index.schema !== 1) add(errors, 'schema', 'must be 1')
  requireInt(index, 'generated_at', '', errors, { positive: true })
  if (!Array.isArray(index.capabilities)) add(errors, 'capabilities', 'must be an array')
  else {
    index.capabilities.forEach((capability, position) => {
      const path = `capabilities[${position}]`
      if (!isObject(capability)) {
        add(errors, path, 'must be an object')
        return
      }
      requireString(capability, 'id', path, errors)
      requireString(capability, 'title', path, errors)
      if (!Array.isArray(capability.providers)) add(errors, `${path}.providers`, 'must be an array')
      else {
        capability.providers.forEach((provider, index2) => {
          const providerPath = `${path}.providers[${index2}]`
          if (!isObject(provider)) add(errors, providerPath, 'must be an object')
          else requireString(provider, 'plugin_id', providerPath, errors)
        })
      }
    })
  }
  return { ok: errors.length === 0, errors }
}

export function assertValid(result, label) {
  if (result.ok) return
  const first = result.errors[0]
  throw new ProtocolError(`invalid-${label}`, `${label} is invalid at ${first.path || '<root>'}: ${first.message}`, {
    errors: result.errors,
  })
}

export function pricingModelOf(value) {
  return PRICING_MODELS.has(value) ? value : 'free'
}

export { BASES, BUCKETS, PRICING_MODELS }
