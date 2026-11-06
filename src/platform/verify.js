/**
 * Batch intake and verification.
 *
 * Order matters: signature, identity, idempotency, previous-root chain,
 * period sanity, reconciliation against the provider bill, then ingestion.
 * A batch is never stored before its signature checks out.
 */
import { keyFingerprint } from '../protocol/canonical.js'
import { verifyBatch } from '../protocol/batch.js'
import { reconcile, scaleAggregates, tokensOf, totalOf } from '../protocol/attribution.js'

export const GENESIS = '0'.repeat(64)

export function verifyHostRegistration({ hostId, installId, publicKey }) {
  if (typeof hostId !== 'string' || !hostId.startsWith('ed25519:')) {
    return { ok: false, problem: 'invalid-host-id' }
  }
  if (typeof installId !== 'string' || installId.length < 3) return { ok: false, problem: 'invalid-install-id' }
  try {
    if (keyFingerprint(publicKey) !== hostId) return { ok: false, problem: 'host-id-mismatch' }
  } catch {
    return { ok: false, problem: 'invalid-public-key' }
  }
  return { ok: true, problem: null }
}

function sumBatchTokens(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + totalOf(tokensOf(row.tokens)), 0)
}

export function ingestBatch({ store, batch, installIdHeader, bodyDigest }) {
  if (!batch || typeof batch !== 'object') return { status: 400, body: { accepted: false, problem: 'invalid-body' } }
  const host = store.host(batch.host_id)
  if (!host) return { status: 404, body: { accepted: false, problem: 'unknown-host' } }
  if (host.installId !== batch.install_id) {
    return { status: 403, body: { accepted: false, problem: 'install-id-mismatch' } }
  }
  if (installIdHeader && installIdHeader !== batch.install_id) {
    return { status: 403, body: { accepted: false, problem: 'install-header-mismatch' } }
  }

  const verification = verifyBatch(batch, host.publicKey)
  if (!verification.ok) {
    return { status: 400, body: { accepted: false, problem: verification.reason || 'verification-failed' } }
  }

  const existing = store.batch(batch.batch_id)
  if (existing) {
    return {
      status: 200,
      body: {
        accepted: true,
        duplicate: true,
        batch_id: batch.batch_id,
        server_seq: existing.server_seq,
        disputes: existing.disputes || [],
      },
    }
  }

  const lastRoot = store.lastRoot(batch.host_id)
  if (lastRoot && batch.prev !== lastRoot) {
    return { status: 409, body: { accepted: false, problem: 'prev-mismatch', expected: lastRoot } }
  }
  if (!lastRoot && batch.prev !== GENESIS) {
    return { status: 409, body: { accepted: false, problem: 'first-batch-prev-not-genesis' } }
  }

  const start = Date.parse(batch.period.start)
  const end = Date.parse(batch.period.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { status: 400, body: { accepted: false, problem: 'invalid-period' } }
  }
  if (end - start > 31 * 86400000) {
    return { status: 400, body: { accepted: false, problem: 'period-too-long' } }
  }

  const attributed = sumBatchTokens(batch.totals)
  const prior = store.batches({ hostId: batch.host_id }).reduce((sum, row) => sum + sumBatchTokens(row.totals), 0)
  const anchor = store.bill(batch.host_id)
  const reconciliation = reconcile(prior + attributed, anchor ? anchor.tokens : null)
  const disputes = []
  let rows = batch.totals
  let scaled = false
  if (!reconciliation.ok) {
    const remaining = Math.max(0, reconciliation.anchor - prior)
    const ratio = attributed > 0 ? Math.min(1, remaining / attributed) : 0
    rows = scaleAggregates(batch.totals, ratio)
    scaled = true
    disputes.push({ ...reconciliation.dispute, applied_ratio: ratio })
  }
  if (!anchor) disputes.push({ kind: 'no-bill-anchor', note: 'accepted before the provider bill was registered' })

  const day = batch.period.start.slice(0, 10)
  const stored = store.recordBatch({
    batch: { ...batch, totals: rows },
    status: scaled ? 'scaled' : 'accepted',
    disputes,
    scaled,
  })
  store.setLastRoot(batch.host_id, batch.root)
  store.addRollups({ hostId: batch.host_id, rows, day })
  return {
    status: 200,
    body: {
      accepted: true,
      duplicate: false,
      batch_id: batch.batch_id,
      server_seq: stored.server_seq,
      disputes,
      scaled,
      credited_tokens: sumBatchTokens(rows),
      received_tokens: attributed,
      digest: bodyDigest || null,
    },
  }
}
