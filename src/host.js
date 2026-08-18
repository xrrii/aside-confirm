// aside-confirm · Host 端
// 用法：将本文件内容作为 cordis_define 的 code.host（详见 README.md）
// 职责：aside-ask RPC 处理器 —— 用当前默认模型直接发起旁路模型调用，
//       不经过 agent loop、不产生会话事件，主对话完全无感知。
//       提示词与错误信息随客户端传入的语言（zh/en）切换。
return {
  apply(ctx) {
    const llm = ctx.get('llm')
    if (llm === undefined) return
    const defaultModel = ctx.get('agentDefaultModel')

    const PROMPTS = {
      zh: [
        '你是主开发会话的"旁路确认"助手。用户正在让主会话中的 agent 开发功能，',
        '对某段 AI 输出有疑问，通过你单独确认；这些问答完全不会进入主会话。',
        '请只针对【被提问的 AI 输出】和【我的问题】作答：',
        '- 用简洁直白的中文回答，解释原因、含义或背景，不要客套；',
        '- 问题如果是"为什么这样做"，结合给定的会话上下文说明可能的意图；',
        '- 只解释、不执行任何任务、不修改任何文件；',
        '- 不要编造上下文里没有的信息，拿不准就直接说拿不准；',
        '- 回答尽量控制在 400 字以内，重点优先；',
        '- 可以使用 Markdown 格式（加粗、列表、行内代码、代码块）让回答更清晰。',
      ].join('\n'),
      en: [
        'You are the "Aside Confirm" assistant for a main development session. The user is having an agent build features in the main session and wants to clarify one piece of AI output through you alone; these Q&As never enter the main session.',
        'Answer ONLY about the [Quoted AI output] and [My question]:',
        '- Answer in concise, plain language; explain the reason, meaning, or background without pleasantries;',
        '- For "why did it do this" questions, use the given conversation context to explain the likely intent;',
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

    ctx.effect(() => harness.handle('aside-ask', async (args) => {
      const lang = args && args.lang === 'en' ? 'en' : 'zh'
      const err = ERRORS[lang]
      const question = String((args && args.question) || '').slice(0, 800)
      const quotedText = String((args && args.quotedText) || '').slice(0, 12000)
      const context = Array.isArray(args && args.context) ? args.context.slice(0, 8) : []
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
      const parts = []
      let finishReason = null
      try {
        for await (const chunk of llm.stream(options)) {
          if (chunk.type === 'text-delta') parts.push(chunk.text)
          else if (chunk.type === 'finish') finishReason = chunk.reason
        }
      } catch (e) {
        return { ok: false, error: err.callFailed + String((e && e.message) || e) }
      }
      if (finishReason !== null && (finishReason.kind === 'error' || finishReason.kind === 'aborted')) {
        const failure = finishReason.failure
        return { ok: false, error: err.callFailed + String((failure && failure.message) || finishReason.kind) }
      }
      const answer = parts.join('').trim()
      if (answer === '') return { ok: false, error: err.emptyAnswer }
      return { ok: true, answer: answer }
    }))
  },
}
