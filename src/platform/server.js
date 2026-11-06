/**
 * Reference platform server.
 *
 * Zero dependencies. It implements the pieces a third party would otherwise
 * have to invent privately:
 *   POST /v1/hosts/register      register a Host public key + install id
 *   POST /v1/hosts/bill          register the provider bill anchor
 *   POST /v1/usage/batches       signed, gzipped daily batches
 *   GET  /v1/settlements         compute + sign a developer statement
 *   GET  /v1/settlements/:id     read one statement
 *   POST /v1/distributors        register a self-signed distributor manifest
 *   GET  /v1/catalog             the format-1 catalog the Host fetches
 *   GET  /portal                 server-rendered developer portal
 */
import http from 'node:http'
import { gunzipSync } from 'node:zlib'
import { keyFingerprint, exportPublicKey, generateIdentity } from '../protocol/canonical.js'
import { parseFormat1 } from '../protocol/catalog.js'
import { settle, verifySettlement } from '../protocol/settlement.js'
import { verifyDistributorManifest } from '../protocol/distributor.js'
import { createPlatformStore } from './store.js'
import { ingestBatch, verifyHostRegistration } from './verify.js'
import { renderMessage, renderPortal, portalJson } from './portal.js'

const BODY_LIMIT = 16 * 1024 * 1024

