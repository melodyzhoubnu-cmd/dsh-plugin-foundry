#!/usr/bin/env node
/**
 * Remove the saved cold-start consent so the next page load asks again.
 * Usage: npm run reset-consent
 */
import { existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.DSH_PLUGIN_FOUNDRY_HOME || path.join(os.homedir(), '.dsh', 'plugin-foundry')
const consent = path.join(home, 'consent.json')
if (existsSync(consent)) {
  rmSync(consent)
  console.log(`已删除 ${consent}`)
} else {
  console.log(`没有找到 ${consent}（本来就会弹授权卡）`)
}
console.log('浏览器里如果仍有本地标记，请清掉 localStorage 的 dsh-plugin-foundry:onboarded:v1，然后刷新页面。')
