/// <reference types="@vitest/browser-playwright" />
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../../ui-react/src/styles.css";
import { TurnError } from "../../../ui-react/src/components/chat/turn-error.js";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../../ui-react/src/root.js";
import { useChatStore } from "../../../ui-react/src/stores/chat-store.js";
import type { ChatMessage } from "../../../ui-react/src/stores/chat-state.js";
import type { ServerMessage, SessionHistoryMessage, TurnFailure } from "../../../ui-sdk/src/protocol.js";
import { overflowing } from "../../stories/_stage.js";

const SESSION = "failure-observations";
const NOW = Date.UTC(2026, 3, 11, 12);
const ORIGINAL = "Plan Odysseus's journey to Ithaca.";
const EMPTY: ChatMessage[] = [];
let renderer: Root | undefined;
let host: HTMLElement | undefined;
let root: BrainUiRoot | undefined;
let socket: Socket;

/** Only the transport is scripted; frames use the real decoder, handlers and store. */
class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  sent: string[] = [];
  constructor() { Socket.instances.push(this); }
  send(raw: string) { this.sent.push(raw); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 } as CloseEvent); }
  deliver(frame: ServerMessage & { turnId?: string }) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
  frames() { return this.sent.map(raw => JSON.parse(raw)); }
}

function unmount() {
  renderer?.unmount(); host?.remove(); root?.dispose();
  renderer = undefined; host = undefined; root = undefined;
}

afterEach(() => {
  unmount(); Socket.instances.length = 0;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function Transcript() {
  const messages = useChatStore(state => state.buffers[SESSION]?.messages ?? EMPTY);
  return messages.filter(message => message.failure && !message.isStreaming).map(message =>
    createElement(TurnError, { key: message.id, message, latest: message === messages.at(-1) })
  );
}

function mount(width: number, theme: string, backend = "claude", now = NOW) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(now);
  vi.stubGlobal("WebSocket", Socket);
  document.documentElement.dataset.theme = theme;
  host = document.createElement("div"); host.style.width = `${width}px`; document.body.append(host);
  root = createBrainUiRoot({ storage: null, config: { backendUrl: "https://ithaca-harbour.example" } });
  root.connection.connect(); socket = Socket.instances.at(-1)!; socket.open();
  root.stores.chat.getState().setActiveSession(SESSION);
  root.stores.chat.getState().setSessionBackend(SESSION, backend);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(createElement(BrainUiProvider, {
    root, children: createElement(Transcript),
  })));
  return host;
}

function live(failure: TurnFailure, turnId = "failed-first") {
  const before = root!.stores.chat.getState().buffers[SESSION].messages.length;
  flushSync(() => {
    const chat = root!.stores.chat.getState();
    chat.addUserMessage(SESSION, ORIGINAL, "typed", [
      { previewUrl: "blob:ithaca-chart", mediaType: "image/png" },
      { previewUrl: "blob:journey-chart", mediaType: "image/png" },
    ]);
    // The composer opens an unowned bubble; this failure has no preceding delta.
    chat.startAssistantMessage(SESSION);
    socket.deliver({ type: "result", sessionId: SESSION, outcome: "error", isError: true,
      durationMs: 800, numTurns: 1, failure, retryOfTurnId: turnId });
    socket.deliver({ type: "status", sessionId: SESSION, status: "idle" });
  });
  expect(root!.stores.chat.getState().buffers[SESSION].messages).toHaveLength(before + 2);
}

function history(): SessionHistoryMessage[] {
  return root!.stores.chat.getState().buffers[SESSION].messages.map(message => ({
    role: message.role, content: message.content, toolCalls: [], parts: message.parts,
    ...(message.attachmentCount !== undefined ? { attachmentCount: message.attachmentCount } : {}),
    ...(message.failure ? { failure: message.failure, retryOfTurnId: message.retryOfTurnId } : {}),
  }));
}

function replay(messages = history()) {
  flushSync(() => {
    socket.deliver({ type: "session_history", sessionId: SESSION, messages });
    socket.deliver({ type: "status", sessionId: SESSION, status: "idle" });
  });
}

function advance(milliseconds: number) {
  flushSync(() => vi.advanceTimersByTime(milliseconds));
}

const cards = () => [...host!.querySelectorAll<HTMLElement>("[data-turn-failure]")];
const action = (card: HTMLElement, label: string) =>
  [...card.querySelectorAll<HTMLElement>('[role="button"], button')].find(node => node.textContent?.trim().startsWith(label));
