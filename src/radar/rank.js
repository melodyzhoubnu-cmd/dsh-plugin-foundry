/**
 * Ranking: catalog entries + task profile -> a small, explainable shortlist.
 *
 * L1 recall is BM25 over curated metadata (title, description, keywords,
 * capabilities), not README embeddings. L2 is the weighted score documented in
 * ARCHITECTURE.md, followed by a net-value gate:
 *
 *   score = 0.35 text + 0.20 task tags + 0.10 stage
 *         + 0.15 quality + 0.05 freshness + 0.10 feedback + 0.05 diversity
 *   net   = benefit * confidence - interruption - install - risk
 *
 * The functions are pure; feedback and install state arrive as options.
 */
import { categoryLabel } from './task.js'
import { compatibleWith } from '../protocol/catalog.js'

export const WEIGHTS = Object.freeze({
  text: 0.35,
  tags: 0.2,
  stage: 0.1,
  quality: 0.15,
  freshness: 0.05,
  feedback: 0.1,
  diversity: 0.05,
})

const META_CATEGORIES = new Set(['market', 'theme', 'fun'])

const TASK_TAGS = {
  spreadsheet: {
    categories: ['docs', 'tools'],
    capabilities: ['spreadsheet.read', 'spreadsheet.write', 'chart.create', 'table.transform'],
  },
  docs: {
    categories: ['docs', 'tools'],
    capabilities: ['doc.write', 'doc.read', 'pdf.extract', 'doc.format'],
  },
  slides: {
    categories: ['docs'],
    capabilities: ['slide.create', 'chart.create', 'doc.write'],
  },
  debug: {
    categories: ['dev', 'tools'],
    capabilities: ['test.run', 'log.inspect', 'error.explain', 'code.review'],
  },
  coding: {
    categories: ['dev', 'tools', 'git'],
    capabilities: ['code.edit', 'code.review', 'git.diff', 'test.run'],
  },
  research: {
    categories: ['tools', 'browser'],
    capabilities: ['web.search', 'web.fetch', 'doc.write'],
  },
  data: {
    categories: ['tools', 'dev'],
    capabilities: ['data.query', 'chart.create', 'dataframe.run', 'table.transform'],
  },
  git: {
    categories: ['git', 'dev'],
    capabilities: ['git.diff', 'code.review'],
  },
  image: {
    categories: ['vision', 'tools'],
    capabilities: ['image.ocr', 'image.generate'],
  },
  browser: {
    categories: ['browser', 'tools'],
    capabilities: ['web.fetch', 'browser.control'],
  },
  memory: {
    categories: ['memory', 'session'],
    capabilities: ['memory.store', 'session.archive'],
  },
  notify: {
    categories: ['notify', 'tools'],
    capabilities: ['notify.send', 'webhook.trigger'],
  },
}

const STAGE_TAGS = {
  planning: { categories: ['tools', 'skill', 'research'] },
  execution: { categories: ['docs', 'tools', 'dev'] },
  debug: { categories: ['dev', 'tools'] },
  wrapup: { categories: ['docs', 'notify', 'memory'] },
  idle: { categories: [] },
}

const TASK_KEYWORDS = {
  spreadsheet: ['excel', 'xlsx', 'csv', '表格', '图表', '公式', '报表', '折线图'],
  docs: ['docx', 'word', 'pdf', '文档', '报告', '排版'],
  slides: ['pptx', 'ppt', '幻灯片', '演示', '路演'],
  debug: ['pytest', 'test', '测试', '报错', '错误', '日志', 'traceback'],
  coding: ['code', '代码', '重构', 'typescript', 'python'],
  research: ['search', '搜索', '调研', '论文', '资料', '竞品'],
  data: ['sql', 'pandas', 'dataframe', '数据', '分析', '趋势'],
  git: ['git', 'commit', 'diff', 'review', '合并'],
  image: ['ocr', '图片', '截图', '视觉', '生图', '插画', '文生图', '绘图', 'illustration'],
  browser: ['browser', '网页', '抓取', '浏览器'],
  memory: ['memory', '记忆', '归档'],
  notify: ['通知', '提醒', 'webhook', '邮件'],
}

