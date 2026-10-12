/**
 * A file the answer linked in turn temp is copied into scratch once the turn
 * has ended, and the saved answer links the copy (#1655). A reader who
 * watched the answer stream in holds the original text; the host's
 * `message_links` frame brings the open conversation to what a reload would
 * show (#1698): the same link, now to the copy, without a reload, a remount
 * or any marker.
 *
 * The real ChatPage, connection, decoder, handlers and store; only the
 * network is scripted.
 */
import { expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork } from "./offline/fault-network.ts";

const SESSION = "ithaca-voyage";
const TURN = "turn-ithaca-7";
const STREAMED = "The [voyage report]($BRAIN_WORKER_SCRATCH/report.pdf) is ready; Penelope has [her copy](/tmp/brain-worker-scratch/report.pdf).";
const COPY = `.brain/scratch/turns/${TURN}/report.pdf`;
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

for (const width of [320, 1280]) {
  test(`${width}: the open conversation links the promoted copy once the turn has ended, without a reload or marker`, async (ctx) => {
    const before = { width: innerWidth, height: innerHeight };
    const outer = await commands.formViewport(width, 800);
    await page.viewport(width, 800);
    const net = installFaultNetwork({
      routes: (url, init) => init.method === "HEAD" && (url.searchParams.get("path") ?? "").startsWith(".brain/scratch/")
        ? new Response(null, { status: 200 })
        : Response.json({ entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [] }),
    });
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
      await page.viewport(before.width, before.height);
      await commands.formViewport(outer.width - 100, outer.height - 120);
    });
    ui.connection.connect();
    await expect.poll(() => net.socket()?.readyState).toBe(1);
    ui.stores.chat.getState().setActiveSession(SESSION);
    const socket = net.socket()!;
    socket.deliver({ type: "session_history", sessionId: SESSION, messages: [
      { role: "user", content: "Write up the voyage report for Penelope.", toolCalls: [] },
    ] });
    socket.deliver({ type: "status", sessionId: SESSION, status: "idle" });
    flushSync(() => renderer.render(<BrainUiProvider root={ui}><ChatPage /></BrainUiProvider>));
    await frame();

    // The turn streams and ends; the answer links turn temp.
    socket.deliver({ type: "status", sessionId: SESSION, turnId: TURN, status: "thinking" });
    socket.deliver({ type: "text_delta", sessionId: SESSION, turnId: TURN, text: STREAMED });
    socket.deliver({ type: "result", sessionId: SESSION, turnId: TURN, durationMs: 900, numTurns: 1, isError: false, outcome: "success" });
    socket.deliver({ type: "status", sessionId: SESSION, turnId: TURN, status: "idle" });
    await frame();
    const column = host.querySelector<HTMLElement>("[data-reading-column]")!;
    const bubbles = [...column.children];
    const answer = bubbles.at(-1)!;
    // A link into turn temp is not a file in the brain: the reader cannot open it.
    await expect.poll(() => answer.textContent).toContain("voyage report");
    expect(answer.querySelector(`a[href*="${COPY}"]`)).toBeNull();
    let removed = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.removedNodes) if (bubbles.includes(node as Element)) removed++;
    });
    observer.observe(column, { childList: true });
    ctx.onTestFinished(() => observer.disconnect());
    const sentBefore = net.frames.length;

    // The worker has exited: the host promoted the file and says so.
    socket.deliver({ type: "message_links", sessionId: SESSION, turnId: TURN, links: [
      { from: "$BRAIN_WORKER_SCRATCH/report.pdf", to: COPY },
      // The same file, written another way.
      { from: "/tmp/brain-worker-scratch/report.pdf", to: COPY },
    ] });
    await frame();

    const report = page.elementLocator(answer).getByRole("link", { name: "voyage report", exact: true });
    await expect.element(report).toHaveAttribute("href", `#/files/${COPY}`);
    await expect.element(page.elementLocator(answer).getByRole("link", { name: "her copy", exact: true })).toHaveAttribute("href", `#/files/${COPY}`);
    expect(host.innerHTML, "no turn-temp link is left on screen").not.toMatch(/BRAIN_WORKER_SCRATCH|brain-worker-scratch/);
    // The same words, the same bubbles, nothing added: no marker, no remount.
    for (const words of ["voyage report", "is ready; Penelope has", "her copy"]) expect(answer.textContent).toContain(words);
    expect(answer.isConnected && removed === 0, "no message was removed even briefly").toBe(true);
    expect([...column.children]).toEqual(bubbles);
    expect(host.textContent).not.toMatch(/expired|promot|copied|moved/i);
    // No reload: nothing was asked of the host.
    expect(net.frames.slice(sentBefore).map((f) => JSON.parse(String(f.data)).type)).toEqual([]);
  });
}
