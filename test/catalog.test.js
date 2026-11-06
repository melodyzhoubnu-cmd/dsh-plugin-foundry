import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCatalog, mergeCatalogEntries } from '../src/radar/catalog.js'
import { discoveredEntryFromGithub, discoveredEntryFromNpm } from '../src/protocol/catalog.js'

const doc = (plugins) => ({
  format: 1,
  title: { zh: 'fixture' },
  description: { zh: 'fixture' },
  metadata: { categories: {}, labels: {}, sortKeys: {} },
  plugins,
})

const plugin = (name, { quality = 0.5, tools = [], description = '' } = {}) => ({
  name,
  title: { zh: name },
  description: { zh: description || `${name} description` },
  metadata: {
    category: 'tools',
    keywords: [name],
    capabilities: [{ id: 'spreadsheet.read', title: '读取表格' }],
    tools,
    quality: { score: quality, verified: quality > 0.7, curated: false, users: 10, stars: 1 },
  },
  versions: [{
    version: '1.0.0',
    publishTimestamp: Math.floor(Date.now() / 1000) - 3600,
    source: { type: 'npm' },
    engines: { dsh: '>=0.2.1' },
    integrity: 'a'.repeat(64),
  }],
})

async function serve(payload) {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(typeof payload === 'function' ? payload() : payload))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}/index.json` }
}

test('multiple format-1 indexes merge by package name', async () => {
  const first = await serve(doc([
    plugin('dsh-a', { quality: 0.4 }),
    plugin('dsh-only-first', { quality: 0.3 }),
  ]))
  const second = await serve(doc([
    plugin('dsh-a', { quality: 0.8, tools: ['a_tool'], description: 'better metadata' }),
    plugin('dsh-b', { quality: 0.6 }),
  ]))
  const home = mkdtempSync(path.join(os.tmpdir(), 'foundry-catalog-'))
  const catalog = createCatalog({ urls: [first.url, second.url], home, ttlMs: 60_000, npmSearch: false })
  await catalog.ensure()
  const snapshot = catalog.snapshot()
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.total, 3)
  assert.equal(snapshot.sources.length, 2)
  const merged = catalog.byName('dsh-a')
  assert.equal(merged.quality.score, 0.8)
  assert.deepEqual(merged.tools, ['a_tool'])
  assert.equal(merged.description, 'better metadata')
  assert.equal(merged.sourceUrls.length, 2)
  first.server.close()
  second.server.close()
})

test('npm discovery adds packages that the indexes do not list', async () => {
  const index = await serve(doc([plugin('dsh-indexed')]))
  const search = await serve({
    objects: [{
      package: {
        name: 'dsh-new-package',
        version: '2.0.0',
        description: 'a newly published DSH plugin',
        date: '2026-01-01T00:00:00.000Z',
        publisher: { username: 'new-publisher' },
      },
      score: { final: 0.4 },
    }],
  })
  const home = mkdtempSync(path.join(os.tmpdir(), 'foundry-catalog-npm-'))
  const catalog = createCatalog({
    urls: [index.url],
    home,
    ttlMs: 60_000,
    npmSearch: true,
    npmSearchUrl: search.url.replace('/index.json', '/search'),
  })
  await catalog.ensure()
  const discovered = await catalog.discover('excel plugin')
  assert.equal(discovered.length, 1)
  assert.equal(discovered[0].name, 'dsh-new-package')
  assert.equal(discovered[0].pluginId, 'pkg:npm/dsh-new-package@2.0.0')
  assert.equal(discovered[0].quality.score, 0.2)
  assert.equal(discovered[0].discovered, true)
  assert.equal(catalog.byName('dsh-new-package').publisher.name, 'new-publisher')
  assert.equal(catalog.snapshot().discovered, 1)
  assert.equal(catalog.snapshot().total, 2)
  index.server.close()
  search.server.close()
})

test('mergeCatalogEntries prefers richer metadata and unions capabilities', () => {
  const merged = mergeCatalogEntries([
    { url: 'a', entries: [{ ...plugin('x'), capabilityIds: ['a'], capabilities: [{ id: 'a', title: 'A' }], keywords: ['one'], tools: ['t1'] }] },
    { url: 'b', entries: [{ ...plugin('x'), quality: { score: 0.9 }, capabilityIds: ['b'], capabilities: [{ id: 'b', title: 'B' }], keywords: ['two'], tools: ['t2'] }] },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].quality.score, 0.9)
  assert.deepEqual(merged[0].capabilityIds.slice().sort(), ['a', 'b'])
  assert.deepEqual(merged[0].tools, ['t1', 't2'])
  assert.deepEqual(merged[0].keywords, ['one', 'two'])
})

test('discoveredEntryFromGithub maps a repository to a git install target', () => {
  const entry = discoveredEntryFromGithub({
    full_name: 'owner/dsh-thing',
    name: 'dsh-thing',
    description: 'A DSH plugin for niche tasks',
    html_url: 'https://github.com/owner/dsh-thing',
    stargazers_count: 12,
    pushed_at: '2026-01-01T00:00:00Z',
    topics: ['dsh', 'plugin'],
    owner: { login: 'owner' },
  })
  assert.ok(entry)
  assert.equal(entry.name, 'owner/dsh-thing')
  assert.equal(entry.sourceType, 'git')
  assert.equal(entry.installSpec, 'https://github.com/owner/dsh-thing')
  assert.equal(entry.pluginId, 'pkg:github/owner/dsh-thing@HEAD')
  assert.equal(entry.quality.stars, 12)
  assert.equal(entry.discovered, true)
  assert.equal(discoveredEntryFromGithub(null), null)
})

test('GitHub discovery adds repositories that the indexes do not list', async () => {
  const index = await serve(doc([plugin('dsh-indexed')]))
  const github = await serve({
    items: [{
      full_name: 'owner/dsh-niche',
      name: 'dsh-niche',
      description: 'A niche DSH plugin found on GitHub',
      html_url: 'https://github.com/owner/dsh-niche',
      stargazers_count: 5,
      pushed_at: '2026-01-01T00:00:00Z',
      topics: ['dsh', 'plugin'],
      owner: { login: 'owner' },
    }],
  })
  const home = mkdtempSync(path.join(os.tmpdir(), 'foundry-catalog-github-'))
  const catalog = createCatalog({
    urls: [index.url],
    home,
    ttlMs: 60_000,
    npmSearch: false,
    githubSearch: true,
    githubSearchUrl: github.url.replace('/index.json', '/repos'),
  })
  await catalog.ensure()
  const discovered = await catalog.discover('niche task')
  assert.equal(discovered.length, 1)
  assert.equal(discovered[0].name, 'owner/dsh-niche')
  assert.equal(discovered[0].sourceType, 'git')
  assert.equal(catalog.byName('owner/dsh-niche').installSpec, 'https://github.com/owner/dsh-niche')
  index.server.close()
  github.server.close()
})

test('discoveredEntryFromNpm is conservative', () => {
  assert.equal(discoveredEntryFromNpm(null), null)
  assert.equal(discoveredEntryFromNpm({}), null)
  const entry = discoveredEntryFromNpm({ name: 'dsh-x', version: '1.0.0', description: 'x', date: '2026-01-01T00:00:00Z' })
  assert.equal(entry.quality.score, 0.2)
  assert.equal(entry.tools.length, 0)
  assert.equal(entry.discovered, true)
})
