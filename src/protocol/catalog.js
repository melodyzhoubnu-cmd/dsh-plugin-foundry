/**
 * Catalog and capability-index readers.
 *
 * The directory stays compatible with DSH's format-1 market index; the
 * `metadata` block is extended with the fields the distribution side needs
 * (capabilities, quality, risk, install source). Every field
 * is optional so an ordinary index still loads.
 */
import { canonicalJson, sha256Hex } from './canonical.js'
import { assertValid, validateCapabilityIndex, validateCatalogIndex } from './schema.js'

const SOURCE_TYPES = new Set(['npm', 'git', 'path', 'url'])

export function pickLang(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    return String(value.zh || value.en || Object.values(value)[0] || '')
  }
  return ''
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => typeof item === 'string' && item).map((item) => item.trim()))]
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return []
  const rows = []
  for (const item of value) {
    if (typeof item === 'string' && item) rows.push({ id: item, title: item })
    else if (item && typeof item === 'object' && typeof item.id === 'string' && item.id) {
      rows.push({ id: item.id, title: typeof item.title === 'string' && item.title ? item.title : item.id })
    }
  }
  const seen = new Set()
  return rows.filter((row) => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
}

function normalizeQuality(value, versionCount, publishedAt) {
  const source = value && typeof value === 'object' ? value : {}
  const stars = Number.isFinite(source.stars) ? Math.max(0, source.stars) : 0
  const users = Number.isFinite(source.users) ? Math.max(0, source.users) : 0
  const verified = source.verified === true
  const curated = source.curated === true
  const explicit = Number.isFinite(source.score) ? clamp01(source.score) : null
  // A transparent fallback: curated/verified dominate, then adoption, then
  // release history and recency. The explicit score always wins.
  const recency = publishedAt ? clamp01(1 - (Date.now() - publishedAt) / (365 * 86400000)) : 0
  const score = explicit ?? clamp01(
    0.30 * (curated ? 1 : 0) +
    0.20 * (verified ? 1 : 0) +
    0.25 * saturate(Math.log10(users + 1) / 4) +
    0.10 * saturate(Math.log2(versionCount + 1) / 3) +
    0.15 * recency,
  )
  return { score, verified, curated, stars, users }
}

function normalizeRisk(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    postinstall: source.postinstall === true,
    restartRequired: source.restartRequired === true,
    dataEgress: source.dataEgress === true,
    permissions: asStringArray(source.permissions),
  }
}

function normalizePublisher(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    id: typeof source.id === 'string' ? source.id : '',
    publicKey: typeof source.publicKey === 'string' ? source.publicKey : '',
    name: typeof source.name === 'string' ? source.name : '',
    verified: source.verified === true,
  }
}

export function normalizePluginEntry(plugin) {
  if (!plugin || typeof plugin.name !== 'string' || !plugin.name) return null
  const meta = plugin.metadata && typeof plugin.metadata === 'object' ? plugin.metadata : {}
  const versions = Array.isArray(plugin.versions) ? plugin.versions : []
  const latest = versions[0] && typeof versions[0] === 'object' ? versions[0] : null
  if (!latest) return null
  const title = pickLang(plugin.title) || plugin.name
  const description = pickLang(plugin.description) || ''
  const category = typeof meta.category === 'string' ? meta.category : ''
  const capabilities = normalizeCapabilities(meta.capabilities || plugin.capabilities)
  const keywords = [...new Set([
    ...asStringArray(meta.keywords),
    ...asStringArray(meta.labels),
    ...asStringArray(plugin.keywords),
    ...capabilities.map((capability) => capability.id),
  ])]
  const tools = asStringArray(meta.tools || plugin.tools)
  const publishedAt = timestampOf(latest.publishTimestamp ?? latest.publishedAt ?? plugin.publishedAt)
  const quality = normalizeQuality(meta.quality || plugin.quality, versions.length, publishedAt)
  const sourceTypeValue = (latest.source && latest.source.type) || meta.sourceType || 'npm'
  const sourceType = SOURCE_TYPES.has(sourceTypeValue) ? sourceTypeValue : 'url'
  const version = String(latest.version || '')
  const integrity = String(latest.integrity || plugin.integrity || '')
  const entry = {
    name: plugin.name,
    title,
    description: description.slice(0, 400),
    category,
    keywords,
    capabilities,
    capabilityIds: capabilities.map((capability) => capability.id),
    tools,
    version,
    versions: versions.map((row) => ({
      version: String(row.version || ''),
      engines: enginesOf(row),
      publishedAt: timestampOf(row.publishTimestamp ?? row.publishedAt),
      sourceType: (row.source && row.source.type) || sourceType,
      integrity: String(row.integrity || ''),
    })),
    versionCount: versions.length,
    engines: enginesOf(latest),
    sourceType,
    installSpec: typeof meta.installSpec === 'string' && meta.installSpec
      ? meta.installSpec
      : (latest.source && typeof latest.source.url === 'string' ? latest.source.url : ''),
    publishedAt,
    integrity,
    quality,
    risk: normalizeRisk(meta.risk || plugin.risk),
    publisher: normalizePublisher(meta.publisher || plugin.publisher),
    distributor: typeof meta.distributor === 'string' ? meta.distributor : '',
    pluginId: canonicalPluginId({ name: plugin.name, version, integrity }),
  }
  entry.searchText = [
    entry.name,
    entry.title,
    entry.description,
    category,
    entry.keywords.join(' '),
    entry.capabilityIds.join(' '),
    entry.publisher.name,
  ].join(' ').toLowerCase()
  return entry
}

