import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { activeChat, useChatStore } from "../../src/stores/chat-store.js";
import { replyToToolApproval } from "../../src/lib/tool-approval.js";
import { googleApproval } from "../fixtures/google-approval.js";

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement;
let viewport: { width: number; height: number }, outer: { width: number; height: number }, previousTheme: string | undefined;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount()); root?.dispose(); host?.remove(); renderer = undefined; root = undefined; host = undefined;
  if (previousTheme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = previousTheme;
  await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width - 100, outer.height - 120);
});
for (const width of [320, 1280]) for (const theme of ["light", "dark"]) {
  test(`${theme} ${width}: Google send and modify in the chat timeline fit and settle`, async () => {
    viewport = { width: innerWidth, height: innerHeight }; previousTheme = document.documentElement.dataset.theme;
    outer = await commands.formViewport(width, 1100); await page.viewport(width, 1100); document.documentElement.dataset.theme = theme;
    const requests: string[] = [], sent: ClientMessage[] = [];
    root = createBrainUiRoot({ storage: null, request: async url => { requests.push(String(url)); throw new Error("No approval lookup"); } });
    root.stores.ui.getState().setSingleKeyShortcuts(true);
    root.stores.chat.getState().startAssistantMessage(null, "turn-ithaca");
    root.stores.chat.getState().requestToolApproval(null, "google-send", "brain_google_gmail_send", googleApproval("gmail.draft.send", true), undefined, "google");
    root.stores.chat.getState().requestToolApproval(null, "google-modify", "brain_google_gmail_modify", googleApproval(), undefined, "google");
    root.connection.send = frame => { sent.push(frame); return true; };
    const decide = (id: string, approved: boolean, always?: boolean, forSession?: boolean) => replyToToolApproval(root!, null, root!.connection.send, id, approved, always, forSession);
    function View() {
      const messages = useChatStore(s => activeChat(s).messages);
      return <div className="px-4 md:px-6"><div className="mx-auto max-w-3xl"><ToolCallTimeline live toolCalls={messages.flatMap(m => m.toolCalls)} onApproval={decide} /><textarea data-composer aria-label="Continue the chat" /></div></div>;
    }
    host = document.createElement("div"); host.style.cssText = `width:${width}px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`; document.body.append(host); renderer = createRoot(host);
    flushSync(() => renderer!.render(<BrainUiProvider root={root!}><View /></BrainUiProvider>));
    const cards = [...host.querySelectorAll<HTMLElement>("[data-google-mail-approval]")]; expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("penelope@ithaca.example"); expect(cards[0]!.querySelector("[data-google-taint-banner]")).not.toBeNull();
    expect(cards[1]!.textContent).toContain("Always allow"); expect(cards[1]!.querySelector("[data-google-taint-banner]")).toBeNull();
    expect(host.scrollWidth, "timeline has no horizontal overflow").toBeLessThanOrEqual(host.clientWidth + 1);
    for (const card of cards) expect(card.scrollWidth, "full card fits its timeline slot").toBeLessThanOrEqual(card.clientWidth + 1);
    await commands.formViewport(width, Math.ceil(host.scrollHeight) + 32); await page.viewport(width, Math.ceil(host.scrollHeight) + 32);
    await page.screenshot({ element: host, path: `../../.vitest-attachments/google-mail-approval/chat-${theme}-${width}.png` });
    const scopes = [...host.querySelectorAll<HTMLElement>("[data-approval-card]")];
    scopes[0]!.focus(); await userEvent.keyboard("a"); expect(sent).toEqual([]);
    await userEvent.click(page.getByRole("button", { name: "Send email, irreversible" }));
    await expect.poll(() => sent.length).toBe(1); expect(sent[0]).toEqual({ type: "tool_approval", toolUseId: "google-send", channel: "card" });
    await expect.poll(() => document.activeElement).toBe(scopes[1]);
    await userEvent.keyboard("d");
    await expect.poll(() => sent.length).toBe(2); expect(sent[1]).toEqual({ type: "tool_denial", toolUseId: "google-modify", channel: "card", message: "Denied by user" });
    expect(host.querySelectorAll("[data-google-mail-approval]")).toHaveLength(0); expect(requests).toEqual([]);
  });
}
