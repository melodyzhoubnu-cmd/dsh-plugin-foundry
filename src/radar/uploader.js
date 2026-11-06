/**
 * Batch uploader.
 *
 * Aggregation and signing happen locally; the request path never waits on the
 * network. Uploads are scheduled after a short idle delay, retried with
 * exponential backoff, and an outbox copy is kept on disk so an offline Host
 * can send the same idempotent batch later. Nothing is sent unless the user
 * chose "report usage" and an upload URL is configured.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildBatch, encodeBatch } from '../protocol/batch.js'
import { gunzipJson } from '../protocol/canonical.js'

const DEFAULT_DELAY_MS = 5000
const DEFAULT_TIMEOUT_MS = 30_000

export function createUploader({ store, config, logger, fetchImpl = globalThis.fetch } = {}) {
  if (!store) throw new TypeError('createUploader: store is required')
  const outbox = path.join(store.home, 'outbox')
  mkdirSync(outbox, { recursive: true })
  let timer = null
  let running = false
  let stopped = false
  let attempts = 0

  function enabled() {
    return store.consent.get().reporting === 'contribute' && Boolean(config.uploadUrl)
  }

  function schedule(delay = config.uploadDelayMs ?? DEFAULT_DELAY_MS) {
    if (stopped || !enabled() || timer) return
    timer = setTimeout(() => {
      timer = null
      void flush().catch((error) => {
        logger?.warn?.(`upload failed: ${String((error && error.message) || error)}`)
      })
    }, Math.max(0, delay))
    timer.unref?.()
  }

  function lastAcceptedSeq() {
    const accepted = store.batches.list().filter((row) => row.status === 'accepted')
    return accepted.reduce((max, row) => Math.max(max, Number(row.last_seq) || 0), 0)
  }

  function pendingBatch() {
    return store.batches.list().find((row) => row.status === 'pending' || row.status === 'failed') || null
  }

  async function flush({ force = false } = {}) {
    if (running) return { status: 'busy' }
    if (stopped) return { status: 'stopped' }
    if (!force && !enabled()) return { status: 'skipped', reason: 'local-only' }
    if (!config.uploadUrl) return { status: 'skipped', reason: 'no-upload-url' }
    running = true
    let batch = null
    try {
      const identity = store.identity()
      const events = store.ledger.readAll()
      let pending
      const previous = pendingBatch()
      if (previous) {
        pending = events.filter((event) => event.seq >= previous.first_seq && event.seq <= previous.last_seq)
        if (pending.length === 0) {
          store.batches.update(previous.batch_id, { status: 'failed', error: 'events-missing' })
          return { status: 'error', reason: 'events-missing' }
        }
        batch = buildBatch({
          events: pending,
          hostId: identity.hostId,
          installId: identity.installId,
          runtimeVersion: config.runtimeVersion,
          previousRoot: previous.prev,
          privateKey: identity.privateKey,
        })
      } else {
        pending = events.filter((event) => event.seq > lastAcceptedSeq())
        if (pending.length === 0) return { status: 'skipped', reason: 'nothing-to-send' }
        const prevRoot = store.batches.lastRoot()
        batch = buildBatch({
          events: pending,
          hostId: identity.hostId,
          installId: identity.installId,
          runtimeVersion: config.runtimeVersion,
          previousRoot: prevRoot,
          privateKey: identity.privateKey,
        })
      }

      store.batches.record(batch, 'pending')
      store.batches.update(batch.batch_id, {
        first_seq: pending[0].seq,
        last_seq: pending[pending.length - 1].seq,
        count: pending.length,
      })
      writeOutbox(batch)
      const body = encodeBatch(batch)
      const response = await fetchImpl(config.uploadUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'idempotency-key': batch.batch_id,
          'x-install-id': identity.installId,
          ...(config.uploadToken ? { authorization: `Bearer ${config.uploadToken}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(config.uploadTimeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
      const text = await response.text()
      let result = null
      try {
        result = text ? JSON.parse(text) : null
      } catch {
        result = null
      }
      if (!response.ok) {
        const reason = (result && (result.problem || result.error)) || `HTTP ${response.status}`
        store.batches.update(batch.batch_id, { status: response.status === 409 ? 'accepted' : 'failed', error: String(reason) })
        if (response.status === 409 && result && result.accepted) {
          removeOutbox(batch.batch_id)
          attempts = 0
          return { status: 'duplicate', batch, result }
        }
        scheduleRetry()
        return { status: 'error', batch, reason: String(reason), response: result }
      }
      store.batches.update(batch.batch_id, {
        status: 'accepted',
        server_seq: result && result.server_seq !== undefined ? result.server_seq : null,
        disputes: (result && result.disputes) || [],
        error: null,
      })
      removeOutbox(batch.batch_id)
      attempts = 0
      return { status: 'accepted', batch, result }
    } catch (error) {
      if (batch) store.batches.update(batch.batch_id, { status: 'failed', error: String((error && error.message) || error) })
      scheduleRetry()
      return { status: 'error', batch, reason: String((error && error.message) || error) }
    } finally {
      running = false
    }
  }

  function scheduleRetry() {
    attempts += 1
    const delay = Math.min(5 * 60_000, 5000 * 2 ** Math.min(6, attempts))
    schedule(delay)
  }

  function writeOutbox(batch) {
    try {
      writeFileSync(path.join(outbox, `${batch.batch_id}.json.gz`), encodeBatch(batch))
    } catch {
      /* outbox is best effort */
    }
  }

  function removeOutbox(batchId) {
    try {
      const file = path.join(outbox, `${batchId}.json.gz`)
      if (existsSync(file)) unlinkSync(file)
    } catch {
      /* ignore */
    }
  }

  /** Retry batches found on disk from a previous process. */
  function pendingOutbox() {
    try {
      return readdirSync(outbox)
        .filter((name) => name.endsWith('.json.gz'))
        .map((name) => {
          try {
            return gunzipJson(readFileSync(path.join(outbox, name)))
          } catch {
            return null
          }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }

  function close() {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }

  return { flush, schedule, close, pendingOutbox, enabled, outbox }
}