const COST_OF_NOT_USING = {
  spreadsheet: '不用它的话，得先把表格导成 CSV，再自己拼图表和结论。',
  docs: '不用它的话，排版、目录和交叉引用都得手工处理。',
  slides: '不用它的话，得先做图再逐页粘贴，版式很难统一。',
  debug: '不用它的话，只能逐个读日志、手动复现失败用例。',
  coding: '不用它的话，改动和回归检查都要手工完成。',
  research: '不用它的话，得自己开网页、摘录、再整理出处。',
  data: '不用它的话，查询和清洗要写一遍临时脚本。',
  git: '不用它的话，只能手动翻 diff 和提交记录。',
  image: '不用它的话，图片里的信息要人工读一遍。',
  browser: '不用它的话，只能手动开页面、复制粘贴。',
  memory: '不用它的话，这些上下文下次还得再说一遍。',
  notify: '不用它的话，通知和集成要自己接一遍。',
}

const K1 = 1.2
const B = 0.75
const FIELD_WEIGHTS = { name: 2, title: 3, description: 1, keywords: 2, capabilities: 2, category: 1 }

const STRONG_KEYWORD = /^(xlsx|excel|csv|docx|pdf|pptx|pytest|sql|pandas|ocr|git|commit|webhook|python|typescript|公式|幻灯片|论文|日志|报错|折线图|生图|插画|文生图)$/i

const QUERY_STOPWORDS = new Set([
  'by', 'in', 'to', 'of', 'on', 'at', 'as', 'is', 'are', 'be', 'it', 'or', 'an', 'we', 'our', 'not', 'but',
  'if', 'then', 'so', 'do', 'does', 'was', 'were', 'been', 'being', 'its', 'their', 'they', 'them', 'he', 'she',
  'his', 'her', 'us', 'me', 'my', 'no', 'yes', 'up', 'out', 'all', 'any', 'why', 'how', 'what', 'when', 'where',
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your', 'you', 'can', 'will', 'has', 'have',
  'dsh', 'plugin', 'plugins',
])

export function tokenize(text) {
  const value = String(text || '').toLowerCase()
  const ascii = value.match(/[a-z0-9][a-z0-9_.+-]{1,}/g) || []
  const cjkRuns = value.match(/[\u4e00-\u9fff]{2,}/g) || []
  const grams = []
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2))
  }
  return [...ascii, ...grams].filter((token) => token.length >= 2)
}

export function buildIndex(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && entry.name)
  const postings = new Map()
  const docs = []
  let totalLength = 0
  list.forEach((entry, docId) => {
    const tf = new Map()
    const add = (text, weight) => {
      for (const token of tokenize(text)) {
        tf.set(token, (tf.get(token) || 0) + weight)
      }
    }
    add(entry.name, FIELD_WEIGHTS.name)
    add(entry.title, FIELD_WEIGHTS.title)
    add(entry.description, FIELD_WEIGHTS.description)
    add((entry.keywords || []).join(' '), FIELD_WEIGHTS.keywords)
    add((entry.capabilityIds || []).join(' '), FIELD_WEIGHTS.capabilities)
    add(entry.category || '', FIELD_WEIGHTS.category)
    let length = 0
    for (const weight of tf.values()) length += weight
    totalLength += length
    docs.push({ entry, length })
    for (const [token, weight] of tf) {
      if (!postings.has(token)) postings.set(token, [])
      postings.get(token).push({ docId, weight })
    }
  })
  for (const [token, list2] of postings) {
    postings.set(token, { df: list2.length, rows: list2 })
  }
  return {
    entries: list,
    docs,
    postings,
    averageLength: docs.length ? totalLength / docs.length : 0,
    size: docs.length,
  }
}

