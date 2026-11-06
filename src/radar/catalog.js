/**
 * Catalog loader: aggregate one or more format-1 indexes, then optionally ask
 * the npm registry for packages that no index lists.
 *
 * The static index is the recall base; npm search is the on-demand "whole web"
 * extension used when the model is already looking for a plugin. Neither path
 * trusts metadata for auto-install: discovery entries get a low quality prior,
 * so they can be recommended but never installed silently.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseFormat1, discoveredEntryFromNpm, discoveredEntryFromGithub } from '../protocol/catalog.js'

export const DEFAULT_CATALOG_URL = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'
export const DEFAULT_NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search'
export const DEFAULT_GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories'
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 20_000
const RETRY_MS = 5 * 60 * 1000
const DISCOVERY_TTL_MS = 60 * 1000

function hashKey(value) {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0
  return Math.abs(hash).toString(36)
}

function sourceList(url, urls) {
  const list = Array.isArray(urls) ? urls.filter((item) => typeof item === 'string' && item) : []
  if (list.length > 0) return [...new Set(list)]
  if (typeof url === 'string' && url) return [url]
  return [DEFAULT_CATALOG_URL]
}

function mergeEntries(left, right, url) {
  const preferred = (right.quality && right.quality.score || 0) > (left.quality && left.quality.score || 0) ? right : left
  const byCapability = new Map()
  for (const capability of [...(left.capabilities || []), ...(right.capabilities || [])]) {
    if (capability && capability.id) byCapability.set(capability.id, capability)
  }
  return {
    ...preferred,
    keywords: [...new Set([...(left.keywords || []), ...(right.keywords || [])])].slice(0, 24),
    capabilities: [...byCapability.values()].slice(0, 16),
    capabilityIds: [...new Set([...(left.capabilityIds || []), ...(right.capabilityIds || [])])],
    tools: [...new Set([...(left.tools || []), ...(right.tools || [])])].slice(0, 24),
    versionCount: Math.max(left.versionCount || 0, right.versionCount || 0),
    sourceUrls: [...new Set([...(left.sourceUrls || []), ...(right.sourceUrls || []), url].filter(Boolean))],
  }
}

export function mergeCatalogEntries(results) {
  const map = new Map()
  for (const result of Array.isArray(results) ? results : []) {
    for (const entry of result.entries || []) {
      if (!entry || !entry.name) continue
      const existing = map.get(entry.name)
      map.set(entry.name, existing ? mergeEntries(existing, entry, result.url) : { ...entry, sourceUrls: [result.url] })
    }
  }
  return [...map.values()]
}

export function createCatalog({
  url,
  urls,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  home,
  fetchImpl = globalThis.fetch,
  npmSearch = false,
  npmSearchUrl = DEFAULT_NPM_SEARCH_URL,
  githubSearch = false,
  githubSearchUrl = DEFAULT_GITHUB_SEARCH_URL,
  githubToken = '',
  githubMinStars = 0,
  logger,
} = {}) {
  if (!home) throw new TypeError('createCatalog: home is required')
  const sources = sourceList(url, urls)
  const cacheFile = path.join(home, `catalog-${hashKey(sources.join('|'))}.json`)
  let state = {
    status: 'idle',
    entries: [],
    total: 0,
    fetchedAt: 0,
    error: null,
    urls: sources,
    sources: [],
  }
  const discovered = new Map()
  const discoveryCache = new Map()
  let inflight = null
  let cacheChecked = false
  let retryAt = 0

  async function readCache() {
    try {
      const raw = await fs.readFile(cacheFile, 'utf8')
      const cached = JSON.parse(raw)
      if (!cached || !Array.isArray(cached.entries) || !cached.fetchedAt) return false
      if (Date.now() - cached.fetchedAt >= ttlMs) return false
      state = {
        status: 'ready',
        entries: cached.entries,
        total: cached.entries.length,
        fetchedAt: cached.fetchedAt,
        error: null,
        urls: sources,
        sources: Array.isArray(cached.sources) ? cached.sources : [],
      }
      return true
    } catch {
      return false
    }
  }

  async function writeCache(entries, fetchedAt, sourceState) {
    try {
      await fs.mkdir(home, { recursive: true })
      await fs.writeFile(cacheFile, JSON.stringify({ urls: sources, fetchedAt, entries, sources: sourceState }))
    } catch {
      /* the cache is an optimisation */
    }
  }

  async function fetchSource(sourceUrl) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable in this runtime')
    const response = await fetchImpl(sourceUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const document = await response.json()
    const parsed = parseFormat1(document)
    return { url: sourceUrl, entries: parsed.entries, fetchedAt: parsed.fetchedAt }
  }

  async function ensure(force = false) {
    if (!cacheChecked && !force) {
      cacheChecked = true
      if (await readCache()) return snapshot()
    }
    const fresh = state.status === 'ready' && Date.now() - state.fetchedAt < ttlMs
    if (fresh && !force) return snapshot()
    if (inflight) return inflight
    if (!force && Date.now() < retryAt) return snapshot()

    state = { ...state, status: 'loading', error: null }
    inflight = (async () => {
      const results = await Promise.allSettled(sources.map((sourceUrl) => fetchSource(sourceUrl)))
      const successful = []
      const sourceState = []
      const errors = []
      results.forEach((result, index) => {
        const sourceUrl = sources[index]
        if (result.status === 'fulfilled') {
          successful.push(result.value)
          sourceState.push({ url: sourceUrl, status: 'ready', count: result.value.entries.length })
        } else {
          const error = String((result.reason && result.reason.message) || result.reason)
          errors.push(`${sourceUrl}: ${error}`)
          sourceState.push({ url: sourceUrl, status: 'error', count: 0, error })
        }
      })
      const entries = mergeCatalogEntries(successful)
      const fetchedAt = Date.now()
      if (entries.length > 0) {
        state = {
          status: 'ready',
          entries,
          total: entries.length,
          fetchedAt,
          error: errors.length > 0 ? errors.join('; ') : null,
          urls: sources,
          sources: sourceState,
        }
        await writeCache(entries, fetchedAt, sourceState)
        retryAt = 0
      } else {
        state = {
          ...state,
          status: 'error',
          error: errors.join('; ') || 'no entries',
          urls: sources,
          sources: sourceState,
        }
        retryAt = Date.now() + RETRY_MS
      }
      inflight = null
      return snapshot()
    })()
    return inflight
  }

  /**
   * Ask the npm registry for packages matching a model-authored query. This is
   * the "whole web" extension: it discovers packages that the curated index
   * does not list. Entries are marked low-quality, so they are recommendation
   * candidates, never silent installs.
   */
  async function searchNpm(text, limit) {
    if (!npmSearch || typeof fetchImpl !== 'function') return []
    const url = `${npmSearchUrl}?text=${encodeURIComponent(`${text} dsh plugin`)}&size=${Math.max(1, Math.min(50, limit))}`
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`npm HTTP ${response.status}`)
    const document = await response.json()
    const objects = Array.isArray(document && document.objects) ? document.objects : []
    return objects
      .map((object) => discoveredEntryFromNpm(object && object.package))
      .filter((entry) => entry && /dsh|plugin/i.test(`${entry.name} ${entry.description}`))
  }

  async function searchGithub(text, limit) {
    if (!githubSearch || typeof fetchImpl !== 'function') return []
    const query = `${text} dsh plugin in:name,description,readme`
    const url = `${githubSearchUrl}?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${Math.max(1, Math.min(30, limit))}`
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-plugin-foundry',
        ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
      },
    })
    if (!response.ok) throw new Error(`github HTTP ${response.status}`)
    const document = await response.json()
    const items = Array.isArray(document && document.items) ? document.items : []
    return items
      .map((repo) => discoveredEntryFromGithub(repo))
      .filter((entry) => entry && entry.quality.stars >= githubMinStars)
      .filter((entry) => /dsh|plugin/i.test(`${entry.name} ${entry.description} ${entry.keywords.join(' ')}`))
  }

  async function discover(query, { limit = 20 } = {}) {
    if (!npmSearch && !githubSearch) return []
    const text = String(query || '').trim() || 'dsh plugin'
    const cached = discoveryCache.get(text)
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.entries
    const [npmResult, githubResult] = await Promise.allSettled([
      searchNpm(text, limit),
      searchGithub(text, Math.min(10, limit)),
    ])
    const entries = []
    for (const result of [npmResult, githubResult]) {
      if (result.status === 'fulfilled') entries.push(...result.value)
      else logger?.warn?.(`plugin-foundry: discovery source failed: ${String((result.reason && result.reason.message) || result.reason)}`)
    }
    for (const entry of entries) {
      if (!state.entries.some((item) => item.name === entry.name)) discovered.set(entry.name, entry)
    }
    const fresh = entries.filter((entry) => discovered.has(entry.name))
    discoveryCache.set(text, { at: Date.now(), entries: fresh })
    return fresh
  }

  function allEntries() {
    if (discovered.size === 0) return state.entries
    return [...state.entries, ...discovered.values()]
  }

  function snapshot() {
    return {
      status: state.status,
      total: allEntries().length,
      fetchedAt: state.fetchedAt,
      error: state.error,
      stale: false,
      source: state.sources.length > 1 ? 'multi' : 'single',
      url: sources[0],
      urls: sources,
      sources: state.sources,
      discovered: discovered.size,
      npmSearch,
      githubSearch,
    }
  }

  function entries() {
    return allEntries()
  }

  function byName(name) {
    return allEntries().find((entry) => entry.name === name) || null
  }

  function ready() {
    return state.status === 'ready' && allEntries().length > 0
  }

  return { ensure, discover, snapshot, entries, byName, ready, cacheFile }
}
