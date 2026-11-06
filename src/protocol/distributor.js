/**
 * Distributor manifests.
 *
 * Distribution is not exclusive to the official catalog: a distributor
 * publishes a self-signed manifest naming its endpoint, capabilities and
 * public key. Consumers can verify the manifest offline and keep using the
 * same UsageEvent / Batch / Settlement formats.
 */
import { createPublicKey } from 'node:crypto'
import { exportPublicKey, keyFingerprint, signCanonical, verifyCanonical } from './canonical.js'
import { assertValid, validateDistributorManifest } from './schema.js'
import { pickLang } from './catalog.js'

export function buildDistributorManifest({
  id,
  name,
  publicKey,
  capabilities = [],
  endpoints = {},
  privateKey,
  now = Date.now(),
  expiresAt = null,
} = {}) {
  const key = publicKey || (privateKey ? createPublicKey(privateKey) : null)
  if (!key) throw new TypeError('buildDistributorManifest: publicKey or privateKey is required')
  if (!id) throw new TypeError('buildDistributorManifest: id is required')
  if (!name) throw new TypeError('buildDistributorManifest: name is required')
  const payload = {
    schema: 1,
    id,
    name,
    public_key: exportPublicKey(key),
    capabilities: (Array.isArray(capabilities) ? capabilities : []).map((item) =>
      typeof item === 'string' ? { id: item, title: item } : { id: item.id, title: item.title || item.id },
    ),
    endpoints: {
      catalog: String(endpoints.catalog || ''),
      batch: String(endpoints.batch || ''),
      portal: String(endpoints.portal || ''),
    },
    issued_at: now,
    expires_at: expiresAt,
  }
  const manifest = { ...payload, sig: signCanonical(payload, privateKey) }
  assertValid(validateDistributorManifest(manifest), 'distributor-manifest')
  return manifest
}

export function verifyDistributorManifest(manifest, { now = Date.now() } = {}) {
  const shape = validateDistributorManifest(manifest)
  if (!shape.ok) return { ok: false, reason: 'invalid-shape', errors: shape.errors }
  const body = { ...manifest }
  delete body.sig
  if (!verifyCanonical(body, manifest.sig, manifest.public_key)) {
    return { ok: false, reason: 'bad-signature', errors: [] }
  }
  if (manifest.id.startsWith('ed25519:')) {
    try {
      if (keyFingerprint(manifest.public_key) !== manifest.id) return { ok: false, reason: 'id-mismatch', errors: [] }
    } catch {
      return { ok: false, reason: 'bad-key', errors: [] }
    }
  }
  if (manifest.expires_at !== null && manifest.expires_at < now) return { ok: false, reason: 'expired', errors: [] }
  return { ok: true, reason: null, errors: [] }
}

export function distributorName(manifest) {
  return pickLang(manifest && manifest.name) || (manifest && manifest.id) || ''
}
