#!/usr/bin/env node
/**
 * Map one tool name to the plugin that provides it, for token attribution.
 * Usage: npm run map-tool -- excel_create_chart dsh-excel-chat
 *        npm run map-tool -- --list
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.DSH_PLUGIN_FOUNDRY_HOME || path.join(os.homedir(), '.dsh', 'plugin-foundry')
const file = path.join(home, 'tool-owners.json')
const args = process.argv.slice(2)

function load() {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

if (args.includes('--list') || args.length === 0) {
  const map = load()
  const rows = Object.entries(map)
  if (rows.length === 0) console.log('还没有映射。用法: npm run map-tool -- <tool> <package>')
  for (const [tool, owner] of rows) console.log(`${tool} -> ${owner}`)
  process.exit(0)
}

const [tool, owner] = args
if (!tool || !owner) {
  console.error('用法: npm run map-tool -- <tool> <package>')
  process.exit(1)
}
const map = load()
map[tool] = owner
mkdirSync(path.dirname(file), { recursive: true })
const temp = `${file}.tmp`
writeFileSync(temp, JSON.stringify(map, null, 2))
renameSync(temp, file)
console.log(`${tool} -> ${owner}`)
console.log('下一次 assistant/message 的 usage 会按这个映射归因。')