function enginesOf(version) {
  const engines = version && version.engines
  if (!engines) return ''
  if (typeof engines === 'string') return engines
  if (typeof engines === 'object' && typeof engines.dsh === 'string') return engines.dsh
  return ''
}

function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.trunc(value) : Math.trunc(value * 1000)
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0))
}

function saturate(value) {
  return clamp01(value)
}

export function parseFormat1(document, option = {}) {
  assertValid(validateCatalogIndex(document), 'catalog-index')
  const entries = document.plugins.map(normalizePluginEntry).filter(Boolean)
  return {
    format: 1,
    title: pickLang(document.title) || 'Plugin catalog',
    description: pickLang(document.description) || '',
    entries: option.limit ? entries.slice(0, option.limit) : entries,
    fetchedAt: option.fetchedAt || Date.now(),
  }
}

/* ------------------------------- semver ------------------------------- */

export function parseVersion(input) {
  const match = String(input || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
    text: String(input).trim(),
  }
}

function comparePrerelease(left, right) {
  if (!left && !right) return 0
  if (!left) return 1
  if (!right) return -1
  const a = left.split('.')
  const b = right.split('.')
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (nx !== ny) {
      return nx ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left
  const b = typeof right === 'string' ? parseVersion(right) : right
  if (!a || !b) throw new TypeError(`compareVersions: invalid ${left} / ${right}`)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

function testComparator(version, comparator) {
  const match = String(comparator).trim().match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/)
  if (!match) return true
  const operator = match[1] || '='
  const target = parseVersion(match[2])
  if (!target) return true
  if (operator === '^') {
    if (version.major !== target.major) return false
    // ^0.x.y is a 0.x range, and ^0.0.z pins the patch: semver's caret is not
    // "any newer version with the same major".
    if (target.major === 0) {
      if (version.minor !== target.minor) return false
      if (target.minor === 0 && version.patch < target.patch) return false
    }
    return compareVersions(version, target) >= 0
  }
  if (operator === '~') {
    return version.major === target.major && version.minor === target.minor && compareVersions(version, target) >= 0
  }
  const order = compareVersions(version, target)
  if (operator === '>=') return order >= 0
  if (operator === '<=') return order <= 0
  if (operator === '>') return order > 0
  if (operator === '<') return order < 0
  return order === 0
}

export function satisfiesRange(range, version) {
  const text = String(range || '').trim()
  if (!text || text === '*' || text === 'x') return true
  const current = typeof version === 'string' ? parseVersion(version) : version
  if (!current) return true
  return text.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean)
    if (comparators.length === 0) return true
    // `^1.2.3` and `~1.2.3` are single comparators; ranges like `>=1 <2` are
    // conjunctive.
    return comparators.every((comparator) => testComparator(current, comparator))
  })
}

export function compatibleWith(engines, runtimeVersion) {
  const text = typeof engines === 'string' ? engines : enginesOf({ engines })
  if (!text) return true
  if (!runtimeVersion) return true
  const runtime = parseVersion(runtimeVersion)
  if (!runtime) return true
  // A running prerelease (for example 0.2.1-rc.5) satisfies a range written
  // for the release line (>=0.2.1). Semver would say no; product-wise the
  // prerelease is the installed build of that line, and refusing every plugin
  // would make the directory unusable on the candidate build.
  const version = runtime.prerelease && !/\d-[A-Za-z0-9]/.test(text)
    ? { ...runtime, prerelease: '' }
    : runtime
  return satisfiesRange(text, version)
}

/* --------------------------- plugin identity --------------------------- */

export function normalizeIntegrityHex(integrity) {
  const value = String(integrity || '').trim()
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  const sha256 = value.match(/^sha256-([A-Za-z0-9+/=_-]+)$/)
  if (sha256) {
    try {
      return Buffer.from(sha256[1], 'base64').toString('hex')
    } catch {
      /* fall through */
    }
  }
  return sha256Hex(value)
}

export function canonicalPluginId({ name, version, integrity }) {
  const versionText = version || '0.0.0'
  const hash = integrity ? `#sha256:${normalizeIntegrityHex(integrity)}` : ''
  return `pkg:npm/${name}@${versionText}${hash}`
}

export function installTarget(entry) {
  if (!entry || !entry.name) throw new TypeError('installTarget: entry is required')
  return entry.version ? `${entry.name}@${entry.version}` : entry.name
}

/* -------------------------- capability index -------------------------- */

