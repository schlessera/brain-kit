import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";

/**
 * Pending follow-ups in the real ChatPage (#1002): a message sent while the
 * session is busy waits as a pill in the right half above the composer, not in
 * the transcript; a reload rebuilds the pill from the host's report; and when
 * the agent takes it, the pill goes and the message enters the chat once.
 * Only the transport is a fixture: the host's frames are delivered over it.
 */
class FixtureSocket {
  static last: FixtureSocket | undefined;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  sent: string[] = [];
  constructor() { FixtureSocket.last = this; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(frame: unknown) { flushSync(() => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)); }
  frames(type: string) { return this.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === type); }
}

let renderer: Root | undefined;
let ui: BrainUiRoot | undefined;
let host: HTMLDivElement | undefined;
let style: HTMLStyleElement | undefined;
let outerBefore: { width: number; height: number } | undefined;
let frameBefore: { width: number; height: number } | undefined;

beforeEach(() => {
  vi.stubGlobal("WebSocket", FixtureSocket);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [], drafts: [],
  })));
});

afterEach(async () => {
  unmount();
  style?.remove();
  style = undefined;
  vi.unstubAllGlobals();
  if (frameBefore) await page.viewport(frameBefore.width, frameBefore.height);
  if (outerBefore) await commands.formViewport(outerBefore.width - 100, outerBefore.height - 120);
});

function unmount() {
  if (renderer) flushSync(() => renderer!.unmount());
  ui?.dispose();
  host?.remove();
  renderer = undefined;
  ui = undefined;
  host = undefined;
}

