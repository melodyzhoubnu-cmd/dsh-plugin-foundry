import test from 'node:test'
import assert from 'node:assert/strict'

function createReactStub() {
  const hook = { values: [], cursor: 0, effects: [] }
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() }
    },
    useState(initial) {
      const index = hook.cursor++
      if (!(index in hook.values)) hook.values[index] = typeof initial === 'function' ? initial() : initial
      return [hook.values[index], (value) => { hook.values[index] = value }]
    },
    useEffect(fn) {
      hook.effects.push(fn)
    },
    __reset() {
      hook.cursor = 0
      hook.effects = []
    },
    __render(component) {
      react.__reset()
      return component()
    },
    __effects() {
      const list = hook.effects
      hook.effects = []
      return list
    },
  }
  return react
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return find(node.children, predicate)
}

test('client bundle registers the cold-start overlay and saves consent', async () => {
  let definition = null
  const rpcCalls = []
  globalThis.window = {
    __ModuleLoader__: { load(value) { definition = value } },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  }
  globalThis.document = {
    createElement: () => ({ textContent: '', id: '' }),
    head: { appendChild: () => {} },
    getElementById: () => null,
  }
  await import('../src/radar/client.js')
  assert.ok(definition)
  assert.equal(definition.id, 'dsh-plugin-foundry')

  const react = createReactStub()
  const exports = definition.factory((id) => {
    if (id === 'react') return react
    throw new Error('unexpected require: ' + id)
  })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'connection'])

  const registered = new Map()
  const injected = []
  const context = {
    connection: {
      rpc: {
        call(channel, method, payload) {
          rpcCalls.push({ channel, method, payload })
          if (method.endsWith('/consent') && (!payload || !payload.policy)) {
            return Promise.resolve({ needsConsent: true, policy: 'never', reporting: 'local' })
          }
          return Promise.resolve({ policy: payload && payload.policy, reporting: payload && payload.reporting })
        },
      },
    },
    slots: {
      inject(name, fn) {
        injected.push(name)
        fn()
      },
      register(options, component) {
        registered.set(options.id, { options, component })
      },
    },
  }
  exports.apply(context)
  assert.deepEqual(injected, ['shell.overlay', 'conversation.chat.turnTail'])
  const consent = registered.get('dsh-plugin-foundry-consent')
  const turnTail = registered.get('plugin-foundry-turn-tail')
  assert.ok(consent)
  assert.ok(turnTail)
  assert.equal(turnTail.options.name, 'conversation.chat.turnTail')
  assert.equal(turnTail.options.order, 10)

  // First render returns null (not checked yet); run the consent RPC effect.
  let tree = react.__render(consent.component)
  assert.equal(tree, null)
  for (const effect of react.__effects()) await effect()
  await new Promise((resolve) => setTimeout(resolve, 0))

  tree = react.__render(consent.component)
  const allText = textOf(tree)
  assert.match(allText, /插件推荐、安装与用量/)
  assert.match(allText, /全部自动安装/)
  assert.match(allText, /仅官方精选自动安装/)
  assert.match(allText, /始终不自动安装/)
  assert.match(allText, /关闭推荐功能/)
  assert.match(allText, /纯本地/)
  assert.match(allText, /上报用量/)

  const allOption = find(tree, (node) => node.props && typeof node.props.onClick === 'function' && textOf(node).includes('全部自动安装'))
  assert.ok(allOption)
  allOption.props.onClick()
  const contribute = find(tree, (node) => node.props && typeof node.props.onClick === 'function' && textOf(node).includes('上报用量'))
  assert.ok(contribute)
  contribute.props.onClick()

  tree = react.__render(consent.component)
  const button = find(tree, (node) => node.type === 'button' && textOf(node).includes('开始使用'))
  assert.ok(button)
  await button.props.onClick()
  const saved = rpcCalls.find((call) => call.method === 'dsh-plugin-foundry/consent' && call.payload && call.payload.policy)
  assert.ok(saved)
  assert.equal(saved.channel, '/api')
  assert.equal(saved.payload.policy, 'all')
  assert.equal(saved.payload.reporting, 'contribute')
})


