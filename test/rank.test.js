import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFormat1 } from '../src/protocol/catalog.js'
import { buildDemoSeed } from '../src/demo/seed.js'
import { buildIndex, rankEntries, tokenize } from '../src/radar/rank.js'

const entries = parseFormat1(buildDemoSeed().catalog).entries

function profile(overrides = {}) {
  return {
    sessionId: 's1',
    turn: 1,
    step: 0,
    taskTypes: [{ id: 'spreadsheet', label: '表格 / 报表' }],
    keywords: ['xlsx', 'excel', '表格', '折线图', '报表'],
    fileTypes: ['.xlsx'],
    tools: [],
    errors: [],
    recipe: { id: 'monthly-report', label: '月度报表', capabilities: ['spreadsheet.read', 'chart.create', 'doc.write'] },
    stage: 'planning',
    signals: 3,
    intent: { capabilityQuestion: false, dependencyError: false },
    opportunity: { type: 'recipe', confidence: 0.68, reason: '任务像月度报表' },
    ...overrides,
  }
}

test('BM25 index and tokenizer handle bilingual text', () => {
  const index = buildIndex(entries)
  assert.ok(index.size > 10)
  assert.ok(tokenize('xlsx 表格').includes('xlsx'))
  assert.ok(tokenize('表格').length >= 1)
})

test('the monthly xlsx task ranks dsh-excel-chat first', () => {
  const ranked = rankEntries(entries, profile(), {
    installed: new Set(['dsh-already-installed']),
    maxCards: 3,
    currentDsh: '0.2.1-rc.5',
  })
  assert.ok(ranked.length > 0)
  assert.equal(ranked[0].package, 'dsh-excel-chat', ranked.map((row) => `${row.package}:${row.score}`).join(' '))
  assert.ok(ranked[0].score > 0.5)
  assert.ok(ranked[0].why.length > 20)
  assert.ok(ranked[0].why.includes('不用它'))
  assert.ok(!ranked.some((row) => row.package === 'dsh-already-installed'))
  assert.ok(!ranked.some((row) => row.package === 'dsh-theme-pack'))
})

test('incompatible, ignored and revoked plugins are filtered', () => {
  const ignored = rankEntries(entries, profile(), {
    installed: new Set(['dsh-already-installed']),
    feedback: { ignored: { 'dsh-excel-chat': Date.now() }, categoryAffinity: {} },
    currentDsh: '0.2.1-rc.5',
  })
  assert.ok(!ignored.some((row) => row.package === 'dsh-excel-chat'))
  assert.ok(!ignored.some((row) => row.package === 'dsh-future-plugin'))

  const revoked = rankEntries(entries, profile(), {
    installed: new Set(['dsh-already-installed']),
    feedback: { revoked: { 'dsh-excel-chat': Date.now() }, ignored: {}, categoryAffinity: {} },
    currentDsh: '0.2.1-rc.5',
  })
  assert.ok(!revoked.some((row) => row.package === 'dsh-excel-chat'))
})

test('net value gate can suppress low-quality suggestions', () => {
  const strict = rankEntries(entries, profile(), {
    maxCards: 3,
    currentDsh: '0.2.1-rc.5',
    minNet: 0.99,
  })
  assert.equal(strict.length, 0)
})