export function createPlatform({
  home,
  catalog,
  publishers = [],
  publisherByPlugin = {},
  meterIdentity,
  rates = {},
  runtimeVersion = '0.2.1-rc.5',
} = {}) {
  if (!home) throw new TypeError('createPlatform: home is required')
  if (!catalog || catalog.format !== 1) throw new TypeError('createPlatform: a format-1 catalog is required')
  const store = createPlatformStore({ home })
  const meter = meterIdentity || generateIdentity()
  const meterKey = keyFingerprint(meter.publicKey)
  const parsed = parseFormat1(catalog)
  const entries = parsed.entries
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const publisherById = new Map()
  for (const publisher of publishers) publisherById.set(publisher.id, publisher)
  const publisherFor = (entry) => {
    if (!entry) return null
    return publisherByPlugin[entry.name] || publisherById.get(entry.publisher.id) || null
  }
  const resolvePluginId = (value) => {
    if (!value) return value
    const entry = byName.get(value)
    return entry ? entry.pluginId : value
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      sendJson(response, 500, { error: 'internal', message: String((error && error.message) || error) })
    })
  })

  let url = ''

  async function handle(request, response) {
    const requestUrl = new URL(request.url || '/', 'http://localhost')
    const pathname = requestUrl.pathname
    if (request.method === 'GET' && pathname === '/health') {
      return sendJson(response, 200, { ok: true, service: 'plugin-foundry-platform', time: Date.now() })
    }
    if (request.method === 'GET' && pathname === '/v1/catalog') {
      return sendJson(response, 200, catalog)
    }
    if (request.method === 'GET' && pathname === '/v1/plugins') {
      const query = (requestUrl.searchParams.get('q') || '').toLowerCase()
      const rows = entries.filter((entry) => !query || entry.searchText.includes(query))
      return sendJson(response, 200, { plugins: rows })
    }
    if (request.method === 'POST' && pathname === '/v1/hosts/register') {
      return registerHost(request, response)
    }
    if (request.method === 'POST' && pathname === '/v1/hosts/bill') {
      return registerBill(request, response)
    }
    if (request.method === 'POST' && pathname === '/v1/usage/batches') {
      return intakeBatch(request, response)
    }
    if (request.method === 'GET' && pathname === '/v1/settlements') {
      return listSettlements(requestUrl, response)
    }
    if (request.method === 'GET' && pathname.startsWith('/v1/settlements/')) {
      return getSettlement(pathname.slice('/v1/settlements/'.length), response)
    }
    if (request.method === 'POST' && pathname === '/v1/distributors') {
      return registerDistributor(request, response)
    }
    if (request.method === 'GET' && pathname === '/v1/distributors') {
      return sendJson(response, 200, { distributors: store.distributors() })
    }
    if (request.method === 'GET' && pathname === '/v1/stats') {
      const publisher = requestUrl.searchParams.get('publisher') || undefined
      const from = requestUrl.searchParams.get('from') || undefined
      const to = requestUrl.searchParams.get('to') || undefined
      const stats = store.stats({ publisher, from, to })
      return sendJson(response, 200, portalJson({
        publisher,
        stats,
        settlements: store.settlements({ publisher }),
        batches: store.batches(),
        entries: publisher ? entries.filter((entry) => entry.publisher.id === publisher) : entries,
        rates,
      }))
    }
    if (request.method === 'GET' && pathname === '/portal') {
      const publisher = requestUrl.searchParams.get('publisher') || undefined
      const stats = store.stats({ publisher })
      const publisherName = publisher
        ? (publisherById.get(publisher)?.name || publisher)
        : '全部开发者'
      return sendHtml(response, 200, renderPortal({
        publisher,
        publisherName,
        stats,
        settlements: store.settlements({ publisher }),
        batches: store.batches(),
        entries,
        hosts: Object.values(store.snapshot().hosts),
        rates,
      }))
    }
    if (request.method === 'GET' && pathname === '/portal.json') {
      const publisher = requestUrl.searchParams.get('publisher') || undefined
      const stats = store.stats({ publisher })
      return sendJson(response, 200, portalJson({
        publisher,
        stats,
        settlements: store.settlements({ publisher }),
        batches: store.batches(),
        entries: publisher ? entries.filter((entry) => entry.publisher.id === publisher) : entries,
        rates,
      }))
    }
    return sendJson(response, 404, { error: 'not-found', path: pathname })
  }

  async function registerHost(request, response) {
    const body = await readJson(request)
    const check = verifyHostRegistration(body)
    if (!check.ok) return sendJson(response, 400, { accepted: false, problem: check.problem })
    const host = store.registerHost({
      hostId: body.hostId,
      installId: body.installId,
      publicKey: body.publicKey,
      runtimeVersion: body.runtimeVersion || runtimeVersion,
    })
    return sendJson(response, 201, { accepted: true, host })
  }

  async function registerBill(request, response) {
    const body = await readJson(request)
    if (!body || typeof body.hostId !== 'string' || !Number.isFinite(Number(body.tokens))) {
      return sendJson(response, 400, { accepted: false, problem: 'bad-bill' })
    }
    if (!store.host(body.hostId)) return sendJson(response, 404, { accepted: false, problem: 'unknown-host' })
    const bill = store.setBill(body.hostId, { tokens: body.tokens, period: body.period || null })
    return sendJson(response, 200, { accepted: true, bill })
  }

  async function intakeBatch(request, response) {
    let buffer
    try {
      buffer = await readBody(request)
    } catch (error) {
      return sendJson(response, 413, { accepted: false, problem: String((error && error.message) || error) })
    }
    let batch
    try {
      const encoding = String(request.headers['content-encoding'] || '').toLowerCase()
      const raw = encoding.includes('gzip') ? gunzipSync(buffer) : buffer
      batch = JSON.parse(raw.toString('utf8'))
    } catch {
      return sendJson(response, 400, { accepted: false, problem: 'invalid-body' })
    }
    const installIdHeader = request.headers['x-install-id'] || request.headers['idempotency-install']
    const result = ingestBatch({
      store,
      batch,
      installIdHeader: typeof installIdHeader === 'string' ? installIdHeader : '',
    })
    return sendJson(response, result.status, result.body)
  }

  function listSettlements(requestUrl, response) {
    const publisher = requestUrl.searchParams.get('publisher') || ''
    if (!publisher) {
      return sendJson(response, 200, { settlements: store.settlements({}) })
    }
    const from = requestUrl.searchParams.get('from') || undefined
    const to = requestUrl.searchParams.get('to') || undefined
    const stats = store.stats({ publisher, from, to })
    if (stats.byPlugin.length === 0) {
      return sendJson(response, 200, { settlements: [], totals: stats.totals, note: 'no attributed usage for this publisher' })
    }
    const now = Date.now()
    const statement = settle({
      publisher,
      period: {
        start: from ? `${from}T00:00:00.000Z` : new Date(now - 30 * 86400000).toISOString(),
        end: to ? `${to}T23:59:59.999Z` : new Date(now).toISOString(),
      },
      totals: stats.byPlugin,
      rates,
      meterKey,
      privateKey: meter.privateKey,
      now,
    })
    store.addSettlement(statement)
    return sendJson(response, 200, {
      settlement: statement,
      verified: verifySettlement(statement, meter.publicKey),
    })
  }

  function getSettlement(id, response) {
    const statement = store.settlements({}).find((row) => row.settlement_id === id)
    if (!statement) return sendJson(response, 404, { error: 'not-found', settlement_id: id })
    return sendJson(response, 200, {
      settlement: statement,
      verified: verifySettlement(statement, meter.publicKey),
      meter_key: meterKey,
      public_key: exportPublicKey(meter.publicKey),
    })
  }

  async function registerDistributor(request, response) {
    const body = await readJson(request)
    const manifest = body && body.manifest ? body.manifest : body
    const result = verifyDistributorManifest(manifest)
    if (!result.ok) return sendJson(response, 400, { accepted: false, problem: result.reason })
    store.addDistributor(manifest)
    return sendJson(response, 201, { accepted: true, distributor: manifest })
  }

  return {
    server,
    store,
    meter,
    meterKey,
    catalog,
    entries,
    publisherFor,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          const address = server.address()
          url = `http://${host}:${address.port}`
          resolve(url)
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
    get url() {
      return url
    },
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(html)
}

async function readBody(request, limit = BODY_LIMIT) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(request, { allowForm = false } = {}) {
  const buffer = await readBody(request)
  const type = String(request.headers['content-type'] || '')
  if (allowForm && type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(buffer.toString('utf8')))
  }
  if (!buffer.length) return {}
  return JSON.parse(buffer.toString('utf8'))
}
