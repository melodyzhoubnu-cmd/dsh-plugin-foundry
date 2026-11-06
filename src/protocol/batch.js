/**
 * Daily batch construction, signing and audit receipts.
 *
 * A batch is the unit of upload: aggregated totals by plugin, a Merkle root
 * over the day's event hashes, the previous batch root (per install), and an
 * Ed25519 signature by the Host. Only aggregates leave the machine; the raw
 * events stay in the local ledger, and a receipt can prove a sample of them.
 */
import { gzipJson, merkleRoot, randomId, sha256Hex, signCanonical, verifyCanonical } from './canonical.js'
import { aggregateEvents } from './attribution.js'
import { assertValid, validateBatch, validateReceipt } from './schema.js'

function hostTag(hostId) {
  return String(hostId || 'host').replace(/^ed25519:/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'host'
}

export function buildBatch({
  events,
  hostId,
  installId,
  runtimeVersion = 'unknown',
  previousRoot = null,
  privateKey,
  now = Date.now(),
} = {}) {
  const list = (Array.isArray(events) ? events : []).filter((event) => event && event.hash)
  if (list.length === 0) throw new Error('buildBatch: at least one event is required')
  const aggregate = aggregateEvents(list)
  const root = merkleRoot(list.map((event) => event.hash))
  const start = Math.min(...list.map((event) => Number(event.ts) || now))
  const end = Math.max(...list.map((event) => Number(event.ts) || now))
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '')
  const payload = {
    schema: 1,
    batch_id: `b_${day}_${hostTag(hostId)}_${root.slice(0, 8)}`,
    host_id: hostId,
    install_id: installId,
    runtime_version: String(runtimeVersion),
    period: {
      start: new Date(start).toISOString(),
      end: new Date(end + 1).toISOString(),
    },
    root,
    prev: previousRoot || '0'.repeat(64),
    event_count: list.length,
    totals: aggregate.byPlugin,
    unattributed: aggregate.unattributed,
    created_at: now,
  }
  const batch = { ...payload, sig: signCanonical(payload, privateKey) }
  assertValid(validateBatch(batch), 'batch')
  return batch
}

export function verifyBatch(batch, publicKey) {
  const shape = validateBatch(batch)
  if (!shape.ok) return { ok: false, errors: shape.errors, reason: 'invalid-shape' }
  const body = { ...batch }
  delete body.sig
  if (!verifyCanonical(body, batch.sig, publicKey)) return { ok: false, errors: [], reason: 'bad-signature' }
  return { ok: true, errors: [], reason: null }
}

export function batchDigest(batch) {
  const body = { ...batch }
  delete body.sig
  return sha256Hex(JSON.stringify(body))
}

export function encodeBatch(batch) {
  return gzipJson(batch)
}

/**
 * A signed receipt over the same events. The platform stores aggregates, so a
 * receipt (with event hashes) is what a developer or auditor uses when a total
 * is disputed. Hashes reveal ordering and count, never content.
 */
export function buildReceipt({ batch, events, privateKey, now = Date.now(), maxLeaves = 1000 } = {}) {
  const list = (Array.isArray(events) ? events : []).filter((event) => event && event.hash)
  const payload = {
    schema: 1,
    receipt_id: randomId('r'),
    host_id: batch.host_id,
    install_id: batch.install_id,
    batch_id: batch.batch_id,
    period: {
      start: Math.trunc(Date.parse(batch.period.start)),
      end: Math.trunc(Date.parse(batch.period.end)),
    },
    root: batch.root,
    event_count: list.length,
    totals: batch.totals,
    leaves: list.slice(0, maxLeaves).map((event) => event.hash),
    issued_at: now,
  }
  const receipt = { ...payload, sig: signCanonical(payload, privateKey) }
  assertValid(validateReceipt(receipt), 'receipt')
  return receipt
}

export function verifyReceipt(receipt, publicKey) {
  const shape = validateReceipt(receipt)
  if (!shape.ok) return { ok: false, errors: shape.errors, reason: 'invalid-shape' }
  const body = { ...receipt }
  delete body.sig
  if (!verifyCanonical(body, receipt.sig, publicKey)) return { ok: false, errors: [], reason: 'bad-signature' }
  if (Array.isArray(receipt.leaves) && receipt.leaves.length > 0 && merkleRoot(receipt.leaves) !== receipt.root && receipt.leaves.length === receipt.event_count) {
    return { ok: false, errors: [], reason: 'bad-root' }
  }
  return { ok: true, errors: [], reason: null }
}
