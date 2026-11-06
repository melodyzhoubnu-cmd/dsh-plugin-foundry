/**
 * Host-side metering.
 *
 * On every completed assistant message we read the provider's usage, map the
 * request's tool calls back to their owning plugins, and write one UsageEvent
 * per (plugin, bucket) into the append-only ledger. The request path never
 * performs network I/O; uploading is a separate, scheduled step.
 */
import { createHash } from 'node:crypto'
import { attributeRequest, normalizeUsage, tokensOf, totalOf, zeroTokens } from '../protocol/attribution.js'
import { canonicalPluginId } from '../protocol/catalog.js'
import { keyFingerprint } from '../protocol/canonical.js'
import { toolCallsOf, textOf } from './task.js'
import { estimateTokens } from '../protocol/tokens.js'

function sessionHashOf(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 24)
}

export function createMeter({ store, tracker, catalog, config } = {}) {
  if (!store || !tracker || !catalog) throw new TypeError('createMeter: store, tracker and catalog are required')

  const pendingCalls = new Map()

  function owners() {
    return { ...(config.toolOwners || {}), ...store.toolOwners.get() }
  }

  function packageNameOf(owner) {
    if (typeof owner !== 'string' || !owner.startsWith('pkg:npm/')) return owner
    const rest = owner.slice('pkg:npm/'.length).split('#')[0]
    const at = rest.lastIndexOf('@')
    return at > 0 ? rest.slice(0, at) : rest
  }

  function pluginOf(owner, cache) {
    if (cache && cache.has(owner)) return cache.get(owner)
    const canonical = String(owner || '').startsWith('pkg:npm/') ? owner : null
    const name = packageNameOf(owner)
    const entry = catalog.byName(name)
    let info
    if (entry) {
      let publisher = entry.publisher.id || null
      if (!publisher && entry.publisher.publicKey) {
        try {
          publisher = keyFingerprint(entry.publisher.publicKey)
        } catch {
          publisher = null
        }
      }
      info = { pluginId: entry.pluginId, publisher, entry }
    } else {
      info = {
        pluginId: canonical || canonicalPluginId({ name: name || owner, version: '0.0.0' }),
        publisher: null,
        entry: null,
      }
    }
    if (cache) cache.set(owner, info)
    return info
  }

  /**
   * Calls that belong to the current request. A tool result arrives after the
   * assistant message that requested it, so the next request must inherit the
   * result's owner even though its own message contains no tool call.
   */
  function observe(session, event) {
    if (!session || !session.id || !event) return
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    const sessionId = session.id
    let map = pendingCalls.get(sessionId)
    if (!map) {
      map = new Map()
      pendingCalls.set(sessionId, map)
    }
    const type = String(event.type || '')
    if (type === 'assistant/message') {
      for (const call of toolCallsOf(data.message || data)) {
        if (!map.has(call.id)) map.set(call.id, { callId: call.id, name: call.name, resultTokens: 0 })
      }
      return
    }
    if (type === 'tool/call') {
      const callId = String(data.callId || '')
      if (callId) map.set(callId, { callId, name: String(data.name || ''), resultTokens: 0 })
      return
    }
    if (type === 'tool/result') {
      const message = data.message || {}
      const callId = String(message.toolCallId || data.callId || '')
      if (!callId) return
      const profile = tracker.profileOf(sessionId)
      const known = (profile.toolCalls || []).find((call) => call.callId === callId)
      const tokens = estimateTokens(textOf(message))
      const existing = map.get(callId) || { callId, name: known ? known.name : '', resultTokens: 0 }
      map.set(callId, { ...existing, name: existing.name || (known ? known.name : ''), resultTokens: tokens })
    }
  }

  function record(session, event) {
    if (!session || !session.id || !event) return null
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    // Only a model-produced assistant message carries provider usage that the
    // Host actually paid for. A plugin can append any surface event, so a
    // missing/non-model source must never create billable attribution.
    const message = data.message && typeof data.message === 'object' ? data.message : null
    if (!message || !message.source || message.source.kind !== 'model') return null
    const usage = normalizeUsage(data.usage || message.usage)
    const total = totalOf(usage)
    if (total <= 0) return null

    const requestId = `${session.id}:${Number(data.turn) || 0}:${Number(data.step) || 0}`
    const ts = Number(event.time) || Date.now()
    const ownerMap = owners()
    const pluginCache = new Map()
    const pending = pendingCalls.get(session.id) || new Map()
    for (const call of toolCallsOf(data.message || data)) {
      if (!pending.has(call.id)) pending.set(call.id, { callId: call.id, name: call.name, resultTokens: 0 })
    }
    const calls = [...pending.values()].map((call) => ({
      ...call,
      owner: ownerMap[call.name] || null,
    }))
    pendingCalls.set(session.id, new Map())
    const ownerIdByCall = new Map(
      calls.map((call) => [call.id, call.owner ? pluginOf(call.owner, pluginCache).pluginId : null]),
    )

    const capability = []
    const noticeIds = []
    for (const notice of tracker.pendingNotices(session.id)) {
      if (!notice.pluginId) continue
      capability.push({ pluginId: notice.pluginId, tokens: notice.tokens })
      noticeIds.push(notice.id)
    }

    const attribution = attributeRequest({
      usage,
      toolCalls: calls,
      capability,
      strategy: config.attributionStrategy === 'count' ? 'count' : 'size',
    })

    const identity = store.identity()
    const sessionHash = sessionHashOf(session.id)
    const base = {
      publisher: null,
      tool: null,
      request_id: requestId,
      session_hash: sessionHash,
      meter_key: identity.meterKey,
      ts,
    }

    const recorded = []
    for (const row of attribution.rows) {
      const owner = row.pluginId
      const info = pluginOf(owner, pluginCache)
      const tool = toolOf(row, calls, ownerIdByCall)
      recorded.push(store.ledger.append({
        ...base,
        plugin_id: info.pluginId,
        publisher: info.publisher,
        tool,
        tokens: tokensOf(row.tokens),
        share: row.share,
        bucket: row.bucket,
      }))
    }

    const unattributed = tokensOf(attribution.unattributed)
    if (totalOf(unattributed) > 0) {
      recorded.push(store.ledger.append({
        ...base,
        plugin_id: null,
        publisher: null,
        tool: null,
        tokens: unattributed,
        share: 0,
        bucket: 'base',
      }))
    }

    if (noticeIds.length > 0) tracker.markNoticesMetered(session.id, noticeIds)

    return {
      requestId,
      sessionHash,
      usage,
      total,
      attributed: attribution.attributed,
      unattributed,
      events: recorded,
      toolCalls: calls,
    }
  }

  function toolOf(row, calls, ownerIdByCall) {
    if (row.bucket === 'capability') return null
    const hit = calls.find((call) => ownerIdByCall.get(call.id) === row.pluginId && (row.bucket !== 'tool_result' || call.resultTokens > 0))
    return hit ? hit.name : null
  }

  function report({ reward } = {}) {
    const events = store.ledger.readAll()
    const verification = store.ledger.verify()
    const latestBatch = store.batches.list().at(-1) || null
    return { events, verification, latestBatch, reward }
  }

  return { record, observe, report, owners }
}

export function emptyTotals() {
  return { tokens: zeroTokens(), requests: 0, tool_calls: 0 }
}
