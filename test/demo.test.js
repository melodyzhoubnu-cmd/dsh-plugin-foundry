import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the end-to-end demo covers distribution, metering and settlement', () => {
  const run = spawnSync(process.execPath, ['src/demo/run.js'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(run.status, 0, `demo failed:\n${run.stdout}\n${run.stderr}`)
  assert.match(run.stdout, /Demo: PASS/)

  const summary = JSON.parse(readFileSync(path.join(root, 'demo/out/summary.json'), 'utf8'))
  assert.equal(summary.consent.policy, 'all')
  assert.ok(summary.task.taskTypes.some((type) => type.id === 'spreadsheet'))
  assert.ok(summary.installs.includes('dsh-excel-chat'))
  assert.ok(summary.report.ledger.ok)
  assert.ok(summary.report.tokens.byPlugin.some((row) => row.plugin_id.includes('dsh-excel-chat')))
  assert.ok(summary.report.batches.length >= 1)
  assert.equal(summary.settlement.lines.length >= 1, true)
  assert.ok(summary.portal.by_plugin.length >= 1)

  const portal = readFileSync(path.join(root, 'demo/out/portal.html'), 'utf8')
  assert.match(portal, /开发者门户/)
  assert.match(portal, /Excel 对话助手/)
})
