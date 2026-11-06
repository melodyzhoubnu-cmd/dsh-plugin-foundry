/**
 * Plugin Foundry · Client half.
 *
 * Two jobs:
 *   1. the cold-start consent card;
 *   2. a turn-tail card that repeats a Plugin Foundry developer message in the
 *      conversation, because the shipped Chat renders developer messages as a
 *      collapsed context row.
 *
 * No sidebar and no floating recommendation panel: recommendations and install
 * receipts are delivered by the Host into the conversation instead.
 *
 * The card asks two questions only:
 *   - install policy: all / official / never / off;
 *   - usage reporting: local only / contribute (daily aggregates, no content).
 * Defaults are "never" and "local".
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-foundry',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports
    const PLUGIN_NAME = 'dsh-plugin-foundry'
    const CHANNEL = '/api'
    const ONBOARDED_KEY = 'dsh-plugin-foundry:onboarded:v1'
    let pluginCtx = null
    let cssInstalled = false

    const POLICIES = [
      ['all', '全部自动安装', '符合来源、兼容性、质量与预算门槛的插件，装完在对话里说明'],
      ['official', '仅官方精选自动安装', '只自动装官方精选；其余只在对话里推荐'],
      ['never', '始终不自动安装', '只在对话里推荐，由你决定是否安装'],
      ['off', '关闭推荐功能', '不推荐，也不自动安装；计量与导出仍可用'],
    ]

    const REPORTING = [
      ['local', '纯本地（默认）', '不上传用量，开发者不会从你的使用中获得 token 收益'],
      ['contribute', '上报用量，可帮助插件开发者获取收益', '只上传按日聚合与签名，不含原文、提示词或文件内容'],
    ]

    function installCss() {
      if (cssInstalled || typeof document === 'undefined') return
      cssInstalled = true
      const style = document.createElement('style')
      style.id = 'dsh-plugin-foundry-css'
      style.textContent = [
        '.dpf-mask{position:fixed;inset:0;z-index:9999;pointer-events:auto;background:rgba(15,23,42,.42);display:flex;align-items:center;justify-content:center;padding:20px;font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);}',
        '.dpf-dialog{width:min(480px,100%);max-height:calc(100vh - 40px);overflow:auto;background:var(--dsw-alias-bg-raised,#fff);color:var(--dsw-alias-label-primary,#1b1b1b);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:16px;box-shadow:var(--dsw-shadow-lv3,0 24px 64px rgba(0,0,0,.22));padding:22px 22px 18px;}',
        '.dpf-title{font-size:18px;font-weight:650;line-height:1.35;margin-bottom:6px;}',
        '.dpf-text{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#666);margin-bottom:14px;}',
        '.dpf-section{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#888);margin:14px 0 7px;}',
        '.dpf-body{display:flex;flex-direction:column;gap:8px;}',
        '.dpf-option{display:flex;align-items:flex-start;gap:10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:11px;padding:10px 11px;cursor:pointer;transition:border-color .15s,background .15s;}',
        '.dpf-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03));}',
        '.dpf-option.active{border-color:var(--dsw-alias-brand,#4d6bfe);background:rgba(77,107,254,.06);}',
        '.dpf-radio{width:15px;height:15px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,#bbb);margin-top:2px;flex:none;box-sizing:border-box;}',
        '.dpf-radio.on{border:4px solid var(--dsw-alias-brand,#4d6bfe);}',
        '.dpf-option b{display:block;font-size:13px;font-weight:600;line-height:1.35;margin-bottom:2px;}',
        '.dpf-option span{display:block;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#666);}',
        '.dpf-note{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary,#888);margin-top:12px;}',
        '.dpf-error{font-size:11.5px;line-height:1.5;color:var(--dsw-static-red-500,#ef4444);margin-top:10px;}',
        '.dpf-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}',
        '.dpf-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:var(--dsw-alias-bg-raised,#fff);color:inherit;font:inherit;font-size:12.5px;padding:7px 18px;border-radius:9px;cursor:pointer;}',
        '.dpf-btn.primary{background:var(--dsw-alias-brand,#4d6bfe);border-color:var(--dsw-alias-brand,#4d6bfe);color:#fff;}',
        '.dpf-btn:disabled{opacity:.55;cursor:default;}',
        '.dpf-tail{margin-top:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:12px;background:var(--dsw-alias-bg-raised,#fff);color:var(--dsw-alias-label-primary,#1b1b1b);font-size:13px;line-height:1.65;text-align:left;}',
        '.dpf-tail-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;}',
        '.dpf-tail-badge{font-size:11px;font-weight:650;color:var(--dsw-alias-brand,#4d6bfe);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:999px;padding:1px 8px;line-height:1.5;}',
        '.dpf-tail-kind{font-size:11px;color:var(--dsw-alias-label-tertiary,#888);}',
        '.dpf-tail-body{white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#555);}',
        '.dpf-tail.installed{border-color:var(--dsw-alias-brand,#4d6bfe);}',
        '.dpf-tail-installed{font-size:14px;font-weight:650;line-height:1.5;margin-bottom:4px;}',
        '.dpf-tail-benefit{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#555);margin-bottom:8px;}',
        '.dpf-tail-undo{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:var(--dsw-alias-bg-raised,#fff);color:var(--dsw-alias-label-secondary,#555);font:inherit;font-size:12px;padding:4px 10px;border-radius:8px;cursor:pointer;}',
        '.dpf-tail-undo:disabled{opacity:.55;cursor:default;}',
        '.dpf-tail-error{font-size:11.5px;color:var(--dsw-static-red-500,#ef4444);margin-top:6px;}',
      ].join('')
      document.head.appendChild(style)
    }

    function rpc(method, payload) {
      const connection = pluginCtx && pluginCtx.connection
      const call = connection && connection.rpc && connection.rpc.call
      if (typeof call !== 'function') throw new Error('连接尚未就绪')
      return call(CHANNEL, `${PLUGIN_NAME}/${method}`, payload || {})
    }

    function ConsentOverlay() {
      const [open, setOpen] = React.useState(false)
      const [checked, setChecked] = React.useState(false)
      const [policy, setPolicy] = React.useState('never')
      const [reporting, setReporting] = React.useState('local')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        installCss()
        let alive = true
        // The Host owns the answer: if it says consent was already given, never
        // ask again. localStorage is only a fallback when the RPC is not ready.
        Promise.resolve()
          .then(() => rpc('consent'))
          .then((current) => {
            if (!alive) return
            if (current && current.needsConsent === false) {
              setOpen(false)
              setChecked(true)
              return
            }
            if (current && typeof current.policy === 'string') setPolicy(current.policy)
            if (current && typeof current.reporting === 'string') setReporting(current.reporting)
            setOpen(true)
            setChecked(true)
          })
          .catch(() => {
            if (!alive) return
            try {
              setOpen(window.localStorage.getItem(ONBOARDED_KEY) !== '1')
            } catch {
              setOpen(true)
            }
            setChecked(true)
          })
        return () => { alive = false }
      }, [])

      async function save() {
        setBusy(true)
        setError('')
        try {
          await rpc('consent', { policy, reporting })
          try { window.localStorage.setItem(ONBOARDED_KEY, '1') } catch { /* ignore */ }
          setOpen(false)
        } catch (error2) {
          setError('保存失败：' + String((error2 && error2.message) || error2) + '。宿主可能还没就绪，稍等几秒再点一次。')
        } finally {
          setBusy(false)
        }
      }

      if (!checked || !open) return null
      return React.createElement('div', { className: 'dpf-mask' },
        React.createElement('div', { className: 'dpf-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '插件工坊设置' },
          React.createElement('div', { className: 'dpf-title' }, '插件推荐、安装与用量'),
          React.createElement('div', { className: 'dpf-text' },
            '插件工坊会在任务需要时推荐插件，把安装结果写进对话，并按插件归因 token。请选择默认安装策略，以及是否上报用量。'),
          React.createElement('div', { className: 'dpf-body' },
            React.createElement('div', { className: 'dpf-section' }, '安装策略'),
            POLICIES.map(([value, title, desc]) =>
              React.createElement('div', {
                key: value,
                className: 'dpf-option' + (policy === value ? ' active' : ''),
                onClick: () => setPolicy(value),
                role: 'radio',
                'aria-checked': policy === value,
                tabIndex: 0,
              },
                React.createElement('span', { className: 'dpf-radio' + (policy === value ? ' on' : '') }),
                React.createElement('div', null,
                  React.createElement('b', null, title),
                  React.createElement('span', null, desc),
                ),
              ),
            ),
            React.createElement('div', { className: 'dpf-section' }, '用量上报'),
            REPORTING.map(([value, title, desc]) =>
              React.createElement('div', {
                key: value,
                className: 'dpf-option' + (reporting === value ? ' active' : ''),
                onClick: () => setReporting(value),
                role: 'radio',
                'aria-checked': reporting === value,
                tabIndex: 0,
              },
                React.createElement('span', { className: 'dpf-radio' + (reporting === value ? ' on' : '') }),
                React.createElement('div', null,
                  React.createElement('b', null, title),
                  React.createElement('span', null, desc),
                ),
              ),
            ),
          ),
          React.createElement('div', { className: 'dpf-note' },
            '自动安装只作用于免费、通过来源与兼容性校验、无 postinstall、无需重启且不涉及数据外发的插件。安装后会在对话里说明装了哪个插件，以及不用插件的区别。付费插件只展示开发者的购买入口，平台不参与交易。'),
          error ? React.createElement('div', { className: 'dpf-error' }, error) : null,
          React.createElement('div', { className: 'dpf-actions' },
            React.createElement('button', {
              type: 'button',
              className: 'dpf-btn primary',
              disabled: busy,
              onClick: save,
            }, busy ? '保存中…' : '开始使用'),
          ),
        ),
      )
    }

    function turnNumberOf(turn) {
      if (typeof turn === 'number') return turn
      if (turn && typeof turn.turn === 'number') return turn.turn
      return undefined
    }

    /**
     * The Host writes recommendations as developer/message context. The shipped
     * Chat renders those as collapsed context rows, so this turn-tail card
     * repeats the same text as a visible note at the end of the turn. It reads
     * the Chat snapshot, not the DOM, and returns null when the turn has no
     * Plugin Foundry notice.
     */
    function FoundryTurnTail({ turn, useChat }) {
      const [undoState, setUndoState] = React.useState('')
      const text = useChat((snapshot) => {
        const turnNo = turnNumberOf(turn)
        if (turnNo === undefined || !snapshot || !snapshot.locations || !snapshot.nodes) return ''
        const keys = snapshot.locations.getTurn(turnNo) || []
        const parts = []
        for (const key of keys) {
          const node = snapshot.nodes.get(key)
          if (!node || node.kind !== 'context') continue
          const source = node.data && node.data.source
          if (!source || source.summary !== 'plugin-foundry') continue
          const content = node.data.content
          if (!Array.isArray(content)) continue
          const body = content
            .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('')
            .trim()
          if (body) parts.push(body)
        }
        return parts.join('\n\n')
      })
      if (!text) return null
      const body = text.replace(/^\[插件工坊\]\s*/, '')
      const receipt = body.match(/本次任务安装了「([^」]+)」\(([^)]+)\)/)
      const benefit = body.match(/它能帮到：([^\n]+)/)
      const installed = Boolean(receipt)
      const auto = installed && body.includes('自动安装')
      const kind = installed
        ? (auto ? '已自动安装' : '已安装')
        : body.startsWith('与当前任务相关的第三方交易插件')
          ? '交易提醒'
          : body.startsWith('当前任务可能用到')
            ? '旁路推荐'
            : body.startsWith('本次任务推荐')
              ? '推荐（自动安装）'
              : '旁路通知'
      const receiptText = installed ? body.slice(body.indexOf('本次任务安装了')) : body
      async function undo() {
        if (!receipt || undoState === 'busy') return
        setUndoState('busy')
        try {
          await rpc('uninstall', { package: receipt[2] })
          setUndoState('done')
        } catch {
          setUndoState('error')
        }
      }
      return React.createElement('section', {
        className: 'dpf-tail' + (installed ? ' installed' : ''),
        'data-plugin': 'dsh-plugin-foundry',
        'aria-label': installed ? '插件工坊安装通知' : '插件工坊旁路消息',
      },
        React.createElement('div', { className: 'dpf-tail-head' },
          React.createElement('span', { className: 'dpf-tail-badge' }, '插件工坊'),
          React.createElement('span', { className: 'dpf-tail-kind' }, kind),
        ),
        installed
          ? React.createElement('div', null,
            React.createElement('div', { className: 'dpf-tail-installed' }, `已安装「${receipt[1]}」`),
            benefit ? React.createElement('div', { className: 'dpf-tail-benefit' }, `它能让这一步变得更好：${benefit[1]}`) : null,
          )
          : null,
        React.createElement('div', { className: 'dpf-tail-body' }, receiptText),
        installed
          ? React.createElement('div', null,
            React.createElement('button', {
              type: 'button',
              className: 'dpf-tail-undo',
              disabled: undoState === 'busy' || undoState === 'done',
              onClick: undo,
            }, undoState === 'busy' ? '撤销中…' : undoState === 'done' ? '已撤销' : '撤销安装'),
            undoState === 'error' ? React.createElement('div', { className: 'dpf-tail-error' }, '撤销失败，稍后再试或到插件管理里卸载。') : null,
          )
          : null,
      )
    }

    function apply(pluginContext) {
      try {
        pluginCtx = pluginContext
        installCss()
        if (!pluginContext || !pluginContext.slots || typeof pluginContext.slots.register !== 'function') {
          throw new Error('slots.register unavailable')
        }
        const register = () => pluginContext.slots.register({
          name: 'shell.overlay',
          id: 'dsh-plugin-foundry-consent',
          order: 100,
          label: '插件工坊',
        }, ConsentOverlay)
        const registerTurnTail = () => pluginContext.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'plugin-foundry-turn-tail',
          order: 10,
          label: '插件工坊旁路消息',
        }, FoundryTurnTail)
        if (typeof pluginContext.slots.inject === 'function') {
          pluginContext.slots.inject('shell.overlay', register)
          pluginContext.slots.inject('conversation.chat.turnTail', registerTurnTail)
        } else {
          register()
          registerTurnTail()
        }
      } catch (error) {
        if (typeof window !== 'undefined') window.__pluginFoundryError = String((error && error.stack) || error)
        console.error('[plugin-foundry] client apply failed', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection']
    return module.exports
  },
})