test('the turn-tail card repeats a foundry notice visibly', () => {
  const react = createReactStub()
  let definition = null
  globalThis.window = {
    __ModuleLoader__: { load(value) { definition = value } },
    localStorage: { getItem: () => null, setItem: () => {} },
  }
  globalThis.document = {
    createElement: () => ({ textContent: '', id: '' }),
    head: { appendChild: () => {} },
    getElementById: () => null,
  }
  return import('../src/radar/client.js?turn-tail').then((module) => {
    // The module instance above is cached; use the definition already loaded by
    // the previous test instead of a second query-string import.
    void module
    void definition
    const exports = definition.factory((id) => {
      if (id === 'react') return react
      throw new Error('unexpected require: ' + id)
    })
    const registered = new Map()
    exports.apply({
      connection: { rpc: { call: () => Promise.resolve({}) } },
      slots: {
        inject(name, fn) { fn() },
        register(options, component) { registered.set(options.id, { options, component }) },
      },
    })
    const card = registered.get('plugin-foundry-turn-tail')
    assert.ok(card)

    const notice = '[插件工坊] 当前任务可能用到「X」(x)，但未自动安装。\n理由：测试。'
    const snapshot = {
      locations: { getTurn: (turn) => (turn === 1 ? ['k1', 'k2'] : []) },
      nodes: {
        get: (key) => key === 'k1'
          ? { kind: 'context', data: { source: { kind: 'capability', form: 'notice', summary: 'plugin-foundry' }, content: [{ type: 'text', text: notice }] } }
          : { kind: 'context', data: { source: { kind: 'skill-invocation' }, content: [{ type: 'text', text: 'other' }] } },
      },
    }
    const useChat = (selector) => selector(snapshot)
    const tree = card.component({ turn: { turn: 1 }, useChat })
    const text = textOf(tree)
    assert.match(text, /插件工坊/)
    assert.match(text, /旁路推荐/)
    assert.match(text, /当前任务可能用到「X」/)
    assert.ok(!text.includes('[插件工坊]'), 'the badge replaces the raw prefix')

    const empty = card.component({
      turn: { turn: 2 },
      useChat: (selector) => selector(snapshot),
    })
    assert.equal(empty, null)
    assert.equal(card.component({ turn: { turn: 1 }, useChat: (selector) => selector({ locations: { getTurn: () => [] }, nodes: { get: () => undefined } }) }), null)
  })
})

test('an install receipt is shown prominently with an undo action', async () => {
  let definition = null
  const rpcCalls = []
  globalThis.window = {
    __ModuleLoader__: { load(value) { definition = value } },
    localStorage: { getItem: () => null, setItem: () => {} },
  }
  globalThis.document = {
    createElement: () => ({ textContent: '', id: '' }),
    head: { appendChild: () => {} },
    getElementById: () => null,
  }
  await import('../src/radar/client.js?receipt')
  const react = createReactStub()
  const exports = definition.factory((id) => {
    if (id === 'react') return react
    throw new Error('unexpected require: ' + id)
  })
  const registered = new Map()
  exports.apply({
    connection: {
      rpc: {
        call(channel, method, payload) {
          rpcCalls.push({ channel, method, payload })
          return Promise.resolve({ ok: true })
        },
      },
    },
    slots: {
      inject(_name, fn) { fn() },
      register(options, component) { registered.set(options.id, { options, component }) },
    },
  })
  const card = registered.get('plugin-foundry-turn-tail')
  const notice = '[插件工坊] 本次任务推荐「glTF 导出器」(dsh-gltf-exporter)，正在自动安装。\n本次任务安装了「glTF 导出器」(dsh-gltf-exporter)。已装好，下一步可以直接使用。\n它能帮到：把 three.js 场景导出为 glTF，自动校验材质和动画轨道。\n请在最终回复末尾用一句话列出本次安装的插件。'
  const snapshot = {
    locations: { getTurn: () => ['k1'] },
    nodes: {
      get: () => ({
        kind: 'context',
        data: {
          source: { kind: 'capability', form: 'notice', summary: 'plugin-foundry' },
          content: [{ type: 'text', text: notice }],
        },
      }),
    },
  }
  const tree = card.component({ turn: { turn: 1 }, useChat: (selector) => selector(snapshot) })
  const text = textOf(tree)
  assert.match(text, /已自动安装/)
  assert.match(text, /已安装「glTF 导出器」/)
  assert.match(text, /它能让这一步变得更好：把 three.js/)
  const undo = find(tree, (node) => node.type === 'button' && textOf(node).includes('撤销安装'))
  assert.ok(undo)
  await undo.props.onClick()
  const call = rpcCalls.find((row) => row.method === 'dsh-plugin-foundry/uninstall')
  assert.ok(call)
  assert.deepEqual(call.payload, { package: 'dsh-gltf-exporter' })
})
