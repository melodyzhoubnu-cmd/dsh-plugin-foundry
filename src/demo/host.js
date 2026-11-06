/**
 * A small fake DSH Host used by the demo and the integration tests.
 *
 * It mirrors the real API shapes that matter:
 *   - `pluginManager.listBundles()` is async and `installed` marks a bundle;
 *   - `inspect(spec)` returns `{status, bundle}` or `{problem}`;
 *   - `installBundle`/`removeBundle` return `ChangeResult`;
 *   - `session.append(type, data, { surfaceOp })` appends surface events;
 *   - RPC routes are registered through `connection.fetch.register`.
 */
import assert from 'node:assert/strict'

export function createFakeHost({ installed = [], manager: managerOverrides = {}, warnings = [] } = {}) {
  const routes = []
  const installs = []
  const bundles = [
    { name: '@deepseek-ai/dsh-base', installed: true, enabled: true, official: true, availability: 'installation', optional: false, removable: false, updatable: false, rows: [], overrides: [] },
    ...installed.map((name) => ({
      name,
      installed: true,
      enabled: true,
      official: name.startsWith('@deepseek-ai/'),
      availability: 'profile',
      optional: false,
      removable: true,
      updatable: false,
      rows: [],
      overrides: [],
    })),
  ]

  const manager = {
    async listBundles() {
      return bundles.map((row) => ({ ...row }))
    },
    async inspect(spec) {
      if (typeof managerOverrides.inspect === 'function') return managerOverrides.inspect(spec)
      const name = spec.replace(/@[^@/]+$/, '')
      return { status: 'accepted', kind: 'registry', name, version: '1.0.0', bundle: true, registry: 'https://registry.npmjs.org/' }
    },
    async installBundle(spec, options) {
      if (typeof managerOverrides.installBundle === 'function') {
        return managerOverrides.installBundle(spec, options, { bundles, installs })
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
      const name = spec.replace(/@[^@/]+$/, '')
      installs.push(name)
      bundles.push({
        name,
        installed: true,
        enabled: true,
        official: name.startsWith('@deepseek-ai/'),
        availability: 'profile',
        version: (spec.match(/@([^@/]+)$/) || [])[1] || '1.0.0',
        optional: false,
        removable: true,
        updatable: false,
        rows: [],
        overrides: [],
      })
      return { changed: true, application: 'applied', stage: 'install', target: spec, bundle: name, version: '1.0.0' }
    },
    async removeBundle(name) {
      if (typeof managerOverrides.removeBundle === 'function') {
        return managerOverrides.removeBundle(name, { bundles })
      }
      const at = bundles.findIndex((row) => row.name === name)
      if (at >= 0) bundles.splice(at, 1)
      return { changed: true, application: 'applied', stage: 'remove', target: name }
    },
  }

  const sessions = new Map()
  const listeners = []

  function sessionOf(id) {
    if (!sessions.has(id)) {
      const events = []
      sessions.set(id, {
        id,
        events,
        append(type, data, opts) {
          if (['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'].includes(type)) {
            assert.equal(opts && opts.surfaceOp, 'append', 'surface append must pass surfaceOp')
          }
          const event = { type, data, time: Date.now(), seq: events.length + 1 }
          events.push(event)
          return event
        },
        snapshotEvents() {
          return events
        },
      })
    }
    return sessions.get(id)
  }

  const ctx = {
    connection: {
      fetch: {
        register(options) {
          routes.push(options)
        },
      },
    },
    logger: {
      warn(message) {
        warnings.push(String(message))
      },
      info() {},
    },
    on(name, listener) {
      if (name === 'session/event') listeners.push(listener)
    },
    get(name) {
      if (name === 'pluginManager') return manager
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      return undefined
    },
  }

  const route = (method) => routes.find((item) => item.path === `/api/dsh-plugin-foundry/${method}`)

  async function rpc(method, payload = null, rpcId = 'test') {
    const target = route(method)
    if (!target) throw new Error(`missing route ${method}; have ${routes.map((item) => item.path).join(', ')}`)
    const response = await target.fetch(new Request(`http://localhost${target.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: `dsh-plugin-foundry/${method}`,
        payload,
      }),
    }))
    const body = await response.json()
    return body.result
  }

  async function emit(sessionId, event) {
    const session = sessionOf(sessionId)
    const full = { seq: (session.events.at(-1)?.seq || 0) + 1, time: Date.now(), ...event }
    for (const listener of listeners) listener(session, full)
    await new Promise((resolve) => setImmediate(resolve))
    return full
  }

  function messagesOf(sessionId) {
    return sessionOf(sessionId).events
      .filter((event) => event.type === 'developer/message')
      .map((event) => event.data.message.content.map((block) => block.text || '').join(''))
  }

  async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`)
  }

  return {
    ctx,
    routes,
    sessions,
    sessionOf,
    manager,
    installs,
    bundles,
    warnings,
    rpc,
    emit,
    messagesOf,
    waitFor,
    route,
  }
}

export const userMessage = (text) => ({
  type: 'user/message',
  data: {
    id: `m_${Math.random().toString(36).slice(2)}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  },
})
