/**
 * Task profile: turn the session log into "what is the user doing right now".
 *
 * Pure rules, no model call, no token cost. The profile is a derived cache —
 * the session log remains the source of truth, so replaying a session yields
 * the same profile.
 */
import { estimateTokens } from '../protocol/tokens.js'
import { detectCapabilityQuestion, looksLikeDependencyError } from './intent.js'

const META_PATTERNS = [
  /插件工坊|plugin\s*foundry|旁路推荐|sidecar|插件推荐|推荐插件|插件雷达|插件生态|插件系统|工具归属|token\s*分成|自动安装/i,
]

function isHumanMessage(data) {
  const kind = data && data.source && typeof data.source.kind === 'string' ? data.source.kind : ''
  return kind === '' || kind === 'user' || kind === 'steering'
}

function isMetaDiscussion(text) {
  return META_PATTERNS.some((pattern) => pattern.test(String(text || '')))
}

function scanFilesFor(type, data) {
  if (type === 'user/message') return isHumanMessage(data)
  if (type === 'assistant/message' || type === 'tool/call' || type === 'tool/result') return true
  return false
}

function discoveryOf(calls) {
  for (let index = calls.length - 1; index >= 0; index--) {
    const call = calls[index]
    const name = String(call && call.name ? call.name : '')
    const args = String(call && call.arguments ? call.arguments : '')
    if (name === 'plugin_market') return { tool: name, query: '', callId: call.callId, at: call.at }
    if (name === 'web_search' && /插件|plugin|扩展|dsh/i.test(args)) {
      let query = ''
      try {
        const parsed = JSON.parse(args)
        query = Array.isArray(parsed.queries) ? parsed.queries.join(' ') : String(parsed.query || '')
      } catch {
        query = args.slice(0, 200)
      }
      return { tool: name, query, callId: call.callId, at: call.at }
    }
  }
  return null
}

export const TASK_RULES = [
  { id: 'spreadsheet', label: '表格 / 报表', patterns: [/xlsx|excel|csv|表格|报表|工作表|数据透视|销售表|利润/i] },
  { id: 'docs', label: '文档 / 写作', patterns: [/docx|word|文档|报告|排版|合同|纪要|写作|brief/i] },
  { id: 'slides', label: '幻灯片 / 演示', patterns: [/pptx|ppt|幻灯片|演示|路演|汇报|slide/i] },
  { id: 'debug', label: '调试 / 修错', patterns: [/报错|错误|失败|异常|崩溃|堆栈|error|traceback|pytest|test fail|failed/i] },
  { id: 'coding', label: '写代码 / 重构', patterns: [/代码|函数|重构|实现|编译|typescript|python|javascript|react|api/i] },
  { id: 'research', label: '查资料 / 调研', patterns: [/搜索|查一下|资料|调研|论文|对比|评测|竞品|web|search/i] },
  { id: 'data', label: '数据分析', patterns: [/数据|分析|统计|sql|dataframe|pandas|指标|趋势|图表/i] },
  { id: 'git', label: 'Git / 评审', patterns: [/git|commit|分支|合并|\bpr\b|pull request|review|diff/i] },
  { id: 'image', label: '图片 / 视觉', patterns: [/图片|截图|识别|ocr|视觉|海报|配图|生图|文生图|插画|绘图|画一张|绘制|image.?gen|text.?to.?image|illustration/i] },
  { id: 'browser', label: '浏览器 / 抓取', patterns: [/浏览器|网页|抓取|爬|登录|表单/i] },
  { id: 'memory', label: '记忆 / 归档', patterns: [/记住|记忆|归档|稍后|提醒我|偏好/i] },
  { id: 'notify', label: '通知 / 集成', patterns: [/通知|提醒|邮件|webhook|飞书|钉钉|telegram/i] },
]

