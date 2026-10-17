import { expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork } from "./offline/fault-network.ts";

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
// These roots have no local-work restore and never open a tracked session.
// The three preparation operations commit synchronously; only their finite
// rendering remains. Motion's JS height animation is not a native Animation.
async function replayCardReady(host: HTMLElement, phase: "summary" | "header" | "expanded") {
  await document.fonts.ready;
  await expect.poll(async () => {
    await frame();
    // Resolve again on every painted sample, including after cancellation or
    // replacement. No rejected Animation.finished promise is swallowed.
    const column = host.querySelector("[data-reading-column]");
    const messages = [...(column?.children ?? [])] as HTMLElement[];
    const header = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("check rope"));
    const detail = header?.parentElement?.querySelector<HTMLElement>(".whitespace-pre-wrap");
    const expansion = detail?.closest<HTMLElement>(".overflow-hidden");
    const visible = (el: HTMLElement | undefined | null) => !!el?.isConnected
      && el.getClientRects().length > 0 && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0
      && getComputedStyle(el).visibility === "visible";
    const summary = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => /^\d+ steps?/.test(b.textContent ?? ""));
    const finite = host.getAnimations({ subtree: true }).filter(a =>
      a.effect?.getComputedTiming().endTime !== Infinity && (a.pending || a.playState === "running" || a.playState === "paused"));
    return {
      transcript: messages.length === 2 && messages.every(message => {
        const style = getComputedStyle(message);
        return style.opacity === "1" && new DOMMatrixReadOnly(style.transform).isIdentity;
      }),
      target: phase === "summary" ? visible(summary) : visible(header),
      expanded: phase !== "expanded" || (visible(detail) && expansion?.style.height === "auto"
        && getComputedStyle(expansion).opacity === "1"),
      finiteAnimations: finite.length,
    };
  }, { interval: 16, timeout: 2_000, message: `replay ${phase}: committed card and finite rendering` })
    .toEqual({ transcript: true, target: true, expanded: true, finiteAnimations: 0 });
}