const S = "sess-ithaca";
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Open the app on a session whose answer is still streaming. */
async function open(width: number, height: number, theme: string) {
  if (!frameBefore) {
    frameBefore = { width: window.innerWidth, height: window.innerHeight };
    outerBefore = await commands.formViewport(width, height);
  } else await commands.formViewport(width, height);
  await page.viewport(width, height);
  document.documentElement.dataset.theme = theme;
  if (!style) {
    style = document.createElement("style");
    style.textContent = await commands.formConsumerStyles();
    document.head.append(style);
  }
  host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;display:flex;flex-direction:column;width:${width}px;height:${height}px`;
  document.body.append(host);
  ui = createBrainUiRoot({ storage: null });
  ui.stores.chat.getState().setActiveSession(S);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={ui}><ChatPage /></BrainUiProvider>));
  ui.connection.connect();
  const socket = FixtureSocket.last!;
  flushSync(() => socket.open());
  socket.deliver({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true, followUpQueue: true } });
  socket.deliver({ type: "session_info", sessionId: S, isNew: false });
  socket.deliver({ type: "session_history", sessionId: S, messages: [{ role: "user", content: "Chart the way home to Ithaca", toolCalls: [] }] });
  socket.deliver({ type: "status", sessionId: S, status: "thinking", turnId: "turn-1" });
  socket.deliver({ type: "text_delta", sessionId: S, turnId: "turn-1", text: "Plotting the course past the Sirens" });
  await nextFrame();
  return socket;
}

const right = () => host!.querySelector<HTMLElement>('[data-row-half="right"]')!;
const left = () => host!.querySelector<HTMLElement>('[data-row-half="left"]')!;
const pills = () => [...host!.querySelectorAll<HTMLElement>('[data-pending-follow-ups] [data-pill][role="button"]')];
const transcript = () => host!.querySelector<HTMLElement>("[data-reading-column]") ?? host!;
const composer = () => host!.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;

async function send(socket: FixtureSocket, text: string) {
  await userEvent.click(composer());
  await userEvent.fill(composer(), text);
  await userEvent.keyboard("{Enter}");
  await nextFrame();
  return socket.frames("chat_message").at(-1)!;
}

for (const [width, height] of [[320, 640], [1280, 800]] as const) {
  for (const theme of ["dark", "light"]) {
    test(`${width}, ${theme}: two follow-ups wait as pills, survive a reload, and each enters the chat once`, async () => {
      let socket = await open(width, height, theme);
      const first = await send(socket, "Ask Aeolus about the west wind");
      expect(first.requestId, "the composer correlates its send").toBeTruthy();
      expect(pills(), "shown at once, before the host answers").toHaveLength(1);
      socket.deliver({ type: "status", sessionId: S, status: "queued", requestId: first.requestId });
      const winds = { id: "fu-winds", requestId: first.requestId, text: first.text, queuedAt: 1 };
      socket.deliver({ type: "session_queue", sessionId: S, followUps: [winds] });
      const second = await send(socket, "Keep the bag of winds shut until we sight Ithaca");
      socket.deliver({ type: "status", sessionId: S, status: "queued", requestId: second.requestId });
      const bag = { id: "fu-bag", requestId: second.requestId, text: second.text, queuedAt: 2 };
      socket.deliver({ type: "session_queue", sessionId: S, followUps: [winds, bag] });
      await nextFrame();

      // Two pills in the right half, oldest on top; neither is in the chat.
      expect(pills().map((p) => p.getAttribute("aria-label"))).toEqual([
        "Pending follow-up 1 of 2: Ask Aeolus about the west…. Not yet received by the agent.",
        "Pending follow-up 2 of 2: Keep the bag of winds…. Not yet received by the agent.",
      ]);
      const half = right().getBoundingClientRect();
      for (const pill of pills()) {
        const r = pill.getBoundingClientRect();
        expect(r.height).toBe(44);
        expect(r.left).toBeGreaterThanOrEqual(half.left);
        expect(r.right).toBeLessThanOrEqual(half.right + 0.5);
      }
      expect(half.left - left().getBoundingClientRect().right, "gutter").toBeGreaterThanOrEqual(8);
      expect(pills()[0]!.getBoundingClientRect().bottom, "the row sits on the composer").toBeLessThanOrEqual(composer().getBoundingClientRect().top);
      expect(transcript().textContent).not.toContain("Ask Aeolus");
      expect(composer().value, "the accepted draft is cleared").toBe("");

      // Reload: a new app on the same host, which re-reports the queue.
      unmount();
      socket = await open(width, height, theme);
      expect(pills(), "nothing is guessed before the host reports").toHaveLength(0);
      socket.deliver({ type: "session_queue", sessionId: S, followUps: [winds, bag] });
      await nextFrame();
      expect(pills()).toHaveLength(2);
      expect(transcript().textContent).not.toContain("Ask Aeolus");

      // Hovering a pill shows its full text above it, inside the right half.
      await userEvent.hover(pills()[1]!);
      const full = host!.querySelector<HTMLElement>("[data-follow-up-text]:not([hidden])")!;
      expect(full.textContent).toBe(bag.text);
      const box = full.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(right().getBoundingClientRect().left - 0.5);
      expect(box.bottom).toBeLessThanOrEqual(pills()[1]!.getBoundingClientRect().top);
      await userEvent.unhover(pills()[1]!);

      // The agent takes the first: its pill goes and it enters the chat once.
      socket.deliver({ type: "result", sessionId: S, turnId: "turn-1", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
      socket.deliver({ type: "session_queue", sessionId: S, followUps: [bag], started: { ...winds, turnId: "turn-2" } });
      socket.deliver({ type: "session_info", sessionId: S, isNew: false, turnId: "turn-2", requestId: first.requestId });
      socket.deliver({ type: "text_delta", sessionId: S, turnId: "turn-2", text: "The west wind holds" });
      await nextFrame();
      expect(pills()).toHaveLength(1);
      const text = transcript().textContent!;
      expect(text.split("Ask Aeolus about the west wind").length - 1, "exactly once").toBe(1);
      expect(text.indexOf("Plotting the course"), "after the turn it waited for").toBeLessThan(text.indexOf("Ask Aeolus"));
      expect(document.querySelector("[data-pending-live]")!.textContent).toBe("Follow-up sent to the agent");

      // Then the second.
      socket.deliver({ type: "result", sessionId: S, turnId: "turn-2", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
      socket.deliver({ type: "session_queue", sessionId: S, followUps: [], started: { ...bag, turnId: "turn-3" } });
      await nextFrame();
      expect(pills()).toHaveLength(0);
      expect(host!.querySelector<HTMLElement>("[data-composer-row]")!.getBoundingClientRect().height, "the empty row is absent").toBe(0);
      expect(transcript().textContent!.split("Keep the bag of winds shut").length - 1).toBe(1);
    });
  }
}