function bm25(index, queryTokens) {
  const raw = new Array(index.size).fill(0)
  const unique = [...new Set(queryTokens)]
  for (const token of unique) {
    const posting = index.postings.get(token)
    if (!posting) continue
    const idf = Math.log(1 + (index.size - posting.df + 0.5) / (posting.df + 0.5))
    for (const row of posting.rows) {
      const doc = index.docs[row.docId]
      const denominator = row.weight + K1 * (1 - B + (B * doc.length) / (index.averageLength || 1))
      raw[row.docId] += idf * ((row.weight * (K1 + 1)) / (denominator || 1))
    }
  }
  return raw
}

function queryOf(profile) {
  const tokens = []
  for (const keyword of profile.keywords || []) {
    if (typeof keyword === 'string' && keyword.length >= 2) tokens.push(...tokenize(keyword))
  }
  for (const ext of profile.fileTypes || []) tokens.push(...tokenize(String(ext).replace(/^\./, '')))
  for (const type of profile.taskTypes || []) {
    for (const keyword of TASK_KEYWORDS[type.id] || []) tokens.push(...tokenize(keyword))
  }
  for (const capability of (profile.recipe && profile.recipe.capabilities) || []) tokens.push(...tokenize(capability))
  return tokens
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0))
}

function tagScore(entry, profile) {
  const capabilities = new Set(entry.capabilityIds || [])
  let capabilityHits = 0
  let wanted = 0
  let categoryHit = false
  for (const type of profile.taskTypes || []) {
    const tags = TASK_TAGS[type.id]
    if (!tags) continue
    for (const category of tags.categories) {
      wanted += 1
      if (entry.category === category) categoryHit = true
    }
    for (const capability of tags.capabilities) {
      wanted += 1
      if (capabilities.has(capability)) capabilityHits += 1
    }
  }
  for (const capability of (profile.recipe && profile.recipe.capabilities) || []) {
    wanted += 1
    if (capabilities.has(capability)) capabilityHits += 1
  }
  const capabilityPart = wanted > 0 ? Math.min(1, capabilityHits / Math.max(2, wanted * 0.5)) : 0
  return clamp01(capabilityPart * 0.7 + (categoryHit ? 0.3 : 0))
}

function stageScore(entry, profile) {
  const tags = STAGE_TAGS[profile.stage]
  if (!tags || tags.categories.length === 0) return 0
  if (tags.categories.includes(entry.category)) return 1
  return 0
}

function freshnessScore(publishedAt) {
  if (!publishedAt) return 0
  const days = Math.max(0, (Date.now() - publishedAt) / 86400000)
  return 1 / (1 + days / 120)
}

function feedbackScore(entry, feedback) {
  const affinity = feedback && feedback.categoryAffinity ? Number(feedback.categoryAffinity[entry.category]) || 0 : 0
  return clamp01(0.5 + affinity / 6)
}

function isIgnored(entry, feedback, now) {
  if (!feedback) return false
  const ignoredAt = feedback.ignored && feedback.ignored[entry.name]
  if (ignoredAt && now - Number(ignoredAt) < 7 * 86400000) return true
  if (feedback.revoked && feedback.revoked[entry.name]) return true
  return false
}

function confidenceOf(entry, profile) {
  const opportunity = profile.opportunity || {}
  return clamp01(
    0.45 +
    0.35 * (Number(opportunity.confidence) || 0.2) +
    0.2 * (entry.quality ? entry.quality.score : 0),
  )
}

function installCostOf(entry) {
  let cost = 0.05
  if (entry.risk && entry.risk.postinstall) cost += 0.1
  if (entry.risk && entry.risk.restartRequired) cost += 0.05
  return cost
}

function riskOf(entry) {
  const risk = entry.risk || {}
  return (risk.postinstall ? 0.15 : 0) + (risk.restartRequired ? 0.08 : 0) + (risk.dataEgress ? 0.15 : 0)
}

