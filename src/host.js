// aside-confirm · Host 端
// 用法：将本文件内容作为 cordis_define 的 code.host（详见 README.md）
// 职责：
//   - aside-ask：校验参数后立即返回 requestId，后台消费 llm.stream 的流式输出，
//     把增量文本写入内存状态（不经过 agent loop、不产生会话事件，主对话完全无感知）；
//   - 分支上下文：每次提问先通过 sessionQuery.readSurface 读取主会话当前的完整
//     模型表面（含工具调用/结果与压缩摘要），用 toolResultPruner 修剪巨型结果，
//     按字符预算从后往前截取，作为旁路问答继承的分支历史；读取失败时回退到
//     客户端传来的最近 8 条上下文；
//   - 再叠加该旁路之前的 Q&A 历史 + 被提问的 AI 输出 + 当前问题；
//   - aside-poll：供客户端轮询增量文本与完成状态；
//   - aside-load / aside-delete / aside-clear：旁路问答记录按消息持久化（进程内），
//     支持加载、单条删除与清空；
//   - 提示词与错误信息随客户端传入的语言（zh/en）切换。
return {
  inject: ['timer'],
  apply(ctx) {
    const llm = ctx.get('llm')
    if (llm === undefined) return
    const defaultModel = ctx.get('agentDefaultModel')
    const sessionQuery = ctx.get('sessionQuery')
    const pruner = ctx.get('toolResultPruner')

    const PROMPTS = {
      zh: [
        '你是主开发会话的"旁路确认"助手。用户正在让主会话中的 agent 开发功能，',
        '对某段 AI 输出有疑问，通过你单独确认；这些问答完全不会进入主会话。',
        '每次提问都会给你三份上下文：',
        '1. 主会话截至当前的完整模型上下文（含工具调用/结果与压缩摘要）——把它当作你继承的分支历史；',
        '2. 此前在该消息下的旁路问答；',
        '3. 当前问题（附被提问的 AI 输出）。',
        '请只针对【被提问的 AI 输出】和【我的问题】作答：',
        '- 用简洁直白的中文回答，解释原因、含义或背景，不要客套；',
        '- 问题如果是"为什么这样做"，结合分支上下文说明可能的意图；',
        '- 结合三份上下文连贯回答，可以呼应"你之前提到…"；',
        '- 只解释、不执行任何任务、不修改任何文件；',
        '- 不要编造上下文里没有的信息，拿不准就直接说拿不准；',
        '- 回答尽量控制在 400 字以内，重点优先；',
        '- 可以使用 Markdown 格式（加粗、列表、行内代码、代码块）让回答更清晰。',
      ].join('\n'),
      en: [
        'You are the "Aside Confirm" assistant for a main development session. The user is having an agent build features in the main session and wants to clarify one piece of AI output through you alone; these Q&As never enter the main session.',
        'Every question gives you three kinds of context:',
        '1. The main session\'s complete model context up to now (including tool calls/results and compaction summaries) — treat it as the branch history you inherit;',
        '2. The earlier aside Q&A under this message;',
        '3. The current question (with the quoted AI output).',
        'Answer ONLY about the [Quoted AI output] and [My question]:',
        '- Answer in concise, plain language; explain the reason, meaning, or background without pleasantries;',
        '- For "why did it do this" questions, use the branch context to explain the likely intent;',
        '- Answer coherently using all three kinds of context; you may refer back with "as mentioned earlier";',
        '- Only explain — never execute tasks or modify files;',
        '- Do not invent information absent from the context; say so when unsure;',
        '- Keep answers within about 400 words, priorities first;',
        '- You may use Markdown (bold, lists, inline code, code blocks) for clarity.',
      ].join('\n'),
    }
    const ERRORS = {
      zh: {
        emptyQuestion: '问题不能为空',
        noModelService: '默认模型服务不可用',
        noSelection: '无法读取当前模型选择',
        callFailed: '模型调用失败：',
        emptyAnswer: '模型没有返回内容',
      },
      en: {
        emptyQuestion: 'Question cannot be empty',
        noModelService: 'Default model service unavailable',
        noSelection: 'Cannot read the current model selection',
        callFailed: 'Model call failed: ',
        emptyAnswer: 'Model returned no content',
      },
    }
    const TRUNCATED = {
      zh: '\n\n…（回答因长度限制被截断）',
      en: '\n\n… (answer truncated by length limit)',
    }

    const streams = new Map()
    const histories = new Map()
    let seq = 0

    function blocksCharLen(blocks) {
      let total = 0
      for (const b of blocks || []) {
        if (!b) continue
        if (b.type === 'text' || b.type === 'reasoning') total += String(b.text || '').length
        else if (b.type === 'tool-call') total += String(b.name || '').length + String(b.arguments || '').length
        else if (b.type === 'tool-result') total += blocksCharLen(b.content)
      }
      return total
    }

    async function loadSurfaceMessages(sessionId) {
      if (sessionQuery === undefined || typeof sessionId !== 'string' || sessionId === '') return null
      let snapshot
      try {
        snapshot = await sessionQuery.readSurface(sessionId)
      } catch (err) {
        return null
      }
      const events = Array.isArray(snapshot && snapshot.events) ? snapshot.events : []
      const all = []
      for (const ev of events) {
        if (!ev || typeof ev.type !== 'string') continue
        try {
          if (ev.type === 'user/message') {
            const m = ev.data
            if (m && Array.isArray(m.content)) all.push({ id: m.id, role: 'user', content: m.content, source: m.source })
          } else if (ev.type === 'assistant/message') {
            const m = ev.data && ev.data.message
            if (m && Array.isArray(m.content)) all.push({ id: m.id, role: 'assistant', content: m.content, source: m.source })
          } else if (ev.type === 'tool/result') {
            const m = ev.data && ev.data.message
            if (m && Array.isArray(m.content)) all.push({ id: m.id, role: 'user', content: m.content, source: m.source })
          }
        } catch (_err) {}
      }
      const picked = []
      let used = 0
      const BUDGET = 24000
      for (let i = all.length - 1; i >= 0; i--) {
        let content = all[i].content
        if (pruner !== undefined) {
          try {
            const pruned = pruner.pruneContent(content)
            if (pruned !== null && Array.isArray(pruned)) content = pruned
          } catch (_err) {}
        }
        const len = blocksCharLen(content)
        if (used + len > BUDGET && picked.length > 0) break
        picked.unshift({ id: all[i].id, role: all[i].role, content: content, source: all[i].source })
        used += len
        if (used > BUDGET) break
      }
      return picked.length > 0 ? picked : null
    }

    ctx.effect(() => harness.handle('aside-load', (args) => {
      const messageId = String((args && args.messageId) || '')
      const list = histories.get(messageId)
      return { entries: list !== undefined ? list.entries : [] }
    }))

    ctx.effect(() => harness.handle('aside-delete', (args) => {
      const messageId = String((args && args.messageId) || '')
      const index = Number(args && args.index)
      const list = histories.get(messageId)
      if (list !== undefined && Number.isInteger(index) && index >= 0 && index < list.entries.length) {
        list.entries.splice(index, 1)
      }
      return { entries: list !== undefined ? list.entries : [] }
    }))

    ctx.effect(() => harness.handle('aside-clear', (args) => {
      const messageId = String((args && args.messageId) || '')
      histories.delete(messageId)
      return { entries: [] }
    }))

    ctx.effect(() => harness.handle('aside-ask', async (args) => {
      const lang = args && args.lang === 'en' ? 'en' : 'zh'
      const err = ERRORS[lang]
      const question = String((args && args.question) || '').slice(0, 800)
      const quotedText = String((args && args.quotedText) || '').slice(0, 12000)
      const context = Array.isArray(args && args.context) ? args.context.slice(0, 8) : []
      const history = Array.isArray(args && args.history) ? args.history.slice(-40) : []
      const messageId = typeof (args && args.messageId) === 'string' ? args.messageId : null
      if (question.trim() === '') return { ok: false, error: err.emptyQuestion }
      if (defaultModel === undefined) return { ok: false, error: err.noModelService }
      const sel = defaultModel.currentSelection()
      if (sel === undefined || typeof sel.provider !== 'string' || typeof sel.model !== 'string') {
        return { ok: false, error: err.noSelection }
      }
      const surfaceMessages = await loadSurfaceMessages(args && args.sessionId)
      const messages = []
      let index = 0
      if (surfaceMessages !== null) {
        for (const m of surfaceMessages) {
          messages.push({
            id: typeof m.id === 'string' && m.id !== '' ? m.id : 'aside-surf-' + (index++),
            role: m.role,
            content: m.content,
            source: m.source,
          })
        }
      } else {
        for (const item of context) {
          const text = String((item && item.text) || '').slice(0, 3000)
          if (text.trim() === '') continue
          const role = (item && item.role) === 'user' ? 'user' : 'assistant'
          messages.push({
            id: 'aside-ctx-' + (index++),
            role: role,
            content: [{ type: 'text', text: text }],
            source: role === 'user'
              ? { kind: 'user' }
              : { kind: 'model', provider: sel.provider, model: sel.model },
          })
        }
      }
      for (const item of history) {
        const text = String((item && item.text) || '').slice(0, 4000)
        if (text.trim() === '') continue
        const role = (item && item.role) === 'assistant' ? 'assistant' : 'user'
        messages.push({
          id: 'aside-his-' + (index++),
          role: role,
          content: [{ type: 'text', text: text }],
          source: role === 'user'
            ? { kind: 'user' }
            : { kind: 'model', provider: sel.provider, model: sel.model },
        })
      }
      const userParts = []
      if (quotedText.trim() !== '') {
        userParts.push(lang === 'en' ? '[Quoted AI output]\n' + quotedText : '【被提问的 AI 输出】\n' + quotedText)
      }
      userParts.push(lang === 'en' ? '[My question]\n' + question : '【我的问题】\n' + question)
      messages.push({
        id: 'aside-q',
        role: 'user',
        content: [{ type: 'text', text: userParts.join('\n\n') }],
        source: { kind: 'user' },
      })
      const options = {
        provider: sel.provider,
        model: sel.model,
        messages: messages,
        system: PROMPTS[lang],
        maxTokens: 8192,
      }
      if (sel.reasoningEffort !== undefined) options.reasoningEffort = sel.reasoningEffort

      const requestId = 'req-' + (++seq)
      streams.set(requestId, { text: '', done: false, error: null })
      const appendHistory = function (entry) {
        if (messageId === null || messageId === '') return
        const list = histories.get(messageId)
        if (list !== undefined) list.entries.push(entry)
        else histories.set(messageId, { entries: [entry] })
      }
      void (async () => {
        const parts = []
        let finishReason = null
        try {
          for await (const chunk of llm.stream(options)) {
            if (chunk.type === 'text-delta') {
              parts.push(chunk.text)
              const st = streams.get(requestId)
              if (st !== undefined) st.text = parts.join('')
            } else if (chunk.type === 'finish') {
              finishReason = chunk.reason
            }
          }
        } catch (e) {
          const text = parts.join('')
          const error = err.callFailed + String((e && e.message) || e)
          streams.set(requestId, { text: text, done: true, error: error })
          appendHistory({ question: question, answer: text, error: error })
          return
        }
        if (finishReason !== null && (finishReason.kind === 'error' || finishReason.kind === 'aborted')) {
          const failure = finishReason.failure
          const text = parts.join('')
          const error = err.callFailed + String((failure && failure.message) || finishReason.kind)
          streams.set(requestId, { text: text, done: true, error: error })
          appendHistory({ question: question, answer: text, error: error })
          return
        }
        let text = parts.join('')
        if (finishReason !== null && finishReason.kind === 'max-tokens') {
          text = text + TRUNCATED[lang]
        }
        const error = text.trim() === '' ? err.emptyAnswer : null
        streams.set(requestId, { text: text, done: true, error: error })
        appendHistory({ question: question, answer: text, error: error })
        ctx.timeout(function () { streams.delete(requestId) }, 600000)
      })()
      return { ok: true, requestId: requestId }
    }))

    ctx.effect(() => harness.handle('aside-poll', (args) => {
      const st = streams.get(String(args && args.requestId))
      if (st === undefined) return { gone: true }
      return { text: st.text, done: st.done, error: st.error }
    }))
  },
}
