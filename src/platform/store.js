/**
 * Reference platform store.
 *
 * A single JSON document is enough for the reference implementation: hosts,
 * batch checkpoints, daily rollups, bill anchors, distributor manifests and
 * settlement statements. A production platform would put the
 * same fields in a relational database; the protocol shapes do not change.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { addTokens, zeroTokens } from '../protocol/attribution.js'

const EMPTY = () => ({
  schema: 1,
  hosts: {},
  batches: {},
  hostSeq: {},
  rollups: [],
  bills: {},
  distributors: [],
  settlements: [],
  seq: 0,
})

export function createPlatformStore({ home } = {}) {
  if (!home) throw new TypeError('createPlatformStore: home is required')
  mkdirSync(home, { recursive: true })
  const file = path.join(home, 'state.json')
  let state = load()

  function load() {
    if (!existsSync(file)) return EMPTY()
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return { ...EMPTY(), ...parsed }
    } catch {
      return EMPTY()
    }
  }

  function save() {
    const temp = `${file}.tmp`
    writeFileSync(temp, JSON.stringify(state))
    renameSync(temp, file)
  }

  function nextSeq() {
    state.seq += 1
    save()
    return state.seq
  }

  function registerHost(host) {
    state.hosts[host.hostId] = {
      hostId: host.hostId,
      installId: host.installId,
      publicKey: host.publicKey,
      runtimeVersion: host.runtimeVersion || '',
      registeredAt: host.registeredAt || Date.now(),
    }
    save()
    return state.hosts[host.hostId]
  }

  function host(hostId) {
    return state.hosts[hostId] || null
  }

  function setBill(hostId, bill) {
    state.bills[hostId] = {
      hostId,
      tokens: Math.max(0, Math.trunc(Number(bill.tokens) || 0)),
      period: bill.period || null,
      at: Date.now(),
    }
    save()
    return state.bills[hostId]
  }

  function bill(hostId) {
    return state.bills[hostId] || null
  }

  function batch(batchId) {
    return state.batches[batchId] || null
  }

  function hasBatch(batchId) {
    return Boolean(state.batches[batchId])
  }

  function recordBatch({ batch, status = 'accepted', disputes = [], scaled = false }) {
    const serial = nextSeq()
    state.batches[batch.batch_id] = {
      batch_id: batch.batch_id,
      host_id: batch.host_id,
      install_id: batch.install_id,
      period: batch.period,
      event_count: batch.event_count,
      totals: batch.totals,
      unattributed: batch.unattributed || zeroTokens(),
      root: batch.root,
      prev: batch.prev,
      status,
      scaled,
      disputes,
      server_seq: serial,
      accepted_at: Date.now(),
    }
    save()
    return state.batches[batch.batch_id]
  }

  function lastRoot(hostId) {
    return state.hostSeq[hostId] || null
  }

  function setLastRoot(hostId, root) {
    state.hostSeq[hostId] = root
    save()
  }

  function addRollups({ hostId, rows, day }) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || !row.plugin_id) continue
      const existing = state.rollups.find((item) =>
        item.hostId === hostId && item.day === day && item.plugin_id === row.plugin_id)
      if (existing) {
        addTokens(existing.tokens, row.tokens || {})
        existing.requests += Number(row.requests) || 0
        existing.tool_calls += Number(row.tool_calls) || 0
      } else {
        state.rollups.push({
          hostId,
          day,
          plugin_id: row.plugin_id,
          publisher: row.publisher || '',
          tokens: { ...zeroTokens(), ...(row.tokens || {}) },
          requests: Number(row.requests) || 0,
          tool_calls: Number(row.tool_calls) || 0,
        })
      }
    }
    save()
  }

  function rollups({ publisher, from, to } = {}) {
    return state.rollups.filter((row) => {
      if (publisher && row.publisher !== publisher) return false
      if (from && row.day < from) return false
      if (to && row.day > to) return false
      return true
    })
  }

  function addDistributor(manifest) {
    if (!state.distributors.some((row) => row.id === manifest.id)) state.distributors.push(manifest)
    save()
    return manifest
  }

  function distributors() {
    return [...state.distributors]
  }

  function addSettlement(statement) {
    if (!state.settlements.some((row) => row.settlement_id === statement.settlement_id)) {
      state.settlements.push(statement)
    }
    save()
    return statement
  }

  function settlements({ publisher } = {}) {
    return state.settlements.filter((row) => !publisher || row.publisher === publisher)
  }

  function batches({ hostId } = {}) {
    return Object.values(state.batches)
      .filter((row) => !hostId || row.host_id === hostId)
      .sort((a, b) => a.server_seq - b.server_seq)
  }

  function stats({ publisher, from, to } = {}) {
    const rows = rollups({ publisher, from, to })
    const byPlugin = new Map()
    const byDay = new Map()
    const totals = zeroTokens()
    let requests = 0
    let toolCalls = 0
    for (const row of rows) {
      addTokens(totals, row.tokens)
      requests += row.requests
      toolCalls += row.tool_calls
      const plugin = byPlugin.get(row.plugin_id) || {
        plugin_id: row.plugin_id,
        publisher: row.publisher,
        tokens: zeroTokens(),
        requests: 0,
        tool_calls: 0,
      }
      addTokens(plugin.tokens, row.tokens)
      plugin.requests += row.requests
      plugin.tool_calls += row.tool_calls
      byPlugin.set(row.plugin_id, plugin)
      const day = byDay.get(row.day) || zeroTokens()
      addTokens(day, row.tokens)
      byDay.set(row.day, day)
    }
    return {
      rows,
      totals,
      requests,
      tool_calls: toolCalls,
      byPlugin: [...byPlugin.values()].sort((a, b) => a.plugin_id.localeCompare(b.plugin_id)),
      byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, tokens]) => ({ day, tokens })),
    }
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state))
  }

  return {
    home,
    file,
    registerHost,
    host,
    setBill,
    bill,
    batch,
    hasBatch,
    recordBatch,
    lastRoot,
    setLastRoot,
    addRollups,
    rollups,
    addDistributor,
    distributors,
    addSettlement,
    settlements,
    batches,
    stats,
    snapshot,
    nextSeq,
  }
}