export const RECIPES = [
  {
    id: 'monthly-report',
    label: '月度报表',
    taskTypes: ['spreadsheet', 'data'],
    capabilities: ['spreadsheet.read', 'chart.create', 'doc.write'],
    patterns: [/月度|月份|报表|趋势|折线|季度|monthly|trend/i],
  },
  {
    id: 'debug-loop',
    label: '失败复现与修复',
    taskTypes: ['debug', 'coding'],
    capabilities: ['test.run', 'log.inspect'],
    patterns: [/pytest|报错|失败|调试|堆栈|traceback|debug/i],
  },
  {
    id: 'research-brief',
    label: '调研简报',
    taskTypes: ['research'],
    capabilities: ['web.search', 'doc.write'],
    patterns: [/调研|论文|资料|竞品|综述|research|brief/i],
  },
  {
    id: 'slide-deck',
    label: '演示稿',
    taskTypes: ['slides'],
    capabilities: ['slide.create', 'chart.create'],
    patterns: [/幻灯片|演示|路演|汇报|pptx|slide/i],
  },
]

const CATEGORY_LABELS = {
  docs: '文档', tools: '工具', dev: '开发', git: 'Git', vision: '视觉',
  browser: '浏览器', memory: '记忆', notify: '通知', ui: '界面', session: '会话',
  workflow: '工作流', model: '模型', usage: '用量', security: '安全', theme: '主题',
  market: '市场', fun: '娱乐', remote: '远程', skill: '技能', identity: '身份',
  agi: 'AGI', wsl: 'WSL', voice: '语音', commerce: '交易',
}

export function categoryLabel(id) {
  return CATEGORY_LABELS[id] || id || '其他'
}

const MAX_MESSAGES = 8
const MAX_ERRORS = 8
const MAX_TOOL_CALLS = 60
const MAX_NOTICES = 50

