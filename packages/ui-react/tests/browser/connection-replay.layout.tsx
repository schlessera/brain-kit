import { expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork } from "./offline/fault-network.ts";

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
for (const theme of ["dark", "light"] as const) for (const width of [320, 1280]) {
  test(`${theme} ${width}: an early replay chunk never unmounts the drawn suffix`, async (ctx) => {
    const before = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme };
    const outer = await commands.formViewport(width, 800);
    await page.viewport(width, 800);
    document.documentElement.dataset.theme = theme;
    const net = installFaultNetwork({ routes: () => Response.json({ entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [] }) });
    const ui = createBrainUiRoot({ storage: null, request: net.request });
    const style = document.createElement("style");
    style.textContent = await commands.formConsumerStyles();
    document.head.append(style);
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
    document.body.append(host);
    const renderer = createRoot(host);
    ctx.onTestFinished(async () => {
      flushSync(() => renderer.unmount());
      ui.dispose(); net.restore(); host.remove(); style.remove();
      document.documentElement.dataset.theme = before.theme;
      await page.viewport(before.width, before.height);
      await commands.formViewport(outer.width - 100, outer.height - 120);
    });
    ui.connection.connect();
    await expect.poll(() => net.socket()?.readyState).toBe(1);
    const messages = Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, content: `Odysseus's voyage note ${i + 1}: remember the harbour and the crossing.`, toolCalls: [] }));
    ui.stores.chat.getState().setActiveSession("ithaca");
    net.socket()!.deliver({ type: "session_history", sessionId: "ithaca", messages });
    net.socket()!.deliver({ type: "status", sessionId: "ithaca", status: "idle" });
    flushSync(() => renderer.render(<BrainUiProvider root={ui}><ChatPage /></BrainUiProvider>));
    await new Promise((done) => setTimeout(done, 500));
    await frame();
    const column = host.querySelector<HTMLElement>("[data-reading-column]")!;
    const scroller = column.parentElement!;
    scroller.scrollTop = 500;
    scroller.dispatchEvent(new Event("scroll"));
    const field = host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
    field.focus();
    await frame();
    const nodes = [...column.children];
    expect(nodes.length, "nonempty transcript with a suffix to protect").toBe(30);
    expect(scroller.scrollHeight - scroller.clientHeight).toBeGreaterThan(500);
    const first = nodes.find((node) => node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top)!;
    const baseline = { scroll: scroller.scrollTop, first: first.getBoundingClientRect().top, field: field.getBoundingClientRect().top };
    let removed = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.removedNodes) if (nodes.includes(node as Element)) removed++;
    });
    observer.observe(column, { childList: true });
    ctx.onTestFinished(() => observer.disconnect());
    const same = () => {
      expect(removed, "no message was removed even briefly").toBe(0);
      expect(nodes.every((node) => node.isConnected), "all drawn nodes stay mounted between chunks").toBe(true);
      expect(scroller.scrollTop, "scroll stays between chunks").toBe(baseline.scroll);
      expect(Math.abs(first.getBoundingClientRect().top - baseline.first)).toBeLessThanOrEqual(1);
      expect(Math.abs(field.getBoundingClientRect().top - baseline.field)).toBeLessThanOrEqual(1);
      expect(document.activeElement).toBe(field);
    };
    const sentBefore = net.frames.length;
    net.drop({ announce: true });
    await frame();
    same();
    net.recover();
    ui.connection.reconnectNow();
    await expect.poll(() => net.socket()?.readyState).toBe(1);
    // Yield a painted frame between chunks, as separate WS tasks can do.
    net.socket()!.deliver({ type: "session_history", sessionId: "ithaca", messages: messages.slice(0, 3) });
    await frame();
    same();
    net.socket()!.deliver({ type: "session_history", sessionId: "ithaca", append: true, messages: messages.slice(3) });
    net.socket()!.deliver({ type: "status", sessionId: "ithaca", status: "idle" });
    await frame();
    same();
    expect(net.frames.slice(sentBefore).filter((f) => JSON.parse(String(f.data)).type === "chat_message")).toEqual([]);
  });
}
