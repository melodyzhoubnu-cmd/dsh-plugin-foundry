/**
 * Canonical encoding, hashing and Ed25519 helpers shared by the Host plugin,
 * the reference platform and any third-party distributor.
 *
 * The protocol is deliberately built from two primitives that every runtime
 * already has:
 *   - a stable JSON encoding (so signatures survive key ordering),
 *   - Ed25519 signatures over that encoding.
 *
 * Nothing here touches the network or the file system.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'

export const PROTOCOL_VERSION = 1
export const GENESIS_HASH = '0'.repeat(64)

/**
 * Deterministic JSON: object keys sorted, `undefined` dropped, no whitespace.
 * Numbers must be finite so that a signature cannot be ambiguous about NaN.
 */
export function canonicalJson(value) {
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number')
    return JSON.stringify(value)
  }
  if (type === 'string' || type === 'boolean') return JSON.stringify(value)
  if (type === 'undefined') return 'null'
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item === undefined ? null : item)).join(',') + ']'
  }
  if (type === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  throw new TypeError(`canonicalJson: unsupported ${type}`)
}

export function sha256Hex(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function merkleRoot(leaves) {
  const list = Array.isArray(leaves) ? leaves : []
  if (list.length === 0) return sha256Hex('')
  let level = list.map((leaf) => createHash('sha256').update(String(leaf)).digest('hex'))
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]
      const right = level[i + 1] ?? left
      next.push(createHash('sha256').update(left + right).digest('hex'))
    }
    level = next
  }
  return level[0]
}

export function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

export function fromB64url(value) {
  return Buffer.from(String(value), 'base64url')
}

export function randomId(prefix = '', bytes = 12) {
  const body = b64url(randomBytes(bytes)).replace(/[^A-Za-z0-9]/g, '').slice(0, Math.ceil((bytes * 4) / 3))
  return prefix ? `${prefix}_${body}` : body
}

/** Generate an Ed25519 identity with PEM exports ready to persist. */
export function generateIdentity() {
  const pair = generateKeyPairSync('ed25519')
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    privatePem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  }
}

export function privateKeyFromPem(pem) {
  return createPrivateKey(String(pem))
}

/** Accept a KeyObject, PEM, or base64url SPKI DER. */
export function toPublicKey(key) {
  if (key && typeof key === 'object' && key.type === 'public') return key
  if (key && typeof key === 'object' && typeof key.export === 'function') {
    return createPublicKey(key)
  }
  const text = String(key || '').trim()
  if (!text) throw new TypeError('toPublicKey: empty key')
  if (text.includes('BEGIN PUBLIC KEY')) return createPublicKey(text)
  return createPublicKey({ key: Buffer.from(text, 'base64url'), format: 'der', type: 'spki' })
}

export function exportPublicKey(key) {
  const publicKey = toPublicKey(key)
  return b64url(publicKey.export({ type: 'spki', format: 'der' }))
}

/** `ed25519:<22 chars>`: short enough to print, derived from the key itself. */
export function keyFingerprint(key) {
  const publicKey = toPublicKey(key)
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return 'ed25519:' + b64url(createHash('sha256').update(der).digest()).slice(0, 22)
}

export function signCanonical(value, privateKey) {
  const body = canonicalJson(value)
  return b64url(sign(null, Buffer.from(body), privateKey))
}

export function verifyCanonical(value, signature, publicKey) {
  try {
    const body = Buffer.from(canonicalJson(value))
    return verify(null, body, toPublicKey(publicKey), fromB64url(signature))
  } catch {
    return false
  }
}

export function gzipJson(value) {
  return gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 })
}

export function gunzipJson(buffer) {
  return JSON.parse(gunzipSync(buffer).toString('utf8'))
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