// Recovery geometry is relative to the drawn baseline, not a theme-size
// comparison. Keep both native widths; consumer composer parity lives in
// Storybook. See docs/process/theme-parity.md for the assertion ownership map.
for (const { theme, width } of [{ theme: "dark", width: 320 }, { theme: "light", width: 1280 }] as const) {
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

// Keep both themes here: no central story proves this consumer's expanded
// tool input and finished-summary/live timeline with the shipped stylesheet.
// A kit-only disclosure story does not cover that presentation boundary.
for (const finished of [false, true]) for (const splitRun of [false, true]) for (const theme of ["dark", "light"] as const) for (const width of [320, 1280]) {
  test(`${theme} ${width} ${finished ? "finished" : "live"}: recovery ${splitRun ? "splits a drawn tool run" : "splits text"} without remounting an expanded live card`, async (ctx) => {
    const before = { width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme };
    const cleanup: Array<() => unknown | Promise<unknown>> = [];
    ctx.onTestFinished(async () => {
      const failures: unknown[] = [];
      for (const clean of [...cleanup].reverse()) {
        try { await clean(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "replay fixture cleanup failed");
    });
    let outer: { width: number; height: number } | undefined;
    cleanup.push(async () => {
      try { await page.viewport(before.width, before.height); }
      finally { if (outer) await commands.formViewport(outer.width - 100, outer.height - 120); }
    });
    cleanup.push(() => { if (before.theme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = before.theme; });
    outer = await commands.formViewport(width, 800);
    await page.viewport(width, 800);
    document.documentElement.dataset.theme = theme;
    const net = installFaultNetwork({ routes: () => Response.json({ entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [] }) });
    cleanup.push(() => net.restore());
    const ui = createBrainUiRoot({ storage: null, request: net.request });
    cleanup.push(() => ui.dispose());
    const style = document.createElement("style"); cleanup.push(() => style.remove());
    style.textContent = await commands.formConsumerStyles(); document.head.append(style);
    const host = document.createElement("div"); cleanup.push(() => host.remove());
    host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column"; document.body.append(host);
    const renderer = createRoot(host); cleanup.push(() => flushSync(() => renderer.unmount()));
    ui.connection.connect(); await expect.poll(() => net.socket()?.readyState).toBe(1);
    const chat = ui.stores.chat.getState(); chat.setActiveSession("ithaca");
    const user = { role: "user", content: "Hold: Sail past the Sirens", toolCalls: [] };
    net.socket()!.deliver({ type: "session_history", sessionId: "ithaca", messages: [user] });
    const opening = "Setting out: Sail past the Sirens.";
    const middle = " The crew rowed past Scylla.";
    chat.startAssistantMessage("ithaca", "turn-1"); chat.appendText("ithaca", opening + (splitRun ? "" : middle));
    if (splitRun) {
      chat.startToolCall("ithaca", "wax-b", "Bash"); chat.completeToolCall("ithaca", "wax-b", "Bash", { command: "check wax" });
    }
    chat.startToolCall("ithaca", "rope-c", "Bash"); chat.completeToolCall("ithaca", "rope-c", "Bash", { command: "check rope" });
    chat.appendText("ithaca", finished ? " Rope held." : " Rope held. Live oars.");
    if (finished) chat.finishAssistantMessage("ithaca");
    flushSync(() => renderer.render(<BrainUiProvider root={ui}><ChatPage /></BrainUiProvider>));
    await replayCardReady(host, finished ? "summary" : "header");
    if (finished) {
      await page.getByRole("button", { name: /^\d+ steps?/ }).click();
      await replayCardReady(host, "header");
    }
    const header = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("check rope"))!;
    expect(header, "a real live tool card is present").toBeDefined();
    await page.getByRole("button", { name: /check rope/ }).click();
    await replayCardReady(host, "expanded");
    const detail = header.parentElement!.querySelector(".whitespace-pre-wrap");
    expect(detail, "the card is expanded before the fault").not.toBeNull();
    const field = host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!; field.focus(); await frame();
    const message = header.closest("[data-reading-column]")!.children[1]!;
    net.drop({ announce: true }); await frame();
    net.recover(); ui.connection.reconnectNow(); await expect.poll(() => net.socket()?.readyState).toBe(1);
    const replayEnd = splitRun && !finished ? " Rope held. Live oars." : " Rope held.";
    net.socket()!.deliver({ type: "session_history", sessionId: "ithaca", messages: [user, {
      role: "assistant", turnId: "turn-1", content: opening + middle + replayEnd, toolCalls: [
        { id: "wax-b", name: "Bash", input: { command: "check wax" } }, { id: "rope-c", name: "Bash", input: { command: "check rope" } },
      ], parts: [{ kind: "text", text: opening }, { kind: "tool", toolIndex: 0 }, { kind: "text", text: middle }, { kind: "tool", toolIndex: 1 }, { kind: "text", text: replayEnd }],
    }] });
    net.socket()!.deliver({ type: "status", sessionId: "ithaca", status: "thinking", turnId: "turn-1" });
    await frame();
    expect(message.isConnected, "the answer stays mounted before inspecting inner cards").toBe(true);
    expect(header.isConnected, "the expanded card keeps its original header node").toBe(true);
    expect(detail!.isConnected, "the expanded input stays mounted").toBe(true);
    const recovered = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("check wax"))!;
    const between = [...host.querySelectorAll(".chat-message-body")].find((b) => b.textContent?.trim() === middle.trim())!;
    expect(between, "recovered text keeps its distinct chronological block").toBeDefined();
    expect(recovered.compareDocumentPosition(between) & Node.DOCUMENT_POSITION_FOLLOWING, "the recovered tool precedes its following text").not.toBe(0);
    expect(between.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING, "the retained tool still follows that text").not.toBe(0);
    expect(document.activeElement).toBe(field);
  });
}

// A real finite effect can be cancelled and replaced between native frames.
// This control tests the readiness helper, not replay behavior or Motion duration.
test("expanded readiness follows a cancelled animation's replacement", async (ctx) => {
  const host = document.createElement("div");
  host.innerHTML = '<div data-reading-column><div style="opacity:1;transform:none"></div><div style="opacity:1;transform:none"><div><button>check rope</button><div class="overflow-hidden" style="height:auto;opacity:1"><span class="whitespace-pre-wrap">check rope</span></div></div></div></div>';
  document.body.append(host);
  const owner = host.querySelector<HTMLElement>(".overflow-hidden")!;
  const first = owner.animate([{ transform: "translateY(6px)" }, { transform: "none" }], { duration: 500 });
  let replacement: Animation | undefined;
  const raf = requestAnimationFrame(() => {
    first.cancel();
    replacement = owner.animate([{ transform: "translateY(6px)" }, { transform: "none" }], { duration: 180 });
  });
  ctx.onTestFinished(() => { cancelAnimationFrame(raf); first.cancel(); replacement?.cancel(); host.remove(); });
  await replayCardReady(host, "expanded");
  expect(replacement, "the cancelled effect was replaced").toBeDefined();
  expect(replacement!.playState, "the actual replacement finished before readiness").toBe("finished");
});
