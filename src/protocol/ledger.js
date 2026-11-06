/**
 * Append-only usage ledger.
 *
 * Each line is a `UsageEvent` extended with `seq`, `prev_hash` and `hash`.
 * The chain makes deletion, reordering and silent edits visible: replaying the
 * file must reproduce every hash, and every `prev_hash` must name the previous
 * line. The head file is only a checkpoint; `verify()` recomputes it from the
 * log, so a lost checkpoint is repairable and a forged one is detectable.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson, GENESIS_HASH, merkleRoot, sha256Hex } from './canonical.js'
import { validateUsageEvent } from './schema.js'

export function createLedger({ dir, file, headFile } = {}) {
  if (!file && !dir) throw new TypeError('createLedger: dir or file is required')
  const eventFile = file || path.join(dir, 'usage.jsonl')
  const headPath = headFile || (dir ? path.join(dir, 'usage.head.json') : `${eventFile}.head.json`)
  const baseDir = path.dirname(eventFile)
  let head = null

  function ensureDir() {
    mkdirSync(baseDir, { recursive: true })
  }

  function readHeadFile() {
    try {
      const parsed = JSON.parse(readFileSync(headPath, 'utf8'))
      if (parsed && Number.isInteger(parsed.seq) && typeof parsed.hash === 'string') {
        return { seq: parsed.seq, hash: parsed.hash, count: Number(parsed.count) || 0 }
      }
    } catch {
      /* no checkpoint yet */
    }
    return null
  }

  function getHead() {
    if (head) return head
    head = readHeadFile() || { seq: 0, hash: GENESIS_HASH, count: 0 }
    return head
  }

  function writeHead(next) {
    ensureDir()
    const temp = `${headPath}.tmp`
    writeFileSync(temp, JSON.stringify(next))
    renameSync(temp, headPath)
    head = next
  }

  function append(payload) {
    ensureDir()
    const previous = getHead()
    const base = {
      schema: 1,
      ...payload,
      seq: previous.seq + 1,
      prev_hash: previous.hash,
    }
    const hash = sha256Hex(canonicalJson(base))
    const record = { ...base, hash }
    const check = validateUsageEvent(record)
    if (!check.ok) {
      const first = check.errors[0]
      throw new Error(`ledger append: invalid event at ${first.path || '<root>'}: ${first.message}`)
    }
    appendFileSync(eventFile, JSON.stringify(record) + '\n')
    writeHead({ seq: record.seq, hash, count: previous.count + 1 })
    return record
  }

  function readLines() {
    if (!existsSync(eventFile)) return { records: [], problems: [] }
    const text = readFileSync(eventFile, 'utf8')
    const lines = text.split('\n')
    const records = []
    const problems = []
    lines.forEach((line, index) => {
      if (!line.trim()) return
      try {
        records.push(JSON.parse(line))
      } catch {
        problems.push({ line: index + 1, problem: 'not-json' })
      }
    })
    return { records, problems }
  }

  function readAll() {
    return readLines().records
  }

  function verify() {
    const { records, problems } = readLines()
    const issues = [...problems]
    let previousHash = GENESIS_HASH
    let expectedSeq = 1
    for (const record of records) {
      if (record.seq !== expectedSeq) {
        issues.push({ seq: record.seq, problem: 'sequence-gap', expected: expectedSeq })
      }
      if (record.prev_hash !== previousHash) {
        issues.push({ seq: record.seq, problem: 'prev-hash-mismatch' })
      }
      const body = { ...record }
      delete body.hash
      const computed = sha256Hex(canonicalJson(body))
      if (computed !== record.hash) {
        issues.push({ seq: record.seq, problem: 'hash-mismatch' })
      }
      const check = validateUsageEvent(record)
      if (!check.ok) issues.push({ seq: record.seq, problem: 'schema', errors: check.errors })
      previousHash = record.hash
      expectedSeq = (record.seq || expectedSeq) + 1
    }
    const computedHead = records.length > 0
      ? { seq: records[records.length - 1].seq, hash: previousHash, count: records.length }
      : { seq: 0, hash: GENESIS_HASH, count: 0 }
    const checkpoint = readHeadFile()
    return {
      ok: issues.length === 0,
      problems: issues,
      head: computedHead,
      checkpoint,
      root: merkleRoot(records.map((record) => record.hash)),
      count: records.length,
    }
  }

  function syncHead() {
    const records = readAll()
    const next = records.length > 0
      ? {
          seq: records[records.length - 1].seq,
          hash: records[records.length - 1].hash,
          count: records.length,
        }
      : { seq: 0, hash: GENESIS_HASH, count: 0 }
    writeHead(next)
    return next
  }

  function eventsAfter(seq = 0) {
    return readAll().filter((record) => record.seq > seq)
  }

  function range(fromSeq, toSeqInclusive) {
    return readAll().filter((record) => record.seq >= fromSeq && record.seq <= toSeqInclusive)
  }

  function rootOf(records) {
    return merkleRoot((records || []).map((record) => record.hash))
  }

  return {
    file: eventFile,
    headFile: headPath,
    append,
    readAll,
    verify,
    syncHead,
    eventsAfter,
    range,
    head: getHead,
    rootOf,
    count: () => getHead().count,
  }
}