const retryFrames = () => socket.frames().filter(frame => frame.type === "retry_turn");
const retryValue = (card: HTMLElement) => [...card.querySelectorAll(".bk-turn-error-facts span")]
  .find(node => node.textContent === "retries")?.nextElementSibling?.textContent;

for (const theme of ["dark", "light"]) for (const width of [320, 860]) {
  test(`${theme} ${width}: a retained failure card withdraws its replayed announcement`, async () => {
    await page.viewport(width, 1000); mount(width, theme);
    const failure = { errorClass: "rate_limit" as const, message: "Reported limit", attempts: 2 };
    flushSync(() => {
      const chat = root!.stores.chat.getState();
      chat.addUserMessage(SESSION, ORIGINAL); chat.startAssistantMessage(SESSION, "failed-first");
      chat.appendText(SESSION, "The crew prepared the wax.");
      for (const id of ["wax-a", "wax-c"]) {
        chat.startToolCall(SESSION, id, "Bash"); chat.setToolResult(SESSION, id, "Wax ready.", false);
      }
      socket.deliver({ type: "result", sessionId: SESSION, turnId: "failed-first", outcome: "error", isError: true,
        durationMs: 800, numTurns: 1, failure, retryOfTurnId: "failed-first" });
    });
    const card = cards()[0]!; expect(card.querySelector('[role="alert"]')).not.toBeNull();
    const old = root!.stores.chat.getState().buffers[SESSION].messages.at(-1)!;
    expect(old.toolCalls).toHaveLength(2);
    const tools = [old.toolCalls[0]!, { ...old.toolCalls[0]!, id: "wax-b" }];
    const saved = history(); saved[saved.length - 1] = { ...saved.at(-1)!, toolCalls: tools,
      turnId: "failed-first", parts: [{ kind: "text", text: old.content }, { kind: "tool", toolIndex: 0 }, { kind: "tool", toolIndex: 1 }] };
    replay(saved);
    expect(cards()[0], "replay keeps the original mounted failure card").toBe(card);
    expect(root!.stores.chat.getState().buffers[SESSION].messages.at(-1)!.failureLive, "the complementary merge marks this failure as replayed").toBe(false);
    expect(card.querySelector('[role="alert"]'), "a retained replayed card withdraws its live announcement").toBeNull();
  });

  test(`${theme} ${width}: observed retries agree live and replay; unknown values stay absent`, async () => {
    await page.viewport(width, 1000);
    mount(width, theme);
    const failure = { errorClass: "rate_limit", status: 429, message: "Reported limit", attempts: 2, resetsAt: NOW + 40_000 };
    live(failure);
    expect(root!.stores.chat.getState().buffers[SESSION].messages.at(-1)!.failure).toEqual(failure);
    expect(retryValue(cards()[0]), "observed retry count is displayed without adding an initial call").toBe("2");
    replay();
    expect(retryValue(cards()[0])).toBe("2");
    expect(host!.querySelector('[role="alert"]')).toBeNull();
    replay([{ role: "assistant", content: "", toolCalls: [], retryOfTurnId: "unknown-turn",
      failure: { errorClass: "unknown", message: "No observations" } }]);
    expect(retryValue(cards()[0]), "unknown retry observations are omitted").toBeUndefined();
    expect(action(cards()[0], "Retry")?.textContent?.trim()).toBe("Retry");
    expect(action(cards()[0], "Retry")?.getAttribute("aria-disabled")).not.toBe("true");
  });

  test(`${theme} ${width}: future reset gates Retry and expires in place without new alerts`, async () => {
    await page.viewport(width, 1000);
    const el = mount(width, theme);
    live({ errorClass: "rate_limit", status: 429, message: "Reported limit", attempts: 2, resetsAt: NOW + 3250 });
    const card = cards()[0];
    expect(action(card, "Retry")?.getAttribute("aria-disabled"), "future reset disables Retry").toBe("true");
    expect(action(card, "Retry")?.textContent?.trim()).toBe("Retry · in 4s");
    await userEvent.click(action(card, "Retry")!, { force: true });
    expect(retryFrames()).toHaveLength(0);
    const announcement = el.querySelector('[role="alert"]');
    expect(announcement).not.toBeNull();
    const announced = announcement!.textContent;
    advance(1000);
    expect(action(card, "Retry")?.textContent?.trim()).toBe("Retry · in 3s");
    expect(el.querySelector('[role="alert"]')).toBe(announcement);
    expect(announcement!.textContent).toBe(announced);
    await page.screenshot({ element: el, path: `../../.vitest-attachments/failure-observations/waiting-${width}-${theme}.png` });
    advance(2249);
    expect(action(card, "Retry")?.getAttribute("aria-disabled")).toBe("true");
    advance(1);
    expect(cards()[0], "expiry does not remount the failure card").toBe(card);
    expect(action(card, "Retry")?.textContent?.trim()).toBe("Retry");
    expect(action(card, "Retry")?.getAttribute("aria-disabled")).not.toBe("true");
    expect(el.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(announcement!.textContent).toBe(announced);
    expect(overflowing(el).filter(line => !line.includes("bk-sr"))).toEqual([]);
    for (const button of card.querySelectorAll<HTMLElement>('[role="button"]')) expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ element: el, path: `../../.vitest-attachments/failure-observations/ready-${width}-${theme}.png` });
    await userEvent.click(action(card, "Retry")!);
    expect(retryFrames()).toHaveLength(1);
    expect(retryFrames()[0].failedTurnId).toBe("failed-first");
    await userEvent.click(action(card, "Retry")!, { force: true });
    expect(retryFrames()).toHaveLength(1);
    flushSync(() => socket.deliver({ type: "retry_receipt", sessionId: SESSION, requestId: retryFrames()[0].requestId,
      state: "accepted", text: ORIGINAL, attachmentCount: 2 }));
    const messages = root!.stores.chat.getState().buffers[SESSION].messages;
    expect(messages.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages[2]).toMatchObject({ content: ORIGINAL, attachmentCount: 2 });
    expect(messages[3].isStreaming).toBe(true);
    expect(action(cards()[0], "Retry")).toBeUndefined();
  });

  test(`${theme} ${width}: replay retains the absolute reset rather than restarting or erasing it`, async () => {
    await page.viewport(width, 1000);
    mount(width, theme);
    const resetsAt = NOW + 3250;
    live({ errorClass: "rate_limit", message: "Reported limit", attempts: 2, resetsAt });
    const saved = history();
    advance(1000);
    const firstSocket = socket;
    socket.close(); root!.connection.reconnectNow();
    socket = Socket.instances.at(-1)!;
    expect(socket, "reconnect uses a new transport").not.toBe(firstSocket);
    socket.open();
    replay(saved);
    const last = root!.stores.chat.getState().buffers[SESSION].messages.at(-1)!;
    expect(last.failure?.resetsAt, "replay preserves the reported reset timestamp").toBe(resetsAt);
    expect(action(cards()[0], "Retry")?.getAttribute("aria-disabled"), "replayed future reset disables Retry").toBe("true");
    expect(action(cards()[0], "Retry")?.textContent?.trim()).toBe("Retry · in 3s");
    expect(host!.querySelector('[role="alert"]')).toBeNull();
    const previousRoot = root;
    unmount(); mount(width, theme, "claude", Date.now()); replay(saved);
    expect(root, "reload creates a new UI root").not.toBe(previousRoot);
    expect(Date.now(), "reload preserves elapsed wall-clock time").toBe(NOW + 1000);
    expect(root!.stores.chat.getState().buffers[SESSION].messages.at(-1)!.failure?.resetsAt).toBe(resetsAt);
    expect(action(cards()[0], "Retry")?.textContent?.trim()).toBe("Retry · in 3s");
    expect(action(cards()[0], "Retry")?.getAttribute("aria-disabled")).toBe("true");
    expect(host!.querySelector('[role="alert"]')).toBeNull();
    advance(2249);
    expect(action(cards()[0], "Retry")?.getAttribute("aria-disabled")).toBe("true");
    advance(1);
    expect(action(cards()[0], "Retry")?.textContent?.trim()).toBe("Retry");
    expect(action(cards()[0], "Retry")?.getAttribute("aria-disabled")).not.toBe("true");
    replay(saved);
    expect(action(cards()[0], "Retry")?.textContent?.trim()).toBe("Retry");
    expect(action(cards()[0], "Retry")?.getAttribute("aria-disabled")).not.toBe("true");
  });

  test(`${theme} ${width}: multiple failures retain their observations after a later success`, async () => {
    await page.viewport(width, 1000);
    mount(width, theme);
    live({ errorClass: "server_error", message: "First failure", attempts: 2, resetsAt: NOW + 20_000 });
    live({ errorClass: "overloaded", message: "Second failure", attempts: 4, resetsAt: NOW + 5000 }, "failed-second");
    replay();
    expect(cards()).toHaveLength(2);
    expect(cards().map(retryValue)).toEqual(["2", "4"]);
    expect(action(cards()[0], "Retry")).toBeUndefined();
    expect(action(cards()[1], "Retry")?.textContent?.trim()).toBe("Retry · in 5s");
    flushSync(() => {
      const chat = root!.stores.chat.getState();
      chat.addUserMessage(SESSION, "Continue the journey.");
      chat.startAssistantMessage(SESSION, "later-success");
      socket.deliver({ type: "text_delta", sessionId: SESSION, turnId: "later-success", text: "Journey planned." });
      socket.deliver({ type: "result", sessionId: SESSION, outcome: "success", isError: false, durationMs: 800, numTurns: 1 });
    });
    expect(root!.stores.chat.getState().buffers[SESSION].messages.at(-1)).toMatchObject({
      role: "assistant", content: "Journey planned.", isStreaming: false,
    });
    expect(root!.stores.chat.getState().buffers[SESSION].messages.at(-1)!.failure).toBeUndefined();
    advance(20_000);
    expect(cards().map(retryValue)).toEqual(["2", "4"]);
    for (const card of cards()) expect(action(card, "Retry")).toBeUndefined();
  });

  test(`${theme} ${width}: expiry preserves pending and uncertain delivery reconciliation`, async () => {
    await page.viewport(width, 1000);
    mount(width, theme);
    live({ errorClass: "rate_limit", message: "Reported limit", resetsAt: NOW + 2000 });
    const pending = { failedTurnId: "failed-first", requestId: "pending-retry", state: "waiting" as const };
    flushSync(() => root!.stores.chat.getState().setTurnRetry(SESSION, pending));
    advance(2000);
    expect(action(cards()[0], "Retrying")?.getAttribute("aria-disabled")).toBe("true");
    expect(retryFrames()).toHaveLength(0);
    flushSync(() => socket.deliver({ type: "retry_receipt", sessionId: SESSION, requestId: pending.requestId, state: "unknown" }));
    expect(action(cards()[0], "Check delivery")).toBeDefined();
    await userEvent.click(action(cards()[0], "Check delivery")!);
    expect(socket.frames().filter(frame => frame.type === "retry_status")).toEqual([
      { type: "retry_status", sessionId: SESSION, requestId: pending.requestId },
    ]);
    expect(retryFrames()).toHaveLength(0);
    flushSync(() => socket.deliver({ type: "retry_receipt", sessionId: SESSION, requestId: pending.requestId, state: "refused", message: "Retry was not delivered." }));
    expect(action(cards()[0], "Retry")?.getAttribute("aria-disabled")).not.toBe("true");
    await userEvent.click(action(cards()[0], "Retry")!);
    expect(retryFrames()).toHaveLength(1);
  });

  test(`${theme} ${width}: future resets keep delivery checks available without sending a retry`, async () => {
    await page.viewport(width, 1000);
    mount(width, theme);
    live({ errorClass: "rate_limit", message: "Reported limit", resetsAt: NOW + 5000 });
    const pending = { failedTurnId: "failed-first", requestId: "uncertain-retry", state: "unknown" as const };
    flushSync(() => root!.stores.chat.getState().setTurnRetry(SESSION, pending));
    expect(Date.now()).toBeLessThan(root!.stores.chat.getState().buffers[SESSION].messages.at(-1)!.failure!.resetsAt!);
    expect(action(cards()[0], "Check delivery")?.getAttribute("aria-disabled")).not.toBe("true");
    await userEvent.click(action(cards()[0], "Check delivery")!);
    expect(socket.frames().filter(frame => frame.type === "retry_status")).toEqual([
      { type: "retry_status", sessionId: SESSION, requestId: pending.requestId },
    ]);
    expect(retryFrames()).toHaveLength(0);
    advance(5000);
    expect(action(cards()[0], "Check delivery")?.getAttribute("aria-disabled")).not.toBe("true");
    expect(root!.stores.chat.getState().turnRetries[SESSION]).toEqual(pending);
    expect(retryFrames()).toHaveLength(0);
  });

  test(`${theme} ${width}: pi observations with no reset and expired resets add no wait`, async () => {
    await page.viewport(width, 1000);
    mount(width, theme, "pi");
    live({ errorClass: "server_error", message: "Reported retries", attempts: 2 });
    expect(retryValue(cards()[0])).toBe("2");
    expect(action(cards()[0], "Retry")?.textContent?.trim()).toBe("Retry");
    replay([{ role: "assistant", content: "", toolCalls: [], retryOfTurnId: "past-turn",
      failure: { errorClass: "rate_limit", message: "Expired reset", resetsAt: NOW - 1 } }]);
    expect(retryValue(cards()[0])).toBeUndefined();
    expect(action(cards()[0], "Retry")?.textContent?.trim()).toBe("Retry");
    expect(action(cards()[0], "Retry")?.getAttribute("aria-disabled")).not.toBe("true");
  });
}
