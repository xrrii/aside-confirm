// aside-confirm · 浏览器端
// 用法：将本文件内容作为 cordis_define 的 code.client（详见 README.md）
// 职责：
//   - 消息操作行的「气泡问号」入口 + 右下角旁路面板（拖拽/缩放）；
//   - 打开面板时通过 aside-load 加载该消息的历史问答，提问后通过 aside-ask 启动
//     旁路问答、aside-poll 轮询增量文本实现流式（打字机）渲染（按 requestId 定位，
//     历史刷新不会打断进行中的流）；
//   - 追问时携带之前的 Q&A 作为历史；支持单条删除与清空（aside-delete/aside-clear）；
//   - 界面文案通过 DSH locale 服务自动跟随界面语言（中/英）。
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const localeService = ctx.get('locale')

    const ZH = {
      askTitle: '旁路确认：就这段输出提问，不影响主对话',
      panelTitle: '💬 旁路确认',
      backTitle: '回到提问的那条消息',
      resetTitle: '重置面板位置和大小',
      closeTitle: '关闭',
      clearTitle: '清空该消息的全部旁路记录',
      deleteTitle: '删除这条问答',
      goneHint: '那条消息已不在当前视口，请向上滚动查找。',
      streamLost: '流式连接丢失，请重试',
      loadingText: '正在加载历史记录…',
      hintText: '输入你的问题，AI 会单独在这里回答，不会进入主对话。',
      placeholder: '比如：这段为什么这样实现？',
      send: '提问',
      requestFailed: '请求失败：',
      slotLabel: '旁路确认',
      panelLabel: '旁路确认面板',
    }
    const EN = {
      askTitle: 'Aside confirm: ask about this output without affecting the main conversation',
      panelTitle: '💬 Aside Confirm',
      backTitle: 'Back to the asked message',
      resetTitle: 'Reset panel position and size',
      closeTitle: 'Close',
      clearTitle: 'Clear all aside records for this message',
      deleteTitle: 'Delete this Q&A',
      goneHint: 'That message is no longer in the current view. Scroll up to find it.',
      streamLost: 'Stream connection lost, please retry',
      loadingText: 'Loading history…',
      hintText: 'Type your question; the AI answers here only, outside the main conversation.',
      placeholder: 'e.g. Why is this implemented this way?',
      send: 'Ask',
      requestFailed: 'Request failed: ',
      slotLabel: 'Aside Confirm',
      panelLabel: 'Aside Confirm Panel',
    }

    let t
    if (localeService !== undefined) {
      ctx.effect(() => {
        const d1 = localeService.register('aside-confirm', 'zh', ZH)
        const d2 = localeService.register('aside-confirm', 'en', EN)
        return function () { d1(); d2() }
      })
      t = localeService.bind('aside-confirm')
    } else {
      t = function (key) { return ZH[key] !== undefined ? ZH[key] : key }
    }

    function currentLang() {
      if (localeService === undefined) return 'zh'
      const snap = localeService.getLocale()
      const active = snap && typeof snap.active === 'string' ? snap.active : ''
      return active.indexOf('zh') === 0 ? 'zh' : 'en'
    }

    ctx.effect(() => styles.insert([
      '.aside-ask-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer}',
      '.aside-ask-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary)}',
      '.aside-ask-btn[data-active]{color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1))}',
      '.aside-ask-btn[data-active]:hover{color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary))}',
      '.aside-panel{position:fixed;width:380px;display:flex;flex-direction:column;pointer-events:auto;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);overflow:hidden;font-size:13px;line-height:1.55}',
      '.aside-panel-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600;cursor:move;user-select:none;touch-action:none}',
      '.aside-panel-ctl{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;padding:2px 6px;border-radius:6px}',
      '.aside-panel-ctl:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}',
      '.aside-panel-head-actions{display:flex;align-items:center;gap:2px}',
      '.aside-panel-body{flex:1 1 auto;min-height:0;padding:10px 12px 8px;display:flex;flex-direction:column;gap:10px;overflow-y:auto}',
      '.aside-panel-entries{display:flex;flex-direction:column;gap:10px}',
      '.aside-entry{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px}',
      '.aside-entry-qrow{display:flex;align-items:flex-start;justify-content:space-between;gap:6px}',
      '.aside-entry-q{flex:1;font-weight:600;white-space:pre-wrap}',
      '.aside-entry-del{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1.4;padding:0 2px;border-radius:4px;opacity:.7}',
      '.aside-entry-del:hover{color:var(--dsw-alias-state-error-primary);opacity:1}',
      '.aside-entry-err{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}',
      '.aside-stream-cursor{display:inline-block;width:6px;height:12px;margin-left:2px;vertical-align:-2px;background:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));animation:aside-blink 1s steps(2,start) infinite}',
      '@keyframes aside-blink{50%{opacity:0}}',
      '.aside-md p{margin:4px 0}',
      '.aside-md ul,.aside-md ol{margin:4px 0;padding-left:18px}',
      '.aside-md li{margin:2px 0}',
      '.aside-md pre{margin:6px 0;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow-x:auto;font-size:12px;white-space:pre-wrap}',
      '.aside-md code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);padding:1px 5px;border-radius:4px}',
      '.aside-md pre code{background:transparent;padding:0;border-radius:0}',
      '.aside-md a{color:var(--dsw-alias-brand-primary);text-decoration:underline}',
      '.aside-md h1,.aside-md h2,.aside-md h3,.aside-md h4{margin:8px 0 4px;font-weight:600;line-height:1.4}',
      '.aside-md h1{font-size:15px}',
      '.aside-md h2{font-size:14px}',
      '.aside-md h3{font-size:13px}',
      '.aside-md h4{font-size:12.5px}',
      '.aside-md blockquote{margin:6px 0;padding:2px 10px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.aside-md strong{font-weight:600}',
      '.aside-panel-input{flex:0 0 auto;display:flex;gap:8px;align-items:center;padding:10px 12px 12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.aside-panel-input-box{flex:1;min-width:0;height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:0 10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;outline:none}',
      '.aside-panel-input-box:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.aside-panel-input-box::placeholder{color:var(--dsw-alias-label-secondary)}',
      '.aside-panel-send{border:none;border-radius:10px;background:var(--dsw-alias-brand-primary);color:#fff;padding:0 14px;height:34px;cursor:pointer;font-weight:600;white-space:nowrap}',
      '.aside-panel-send:disabled{opacity:.5;cursor:default}',
      '.aside-panel-resize{position:absolute;right:0;bottom:0;width:12px;height:12px;cursor:nwse-resize;touch-action:none}',
      '.aside-panel-hint{color:var(--dsw-alias-label-secondary);font-size:12px}',
    ].join('\n')))

    function createPanelStore() {
      let state = { open: false, quotedText: '', context: [], entries: [], loading: false, anchorEl: null, anchorMessageId: null }
      const listeners = new Set()
      return {
        get: function () { return state },
        set: function (next) { state = next; for (const fn of listeners) fn(state) },
        subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn) } },
      }
    }
    const store = createPanelStore()

    function usePanelState() {
      const [state, setState] = React.useState(store.get())
      React.useEffect(function () { return store.subscribe(setState) }, [])
      return state
    }

    function useLocaleTick() {
      const [tick, setTick] = React.useState(0)
      React.useEffect(function () {
        if (localeService === undefined) return
        return localeService.subscribe(function () {
          setTick(function (n) { return n + 1 })
        })
      }, [])
      return tick
    }

    function updateEntry(entries, index, patch) {
      const next = entries.slice()
      if (index < 0 || index >= next.length) return entries
      next[index] = Object.assign({}, next[index], patch)
      return next
    }

    function findStreamIndex(entries, requestId) {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (e && e.requestId === requestId) return i
      }
      return -1
    }

    function blocksToText(blocks) {
      const parts = []
      for (const block of blocks || []) {
        if (block && block.kind === 'text') parts.push(block.text)
      }
      return parts.join('\n')
    }

    function contentToText(content) {
      const parts = []
      for (const block of content || []) {
        if (block && block.type === 'text') parts.push(block.text)
      }
      return parts.join('\n')
    }

    function safeUrl(url) {
      if (/^(https?:|mailto:|#|\/)/i.test(url)) return url
      return null
    }

    function renderInline(text) {
      const nodes = []
      let key = 0
      const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\))/g
      let last = 0
      let m
      while ((m = pattern.exec(text)) !== null) {
        if (m.index > last) nodes.push(text.slice(last, m.index))
        const token = m[0]
        if (token.charAt(0) === '`') {
          nodes.push(React.createElement('code', { key: 'ix' + (key++) }, token.slice(1, -1)))
        } else if (token.charAt(0) === '[') {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          const href = link ? safeUrl(link[2]) : null
          if (href === null) {
            nodes.push(token)
          } else {
            nodes.push(React.createElement('a', { key: 'ix' + (key++), href: href, target: '_blank', rel: 'noreferrer noopener' }, link[1]))
          }
        } else {
          nodes.push(React.createElement('strong', { key: 'ix' + (key++) }, renderInline(token.slice(2, -2))))
        }
        last = pattern.lastIndex
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function renderMarkdown(text) {
      const lines = String(text || '').split('\n')
      const blocks = []
      let key = 0
      const nextKey = function () { return 'bk' + (key++) }
      let para = []
      let list = null
      let quote = []
      let code = null

      const flushPara = function () {
        if (para.length === 0) return
        blocks.push(React.createElement('p', { key: nextKey() }, renderInline(para.join(' '))))
        para = []
      }
      const flushList = function () {
        if (list === null) return
        const items = list.items.map(function (nodes, i) {
          return React.createElement('li', { key: 'li' + i }, nodes)
        })
        blocks.push(React.createElement(list.type, { key: nextKey() }, items))
        list = null
      }
      const flushQuote = function () {
        if (quote.length === 0) return
        blocks.push(React.createElement('blockquote', { key: nextKey() }, renderInline(quote.join(' '))))
        quote = []
      }
      const flushCode = function () {
        if (code === null) return
        blocks.push(React.createElement('pre', { key: nextKey() },
          React.createElement('code', null, code.join('\n'))))
        code = null
      }

      for (const raw of lines) {
        if (code !== null) {
          if (/^\s*```/.test(raw)) { flushCode(); code = null }
          else code.push(raw)
          continue
        }
        const fence = /^\s*```.*$/.exec(raw)
        if (fence !== null) {
          flushPara(); flushList(); flushQuote()
          code = []
          continue
        }
        if (raw.trim() === '') { flushPara(); flushList(); flushQuote(); continue }
        const heading = /^(#{1,4})\s+(.*)$/.exec(raw)
        if (heading !== null) {
          flushPara(); flushList(); flushQuote()
          blocks.push(React.createElement('h' + heading[1].length, { key: nextKey() }, renderInline(heading[2])))
          continue
        }
        const quoteLine = /^>\s?(.*)$/.exec(raw)
        if (quoteLine !== null) {
          flushPara(); flushList()
          quote.push(quoteLine[1])
          continue
        }
        const ulItem = /^[-*+]\s+(.*)$/.exec(raw)
        if (ulItem !== null) {
          flushPara(); flushQuote()
          if (list === null || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] } }
          list.items.push(renderInline(ulItem[1]))
          continue
        }
        const olItem = /^\d+[.)]\s+(.*)$/.exec(raw)
        if (olItem !== null) {
          flushPara(); flushQuote()
          if (list === null || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] } }
          list.items.push(renderInline(olItem[1]))
          continue
        }
        flushList(); flushQuote()
        para.push(raw.trim())
      }
      flushPara(); flushList(); flushQuote(); flushCode()
      return blocks
    }

    function AskButton(props) {
      const nodes = props.useSession(function (s) { return s.nodes })
      const state = usePanelState()
      useLocaleTick()
      const active = state.anchorMessageId !== null && state.anchorMessageId === props.messageId
      const onClick = function (e) {
        let quotedText = ''
        const list = Array.isArray(nodes) ? nodes : []
        for (const node of list) {
          if (node && node.kind === 'assistant' && node.messageId === props.messageId) {
            quotedText = blocksToText(node.blocks).slice(0, 12000)
            break
          }
        }
        const context = []
        for (let i = list.length - 1; i >= 0 && context.length < 8; i--) {
          const node = list[i]
          if (!node) continue
          let text = null
          let role = null
          if (node.kind === 'user') { role = 'user'; text = contentToText(node.content) }
          else if (node.kind === 'assistant') { role = 'assistant'; text = blocksToText(node.blocks) }
          if (text !== null && text.trim() !== '') context.unshift({ role: role, text: text.slice(0, 3000) })
        }
        const anchorEl = e && e.currentTarget ? e.currentTarget : null
        store.set({ open: true, quotedText: quotedText, context: context, entries: [], loading: true, anchorEl: anchorEl, anchorMessageId: props.messageId })
        void (async () => {
          let entries = []
          try {
            const res = await host.call('aside-load', { messageId: props.messageId })
            if (res && Array.isArray(res.entries)) entries = res.entries
          } catch (_err) {}
          const cur = store.get()
          if (cur.anchorMessageId !== props.messageId) return
          store.set(Object.assign({}, cur, { entries: entries, loading: false }))
        })()
      }
      const icon = React.createElement('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        React.createElement('path', { d: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z' }),
        React.createElement('path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }),
        React.createElement('path', { d: 'M12 17h.01' }),
      )
      return React.createElement('button', {
        type: 'button',
        className: 'aside-ask-btn',
        title: t('askTitle'),
        'aria-label': t('askTitle'),
        'data-active': active ? '' : undefined,
        onClick: onClick,
      }, icon)
    }

    function Panel() {
      const state = usePanelState()
      useLocaleTick()
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [goneHint, setGoneHint] = React.useState(false)
      const [box, setBox] = React.useState({ left: null, top: null, width: 380, height: null })
      const [drag, setDrag] = React.useState(null)
      const [resize, setResize] = React.useState(null)
      if (!state.open) return null

      const refreshEntries = async function () {
        const messageId = store.get().anchorMessageId
        if (messageId === null) return
        let entries = null
        try {
          const res = await host.call('aside-load', { messageId: messageId })
          if (res && Array.isArray(res.entries)) entries = res.entries
        } catch (_err) { return }
        const cur = store.get()
        if (cur.anchorMessageId !== messageId) return
        const merged = entries.slice()
        for (const e of cur.entries) {
          if (e && e.streaming) merged.push(e)
        }
        store.set(Object.assign({}, cur, { entries: merged }))
      }

      const startPolling = function (requestId) {
        const pollOnce = async function () {
          let res
          try {
            res = await host.call('aside-poll', { requestId: requestId })
          } catch (err) {
            res = { gone: true }
          }
          const cur = store.get()
          const idx = findStreamIndex(cur.entries, requestId)
          if (idx === -1) return
          if (res && res.gone) {
            store.set(Object.assign({}, cur, {
              entries: updateEntry(cur.entries, idx, { streaming: false, error: t('streamLost') }),
            }))
            setBusy(false)
            return
          }
          if (res && res.done) {
            if (res.error !== null && res.error !== undefined && res.error !== '') {
              store.set(Object.assign({}, cur, {
                entries: updateEntry(cur.entries, idx, { streaming: false, error: res.error }),
              }))
            } else {
              store.set(Object.assign({}, cur, {
                entries: updateEntry(cur.entries, idx, { streaming: false, answer: String(res.text || '') }),
              }))
            }
            setBusy(false)
            void refreshEntries()
            return
          }
          store.set(Object.assign({}, cur, {
            entries: updateEntry(cur.entries, idx, { answer: String(res.text || '') }),
          }))
          ctx.timeout(pollOnce, 250)
        }
        pollOnce()
      }

      const send = async function () {
        const question = draft.trim()
        if (question === '' || busy) return
        setBusy(true)
        setDraft('')
        const history = []
        for (const e of state.entries) {
          if (e.streaming) continue
          if (e.question) history.push({ role: 'user', text: e.question })
          if (e.error === null && e.answer) history.push({ role: 'assistant', text: e.answer })
        }
        const entry = { question: question, answer: '', error: null, streaming: true, requestId: null }
        const entries = state.entries.concat([entry])
        store.set({
          open: true,
          quotedText: state.quotedText,
          context: state.context || [],
          entries: entries,
          loading: state.loading,
          anchorEl: state.anchorEl,
          anchorMessageId: state.anchorMessageId,
        })
        let started
        try {
          started = await host.call('aside-ask', {
            question: question,
            quotedText: state.quotedText,
            context: state.context || [],
            history: history.slice(-20),
            messageId: state.anchorMessageId,
            lang: currentLang(),
          })
        } catch (err) {
          started = { ok: false, error: t('requestFailed') + String((err && err.message) || err) }
        }
        const cur0 = store.get()
        if (started === null || started === undefined || !started.ok) {
          const msg = started && started.error ? String(started.error) : t('requestFailed') + 'RPC'
          const idx = findStreamIndex(cur0.entries, null)
          const target = idx === -1 ? cur0.entries.length - 1 : idx
          store.set(Object.assign({}, cur0, {
            entries: updateEntry(cur0.entries, target, { streaming: false, error: msg, requestId: null }),
          }))
          setBusy(false)
          return
        }
        const idx = findStreamIndex(cur0.entries, null)
        const target = idx === -1 ? cur0.entries.length - 1 : idx
        store.set(Object.assign({}, cur0, {
          entries: updateEntry(cur0.entries, target, { requestId: started.requestId }),
        }))
        startPolling(String(started.requestId))
      }

      const deleteEntry = async function (index) {
        const cur = store.get()
        const messageId = cur.anchorMessageId
        const next = cur.entries.slice()
        next.splice(index, 1)
        store.set(Object.assign({}, cur, { entries: next }))
        if (messageId === null) return
        try {
          const res = await host.call('aside-delete', { messageId: messageId, index: index })
          const cur2 = store.get()
          if (res && Array.isArray(res.entries) && cur2.anchorMessageId === messageId) {
            store.set(Object.assign({}, cur2, { entries: res.entries }))
          }
        } catch (_err) {}
      }

      const clearEntries = async function () {
        const cur = store.get()
        const messageId = cur.anchorMessageId
        store.set(Object.assign({}, cur, { entries: [] }))
        if (messageId === null) return
        try {
          const res = await host.call('aside-clear', { messageId: messageId })
          const cur2 = store.get()
          if (res && Array.isArray(res.entries) && cur2.anchorMessageId === messageId) {
            store.set(Object.assign({}, cur2, { entries: res.entries }))
          }
        } catch (_err) {}
      }

      const goBack = function () {
        const el = state.anchorEl
        if (el !== null && el !== undefined && el.isConnected) {
          try {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          } catch (_err) {
            try { el.scrollIntoView() } catch (_err2) {}
          }
          setGoneHint(false)
        } else {
          setGoneHint(true)
        }
      }

      const onHeadDown = function (e) {
        if (e.target && e.target.tagName === 'BUTTON') return
        const rect = e.currentTarget.getBoundingClientRect()
        setDrag({ id: e.pointerId, startX: e.clientX, startY: e.clientY, baseLeft: rect.left, baseTop: rect.top })
        if (e.currentTarget.setPointerCapture) {
          try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_err) {}
        }
      }
      const onHeadMove = function (e) {
        if (drag === null || e.pointerId !== drag.id) return
        const left = drag.baseLeft + (e.clientX - drag.startX)
        const top = Math.max(0, drag.baseTop + (e.clientY - drag.startY))
        setBox(function (prev) { return { left: left, top: top, width: prev.width, height: prev.height } })
      }
      const onHeadUp = function (e) {
        if (drag !== null && e.pointerId === drag.id) setDrag(null)
      }
      const onResizeDown = function (e) {
        const rect = e.currentTarget.parentElement.getBoundingClientRect()
        setResize({ id: e.pointerId, startX: e.clientX, startY: e.clientY, baseW: rect.width, baseH: rect.height })
        if (e.currentTarget.setPointerCapture) {
          try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_err) {}
        }
        e.stopPropagation && e.stopPropagation()
      }
      const onResizeMove = function (e) {
        if (resize === null || e.pointerId !== resize.id) return
        const w = Math.max(280, resize.baseW + (e.clientX - resize.startX))
        const h = Math.max(180, resize.baseH + (e.clientY - resize.startY))
        setBox(function (prev) { return { left: prev.left, top: prev.top, width: w, height: h } })
      }
      const onResizeUp = function (e) {
        if (resize !== null && e.pointerId === resize.id) setResize(null)
      }
      const resetBox = function () {
        setBox({ left: null, top: null, width: 380, height: null })
      }

      const panelStyle = {
        width: box.width + 'px',
        maxHeight: box.height === null ? '66vh' : 'none',
      }
      if (box.left === null) {
        panelStyle.right = '20px'
        panelStyle.bottom = '20px'
      } else {
        panelStyle.left = box.left + 'px'
        panelStyle.top = box.top + 'px'
      }
      if (box.height !== null) panelStyle.height = box.height + 'px'

      const entries = (state.entries || []).map(function (entry, i) {
        const answerEl = entry.streaming
          ? React.createElement('div', { className: 'aside-md' },
              renderMarkdown(entry.answer),
              React.createElement('span', { className: 'aside-stream-cursor' }))
          : entry.error !== null && entry.error !== undefined
            ? React.createElement('div', { className: 'aside-entry-err' }, '✗ ' + entry.error)
            : React.createElement('div', { className: 'aside-md' }, renderMarkdown(entry.answer))
        return React.createElement('div', { key: 'e' + i, className: 'aside-entry' },
          React.createElement('div', { className: 'aside-entry-qrow' },
            React.createElement('div', { className: 'aside-entry-q' }, 'Q: ' + entry.question),
            entry.streaming
              ? null
              : React.createElement('button', {
                  type: 'button',
                  className: 'aside-entry-del',
                  title: t('deleteTitle'),
                  onClick: function () { void deleteEntry(i) },
                }, '✕'),
          ),
          answerEl,
        )
      })
      return React.createElement('div', { className: 'aside-panel', style: panelStyle },
        React.createElement('div', {
          className: 'aside-panel-head',
          onPointerDown: onHeadDown,
          onPointerMove: onHeadMove,
          onPointerUp: onHeadUp,
        },
          React.createElement('span', null, t('panelTitle')),
          React.createElement('div', { className: 'aside-panel-head-actions' },
            React.createElement('button', {
              type: 'button',
              className: 'aside-panel-ctl',
              title: t('backTitle'),
              onClick: goBack,
            }, '📍'),
            React.createElement('button', {
              type: 'button',
              className: 'aside-panel-ctl',
              title: t('resetTitle'),
              onClick: resetBox,
            }, '↺'),
            React.createElement('button', {
              type: 'button',
              className: 'aside-panel-ctl',
              title: t('clearTitle'),
              onClick: function () { void clearEntries() },
            }, '🗑'),
            React.createElement('button', {
              type: 'button',
              className: 'aside-panel-ctl',
              title: t('closeTitle'),
              onClick: function () {
                store.set({ open: false, quotedText: state.quotedText, context: state.context, entries: state.entries, loading: state.loading, anchorEl: state.anchorEl, anchorMessageId: null })
              },
            }, '✕'),
          ),
        ),
        React.createElement('div', { className: 'aside-panel-body' },
          goneHint
            ? React.createElement('div', { className: 'aside-panel-hint' }, t('goneHint'))
            : null,
          entries.length > 0 ? React.createElement('div', { className: 'aside-panel-entries' }, entries) : null,
          entries.length === 0 && state.loading
            ? React.createElement('div', { className: 'aside-panel-hint' }, t('loadingText'))
            : null,
          entries.length === 0 && !state.loading
            ? React.createElement('div', { className: 'aside-panel-hint' }, t('hintText'))
            : null,
        ),
        React.createElement('div', { className: 'aside-panel-input' },
          React.createElement('input', {
            type: 'text',
            className: 'aside-panel-input-box',
            placeholder: t('placeholder'),
            value: draft,
            onChange: function (e) { setDraft(e.target.value) },
            onKeyDown: function (e) {
              if (e.key === 'Enter' && !(e.nativeEvent && e.nativeEvent.isComposing)) {
                e.preventDefault()
                send()
              }
            },
          }),
          React.createElement('button', {
            type: 'button',
            className: 'aside-panel-send',
            disabled: busy || draft.trim() === '',
            onClick: send,
          }, t('send')),
        ),
        React.createElement('div', {
          className: 'aside-panel-resize',
          onPointerDown: onResizeDown,
          onPointerMove: onResizeMove,
          onPointerUp: onResizeUp,
        }),
      )
    }

    slots.inject('conversation.chat.assistant-actions', function () {
      return slots.register(
        { name: 'conversation.chat.assistant-actions', id: 'aside-confirm-ask', order: 60, label: function () { return t('slotLabel') } },
        function (props) { return React.createElement(AskButton, props) },
      )
    })
    slots.inject('shell.overlay', function () {
      return slots.register(
        { name: 'shell.overlay', id: 'aside-confirm-panel', order: 90, label: function () { return t('panelLabel') } },
        function () { return React.createElement(Panel) },
      )
    })
  },
}
