import { contextUpdates } from "@frontapp/plugin-sdk";
import type { CaptureResult } from "@overturn-ai/shared";
import {
  type ConversationSnapshot,
  createDraftDetector,
  decideOnSend,
  type FrontSettings,
  latestSentText,
  quickReasons,
  settingsFrom,
  statusLine,
} from "./capture";

/** The context the SDK pushes; derived from the observable so it tracks the SDK's own type. */
type WebViewContext = Parameters<NonNullable<Parameters<typeof contextUpdates.subscribe>[0]>>[0];

/** The composer and single-conversation contexts this plugin runs in. */
type PluginContext = Extract<WebViewContext, { type: "messageComposer" | "singleConversation" }>;

interface FrontAppWindow extends Window {
  /** Settings arrive as URL query parameters; tests inject them here instead. */
  __OVERTURN_SETTINGS__?: Record<string, unknown>;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function readSettings(win: FrontAppWindow): FrontSettings {
  const query: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(location.search)) query[k] = v;
  return settingsFrom({ ...query, ...(win.__OVERTURN_SETTINGS__ ?? {}) });
}

function apiKey(win: FrontAppWindow): string {
  const injected = win.__OVERTURN_SETTINGS__?.overturn_api_key;
  if (typeof injected === "string") return injected;
  return new URLSearchParams(location.search).get("overturn_api_key") ?? "";
}

/** The thread the reviewer sees: messages (inbound/outbound) and internal comments, oldest first. */
async function readConversation(context: PluginContext): Promise<ConversationSnapshot> {
  const conv = context.conversation;
  const messages: ConversationSnapshot["messages"] = [];
  if ("listMessages" in context) {
    for (const m of (await context.listMessages()).results) {
      messages.push({
        id: m.id,
        body: m.content?.body ?? "",
        kind: m.status === "outbound" ? "outbound" : "inbound",
        authorName: m.from?.name ?? null,
        authorEmail: m.from?.handle ?? null,
        createdAt: m.date ? m.date.toISOString() : null,
      });
    }
  }
  if ("listComments" in context) {
    for (const c of (await context.listComments()).results) {
      messages.push({
        id: c.id,
        body: c.content.body,
        kind: "comment",
        authorName: c.author?.name ?? null,
        authorEmail: c.author?.email ?? null,
        createdAt: c.createdAt ? c.createdAt.toISOString() : null,
      });
    }
  }
  const fields: Record<string, unknown> = {};
  for (const attr of conv?.customFieldAttributes ?? []) fields[attr.name] = attr.value;
  return {
    id: conv?.id ?? (context.type === "messageComposer" ? context.draft.channel.id : "unknown"),
    subject: conv?.subject ?? null,
    messages,
    fields,
    url: conv ? `https://app.frontapp.com/open/${conv.id}` : null,
  };
}

async function main(): Promise<void> {
  const win = window as FrontAppWindow;
  const settings = readSettings(win);
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const root = document.getElementById("app")!;
  const status = el("div", { class: "status" }, "Waiting for a draft");
  let reasonCode: string | null = null;
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const chips: HTMLButtonElement[] = [];
  for (const q of quickReasons(settings)) {
    const b = el(
      "button",
      { type: "button", class: "chip", "data-code": q.code },
      q.label,
    ) as HTMLButtonElement;
    b.addEventListener("click", () => {
      reasonCode = reasonCode === q.code ? null : q.code;
      for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
    });
    chips.push(b);
    quick.appendChild(b);
  }
  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  }) as HTMLTextAreaElement;
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const capture = el("button", { type: "button", class: "primary" }, "Capture this send");
  const note = el("div", { class: "note" }, "");
  root.append(status, quick, reason, mark, capture, note);

  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  const render = (): void => {
    status.textContent = statusLine(detector.current(), lastResult);
  };

  // Front has no pre-send hook: the draft is read from the composer context, and the sent body
  // is the newest outbound message the teammate actually sent (never the text we last saw).
  let current: PluginContext | null = null;
  contextUpdates.subscribe((ctx) => {
    if (ctx.type !== "messageComposer" && ctx.type !== "singleConversation") return;
    current = ctx;
    if (ctx.type === "messageComposer" && detector.onComposer(ctx.draft.content.body, Date.now())) render();
  });

  mark.addEventListener("click", async () => {
    if (!current || !("fetchDraft" in current)) return;
    const draftId = current.conversation?.draftId;
    if (!draftId) return;
    const draft = await current.fetchDraft(draftId);
    if (!draft?.content.body.trim()) return;
    detector.set({ text: draft.content.body, origin: "manual", at: Date.now() });
    lastResult = null;
    render();
  });

  capture.addEventListener("click", async () => {
    if (!current) return;
    const conversation = await readConversation(current);
    const decision = decideOnSend({
      conversation,
      draft: detector.current(),
      draftFields: conversation.fields,
      send: {
        text: latestSentText(conversation),
        kind: current.type === "messageComposer" && current.conversation ? "message" : "comment",
        fields: conversation.fields,
      },
      reasonCode,
      reason: reason.value,
      actor: null,
      settings,
      now: Date.now(),
    });
    if (decision.action === "skip") {
      note.textContent = `Nothing to capture (${decision.why}).`;
      return;
    }
    if (decision.action === "need-reason") {
      chips[0]?.focus();
      const what = decision.changedFields.length ? decision.changedFields.join(", ") : "reply";
      note.textContent = `Pick why you changed the ${what} (one click).`;
      return;
    }
    try {
      const res = await fetch(`${settings.baseUrl}/v1/capture`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey(win)}` },
        body: JSON.stringify(decision.body),
      });
      const r = (await res.json()) as CaptureResult;
      lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
      note.textContent = r.changed && r.case ? `Case: ${r.case.title}` : "";
      reason.value = "";
      reasonCode = null;
      for (const c of chips) c.classList.remove("on");
      detector.set(null);
      render();
    } catch (e) {
      // Never block the reviewer's work on our failure; say so in the panel.
      note.textContent = `Overturn could not save this correction (${(e as { status?: number }).status ?? "network"}).`;
    }
  });

  render();
}

if (typeof document !== "undefined") {
  void main();
}