export function createTaskTracker() {
  const sessions = new Map()

  function stateOf(sessionId) {
    let state = sessions.get(sessionId)
    if (!state) {
      state = {
        sessionId,
        messages: [],
        tools: new Map(),
        files: new Set(),
        errors: [],
        toolCalls: [],
        toolResults: new Map(),
        notices: [],
        taskTypes: [],
        keywords: [],
        recipe: null,
        stage: 'idle',
        intent: { capabilityQuestion: false, dependencyError: false },
        opportunity: null,
        lastUserAt: 0,
        lastEventAt: 0,
        lastUserText: '',
        assistantText: '',
        turn: 0,
        step: 0,
        turnEnded: false,
        noticeSeq: 0,
        meta: false,
        discovery: null,
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  function observe(_session, event) {
    if (!event || typeof event !== 'object') return
    const sessionId = _session && _session.id ? _session.id : 'unknown'
    const state = stateOf(sessionId)
    const data = event.data && typeof event.data === 'object' ? event.data : event
    const type = String(event.type || '')
    const time = Number(event.time) || Date.now()

    if (type === 'user/message') {
      if (isHumanMessage(data)) {
        const text = textOf(data)
        if (text) {
          state.messages.push({ text: text.slice(0, 2000), at: time })
          state.messages = state.messages.slice(-MAX_MESSAGES)
          state.lastUserText = text.slice(0, 2000)
          state.lastUserAt = time
          state.turnEnded = false
          state.meta = isMetaDiscussion(text)
        }
      }
    } else if (type === 'turn/start') {
      state.turn = Number(data.turn) || state.turn
      state.step = 0
      state.turnEnded = false
    } else if (type === 'step/start') {
      state.turn = Number(data.turn) || state.turn
      state.step = Number(data.step) || state.step
    } else if (type === 'assistant/message') {
      state.turn = Number(data.turn) || state.turn
      state.step = Number(data.step) || state.step
      const text = textOf(data.message || data)
      if (text) state.assistantText = text.slice(0, 500)
      for (const call of toolCallsOf(data.message || data)) pushCall(state, call, time)
      const discovery = discoveryOf(state.toolCalls)
      if (discovery) state.discovery = discovery
      else if (state.toolCalls.length > 0 && state.taskTypes.length > 0) state.discovery = null
    } else if (type === 'tool/call') {
      pushCall(state, { id: data.callId, name: data.name }, time)
    } else if (type === 'tool/result') {
      const message = data.message || {}
      const callId = String(message.toolCallId || data.callId || '')
      const name = nameOfCall(state, callId)
      const text = textOf(message) || errorTextOf(data)
      const isError = Boolean(data.error || message.isError)
      if (callId) {
        state.toolResults.set(callId, { callId, name, tokens: estimateTokens(text), isError })
        if (state.toolResults.size > MAX_TOOL_CALLS) {
          const first = state.toolResults.keys().next().value
          state.toolResults.delete(first)
        }
      }
      if (isError) {
        const messageText = errorTextOf(data) || text
        if (messageText) {
          state.errors.push({ text: messageText.slice(0, 500), at: time, tool: name })
          state.errors = state.errors.slice(-MAX_ERRORS)
        }
      }
    } else if (type === 'turn/end') {
      state.turnEnded = true
    }

    if (scanFilesFor(type, data)) {
      for (const ext of filesOf(data)) state.files.add(ext)
      if (state.files.size > 40) state.files = new Set([...state.files].slice(-40))
    }
    state.lastEventAt = time
    recompute(state)
  }

  function pushCall(state, call, time) {
    const id = String(call.id || '')
    const name = String(call.name || '')
    if (!name) return
    if (id) {
      const existing = state.toolCalls.find((item) => item.callId === id)
      if (existing) {
        if (call.arguments) existing.arguments = String(call.arguments)
        return
      }
    }
    state.toolCalls.push({ callId: id, name, at: time, arguments: String(call.arguments || '') })
    state.toolCalls = state.toolCalls.slice(-MAX_TOOL_CALLS)
    state.tools.set(name, (state.tools.get(name) || 0) + 1)
  }

  function nameOfCall(state, callId) {
    const known = state.toolCalls.find((item) => item.callId === callId)
    return known ? known.name : ''
  }

  function recompute(state) {
    const recentUser = state.messages.slice(-3).map((message) => message.text).join('\n')
    state.keywords = keywordsOf(recentUser).slice(0, 32)

    const haystack = [recentUser, state.lastUserText, state.assistantText, state.errors.map((error) => error.text).join(' ')].join('\n')
    const matched = TASK_RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(haystack)))
    state.taskTypes = matched.map((rule) => ({ id: rule.id, label: rule.label }))
    state.recipe = matchRecipe(state, haystack)
    state.intent = {
      capabilityQuestion: detectCapabilityQuestion(state.lastUserText),
      dependencyError: state.errors.some((error) => looksLikeDependencyError(error.text)),
    }

    const toolNames = [...state.tools.keys()]
    if (state.turnEnded) state.stage = 'wrapup'
    else if (state.errors.length > 0) state.stage = 'debug'
    else if (toolNames.some((name) => /^(bash|write|edit|read|multi_tool|terminal|apply_patch)$/.test(name))) state.stage = 'execution'
    else state.stage = state.messages.length > 0 ? 'planning' : 'idle'

    state.opportunity = opportunityOf(state)
  }

  function opportunityOf(state) {
    if (state.meta) return null
    const intent = state.intent
    if (intent.dependencyError) {
      const first = state.errors.find((error) => looksLikeDependencyError(error.text))
      return { type: 'gap', confidence: 0.85, reason: `工具报错：${(first && first.text) || '缺少依赖'}` }
    }
    if (intent.capabilityQuestion) {
      return { type: 'gap', confidence: 0.72, reason: '用户在问有没有能做这件事的工具' }
    }
    if (state.recipe && state.taskTypes.length > 0) {
      return { type: 'recipe', confidence: 0.68, reason: `任务像「${state.recipe.label}」` }
    }
    if (state.taskTypes.length > 0) {
      const manual = state.files.size > 0 && [...state.tools.keys()].some((name) => /^(bash|write|edit)$/.test(name))
      if (manual) {
        return {
          type: 'uplift',
          confidence: 0.62,
          reason: `你正在用 ${[...state.tools.keys()].filter((name) => /^(bash|write|edit)$/.test(name)).join(' / ')} 手工处理 ${[...state.files].slice(0, 2).join(' / ')}`,
        }
      }
      return { type: 'discovery', confidence: 0.5, reason: '任务类型匹配到目录里的能力' }
    }
    if (state.keywords.length > 0) {
      return { type: 'discovery', confidence: 0.35, reason: '出现了可匹配的能力关键词' }
    }
    return null
  }

  function noteCapability(sessionId, notice) {
    const state = stateOf(sessionId)
    const text = String(notice && notice.text ? notice.text : '')
    if (!text) return null
    state.noticeSeq += 1
    const record = {
      id: `${sessionId}:${state.noticeSeq}`,
      text,
      pluginId: notice.pluginId || '',
      turn: Number(notice.turn) || state.turn,
      step: Number(notice.step) || state.step,
      at: Date.now(),
      metered: false,
      tokens: estimateTokens(text),
    }
    state.notices.push(record)
    state.notices = state.notices.slice(-MAX_NOTICES)
    return record
  }

  function pendingNotices(sessionId) {
    const state = sessions.get(sessionId)
    if (!state) return []
    return state.notices.filter((notice) => !notice.metered)
  }

  function markNoticesMetered(sessionId, ids) {
    const state = sessions.get(sessionId)
    if (!state) return
    const wanted = new Set(ids || [])
    for (const notice of state.notices) {
      if (wanted.size === 0 || wanted.has(notice.id)) notice.metered = true
    }
  }

  function profileOf(sessionId) {
    const state = sessions.get(sessionId)
    if (!state) return emptyProfile(sessionId)
    const toolResults = [...state.toolResults.values()].slice(-20)
    return {
      sessionId: state.sessionId,
      turn: state.turn,
      step: state.step,
      taskTypes: state.taskTypes.map((type) => ({ ...type })),
      keywords: [...state.keywords],
      fileTypes: [...state.files].slice(-6),
      tools: [...state.tools.keys()].slice(-12),
      errors: state.errors.slice(-3).map((error) => error.text),
      toolCalls: state.toolCalls.slice(-20).map((call) => ({ ...call })),
      toolResults,
      meta: state.meta === true,
      discovery: state.discovery ? { ...state.discovery } : null,
      recipe: state.recipe ? { ...state.recipe } : null,
      stage: state.stage,
      intent: {
        capabilityQuestion: state.intent.capabilityQuestion,
        dependencyError: state.intent.dependencyError,
      },
      opportunity: state.opportunity ? { ...state.opportunity } : null,
      signals: state.messages.length + state.tools.size + state.errors.length,
      updatedAt: state.lastEventAt,
      lastUserAt: state.lastUserAt,
      lastUserText: state.lastUserText,
      label: labelOf(state),
    }
  }

  function latestProfile() {
    let best = null
    for (const state of sessions.values()) {
      if (!best || state.lastEventAt > best.lastEventAt) best = state
    }
    return best ? profileOf(best.sessionId) : emptyProfile(null)
  }

  return {
    observe,
    profileOf,
    latestProfile,
    noteCapability,
    pendingNotices,
    markNoticesMetered,
    sessions,
    reset(sessionId) {
      sessions.delete(sessionId)
    },
  }
}

export function matchRecipe(state, haystack) {
  const ids = new Set(state.taskTypes.map((type) => type.id))
  const text = String(haystack || '')
  for (const recipe of RECIPES) {
    const patternHit = recipe.patterns.some((pattern) => pattern.test(text))
    const typeHit = recipe.taskTypes.some((type) => ids.has(type))
    if (patternHit && typeHit) return recipe
  }
  return null
}

function emptyProfile(sessionId) {
  return {
    sessionId,
    turn: 0,
    step: 0,
    taskTypes: [],
    keywords: [],
    fileTypes: [],
    tools: [],
    errors: [],
    toolCalls: [],
    toolResults: [],
    meta: false,
    discovery: null,
    recipe: null,
    stage: 'idle',
    intent: { capabilityQuestion: false, dependencyError: false },
    opportunity: null,
    signals: 0,
    updatedAt: 0,
    lastUserAt: 0,
    lastUserText: '',
    label: '等待任务信号',
  }
}

function labelOf(state) {
  const type = state.taskTypes[0]
  const files = [...state.files].slice(0, 2)
  const parts = []
  if (type) parts.push(type.label)
  if (files.length) parts.push(files.join(' / '))
  if (state.errors.length) parts.push('有报错')
  return parts.length ? parts.join(' · ') : '等待任务信号'
}

export function textOf(data) {
  if (!data) return ''
  if (typeof data === 'string') return data.trim()
  if (typeof data.text === 'string') return data.text.trim()
  const content = data.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && (block.type === 'text' || block.type === 'reasoning' || typeof block.text === 'string'))
    .map((block) => String(block.text || ''))
    .join('\n')
    .trim()
}

