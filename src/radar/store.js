/**
 * Local state for the Host plugin.
 *
 * Everything the plugin owns lives under one directory (by default
 * `~/.dsh/plugin-foundry`): consent, feedback, budget, install receipts,
 * tool-owner hints, batch checkpoints and the append-only ledger.
 * Files are written atomically; none of them contains prompt or file content.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { generateIdentity, keyFingerprint, randomId } from '../protocol/canonical.js'
import { createLedger } from '../protocol/ledger.js'

const DEFAULTS = {
  consent: {
    policy: 'never',
    reporting: 'local',
    needsConsent: true,
    never: [],
    revoked: [],
    updatedAt: 0,
  },
  feedback: {
    categoryAffinity: {},
    ignored: {},
    clicked: {},
    installed: {},
    revoked: {},
    used: {},
    updatedAt: 0,
  },
}

const POLICIES = new Set(['all', 'official', 'never', 'off'])

function today() {
  return new Date().toISOString().slice(0, 10)
}

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2))
  renameSync(temp, file)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function clampAffinity(value) {
  return Math.max(-3, Math.min(3, Math.round(value * 10) / 10))
}

export function createStore({ home } = {}) {
  if (!home) throw new TypeError('createStore: home is required')
  const dirs = {
    root: home,
    ledger: path.join(home, 'ledger'),
    outbox: path.join(home, 'outbox'),
    cache: path.join(home, 'cache'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })

  const files = {
    consent: path.join(home, 'consent.json'),
    feedback: path.join(home, 'feedback.json'),
    budget: path.join(home, 'budget.json'),
    installs: path.join(home, 'installs.json'),
    receipts: path.join(home, 'receipts.json'),
    toolOwners: path.join(home, 'tool-owners.json'),
    batches: path.join(home, 'batches.json'),
    identity: path.join(home, 'identity.json'),
    hostKey: path.join(home, 'host-key.pem'),
  }

  const ledger = createLedger({ dir: dirs.ledger })
  const memory = {
    consent: null,
    feedback: null,
    budget: null,
    installs: null,
    receipts: null,
    toolOwners: null,
    batches: null,
    identity: null,
  }

  /* ------------------------------- consent ------------------------------- */

  function loadConsent() {
    if (memory.consent) return memory.consent
    const saved = readJson(files.consent, {})
    const policy = POLICIES.has(saved.policy) ? saved.policy : 'never'
    memory.consent = {
      ...clone(DEFAULTS.consent),
      ...saved,
      policy,
      reporting: saved.reporting === 'contribute' ? 'contribute' : 'local',
      needsConsent: saved.policy ? saved.needsConsent === true : true,
      never: Array.isArray(saved.never) ? saved.never.filter((item) => typeof item === 'string').slice(-200) : [],
      revoked: Array.isArray(saved.revoked) ? saved.revoked.filter((item) => typeof item === 'string').slice(-200) : [],
      updatedAt: Number(saved.updatedAt) || 0,
    }
    return memory.consent
  }

  function saveConsent(patch) {
    const current = loadConsent()
    const next = { ...current, ...patch, updatedAt: Date.now() }
    if (patch && patch.policy !== undefined) {
      if (!POLICIES.has(patch.policy)) throw new Error('invalid consent policy')
      next.policy = patch.policy
    }
    if (patch && patch.reporting !== undefined) {
      next.reporting = patch.reporting === 'contribute' ? 'contribute' : 'local'
    }
    if (patch && patch.policy !== undefined) next.needsConsent = false
    writeJson(files.consent, next)
    memory.consent = next
    return clone(next)
  }

  function neverAuto(pkg) {
    const current = loadConsent()
    if (!current.never.includes(pkg)) current.never.push(pkg)
    current.never = current.never.slice(-200)
    writeJson(files.consent, current)
    return clone(current)
  }

  function revoke(pkg, category) {
    const current = loadConsent()
    if (!current.revoked.includes(pkg)) current.revoked.push(pkg)
    current.revoked = current.revoked.slice(-200)
    writeJson(files.consent, current)
    recordFeedback('revoked', pkg, category)
    return clone(current)
  }

  /* ------------------------------- feedback ------------------------------- */

  function loadFeedback() {
    if (memory.feedback) return memory.feedback
    const saved = readJson(files.feedback, {})
    memory.feedback = {
      ...clone(DEFAULTS.feedback),
      ...saved,
      categoryAffinity: saved.categoryAffinity && typeof saved.categoryAffinity === 'object' ? saved.categoryAffinity : {},
      ignored: saved.ignored && typeof saved.ignored === 'object' ? saved.ignored : {},
      clicked: saved.clicked && typeof saved.clicked === 'object' ? saved.clicked : {},
      installed: saved.installed && typeof saved.installed === 'object' ? saved.installed : {},
      revoked: saved.revoked && typeof saved.revoked === 'object' ? saved.revoked : {},
      used: saved.used && typeof saved.used === 'object' ? saved.used : {},
    }
    return memory.feedback
  }

  function recordFeedback(kind, pkg, category) {
    if (!pkg) return null
    const feedback = loadFeedback()
    const now = Date.now()
    const delta = { ignored: -1, clicked: 0.5, installed: 1, used: 0.5, revoked: -2 }[kind] || 0
    if (kind === 'ignored') feedback.ignored[pkg] = now
    if (kind === 'clicked') feedback.clicked[pkg] = now
    if (kind === 'installed') feedback.installed[pkg] = now
    if (kind === 'revoked') feedback.revoked[pkg] = now
    if (kind === 'used') feedback.used[pkg] = (feedback.used[pkg] || 0) + 1
    if (category && delta !== 0) {
      feedback.categoryAffinity[category] = clampAffinity((feedback.categoryAffinity[category] || 0) + delta)
    }
    feedback.updatedAt = now
    pruneFeedback(feedback, now)
    writeJson(files.feedback, feedback)
    return clone(feedback)
  }

  function pruneFeedback(feedback, now) {
    for (const bucket of ['ignored', 'clicked', 'installed']) {
      const map = feedback[bucket]
      for (const pkg of Object.keys(map)) {
        if (now - Number(map[pkg]) > 90 * 86400000) delete map[pkg]
      }
    }
    const entries = Object.entries(feedback.ignored)
    if (entries.length > 200) {
      feedback.ignored = Object.fromEntries(entries.slice(-200))
    }
  }

  /* -------------------------------- budget -------------------------------- */

  function loadBudget() {
    if (memory.budget) return memory.budget
    const saved = readJson(files.budget, {})
    memory.budget = {
      day: saved.day === today() ? saved.day : today(),
      count: saved.day === today() ? Number(saved.count) || 0 : 0,
      plugins: saved.day === today() && Array.isArray(saved.plugins) ? saved.plugins : [],
      sessions: saved.day === today() && saved.sessions && typeof saved.sessions === 'object' ? saved.sessions : {},
    }
    if (memory.budget.day !== saved.day) writeJson(files.budget, memory.budget)
    return memory.budget
  }

  function canAuto(pkg, sessionId, { dailyMax = 3, perSession = 1 } = {}) {
    const budget = loadBudget()
    if (budget.count >= dailyMax) return { ok: false, reason: 'daily-budget' }
    if (budget.plugins.includes(pkg)) return { ok: false, reason: 'already-tried' }
    if (sessionId) {
      const used = Number(budget.sessions[sessionId]) || 0
      if (used >= perSession) return { ok: false, reason: 'session-budget' }
    }
    return { ok: true, reason: null }
  }

  function recordAuto(pkg, sessionId) {
    const budget = loadBudget()
    budget.count += 1
    if (!budget.plugins.includes(pkg)) budget.plugins.push(pkg)
    if (sessionId) budget.sessions[sessionId] = (Number(budget.sessions[sessionId]) || 0) + 1
    writeJson(files.budget, budget)
    return clone(budget)
  }

  /* --------------------------- installs / receipts --------------------------- */

  function loadInstalls() {
    if (memory.installs) return memory.installs
    const saved = readJson(files.installs, { installs: [] })
    memory.installs = Array.isArray(saved.installs) ? saved.installs.slice(0, 300) : []
    return memory.installs
  }

  function addInstall(row) {
    const list = loadInstalls()
    list.unshift({ ...row, at: row.at || Date.now() })
    memory.installs = list.slice(0, 300)
    writeJson(files.installs, { installs: memory.installs })
    return clone(memory.installs[0])
  }

  function loadReceipts() {
    if (memory.receipts) return memory.receipts
    const saved = readJson(files.receipts, { receipts: [] })
    memory.receipts = Array.isArray(saved.receipts) ? saved.receipts.slice(0, 30) : []
    return memory.receipts
  }

  function addReceipt(row) {
    const list = loadReceipts()
    list.unshift({ ...row, at: row.at || Date.now() })
    memory.receipts = list.slice(0, 30)
    writeJson(files.receipts, { receipts: memory.receipts })
    return clone(memory.receipts[0])
  }

  /* ----------------------------- tool owners ----------------------------- */

  function loadToolOwners() {
    if (memory.toolOwners) return memory.toolOwners
    const saved = readJson(files.toolOwners, {})
    memory.toolOwners = Object.fromEntries(
      Object.entries(saved).filter(([tool, owner]) => typeof tool === 'string' && typeof owner === 'string' && tool && owner),
    )
    return memory.toolOwners
  }

  function setToolOwners(map) {
    const merged = { ...loadToolOwners() }
    for (const [tool, owner] of Object.entries(map || {})) {
      if (typeof tool === 'string' && typeof owner === 'string' && tool && owner) merged[tool] = owner
    }
    memory.toolOwners = merged
    writeJson(files.toolOwners, merged)
    return clone(merged)
  }

  /* -------------------------------- batches -------------------------------- */

  function loadBatches() {
    if (memory.batches) return memory.batches
    const saved = readJson(files.batches, { batches: [] })
    memory.batches = Array.isArray(saved.batches) ? saved.batches.slice(-200) : []
    return memory.batches
  }

  function recordBatch(batch, status = 'pending') {
    const list = loadBatches()
    const filtered = list.filter((row) => row.batch_id !== batch.batch_id)
    filtered.push({
      batch_id: batch.batch_id,
      root: batch.root,
      prev: batch.prev,
      event_count: batch.event_count,
      status,
      at: Date.now(),
      server_seq: null,
    })
    memory.batches = filtered.slice(-200)
    writeJson(files.batches, { batches: memory.batches })
    return clone(memory.batches[memory.batches.length - 1])
  }

  function updateBatch(batchId, patch) {
    const list = loadBatches()
    const target = list.find((row) => row.batch_id === batchId)
    if (!target) return null
    Object.assign(target, patch)
    writeJson(files.batches, { batches: list })
    return clone(target)
  }

  function lastBatchRoot() {
    const list = loadBatches().filter((row) => row.status === 'accepted' || row.status === 'pending')
    return list.length > 0 ? list[list.length - 1].root : null
  }

  function batches() {
    return clone(loadBatches())
  }

  function uploadedEventCount() {
    return loadBatches()
      .filter((row) => row.status === 'accepted')
      .reduce((sum, row) => sum + (Number(row.event_count) || 0), 0)
  }

  /* ------------------------------- identity ------------------------------- */

  function identity() {
    if (memory.identity) return memory.identity
    let privatePem
    try {
      privatePem = readFileSync(files.hostKey, 'utf8')
    } catch {
      const generated = generateIdentity()
      privatePem = generated.privatePem
      writeFileSync(files.hostKey, privatePem, { mode: 0o600 })
      try {
        chmodSync(files.hostKey, 0o600)
      } catch {
        /* best effort */
      }
    }
    const privateKey = createPrivateKey(privatePem)
    const publicKey = createPublicKey(privateKey)
    const saved = readJson(files.identity, {})
    let installId = typeof saved.installId === 'string' && saved.installId ? saved.installId : ''
    if (!installId) {
      installId = randomId('i')
      writeJson(files.identity, { installId })
    }
    const hostId = keyFingerprint(publicKey)
    memory.identity = {
      privateKey,
      publicKey,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      hostId,
      installId,
      meterKey: hostId,
    }
    return memory.identity
  }

  function exportAll() {
    return {
      exported_at: Date.now(),
      consent: clone(loadConsent()),
      feedback: clone(loadFeedback()),
      installs: clone(loadInstalls()),
      receipts: clone(loadReceipts()),
      batches: batches(),
      usage: ledger.readAll(),
      identity: (() => {
        const id = identity()
        return { hostId: id.hostId, installId: id.installId, publicKey: id.publicKeySpki }
      })(),
    }
  }

  return {
    home,
    dirs,
    files,
    ledger,
    consent: {
      get: () => clone(loadConsent()),
      set: saveConsent,
      never: neverAuto,
      revoke,
    },
    feedback: {
      get: () => clone(loadFeedback()),
      record: recordFeedback,
    },
    budget: {
      status: () => clone(loadBudget()),
      canAuto,
      record: recordAuto,
    },
    installs: {
      list: () => clone(loadInstalls()),
      add: addInstall,
    },
    receipts: {
      list: () => clone(loadReceipts()),
      add: addReceipt,
    },
    toolOwners: {
      get: () => clone(loadToolOwners()),
      set: setToolOwners,
    },
    batches: {
      list: batches,
      record: recordBatch,
      update: updateBatch,
      lastRoot: lastBatchRoot,
      uploadedEventCount,
    },
    identity,
    exportAll,
    _internals: { readJson, writeJson, today },
  }
}
