/**
 * Plugin Foundry · Host half.
 *
 * Two pillars in one plugin:
 *   1. distribution  — task profile -> opportunity -> rank -> gate -> a
 *                      `developer/message` in the conversation (no side panel);
 *   2. metering      — provider usage -> plugin-attributed events -> an
 *                      append-only ledger -> signed daily batches;
 *
 * The plugin is deliberately dependency-free and feature-detects every Host
 * service it uses, so a profile without `pluginManager` still gets
 * recommendations and metering.
 */
import os from 'node:os'
import path from 'node:path'
import { aggregateEvents } from '../protocol/attribution.js'
import { compatibleWith } from '../protocol/catalog.js'
import { previewReward } from '../protocol/settlement.js'
import { DEFAULT_CATALOG_URL, DEFAULT_NPM_SEARCH_URL, createCatalog } from './catalog.js'
import { createTaskTracker, keywordsOf, taskTypesOf } from './task.js'
import { createRanker } from './rank.js'
import { createStore } from './store.js'
import { createMeter } from './meter.js'
import { createUploader } from './uploader.js'
import { createNotifier } from './notify.js'

export const name = 'dsh-plugin-foundry'
export const inject = ['connection']
export const VERSION = '0.1.0'
const CHANNEL = '/api'
const METHODS = [
  'ping',
  'state',
  'consent',
  'install',
  'uninstall',
  'never-auto',
  'feedback',
  'report',
  'ledger',
  'export',
]

const AUTO_DENY_CATEGORIES = new Set(['security', 'terminal', 'system', 'market', 'theme', 'fun'])

