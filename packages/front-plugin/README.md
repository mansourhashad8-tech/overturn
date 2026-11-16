# Overturn for Front

QA for AI-drafted replies, in the conversation sidebar. It watches the composer draft, diffs it against what the reviewer actually sent, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. The drafting agent never has to be instrumented, and it does not matter who wrote the draft: a Front AI assist, a macro, a homegrown drafter, or a teammate pasting from a doc.

## What the reviewer sees

A small panel in the sidebar:

- **Draft inserted · 112 words** once a reply-sized text lands in the composer in one change (an AI assist, macro or paste). "Use the current text as the draft" marks it by hand.
- A **reason** box with quick picks, and an optional note.
- **Capture this send** records the send: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric. With *require a reason* on, a changed reply cannot be captured without one.

Overturn failing never blocks the reviewer's work; the panel says what happened.

## No pre-send hook, and what that means

Front's Plugin SDK has no hook that can veto the native Send (`Front.contextUpdates` is the only stream; the draft surface is `createDraft` / `updateDraft` / `fetchDraft` / `close` / `closeDraft`, and neither rules nor application triggers can block a send — verified against `@frontapp/plugin-sdk` 1.12.0, not just the docs). So this is a conversation-sidebar plugin where both halves are observable:

- the **draft** through the composer context (`messageComposer.draft`) or `conversation.draftId` + `fetchDraft`;
- the **sent body** as the newest outbound message the teammate actually sent in the thread — never the text the plugin last saw.

`require_reason` therefore holds a changed reply's *capture* in the panel until a chip is clicked rather than pretending to block Front's send: nothing unexplained reaches the suite, and the send itself is never blocked or delayed.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/front-plugin build` → `dist/app` (and `dist/overturn-front-plugin.zip` when `zip` is on the PATH).
3. Front → Settings → Plugins → add a plugin, point it at the hosted `index.html` (or sideload `dist/app`), and configure:
   - `overturn_api_key` (the project key)
   - `agent`: the workflow name, one regression suite per workflow (default `support-reply`)
   - `reason_pack`: `support` (default) or `claims`, the one-click reasons reviewers see
   - `decision_fields`: custom fields that *are* the decision, as `id:label` pairs
   - `require_reason`, `capture_internal_notes`, `min_draft_chars`, `overturn_base_url`

The plugin reads its settings from the plugin URL query parameters (and from `window.__OVERTURN_SETTINGS__`, which the tests inject).

## Replay what it captured

```bash
overturn cases list --agent support-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent support-reply
```

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test      # draft detection, diff, send decision
pnpm --filter @overturn-ai/front-plugin build
```

`src/capture.ts` is the logic (pure, tested); `src/main.ts` is the Front SDK glue; `app/` is the HTML shell and stylesheet. The payload builder and the send decision are the same shape as `packages/zendesk-app`; only the surface differs.
