import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { activeChat } from "../../src/stores/chat-store.js";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";

class FixtureSocket {
  readyState = 0;
  onopen = null; onmessage = null; onclose = null; onerror = null;
  send() {} close() { this.readyState = 3; }
}
let root: BrainUiRoot | undefined, renderer: Root | undefined, host: HTMLDivElement | undefined;
let styles: HTMLStyleElement, viewport: { width: number; height: number }, outer: { width: number; height: number };
const frames: ClientMessage[] = [];
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
beforeAll(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles);
});
afterAll(() => styles.remove());
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount()); root?.dispose(); host?.remove();
  renderer = undefined; root = undefined; host = undefined; frames.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.documentElement.dataset.theme = "dark"; await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});
async function mount(width: number, theme: string) {
  vi.stubGlobal("WebSocket", FixtureSocket);
  outer = await commands.formViewport(width, 1000); await page.viewport(width, 1000);
  document.documentElement.dataset.theme = theme;
  const clockStart = performance.now();
  vi.spyOn(Date, "now").mockImplementation(() => Date.UTC(2026, 6, 12, 6, 12) + Math.floor(performance.now() - clockStart));
  root = createBrainUiRoot({ storage: null, request: async url => {
    if (String(url).endsWith("/sessions")) return Response.json({ sessions: [] });
    return new Response("{}", { status: 404 });
  } });
  root.stores.ui.getState().setTheme(theme as "dark" | "light");
  const chat = root.stores.chat.getState(); chat.setActiveSession("crossing-a");
  chat.addUserMessage("crossing-a", "Which passage should we take?", "typed");
  chat.startAssistantMessage("crossing-a", "turn-a");
  vi.spyOn(root.connection, "send").mockImplementation(msg => { frames.push(msg); return true; });
  host = document.createElement("div"); host.style.cssText = `width:${width}px;height:1000px;display:flex;background:var(--bk-color-canvas)`;
  document.body.append(host); renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={root!}><ChatPage/></BrainUiProvider>));
  await document.fonts.ready; await settle(); await settle();
  flushSync(() => root!.stores.connection.setState({ wsStatus: "connected" }));
  await expect.poll(() => host!.querySelectorAll('[data-kit-streaming-answer]').length).toBe(1);
}
for (const width of [320,1280]) for (const theme of ["dark","light"]) {
  test(`${theme} ${width}: actual chat waiting, approval, retry and scoped Stop keep one status and rich groups`, async () => {
    await mount(width, theme); const chat = root!.stores.chat.getState();
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const row = () => host!.querySelector<HTMLElement>('[data-kit-streaming-answer]');
    const stops = () => host!.querySelectorAll('[role="button"][aria-label="Stop generating"],button[aria-label="Stop generating"]');
    expect(row()!.querySelector('[aria-live="polite"]')!.textContent).toBe("thinking");
    expect(row()!.querySelectorAll('.bk-ghost')).toHaveLength(2);
    expect(row()!.querySelectorAll('button,[role="button"]')).toHaveLength(0);
    expect(row()!.textContent).not.toContain("$"); expect(stops()).toHaveLength(1);
    for (const ghost of row()!.querySelectorAll<HTMLElement>('.bk-ghost')) expect(getComputedStyle(ghost).animationName).toBe("none");
    const track = row()!.querySelector<HTMLElement>('.bk-ghost-track'); if (track) expect(getComputedStyle(track).display).toBe("none");
    await page.screenshot({ element: host!, path: `../../.vitest-attachments/turn-status/${theme}-${width}-waiting.png` });
    flushSync(() => chat.appendThinking("crossing-a", "Compare what Circe said about each passage."));
    await expect.poll(() => row()).toBeNull(); expect(host!.textContent).toContain("Compare what Circe said");
    flushSync(() => { chat.appendText("crossing-a", "Circe names **Scylla**."); chat.startToolCall("crossing-a", "tool-read", "Read"); });
    expect(host!.querySelector('strong')!.textContent).toBe("Scylla"); expect(row()).toBeNull(); expect(stops()).toHaveLength(1);
    const tool = "Write-" + "crossing-directions-".repeat(8);
    flushSync(() => chat.requestToolApproval("crossing-a", "tool-write", tool, { file_path: "voyage/crossing.md", content: "Keep the oars clear." }));
    await expect.poll(() => row() !== null).toBe(true);
    expect(row()!.textContent).toContain("waiting for approval"); expect(row()!.textContent).toContain(tool);
    expect(row()!.querySelectorAll('.bk-ghost')).toHaveLength(0);
    const dot = row()!.firstElementChild!.firstElementChild as HTMLElement;
    expect(getComputedStyle(dot).animationName).toBe("none");
    const target = row()!.children[1] as HTMLElement;
    expect(target.scrollWidth).toBeLessThanOrEqual(target.clientWidth + 1);
    expect(getComputedStyle(target).textOverflow).not.toBe("ellipsis");
    const approval = host!.querySelector('[data-approval-card]')!;
    await expect.poll(() => row()!.getBoundingClientRect().top - approval.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(0);
    expect(stops()).toHaveLength(1);
    const live = row()!.querySelector('[aria-live="polite"]')!;
    const announcements: string[] = [];
    const observer = new MutationObserver(() => announcements.push(live.textContent!));
    observer.observe(live, { subtree: true, childList: true, characterData: true });
    try {
      const elapsed = row()!.querySelector('[data-stream-elapsed]')!.textContent;
      await expect.poll(() => row()!.querySelector('[data-stream-elapsed]')!.textContent, { timeout: 2200 }).not.toBe(elapsed);
      expect(announcements).toEqual([]);
      flushSync(() => chat.setRetry("crossing-a", { attempt: 2, maxAttempts: 5, delayMs: 8000, errorClass: "overloaded", status: 503 }));
      await settle(); expect(announcements).toEqual(["retrying"]);
      expect(row()!.textContent).toContain("Retrying (attempt 2 of 5) in 8s after overloaded, HTTP 503");
      expect(stops()).toHaveLength(1);
      await page.screenshot({ element: host!, path: `../../.vitest-attachments/turn-status/${theme}-${width}-retry.png` });
      flushSync(() => chat.setActiveSession("crossing-b")); await expect.poll(() => row()).toBeNull();
      expect(stops()).toHaveLength(0);
      flushSync(() => chat.setActiveSession("crossing-a")); await expect.poll(() => row() !== null).toBe(true);
      expect(announcements).toEqual(["retrying"]); expect(row()!.textContent).toContain("retrying"); expect(stops()).toHaveLength(1);
      await userEvent.click(stops()[0] as HTMLElement);
      expect(frames.filter(frame => frame.type === "cancel")).toEqual([{ type: "cancel", sessionId: "crossing-a" }]);
      flushSync(() => root!.connection.handleServerMessage({ type: "result", sessionId: "crossing-a", isError: false, outcome: "cancelled", costUsd: 0, durationMs: 1000, numTurns: 1 }));
      await expect.poll(() => row()).toBeNull(); expect(stops()).toHaveLength(0);
      expect(activeChat(root!.stores.chat.getState()).messages.at(-1)!.isStreaming).toBe(false);
      expect(host!.querySelector('strong')!.textContent).toBe("Scylla");
    } finally { observer.disconnect(); }
  });
}