const DEFAULT_HOME = process.env.DSH_PLUGIN_FOUNDRY_HOME || path.join(os.homedir(), '.dsh', 'plugin-foundry')

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return
  const logger = ctx.logger
  const startedAt = Date.now()
  const store = createStore({ home: config.home })
  const tracker = createTaskTracker()
  const catalog = createCatalog({
    url: config.catalogUrl,
    urls: config.catalogUrls,
    ttlMs: config.catalogTtlMs,
    home: path.join(config.home, 'cache'),
    npmSearch: config.npmSearch,
    npmSearchUrl: config.npmSearchUrl,
    githubSearch: config.githubSearch,
    githubSearchUrl: config.githubSearchUrl,
    githubToken: config.githubToken,
    githubMinStars: config.githubMinStars,
    logger,
  })
  const meter = createMeter({ store, tracker, catalog, config, logger })
  const uploader = createUploader({ store, config, logger })
  const notifier = createNotifier({ ctx, logger })

  const runtime = {
    startedAt,
    lastAuto: null,
    latestReceipt: null,
    installing: false,
    autoBusy: false,
    evaluating: new Set(),
    injected: new Set(),
    used: new Set(),
    installsBySession: new Map(),
    lastNoticeAt: new Map(),
    ranker: null,
    rankerKey: '',
  }
  const cache = new Map()
  let managerRef = null

  if (typeof ctx.inject === 'function') {
    ctx.inject(['pluginManager'], (scope) => {
      managerRef = (scope && scope.pluginManager) || (scope && scope.get && scope.get('pluginManager')) || null
    })
  }

  Promise.resolve(catalog.ensure()).catch(() => {})

  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (session, event) => {
      try {
        tracker.observe(session, event)
        meter.observe(session, event)
        if (!session || !session.id) return
        if (event && event.type === 'assistant/message') {
          const recorded = meter.record(session, event)
          if (recorded) uploader.schedule()
          cache.delete(session.id)
          const discovery = tracker.profileOf(session.id).discovery
          if (discovery && discovery.callId) {
            void evaluateDiscovery(session, discovery).catch((error) => {
              logger?.warn?.(`plugin-foundry: discovery failed: ${String((error && error.message) || error)}`)
            })
          }
        } else if (event && event.type === 'tool/result') {
          markUsed(session, event)
        } else if (event && event.type === 'user/message') {
          cache.delete(session.id)
          void evaluate(session).catch((error) => {
            logger?.warn?.(`plugin-foundry: evaluation failed: ${String((error && error.message) || error)}`)
          })
        }
      } catch (error) {
        logger?.warn?.(`plugin-foundry: session event failed: ${String((error && error.message) || error)}`)
      }
    })
    ctx.on('session/disposed', (session) => {
      if (!session || !session.id) return
      tracker.reset(session.id)
      cache.delete(session.id)
      runtime.evaluating.delete(session.id)
      runtime.installsBySession.delete(session.id)
      runtime.lastNoticeAt.delete(session.id)
    })
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => uploader.close())
  }

  /* ------------------------------ ranking ------------------------------ */

  function ranker() {
    const entries = catalog.entries()
    const key = `${catalog.snapshot().fetchedAt}:${entries.length}`
    if (!runtime.ranker || runtime.rankerKey !== key) {
      runtime.ranker = createRanker(entries)
      runtime.rankerKey = key
    }
    return runtime.ranker
  }

  function rankFor(profile, options = {}) {
    if (!catalog.ready()) return []
    return ranker().rank(profile, {
      installed: options.installed || new Set(),
      exclude: options.exclude,
      feedback: store.feedback.get(),
      maxCards: options.maxCards || config.maxCards,
      currentDsh: config.runtimeVersion,
      minScore: options.minScore ?? config.minScore,
      minNet: options.minNet ?? config.minNet,
      interruptionCost: options.interruptionCost,
      now: Date.now(),
    })
  }

  /* ----------------------------- delivery ----------------------------- */

  /**
   * Complement the model's own search: when it calls plugin_market or a
   * plugin-related web_search, spend one small notice on the ranked candidates
   * from the aggregated index plus the npm registry. This is not another search
   * box; it is the answer the model would have had to assemble itself.
   */
  async function evaluateDiscovery(session, discovery) {
    if (!session || !session.id) return null
    const consent = store.consent.get()
    if (consent.needsConsent || consent.policy === 'off') return null
    const key = `${session.id}:discovery:${discovery.callId}`
    if (runtime.injected.has(key)) return null
    if (Date.now() - (runtime.lastNoticeAt.get(session.id) || 0) < config.noticeCooldownMs) return null
    runtime.injected.add(key)
    try {
      if (!catalog.ready()) await catalog.ensure()
      const baseProfile = tracker.profileOf(session.id)
      const query = String(discovery.query || baseProfile.lastUserText || 'dsh plugin').slice(0, 400)
      const discovered = await catalog.discover(query)
      if (!catalog.ready()) return null
      const queryProfile = {
        ...baseProfile,
        taskTypes: taskTypesOf(query),
        keywords: keywordsOf(query).slice(0, 24),
        fileTypes: [],
        errors: [],
        recipe: null,
        stage: 'planning',
        signals: 1,
        intent: {
          capabilityQuestion: false,
          dependencyError: false,
        },
        opportunity: { type: 'discovery', confidence: 0.55, reason: '模型正在查找插件' },
      }
      const installed = await installedNames()
      const suggestions = ranker().rank(queryProfile, {
        installed,
        feedback: store.feedback.get(),
        maxCards: Math.min(3, config.maxCards + 2),
        currentDsh: config.runtimeVersion,
        minScore: 0.2,
        minNet: 0.02,
        allowKeywordsOnly: true,
      })
      if (suggestions.length === 0) return null
      const snapshot = catalog.snapshot()
      const sourceLabels = [`目录（${snapshot.urls.length} 个索引）`]
      if (snapshot.npmSearch) sourceLabels.push('npm registry')
      if (snapshot.githubSearch) sourceLabels.push('GitHub')
      const lines = [
        `[插件工坊] 你在查找插件。${sourceLabels.join(' + ')} 的匹配：`,
      ]
      suggestions.forEach((row, index) => {
        const status = installed.has(row.package) ? '已安装' : '未安装'
        const cap = row.capabilities && row.capabilities.length > 0 ? ` · ${row.capabilities.slice(0, 3).join(', ')}` : ''
        const source = row.sourceType === 'git' && row.installSpec ? ` · ${row.installSpec}` : ''
        lines.push(`${index + 1}. ${row.name} (${row.package}) · 分数 ${row.score} · ${status}${cap}${source}`)
      })
      lines.push('这只是候选：请核对来源、兼容性和安装结果，不要编造不存在的包名；需要我安装哪一个，直接说。')
      const top = suggestions[0]
      runtime.lastNoticeAt.set(session.id, Date.now())
      deliver(session, lines.join('\n'), top, queryProfile)
      if (discovered.length > 0) cache.clear()
      return { mode: 'discovery', suggestions }
    } finally {
      // no-op: runtime.injected is the durable de-dupe for this call
    }
  }

  async function evaluate(session) {
    if (!session || !session.id) return null
    const consent = store.consent.get()
    if (consent.needsConsent || consent.policy === 'off') return null
    if (runtime.evaluating.has(session.id)) return null
    runtime.evaluating.add(session.id)
    try {
      if (!catalog.ready()) await catalog.ensure()
      if (!catalog.ready()) return null
      const profile = tracker.profileOf(session.id)
      if (!profile.signals || !profile.opportunity) return null
      const installed = await installedNames()
      let suggestions = rankFor(profile, { installed })
      // When the static indexes have no confident answer, widen recall on
      // demand: npm registry plus GitHub repositories. The result is merged
      // into the same catalog and ranked by the same rules.
      const weakStatic = suggestions.length === 0 ||
        (suggestions[0].score || 0) < config.discoveryMinScore ||
        !suggestions[0].quality ||
        (suggestions[0].quality.score || 0) < 0.5
      if (config.externalDiscovery && weakStatic) {
        const query = [
          profile.lastUserText,
          ...(profile.keywords || []).slice(0, 8),
          ...(profile.taskTypes || []).map((type) => type.label),
        ].filter(Boolean).join(' ').slice(0, 400)
        const discovered = await catalog.discover(query)
        if (discovered.length > 0) suggestions = rankFor(profile, { installed })
      }
      const [top] = suggestions
      if (!top) return null

      const key = `${session.id}:${top.package}:${profile.taskTypes.map((type) => type.id).join('+')}:${consent.policy}`
      if (runtime.injected.has(key)) return null
      const lastAt = runtime.lastNoticeAt.get(session.id) || 0
      if (Date.now() - lastAt < config.noticeCooldownMs) return null
      runtime.injected.add(key)
      if (runtime.injected.size > 1000) runtime.injected.delete(runtime.injected.values().next().value)
      runtime.lastNoticeAt.set(session.id, Date.now())
      capMap(runtime.lastNoticeAt, 500)

      const canAuto = consent.policy !== 'never' && autoEligible(top, profile, consent)
      if (!canAuto) {
        deliver(session, recommendationText(top, profile, false), top, profile)
        return { mode: 'recommend', top }
      }
      const scheduled = scheduleAutoInstall(session, top, profile)
      deliver(session, recommendationText(top, profile, scheduled), top, profile)
      return { mode: scheduled ? 'auto' : 'recommend', top }
    } finally {
      runtime.evaluating.delete(session.id)
    }
  }

  function deliver(session, text, top, profile) {
    if (!text) return false
    const ok = notifier.append(session.id, text, { turn: profile.turn, step: profile.step })
    if (ok && top && top.pluginId) {
      tracker.noteCapability(session.id, { text, pluginId: top.pluginId })
    }
    return ok
  }

  function recommendationText(top, profile, autoScheduled) {
    const lines = []
    if (autoScheduled) {
      lines.push(`[插件工坊] 本次任务推荐「${top.name}」(${top.package})，正在自动安装。`)
      lines.push(`理由：${top.why}`)
      lines.push('安装结果确认前，不要声称已经安装；可以先说明它能做什么，以及不使用它时需要多做的步骤。')
    } else {
      lines.push(`[插件工坊] 当前任务可能用到「${top.name}」(${top.package})，但未自动安装。`)
      lines.push(`理由：${top.why}`)
      lines.push('请在思考中判断是否值得推荐；如果推荐，说明它能做什么、不装时需要怎么做，不要声称已经安装。')
      lines.push('最终回复末尾用一句话说明本次是否安装了插件。')
    }
    return lines.join('\n')
  }

  function capabilityText(receipt) {
    const effective = receipt.effective === 'next-step'
      ? '已装好，下一步可以直接使用。'
      : receipt.effective === 'restart'
        ? '已安装，但需要重启 DeepSeek Harness 后才能使用。'
        : '安装尚未完成。'
    return [
      `[插件工坊] 本次任务安装了「${receipt.name}」(${receipt.package})。${effective}`,
      receipt.mode === 'auto' ? '（这是你授权「全部自动安装」后的自动安装；可以在回合末尾的卡片里撤销。）' : '',
      receipt.benefit ? `它能帮到：${receipt.benefit}` : '',
      '请在最终回复末尾用一句话列出本次安装的插件，并说明没有它时需要手动完成哪些步骤、会多花什么时间。',
      '不要声称未安装的插件已经安装。',
    ].filter(Boolean).join('\n')
  }

  /* --------------------------- auto install --------------------------- */

  function autoEligible(top, profile, consent) {
    if (!config.allowInstall || !config.autoInstall) return false
    if (!top || !top.package) return false
    if (consent.needsConsent) return false
    if (consent.policy === 'never' || consent.policy === 'off') return false
    if ((profile.lastUserAt || 0) < consent.updatedAt) return false
    if (Date.now() - (profile.lastUserAt || 0) > 5 * 60 * 1000) return false
    if (top.score < config.autoMinScore) return false
    if (top.net < config.autoMinNet) return false
    if (top.confidence < 0.6) return false
    const minQuality = consent.policy === 'all' ? config.autoMinQualityAll : config.autoMinQuality
    if (!top.quality || top.quality.score < minQuality) return false
    if (top.category && AUTO_DENY_CATEGORIES.has(top.category)) return false
    if (top.sourceType !== 'npm' && top.sourceType !== 'git') return false
    if (top.risk && (top.risk.postinstall || top.risk.restartRequired || top.risk.dataEgress)) return false
    if (top.publishedAt && Date.now() - top.publishedAt > 365 * 86400000) return false
    if (consent.policy === 'official' && !isOfficial(top)) return false
    if (consent.policy !== 'all' && Number(top.versionCount) < 2) return false
    if (consent.never.includes(top.package) || consent.revoked.includes(top.package)) return false
    if (store.consent.get().revoked.includes(top.package)) return false
    const budget = store.budget.canAuto(top.package, profile.sessionId, {
      dailyMax: config.autoDailyBudget,
      perSession: 1,
    })
    if (!budget.ok) return false
    return true
  }

  function scheduleAutoInstall(session, top, profile) {
    if (runtime.autoBusy || runtime.installing) return false
    runtime.autoBusy = true
    const timer = setTimeout(() => {
      void runAutoInstall(session, top, profile).finally(() => {
        runtime.autoBusy = false
      })
    }, config.autoInstallDelayMs)
    timer.unref?.()
    return true
  }

  async function runAutoInstall(session, top, profile) {
    const consent = store.consent.get()
    if (!autoEligible(top, profile, consent)) {
      deliver(session, `[插件工坊] 「${top.name}」(${top.package}) 未自动安装（预算、去重或门槛未通过），不要声称已安装。`, top, profile)
      return { ok: false, reason: 'gate' }
    }
    const result = await installOne(top.package, { auto: true })
    if (!result.ok) {
      const receipt = {
        id: `${top.package}@${Date.now()}`,
        package: top.package,
        name: top.name || top.package,
        pluginId: top.pluginId,
        mode: 'auto',
        effective: 'failed',
        message: result.error.message,
        benefit: top.why || '',
        notified: false,
      }
      receipt.notified = deliver(session, [
        `[插件工坊] 「${top.name}」(${top.package}) 安装失败，当前没有安装。`,
        `原因：${result.error.message}`,
        '请不要声称已安装；可以在回复里说明失败原因，或建议用户手动安装。',
      ].filter(Boolean).join('\n'), top, profile)
      runtime.latestReceipt = receipt
      store.receipts.add(receipt)
      store.budget.record(top.package, profile.sessionId)
      return { ok: false, reason: 'install-failed', error: result.error }
    }

    const value = result.value
    const receipt = {
      id: `${top.package}@${Date.now()}`,
      package: top.package,
      name: top.name || top.package,
      pluginId: top.pluginId,
      mode: 'auto',
      effective: value.effective,
      message: value.message,
      benefit: top.why || '',
      notified: false,
    }
    receipt.notified = deliver(session, capabilityText(receipt), top, profile)
    runtime.latestReceipt = receipt
    store.receipts.add(receipt)
    store.installs.add({
      package: value.package,
      version: value.version,
      mode: 'auto',
      effective: value.effective,
      notified: receipt.notified,
      pluginId: top.pluginId,
      category: top.category,
    })
    store.budget.record(top.package, profile.sessionId)
    store.feedback.record('installed', top.package, top.category)
    rememberTools(top)
    const list = runtime.installsBySession.get(profile.sessionId) || []
    if (!list.includes(top.package)) list.push(top.package)
    runtime.installsBySession.set(profile.sessionId, list)
    runtime.lastAuto = {
      package: top.package,
      version: value.version,
      at: Date.now(),
      application: value.application,
      effective: value.effective,
      message: value.message,
    }
    cache.clear()
    return { ok: true, receipt }
  }

  function rememberTools(top) {
    const entry = catalog.byName(top.package)
    const tools = entry && Array.isArray(entry.tools) ? entry.tools : top.tools || []
    if (tools.length === 0) return
    const map = {}
    for (const tool of tools) if (typeof tool === 'string' && tool) map[tool] = top.package
    store.toolOwners.set(map)
  }

  function isOfficial(top) {
    if (!top || !top.package) return false
    return top.package.startsWith('@deepseek-ai/') || config.officialPackages.includes(top.package)
  }

  /* ----------------------------- install ----------------------------- */

  async function installOne(pkg, meta = {}) {
    if (!config.allowInstall) return fail('install-disabled', '这个 profile 没有开启安装', { command: commandFor(pkg) })
    const snapshot = catalog.snapshot()
    if (snapshot.status !== 'ready') return fail('catalog-not-ready', '插件目录还没准备好')
    const entry = catalog.byName(pkg)
    if (!entry) return fail('not-in-catalog', '这个插件不在当前目录里')
    if (!compatibleWith(entry.engines, config.runtimeVersion)) {
      return fail('incompatible', '它和当前 DSH 版本不兼容', { engines: entry.engines, runtime: config.runtimeVersion })
    }
    if (entry.sourceType !== 'npm' && entry.sourceType !== 'git') {
      return fail('unsupported-source', '当前只允许从 npm 或 git 源安装', { source: entry.sourceType })
    }
    if ((await installedNames()).has(pkg)) return fail('already-installed', '已经安装过了')

    const spec = entry.sourceType === 'git'
      ? (entry.installSpec || entry.homepage || pkg)
      : (entry.version ? `${pkg}@${entry.version}` : pkg)
    const command = commandFor(spec)
    const pm = pluginManagerOf()
    if (!pm || typeof pm.installBundle !== 'function') {
      return fail('no-manager', '这个 DSH 不能在这里安装，请用命令', { command })
    }
    if (typeof pm.inspect === 'function') {
      let inspection
      try {
        inspection = await pm.inspect(spec)
      } catch (error) {
        return fail('inspect-failed', String((error && error.message) || error), { command })
      }
      if (inspection && (inspection.problem || inspection.status === 'refused')) {
        return fail('inspect-' + (inspection.problem || 'refused'), `预检未通过：${inspection.problem || inspection.reason || 'refused'}`, { command })
      }
      if (inspection && inspection.bundle === false) {
        return fail('not-a-bundle', '这个包没有声明 dsh.bundle，DSH 会拒绝安装', { command })
      }
    }

    let result
    try {
      result = await pm.installBundle(spec, { enabled: true, saveExact: entry.sourceType === 'npm' })
    } catch (error) {
      return fail('install-failed', String((error && error.message) || error), { command })
    }

    const application = (result && result.application) || 'failed'
    const effective = application === 'applied'
      ? 'next-step'
      : application === 'restart-required'
        ? 'restart'
        : result && Array.isArray(result.pendingBuilds) && result.pendingBuilds.length > 0
          ? 'configure'
          : 'failed'
    const errorMessage = result && result.error
      ? String(result.error.diagnostic || result.error.code || '')
      : application === 'cancelled'
        ? '安装被取消'
        : application === 'overridden'
          ? '这个 profile 用更高优先级的配置覆盖了它'
          : ''

    if (effective === 'failed') {
      return fail('install-failed', errorMessage || '安装命令没有成功应用', {
        command,
        application,
        pendingBuilds: (result && result.pendingBuilds) || [],
      })
    }

    return ok({
      package: pkg,
      version: (result && result.version) || entry.version,
      application,
      effective,
      message: describeEffective(effective, errorMessage),
      command,
      pendingBuilds: (result && result.pendingBuilds) || [],
      auto: Boolean(meta.auto),
    })
  }

  function commandFor(spec) {
    return `dsh plugin --profile ${process.env.DSH_PROFILE || 'desktop'} add ${spec}`
  }

  /* ----------------------------- RPC ----------------------------- */

  const handle = async (method, payload) => {
    if (method === 'ping') return ok({ pong: Date.now(), version: VERSION, catalog: catalog.snapshot() })
    if (method === 'state') return stateOf(payload || {})
    if (method === 'consent') return consentOf(payload || {})
    if (method === 'install') return installRpc(payload || {})
    if (method === 'uninstall') return uninstallOf(payload || {})
    if (method === 'never-auto') return neverAutoOf(payload || {})
    if (method === 'feedback') return feedbackOf(payload || {})
    if (method === 'report') return reportOf()
    if (method === 'ledger') return ledgerOf(payload || {})
    if (method === 'export') return ok(store.exportAll())
    return fail('unknown-method', `unknown method: ${method}`)
  }

  async function stateOf(payload) {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null
    const force = payload.force === true
    const exclude = new Set(Array.isArray(payload.exclude) ? payload.exclude.filter((item) => typeof item === 'string') : [])
    const profile = sessionId ? tracker.profileOf(sessionId) : tracker.latestProfile()
    const snapshot = catalog.snapshot()
    if (snapshot.status !== 'ready') {
      return ok(baseState(profile, snapshot, [], { exhausted: false }))
    }
    const key = `${sessionId || 'latest'}:${[...exclude].sort().join(',')}`
    const cached = cache.get(key)
    if (!force && cached && Date.now() - cached.at < config.minIntervalMs) {
      return ok({ ...cached.value, task: profile, catalog: snapshot })
    }
    const installed = await installedNames()
    let suggestions = rankFor(profile, { installed, exclude })
    let exhausted = false
    if (exclude.size > 0 && suggestions.length === 0) {
      suggestions = rankFor(profile, { installed })
      exhausted = true
    }
    const value = baseState(profile, snapshot, suggestions, { exhausted })
    cache.set(key, { at: Date.now(), value })
    capMap(cache, 200)
    return ok(value)
  }

  function baseState(profile, snapshot, suggestions, extra = {}) {
    const top = suggestions[0] || null
    return {
      plugin: { name, version: VERSION, phase: 'v1' },
      host: {
        startedAt,
        now: Date.now(),
        uptimeMs: Date.now() - startedAt,
        sessionId: profile ? profile.sessionId : null,
        runtimeVersion: config.runtimeVersion,
      },
      task: profile,
      catalog: snapshot,
      generatedAt: Date.now(),
      suggestions,
      exhausted: Boolean(extra.exhausted),
      capabilities: {
        install: config.allowInstall,
        autoInstall: config.autoInstall,
        upload: Boolean(config.uploadUrl),
        settlementPreview: true,
      },
      limits: {
        maxCards: config.maxCards,
        autoDailyBudget: config.autoDailyBudget,
        suggestionTtlMs: 10 * 60 * 1000,
        attributionStrategy: config.attributionStrategy,
      },
      consent: publicConsent(),
      auto: runtime.lastAuto,
      latestReceipt: runtime.latestReceipt,
      receipts: store.receipts.list().slice(0, 8),
      counts: {
        ledger: store.ledger.count(),
        installs: store.installs.list().length,
        batches: store.batches.list().length,
      },
    }
  }

  function consentOf(payload) {
    if (payload.policy === undefined) return ok(publicConsent())
    if (!['all', 'official', 'never', 'off'].includes(payload.policy)) {
      return fail('bad-request', 'policy 必须是 all / official / never / off')
    }
    if (payload.reporting !== undefined && !['local', 'contribute'].includes(payload.reporting)) {
      return fail('bad-request', 'reporting 必须是 local / contribute')
    }
    store.consent.set({ policy: payload.policy, ...(payload.reporting !== undefined ? { reporting: payload.reporting } : {}) })
    cache.clear()
    if (payload.reporting === 'contribute') uploader.schedule(config.uploadDelayMs)
    return ok(publicConsent())
  }

  function publicConsent() {
    const consent = store.consent.get()
    return {
      policy: consent.policy,
      reporting: consent.reporting,
      needsConsent: consent.needsConsent,
      never: consent.never.length,
      revoked: consent.revoked.length,
      updatedAt: consent.updatedAt,
    }
  }

  async function installRpc(payload) {
    const pkg = typeof payload.package === 'string' ? payload.package.trim() : ''
    if (!pkg) return fail('bad-request', '缺少 package')
    if (runtime.installing) return fail('busy', '已有安装在进行')
    runtime.installing = true
    try {
      const result = await installOne(pkg)
      if (!result.ok) return result
      const entry = catalog.byName(pkg)
      const receipt = {
        id: `${pkg}@${Date.now()}`,
        package: pkg,
        name: (entry && entry.title) || pkg,
        pluginId: entry ? entry.pluginId : '',
        mode: 'manual',
        effective: result.value.effective,
        message: result.value.message,
        benefit: entry ? entry.description.slice(0, 120) : '',
        notified: false,
      }
      if (payload.sessionId) {
        const session = notifier.sessionOf(payload.sessionId)
        if (session) {
          const profile = tracker.profileOf(payload.sessionId)
          receipt.notified = notifier.append(payload.sessionId, capabilityText(receipt), {
            turn: profile.turn,
            step: profile.step,
          })
        }
      }
      runtime.latestReceipt = receipt
      store.receipts.add(receipt)
      store.installs.add({
        package: pkg,
        version: result.value.version,
        mode: 'manual',
        effective: result.value.effective,
        notified: receipt.notified,
        pluginId: receipt.pluginId,
        category: entry ? entry.category : '',
      })
      if (entry) {
        store.feedback.record('installed', pkg, entry.category)
        rememberTools({ package: pkg, tools: entry.tools, pluginId: entry.pluginId })
      }
      cache.clear()
      return result
    } finally {
      runtime.installing = false
    }
  }

  async function uninstallOf(payload) {
    const pkg = typeof payload.package === 'string' ? payload.package.trim() : ''
    if (!pkg) return fail('bad-request', '缺少 package')
    const pm = pluginManagerOf()
    if (!pm || typeof pm.removeBundle !== 'function') return fail('no-manager', '这个 DSH 没有 pluginManager')
    try {
      const result = await pm.removeBundle(pkg)
      const entry = catalog.byName(pkg)
      store.consent.revoke(pkg, entry ? entry.category : '')
      if (runtime.lastAuto && runtime.lastAuto.package === pkg) runtime.lastAuto = null
      cache.clear()
      return ok({
        package: pkg,
        application: (result && result.application) || 'applied',
        message: (result && result.application) === 'restart-required'
          ? '已撤销，需要重启后完全移除'
          : '已撤销，之后不会再自动安装',
      })
    } catch (error) {
      return fail('uninstall-failed', String((error && error.message) || error))
    }
  }

  function neverAutoOf(payload) {
    const pkg = typeof payload.package === 'string' ? payload.package.trim() : ''
    if (!pkg) return fail('bad-request', '缺少 package')
    const consent = store.consent.never(pkg)
    cache.clear()
    return ok({ package: pkg, never: consent.never.length })
  }

  function feedbackOf(payload) {
    const pkg = typeof payload.package === 'string' ? payload.package.trim() : ''
    if (!pkg) return fail('bad-request', '缺少 package')
    const kinds = new Set(['ignored', 'clicked', 'installed', 'used', 'revoked'])
    if (!kinds.has(payload.kind)) return fail('bad-request', 'kind 必须是 ignored / clicked / installed / used / revoked')
    const entry = catalog.byName(pkg)
    store.feedback.record(payload.kind, pkg, (entry && entry.category) || payload.category || '')
    cache.clear()
    return ok({ package: pkg, kind: payload.kind, feedback: store.feedback.get() })
  }

  async function installedNames() {
    try {
      const pm = pluginManagerOf()
      if (!pm || typeof pm.listBundles !== 'function') return new Set()
      const list = await pm.listBundles()
      const rows = Array.isArray(list) ? list : (list && Array.isArray(list.bundles) ? list.bundles : [])
      const names = new Set(
        rows
          .filter((row) => typeof row === 'string' || (row && row.installed !== false))
          .map((row) => (typeof row === 'string' ? row : row && row.name))
          .filter(Boolean),
      )
      // A git install's bundle name can differ from its repository name; keep
      // the Foundry install record as an alias so the same repo is not
      // recommended again after it was installed.
      for (const row of store.installs.list()) {
        if (row && typeof row.package === 'string' && row.package) names.add(row.package)
      }
      return names
    } catch (error) {
      logger?.warn?.(`plugin-foundry: listBundles failed: ${String((error && error.message) || error)}`)
      return new Set()
    }
  }

  function reportOf() {
    const events = store.ledger.readAll()
    const aggregate = aggregateEvents(events)
    const verification = store.ledger.verify()
    const rates = {
      currency: config.currency,
      basis: config.rewardMode,
      shareRate: config.shareRate,
      rebateRate: config.rebateRate,
      pricePerMTokens: config.pricePerMTokens,
      plugins: config.pluginRates,
    }
    const byPlugin = aggregate.byPlugin.map((row) => {
      const entry = catalog.byName(row.plugin_id) || catalog.entries().find((item) => item.pluginId === row.plugin_id)
      return {
        ...row,
        category: entry ? entry.category : '',
        reward: previewReward(row.tokens, { ...rates, pluginId: row.plugin_id }),
      }
    })
    return ok({
      generatedAt: Date.now(),
      attribution: 'three buckets: request base, tool results, capability signals',
      tokenSource: 'provider usage',
      reward: {
        mode: config.rewardMode,
        shareRate: config.shareRate,
        rebateRate: config.rebateRate,
        pricePerMTokens: config.pricePerMTokens,
        currency: config.currency,
      },
      tokens: {
        byPlugin,
        totals: aggregate.totals,
        unattributed: aggregate.unattributed,
        events: events.length,
        unattributedEvents: events.filter((event) => !event.plugin_id).length,
      },
      installs: aggregateInstalls(store.installs.list()),
      ledger: {
        ok: verification.ok,
        count: verification.count,
        root: verification.root,
        head: verification.head,
        problems: verification.problems.slice(0, 5),
      },
      batches: store.batches.list().slice(-10),
      consent: publicConsent(),
      toolOwners: meter.owners(),
    })
  }

  function ledgerOf(payload) {
    const verification = store.ledger.verify()
    const limit = Number.isFinite(payload.limit) ? Math.min(500, Math.max(1, payload.limit)) : 50
    const from = Number.isFinite(payload.fromSeq) ? payload.fromSeq : 0
    const events = store.ledger.readAll().filter((event) => event.seq > from).slice(-limit)
    return ok({
      verification: {
        ok: verification.ok,
        count: verification.count,
        root: verification.root,
        head: verification.head,
        problems: verification.problems.slice(0, 20),
      },
      events,
    })
  }

  function pluginManagerOf() {
    if (managerRef) return managerRef
    try {
      return (ctx.get && ctx.get('pluginManager')) || ctx.pluginManager
    } catch {
      return undefined
    }
  }

  function markUsed(session, event) {
    try {
      const callId = String((event.data && event.data.message && event.data.message.toolCallId) || '')
      if (!callId) return
      const profile = tracker.profileOf(session.id)
      const call = (profile.toolCalls || []).find((item) => item.callId === callId)
      if (!call) return
      const owner = meter.owners()[call.name]
      if (!owner) return
      const installed = store.installs.list().some((row) => row.package === owner)
      if (!installed) return
      const key = `${session.id}:${owner}`
      if (runtime.used.has(key)) return
      runtime.used.add(key)
      if (runtime.used.size > 500) runtime.used.delete(runtime.used.values().next().value)
      const entry = catalog.byName(owner)
      store.feedback.record('used', owner, entry ? entry.category : '')
    } catch {
      /* feedback is best effort */
    }
  }

  /* --------------------------- transport --------------------------- */

  const fetchRegistry = ctx.connection && ctx.connection.fetch
  if (!fetchRegistry || typeof fetchRegistry.register !== 'function') {
    logger?.warn?.('plugin-foundry: connection.fetch.register unavailable; RPC not registered')
    return
  }
  for (const method of METHODS) {
    fetchRegistry.register({
      path: `${CHANNEL}/${name}/${method}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => serveRpc(method, request, (payload) => handle(method, payload)),
    })
  }
}

/* ------------------------------ helpers ------------------------------ */

function capMap(map, limit) {
  while (map.size > limit) map.delete(map.keys().next().value)
}

function aggregateInstalls(installs) {
  const map = new Map()
  for (const row of Array.isArray(installs) ? installs : []) {
    if (!row || !row.package) continue
    const item = map.get(row.package) || {
      package: row.package,
      installs: 0,
      auto: 0,
      manual: 0,
      notified: 0,
      nextStep: 0,
      lastAt: 0,
    }
    item.installs += 1
    if (row.mode === 'auto') item.auto += 1
    else item.manual += 1
    if (row.notified) item.notified += 1
    if (row.effective === 'next-step') item.nextStep += 1
    if (Number(row.at) > item.lastAt) item.lastAt = Number(row.at)
    map.set(row.package, item)
  }
  return [...map.values()].sort((a, b) => b.installs - a.installs)
}

function describeEffective(effective, errorMessage) {
  if (effective === 'next-step') return '已安装，下一步就能用'
  if (effective === 'restart') return '已安装，重启 DeepSeek Harness 后生效'
  if (effective === 'configure') return '安装未完成：需要允许构建脚本或补充配置'
  return errorMessage || '安装失败'
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function normalizeConfig(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const autoInstall = value.autoInstall === false || value.autoInstall === 'off' ? false : true
  return {
    enabled: value.enabled !== false,
    home: typeof value.home === 'string' && value.home ? value.home : DEFAULT_HOME,
    maxCards: clampInt(value.maxCards, 1, 6, 1),
    allowInstall: value.allowInstall !== false,
    autoInstall,
    autoInstallDelayMs: clampInt(value.autoInstallDelayMs, 0, 60_000, 1200),
    autoDailyBudget: clampInt(value.autoDailyBudget, 1, 50, 3),
    autoMinScore: clampNumber(value.autoMinScore, 0, 1, 0.45),
    autoMinNet: clampNumber(value.autoMinNet, 0, 1, 0.22),
    autoMinQuality: clampNumber(value.autoMinQuality, 0, 1, 0.55),
    minScore: clampNumber(value.minScore, 0, 1, 0.38),
    minNet: clampNumber(value.minNet, -1, 1, 0.1),
    noticeCooldownMs: clampInt(value.noticeCooldownMs, 0, 600_000, 10_000),
    minIntervalMs: clampInt(value.minIntervalMs, 0, 60_000, 4000),
    catalogUrl: typeof value.catalogUrl === 'string' && value.catalogUrl ? value.catalogUrl : DEFAULT_CATALOG_URL,
    catalogUrls: Array.isArray(value.catalogUrls)
      ? value.catalogUrls.filter((item) => typeof item === 'string' && item)
      : (typeof value.catalogUrl === 'string' && value.catalogUrl ? [value.catalogUrl] : [DEFAULT_CATALOG_URL]),
    npmSearch: value.npmSearch !== false,
    npmSearchUrl: typeof value.npmSearchUrl === 'string' && value.npmSearchUrl ? value.npmSearchUrl : DEFAULT_NPM_SEARCH_URL,
    githubSearch: value.githubSearch !== false,
    githubSearchUrl: typeof value.githubSearchUrl === 'string' && value.githubSearchUrl ? value.githubSearchUrl : 'https://api.github.com/search/repositories',
    githubToken: typeof value.githubToken === 'string' ? value.githubToken : '',
    githubMinStars: clampInt(value.githubMinStars, 0, 100000, 0),
    externalDiscovery: value.externalDiscovery !== false,
    discoveryMinScore: clampNumber(value.discoveryMinScore, 0, 1, 0.65),
    autoMinQualityAll: clampNumber(value.autoMinQualityAll, 0, 1, 0.15),
    catalogTtlMs: clampInt(value.catalogTtlMs, 60_000, 24 * 3600 * 1000, 6 * 3600 * 1000),
    runtimeVersion: typeof value.runtimeVersion === 'string' && value.runtimeVersion
      ? value.runtimeVersion
      : (process.env.DSH_VERSION || '0.2.1-rc.5'),
    toolOwners: value.toolOwners && typeof value.toolOwners === 'object' ? value.toolOwners : {},
    officialPackages: Array.isArray(value.officialPackages)
      ? value.officialPackages.filter((item) => typeof item === 'string')
      : [],
    uploadUrl: typeof value.uploadUrl === 'string' ? value.uploadUrl : '',
    uploadToken: typeof value.uploadToken === 'string' ? value.uploadToken : '',
    uploadDelayMs: clampInt(value.uploadDelayMs, 0, 300_000, 5000),
    uploadTimeoutMs: clampInt(value.uploadTimeoutMs, 1000, 120_000, 30_000),
    rewardMode: value.rewardMode === 'rebate' ? 'rebate' : 'share',
    shareRate: clampNumber(value.shareRate, 0, 1, 0.3),
    rebateRate: clampNumber(value.rebateRate, 0, 1, 0.1),
    pricePerMTokens: clampNumber(value.pricePerMTokens, 0, 1e6, 0.5),
    currency: typeof value.currency === 'string' && value.currency ? value.currency : 'USD',
    pluginRates: value.pluginRates && typeof value.pluginRates === 'object' ? value.pluginRates : {},
    attributionStrategy: value.attributionStrategy === 'count' ? 'count' : 'size',
  }
}

function ok(value) {
  return { ok: true, value }
}

function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

function envelope(rpcId, result, status = 200) {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

async function serveRpc(method, request, handlePayload) {
  const expected = `${name}/${method}`
  const bad = (message) => envelope('invalid-request', fail('bad-request', message), 400)
  const contentType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') {
    return envelope('invalid-request', fail('bad-request', 'content type must be application/json'), 415)
  }
  let message
  try {
    message = await request.json()
  } catch {
    return bad('body is not JSON')
  }
  const valid = message &&
    typeof message === 'object' &&
    !Array.isArray(message) &&
    message.type === 'client-request' &&
    typeof message.rpcId === 'string'
  if (!valid) return bad('invalid client-request envelope')
  if (message.method !== expected) {
    return envelope(
      message.rpcId,
      fail('bad-request', `method ${JSON.stringify(String(message.method))} does not match ${JSON.stringify(expected)}`),
    )
  }
  try {
    return envelope(message.rpcId, await handlePayload(message.payload))
  } catch (error) {
    return envelope(message.rpcId, fail('internal', String((error && error.message) || error)))
  }
}