export function scoreEntry(entry, profile, options = {}) {
  const rawText = options.textScore ?? 0
  const text = clamp01(rawText)
  const tags = tagScore(entry, profile)
  const stage = stageScore(entry, profile)
  const quality = clamp01(entry.quality ? entry.quality.score : 0)
  const freshness = freshnessScore(entry.publishedAt)
  const feedback = feedbackScore(entry, options.feedback)
  const score = WEIGHTS.text * text +
    WEIGHTS.tags * tags +
    WEIGHTS.stage * stage +
    WEIGHTS.quality * quality +
    WEIGHTS.freshness * freshness +
    WEIGHTS.feedback * feedback
  const confidence = confidenceOf(entry, profile)
  const interruption = Number.isFinite(options.interruptionCost) ? options.interruptionCost : 0.08
  const net = score * confidence - interruption - installCostOf(entry) - riskOf(entry)
  return {
    score: round(score),
    text: round(text),
    tags: round(tags),
    stage: round(stage),
    quality: round(quality),
    freshness: round(freshness),
    feedback: round(feedback),
    confidence: round(confidence),
    net: round(net),
  }
}

function round(value) {
  return Math.round((Number(value) || 0) * 1e4) / 1e4
}

function similarity(a, b) {
  if (a.category && a.category === b.category) return 1
  const left = new Set(a.capabilityIds || [])
  const right = new Set(b.capabilityIds || [])
  if (left.size === 0 || right.size === 0) return 0
  let overlap = 0
  for (const capability of left) if (right.has(capability)) overlap += 1
  return overlap / Math.min(left.size, right.size)
}

export function createRanker(entries) {
  const index = buildIndex(entries)
  return {
    index,
    rank(profile, options = {}) {
      return rankWithIndex(index, profile, options)
    },
  }
}

export function rankEntries(entries, profile, options = {}) {
  return createRanker(entries).rank(profile, options)
}

function rankWithIndex(index, profile, options) {
  if (!profile) return []
  if (!profile.taskTypes || profile.taskTypes.length === 0) {
    if (!options.allowKeywordsOnly) return []
  }
  if (!profile.signals) return []
  const installed = options.installed instanceof Set ? options.installed : new Set()
  const exclude = options.exclude instanceof Set ? options.exclude : new Set()
  const feedback = options.feedback || {}
  const currentDsh = options.currentDsh || '0.2.1'
  const maxCards = Number.isFinite(options.maxCards) ? options.maxCards : 1
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0.38
  const minNet = Number.isFinite(options.minNet) ? options.minNet : 0.12
  const now = options.now || Date.now()
  const queryTokens = queryOf(profile).filter((token) => !QUERY_STOPWORDS.has(token))
  if (queryTokens.length === 0) return []
  const raw = bm25(index, queryTokens)
  const maxRaw = Math.max(0, ...raw)

  const candidates = []
  for (let docId = 0; docId < index.docs.length; docId++) {
    const entry = index.docs[docId].entry
    if (installed.has(entry.name)) continue
    if (exclude.has(entry.name)) continue
    if (META_CATEGORIES.has(entry.category)) continue
    if (String(entry.description || '').trim().length < 10) continue
    if (!compatibleWith(entry.engines, currentDsh)) continue
    if (isIgnored(entry, feedback, now)) continue
    const normalizedText = maxRaw > 0 ? raw[docId] / maxRaw : 0
    const scored = scoreEntry(entry, profile, { feedback, textScore: normalizedText, interruptionCost: options.interruptionCost })
    if (scored.score < minScore) continue
    if (scored.net < minNet) continue
    candidates.push({ entry, ...scored, matched: matchedTokens(entry, queryTokens) })
  }

  candidates.sort((a, b) => b.score - a.score || b.entry.quality.score - a.entry.quality.score || a.entry.name.localeCompare(b.entry.name))

  const picked = []
  const pool = [...candidates]
  while (picked.length < maxCards && pool.length > 0) {
    let bestIndex = 0
    let bestAdjusted = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i]
      const penalty = picked.length > 0 ? WEIGHTS.diversity * similarity(candidate.entry, picked[picked.length - 1].entry) : 0
      const adjusted = candidate.score - penalty
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted
        bestIndex = i
      }
    }
    const [chosen] = pool.splice(bestIndex, 1)
    picked.push(chosen)
  }

  return picked.map((candidate) => suggestionOf(candidate, profile, options))
}

