// aside-confirm · Host 端
// 用法：将本文件内容作为 cordis_define 的 code.host（详见 README.md）
// 职责：
//   - aside-ask：校验参数后立即返回 requestId，后台消费 llm.stream 的流式输出，
//     把增量文本写入内存状态（不经过 agent loop、不产生会话事件，主对话完全无感知）；
//     追问时把该消息之前的旁路问答作为对话历史传给模型；
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

    const PROMPTS = {
      zh: [
        '你是主开发会话的"旁路确认"助手。用户正在让主会话中的 agent 开发功能，',
        '对某段 AI 输出有疑问，通过你单独确认；这些问答完全不会进入主会话。',
        '请只针对【被提问的 AI 输出】和【我的问题】作答，同时把此前该消息下的旁路问答作为对话历史：',
        '- 用简洁直白的中文回答，解释原因、含义或背景，不要客套；',
        '- 问题如果是"为什么这样做"，结合给定的会话上下文说明可能的意图；',
        '- 追问时注意与之前的旁路问答保持连贯，可以用"你之前提到…"的方式呼应；',
        '- 只解释、不执行任何任务、不修改任何文件；',
        '- 不要编造上下文里没有的信息，拿不准就直接说拿不准；',
        '- 回答尽量控制在 400 字以内，重点优先；',
        '- 可以使用 Markdown 格式（加粗、列表、行内代码、代码块）让回答更清晰。',
      ].join('\n'),
      en: [
        'You are the "Aside Confirm" assistant for a main development session. The user is having an agent build features in the main session and wants to clarify one piece of AI output through you alone; these Q&As never enter the main session.',
        'Answer ONLY about the [Quoted AI output] and [My question], treating the earlier aside Q&A under this message as conversation history:',
        '- Answer in concise, plain language; explain the reason, meaning, or background without pleasantries;',
        '- For "why did it do this" questions, use the given conversation context to explain the likely intent;',
        '- For follow-up questions, stay coherent with the earlier aside Q&A; you may refer back with phrases like "as mentioned earlier";',
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

    const streams = new Map()
    const histories = new Map()
    let seq = 0

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
      const messages = []
      let index = 0
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
        maxTokens: 1600,
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
        const text = parts.join('')
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