export function buildCapabilityIndex(entries, now = Date.now()) {
  const map = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const capability of entry.capabilities || []) {
      const row = map.get(capability.id) || { id: capability.id, title: capability.title || capability.id, providers: [] }
      row.providers.push({
        plugin_id: entry.pluginId,
        name: entry.name,
        title: entry.title,
        category: entry.category,
        verified: Boolean(entry.quality && entry.quality.verified),
      })
      map.set(capability.id, row)
    }
  }
  const index = {
    schema: 1,
    generated_at: now,
    capabilities: [...map.values()]
      .map((row) => ({
        ...row,
        providers: row.providers.sort((a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
  assertValid(validateCapabilityIndex(index), 'capability-index')
  return index
}

export function lookupCapability(index, capabilityId) {
  if (!index || !Array.isArray(index.capabilities)) return null
  return index.capabilities.find((capability) => capability.id === capabilityId) || null
}

export function fingerprintCatalog(entries) {
  return sha256Hex(canonicalJson((entries || []).map((entry) => entry.name).sort()))
}

/**
 * A package found through npm search rather than a curated index.
 *
 * Only the fields npm returns are trusted: name, version, description, date.
 * Everything else is deliberately conservative: no tools, no capabilities, a
 * low quality prior. It may be recommended, never auto-installed.
 */
export function discoveredEntryFromNpm(pkg) {
  if (!pkg || typeof pkg.name !== 'string' || !pkg.name) return null
  const version = String(pkg.version || '0.0.0')
  const publishedAt = pkg.date ? Date.parse(pkg.date) || 0 : 0
  const description = typeof pkg.description === 'string' ? pkg.description : ''
  const publisherName = pkg.publisher && typeof pkg.publisher.username === 'string' ? pkg.publisher.username : ''
  const entry = {
    name: pkg.name,
    title: pkg.name,
    description: description.slice(0, 400),
    category: '',
    keywords: [],
    capabilities: [],
    capabilityIds: [],
    tools: [],
    version,
    versions: [{
      version,
      engines: '',
      publishedAt,
      sourceType: 'npm',
      integrity: '',
    }],
    versionCount: 1,
    engines: '',
    sourceType: 'npm',
    publishedAt,
    integrity: '',
    quality: { score: 0.2, verified: false, curated: false, stars: 0, users: 0 },
    risk: { postinstall: false, restartRequired: false, dataEgress: false, permissions: [] },
    publisher: { id: '', publicKey: '', name: publisherName, verified: false },
    distributor: 'npm-registry',
    pluginId: canonicalPluginId({ name: pkg.name, version }),
    discovered: true,
  }
  entry.searchText = [entry.name, entry.title, entry.description, publisherName].join(' ').toLowerCase()
  return entry
}

/**
 * A repository found through GitHub search.
 *
 * The install target is the repository URL; the Host inspects it before
 * installing, so a repository that does not declare `dsh.bundle` simply fails
 * the preflight. Stars are only a weak prior, never an auto-install guarantee.
 */
export function discoveredEntryFromGithub(repo) {
  if (!repo || typeof repo.full_name !== 'string' || !repo.full_name) return null
  const name = repo.full_name
  const publishedAt = Date.parse(repo.pushed_at || repo.updated_at || repo.created_at || '') || 0
  const stars = Number.isFinite(repo.stargazers_count) ? Math.max(0, repo.stargazers_count) : 0
  const topics = Array.isArray(repo.topics) ? repo.topics.filter((item) => typeof item === 'string') : []
  const description = typeof repo.description === 'string' ? repo.description : ''
  const owner = repo.owner && typeof repo.owner.login === 'string' ? repo.owner.login : ''
  const entry = {
    name,
    title: typeof repo.name === 'string' && repo.name ? repo.name : name,
    description: (description || 'DSH plugin repository on GitHub').slice(0, 400),
    category: '',
    keywords: topics,
    capabilities: [],
    capabilityIds: [],
    tools: [],
    version: '0.0.0',
    versions: [{
      version: '0.0.0',
      engines: '',
      publishedAt,
      sourceType: 'git',
      integrity: '',
    }],
    versionCount: 1,
    engines: '',
    sourceType: 'git',
    publishedAt,
    integrity: '',
    quality: { score: Math.min(0.5, 0.15 + Math.log10(stars + 1) / 4), verified: false, curated: false, stars, users: 0 },
    risk: { postinstall: false, restartRequired: false, dataEgress: false, permissions: [] },
    publisher: { id: owner ? `github:${owner}` : '', publicKey: '', name: owner, verified: false },
    distributor: 'github',
    pluginId: `pkg:github/${name}@HEAD`,
    installSpec: typeof repo.html_url === 'string' ? repo.html_url : `https://github.com/${name}`,
    homepage: typeof repo.html_url === 'string' ? repo.html_url : '',
    repository: name,
    discovered: true,
  }
  entry.searchText = [entry.name, entry.title, entry.description, entry.keywords.join(' '), owner].join(' ').toLowerCase()
  return entry
}