function matchedTokens(entry, queryTokens) {
  const wanted = [...new Set(queryTokens)].filter((token) => {
    if (QUERY_STOPWORDS.has(token)) return false
    if (/^[a-z0-9]+$/.test(token) && token.length < 3) return false
    return token.length >= 2
  })
  const hits = []
  for (const token of wanted) {
    if (entry.searchText.includes(token)) hits.push(token)
  }
  return [...new Set(hits)].slice(0, 6)
}

function suggestionOf(candidate, profile) {
  const entry = candidate.entry
  return {
    id: entry.name,
    name: entry.title || entry.name,
    package: entry.name,
    pluginId: entry.pluginId,
    version: entry.version,
    category: entry.category,
    categoryLabel: categoryLabel(entry.category),
    reason: shortReason(candidate, profile),
    why: explain(candidate, profile),
    detail: firstSentence(entry.description),
    score: candidate.score,
    net: candidate.net,
    confidence: candidate.confidence,
    matched: candidate.matched,
    capabilities: (entry.capabilityIds || []).slice(0, 6),
    tools: (entry.tools || []).slice(0, 8),
    quality: entry.quality,
    risk: entry.risk,
    publisher: entry.publisher,
    kind: entry.kind,
    compatible: true,
    installed: false,
    versionCount: entry.versionCount,
    publishedAt: entry.publishedAt,
    sourceType: entry.sourceType,
    installSpec: entry.installSpec || '',
    action: 'install',
  }
}

function shortReason(candidate, profile) {
  const type = profile.taskTypes && profile.taskTypes[0]
  const file = profile.fileTypes && profile.fileTypes[0]
  const parts = []
  if (type) parts.push(type.label)
  if (file) parts.push(file)
  if (candidate.matched.length) parts.push(candidate.matched.slice(0, 2).join(' / '))
  if (parts.length === 0) return `匹配度 ${candidate.score}`
  return `命中 ${parts.join(' · ')}`
}

function explain(candidate, profile) {
  const entry = candidate.entry
  const type = profile.taskTypes && profile.taskTypes[0]
  const files = profile.fileTypes || []
  const hasError = Array.isArray(profile.errors) && profile.errors.length > 0
  const context = [
    type ? `当前任务偏「${type.label}」` : '',
    files.length ? `手上有 ${files.slice(0, 2).join(' / ')}` : '',
    hasError ? '而且刚遇到报错' : '',
  ].filter(Boolean).join('，')
  const capability = firstSentence(entry.description).replace(/[。.!！?？]$/, '')
  const subject = /^(DSH|一个|一款|为|面向|基于)/i.test(capability) ? `它的定位是「${capability}」` : `它${capability}`
  const evidence = candidate.matched.length
    ? `目录里它在「${candidate.matched.slice(0, 3).join('、')}」上的匹配度最高`
    : '目录里它与当前任务最匹配'
  const cost = COST_OF_NOT_USING[(type && type.id) || ''] || '不装的话，这一步要用内置方法手工完成。'
  return `${context ? context + '。' : ''}${subject}；${evidence}，且兼容当前 DSH。${cost}`
}

function firstSentence(text) {
  const value = String(text || '').trim()
  if (!value) return '适合当前任务。'
  const cut = value.split(/[。.!?！？]/)[0]
  return cut.length > 72 ? cut.slice(0, 72) + '…' : cut + '。'
}
