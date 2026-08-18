// aside-confirm · Host 端
// 用法：将本文件内容作为 cordis_define 的 code.host（详见 README.md）
// 职责：aside-ask RPC 处理器 —— 用当前默认模型直接发起旁路模型调用，
//       不经过 agent loop、不产生会话事件，主对话完全无感知。
return {
  apply(ctx) {
    const llm = ctx.get('llm')
    if (llm === undefined) return
    const defaultModel = ctx.get('agentDefaultModel')

    const SYSTEM_PROMPT = [
      '你是主开发会话的"旁路确认"助手。用户正在让主会话中的 agent 开发功能，',
      '对某段 AI 输出有疑问，通过你单独确认；这些问答完全不会进入主会话。',
      '请只针对【被提问的 AI 输出】和【我的问题】作答：',
      '- 用简洁直白的中文回答，解释原因、含义或背景，不要客套；',
      '- 问题如果是"为什么这样做"，结合给定的会话上下文说明可能的意图；',
      '- 只解释、不执行任何任务、不修改任何文件；',
      '- 不要编造上下文里没有的信息，拿不准就直接说拿不准；',
      '- 回答尽量控制在 400 字以内，重点优先；',
      '- 可以使用 Markdown 格式（加粗、列表、行内代码、代码块）让回答更清晰。',
    ].join('\n')

    ctx.effect(() => harness.handle('aside-ask', async (args) => {
      const question = String((args && args.question) || '').slice(0, 800)
      const quotedText = String((args && args.quotedText) || '').slice(0, 12000)
      const context = Array.isArray(args && args.context) ? args.context.slice(0, 8) : []
      if (question.trim() === '') return { ok: false, error: '问题不能为空' }
      if (defaultModel === undefined) return { ok: false, error: '默认模型服务不可用' }
      const sel = defaultModel.currentSelection()
      if (sel === undefined || typeof sel.provider !== 'string' || typeof sel.model !== 'string') {
        return { ok: false, error: '无法读取当前模型选择' }
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
      if (quotedText.trim() !== '') userParts.push('【被提问的 AI 输出】\n' + quotedText)
      userParts.push('【我的问题】\n' + question)
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
        system: SYSTEM_PROMPT,
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
      } catch (err) {
        return { ok: false, error: '模型调用失败：' + String((err && err.message) || err) }
      }
      if (finishReason !== null && (finishReason.kind === 'error' || finishReason.kind === 'aborted')) {
        const failure = finishReason.failure
        return { ok: false, error: '模型调用失败：' + String((failure && failure.message) || finishReason.kind) }
      }
      const answer = parts.join('').trim()
      if (answer === '') return { ok: false, error: '模型没有返回内容' }
      return { ok: true, answer: answer }
    }))
  },
}
