import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskTracker, keywordsOf, taskTypesOf, RECIPES } from '../src/radar/task.js'

const user = (text) => ({
  type: 'user/message',
  data: { id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

test('task tracker builds a spreadsheet profile with file types', () => {
  const tracker = createTaskTracker()
  const session = { id: 's1' }
  tracker.observe(session, { type: 'turn/start', data: { turn: 1 }, time: 1 })
  tracker.observe(session, user('帮我把 /tmp/demo-sales.xlsx 做可视化，按月份画折线图'))
  const profile = tracker.profileOf('s1')
  assert.ok(profile.taskTypes.some((type) => type.id === 'spreadsheet'))
  assert.deepEqual(profile.fileTypes, ['.xlsx'])
  assert.ok(profile.keywords.includes('xlsx'))
  assert.equal(profile.stage, 'planning')
  assert.equal(profile.opportunity.type, 'recipe')
  assert.equal(profile.recipe.id, 'monthly-report')
  assert.equal(profile.turn, 1)
})

test('tool failures become a gap opportunity', () => {
  const tracker = createTaskTracker()
  const session = { id: 's2' }
  tracker.observe(session, user('跑一下 pytest 看看'))
  tracker.observe(session, {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }],
      },
    },
  })
  tracker.observe(session, {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      error: { name: 'CommandError', code: 'not-found', reason: 'command not found: pytest' },
      message: {
        role: 'tool',
        toolCallId: 'c1',
        isError: true,
        content: [{ type: 'text', text: 'command not found: pytest' }],
      },
    },
  })
  const profile = tracker.profileOf('s2')
  assert.equal(profile.stage, 'debug')
  assert.equal(profile.intent.dependencyError, true)
  assert.equal(profile.opportunity.type, 'gap')
  assert.ok(profile.errors.some((error) => error.includes('command not found')))
})

test('capability questions trigger a gap and turn end sets wrapup', () => {
  const tracker = createTaskTracker()
  const session = { id: 's3' }
  tracker.observe(session, user('有没有能把 PDF 转成表格的工具？'))
  let profile = tracker.profileOf('s3')
  assert.equal(profile.intent.capabilityQuestion, true)
  assert.equal(profile.opportunity.type, 'gap')
  tracker.observe(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  profile = tracker.profileOf('s3')
  assert.equal(profile.stage, 'wrapup')
})

test('capability notices are pending once and then metered', () => {
  const tracker = createTaskTracker()
  const session = { id: 's4' }
  tracker.observe(session, user('做个报表'))
  const notice = tracker.noteCapability('s4', { text: '推荐一个插件', pluginId: 'pkg:npm/x@1' })
  assert.ok(notice.tokens > 0)
  assert.equal(tracker.pendingNotices('s4').length, 1)
  tracker.markNoticesMetered('s4', [notice.id])
  assert.equal(tracker.pendingNotices('s4').length, 0)
})

test('runtime context and skill catalog are not treated as task text', () => {
  const tracker = createTaskTracker()
  const session = { id: 's5' }
  tracker.observe(session, {
    type: 'user/message',
    data: {
      source: { kind: 'runtime-context', form: 'snapshot' },
      content: [{ type: 'text', text: 'Current DSH checkout: /Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/' }],
    },
  })
  tracker.observe(session, {
    type: 'user/message',
    data: {
      source: { kind: 'skill-catalog', form: 'catalog' },
      content: [{ type: 'text', text: 'dsh by in plugin tool web search office' }],
    },
  })
  tracker.observe(session, user('帮我修一个 dsh 插件的加载问题'))
  const profile = tracker.profileOf('s5')
  assert.deepEqual(profile.fileTypes, [])
  assert.ok(!profile.keywords.includes('by'))
  assert.ok(!profile.keywords.includes('in'))
  assert.ok(!profile.fileTypes.includes('.app'))
})

test('meta discussion about the sidecar does not produce a recommendation opportunity', () => {
  const tracker = createTaskTracker()
  const session = { id: 's6' }
  tracker.observe(session, user('我们的覆盖也需要是全网，插件工坊怎么触发？为什么测试失败了？'))
  const profile = tracker.profileOf('s6')
  assert.equal(profile.meta, true)
  assert.equal(profile.opportunity, null)
})

test('intent detection and keyword extraction', () => {
  const keywords = keywordsOf('把 xlsx 表格按月份画折线图')
  assert.ok(keywords.includes('xlsx'))
  assert.ok(taskTypesOf('用生图工具生成一张电影感插画').some((type) => type.id === 'image'))
  assert.ok(keywords.some((word) => word.includes('月份')))
  assert.ok(RECIPES.some((recipe) => recipe.id === 'monthly-report'))
})
