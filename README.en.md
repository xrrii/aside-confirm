# aside-confirm · Aside-Confirmation Plugin for DSH

[中文](./README.md) | English

While an agent is building features for you in a [DeepSeek Harness](https://github.com/deepseek-ai) session, sometimes you do not fully understand a piece of its output and want to ask about it — but asking in the main conversation breaks the flow. This plugin gives you a side channel:

- Every finalized AI reply gets a small "chat-bubble question" icon button;
- Click it to open a side panel in the bottom-right corner and ask about that output;
- The AI answers privately in the panel, using that message plus recent conversation context;
- **The Q&A is never written into the main conversation history** — the main agent is completely unaware, so your development flow stays intact.

## Features

- **Side-channel questions**: ask about any AI output; answers appear only in the panel
- **Context-aware**: automatically sends "the quoted output + up to 8 recent messages" as context
- **Markdown rendering**: answers support bold, inline code, code blocks, lists, headings, quotes, and links
- **Free-form panel**: drag to move, resize from the bottom-right corner, one-click reset
- **📍 Back to origin**: scroll back to the message you asked about
- **Active-state highlight**: the asked message's icon turns brand-colored while selected; resets when the panel closes
- **Multi-turn Q&A**: history kept inside the panel; single-line input, Enter to send (safe with IME composition)
- **Bilingual UI**: the interface follows the DSH language setting (Chinese / English) via the DSH `locale` service; the answer prompt on the Host side switches language accordingly

## How It Works

```
┌───────────── DSH Client (browser) ──────────────┐
│ Message action row ──bubble icon──▶ Side panel  │
│   (conversation.chat.assistant-actions)         │
│                    │  host.call('aside-ask')    │
└────────────────────┼────────────────────────────┘
                     ▼
┌────────────── DSH Host (Node process) ──────────┐
│ aside-ask handler:                              │
│   1. Read the current default model             │
│      (agentDefaultModel)                        │
│   2. Call llm.stream directly — a one-shot      │
│      model request                              │
│   3. No agent loop, no session events           │
└─────────────────────────────────────────────────┘
```

The key point: the answer goes through the Host's `llm` service directly — **no agent loop, no session log writes** — so the main agent never sees this Q&A and the conversation's coherence is untouched.

## Files

| File | Description |
| --- | --- |
| `src/host.js` | Host-side plugin code (the `code.host` value for `cordis_define`) |
| `src/client.js` | Browser-side plugin code (the `code.client` value for `cordis_define`) |
| `LICENSE` | MIT License |

## Installation (DSH Dynamic Plugin)

This plugin is a **dynamic Cordis plugin** for DeepSeek Harness: a temporary, in-process extension that does not modify DSH source code and needs no rebuild.

Hand this repository to your DSH session (or paste the file contents to it) and let it:

1. Create the plugin with `cordis_define`: `plugin.kind: "new"`, `idPrefix: "aside"`, with `code.host` set to the contents of `src/host.js` and `code.client` set to the contents of `src/client.js`;
2. Activate it with `cordis_run` (the first activation asks for approval — allow it; double-checking authorizes future versions of this plugin automatically);
3. Once active, a chat-bubble question icon appears beside every finalized AI reply.

### Updating

After changing the code, append a new Package to the same `pluginId` with `cordis_define` (`kind: "existing"`), then switch versions with `cordis_run` (`mode: "update"`); if the new version fails, roll back to the previous one (`mode: "run"`).

### Notes

- A dynamic plugin lives only in the current DSH process: after a DSH restart, define and activate it again;
- Answers use the session's currently selected default model;
- The UI language follows the DSH language setting automatically (Chinese and English dictionaries are bundled).

## Usage

1. Hover over the AI reply you do not understand and click the bubble-question icon in its action row;
2. Type your question in the bottom-right panel (e.g. "Why is this implemented this way?") and press Enter;
3. Read the Markdown answer in the panel; keep asking follow-ups if needed; click 📍 to jump back to that message;
4. Close the panel (✕) and continue your original development flow.

## License

[MIT](./LICENSE)