export function toolCallsOf(data) {
  const content = data && data.content
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block && (block.type === 'tool-call' || block.type === 'tool_call'))
    .map((block) => ({
      id: String(block.id || block.callId || ''),
      name: String(block.name || block.toolName || ''),
      arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments || {}),
    }))
    .filter((call) => call.name)
}

function errorTextOf(data) {
  if (!data) return ''
  if (typeof data.error === 'string') return data.error
  if (data.error && typeof data.error === 'object') {
    return [data.error.reason, data.error.message, data.error.code].filter((part) => typeof part === 'string' && part).join(' ')
  }
  const message = data.message
  if (message && message.isError) return textOf(message)
  return textOf(data)
}

function filesOf(data) {
  const out = []
  const visit = (value, depth) => {
    if (depth > 3 || value === null || value === undefined) return
    if (typeof value === 'string') {
      const matches = value.match(/\.[a-zA-Z]{2,6}\b/g)
      if (matches) out.push(...matches.map((match) => match.toLowerCase()))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (typeof value === 'object') {
      for (const key of ['content', 'path', 'file', 'filePath', 'name', 'text', 'command', 'args', 'error']) {
        if (key in value) visit(value[key], depth + 1)
      }
    }
  }
  visit(data, 0)
  return [...new Set(out)].filter((ext) => !/^\.(com|org|net|io|ai)$/.test(ext)).slice(0, 8)
}

export function taskTypesOf(text) {
  const haystack = String(text || '')
  return TASK_RULES
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(haystack)))
    .map((rule) => ({ id: rule.id, label: rule.label }))
}

export function keywordsOf(text) {
  const value = String(text || '').toLowerCase()
  const ascii = value.match(/[a-z0-9][a-z0-9+_-]{1,}/g) || []
  const cjkRuns = value.match(/[\u4e00-\u9fff]{2,}/g) || []
  const grams = []
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2))
  }
  const stop = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your', 'you', 'can', 'will', 'has', 'have',
    'by', 'in', 'to', 'of', 'on', 'at', 'as', 'is', 'are', 'be', 'it', 'or', 'an', 'we', 'our', 'not', 'but',
    'if', 'then', 'so', 'do', 'does', 'was', 'were', 'been', 'being', 'its', 'their', 'they', 'them', 'he', 'she',
    'his', 'her', 'us', 'me', 'my', 'no', 'yes', 'up', 'out', 'all', 'any', 'why', 'how', 'what', 'when', 'where',
    'dsh', 'plugin', 'plugins',
    '一个', '这个', '那个', '可以', '我们', '你们', '他们', '帮我', '一下', '什么', '怎么', '然后', '现在',
  ])
  return [...new Set([...ascii, ...grams])].filter((word) => word.length >= 2 && !stop.has(word))
}
