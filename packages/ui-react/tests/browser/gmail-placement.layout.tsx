/**
 * The Gmail tool cards placed in the chat's tool timeline (#4210), at 320px
 * and desktop, in both themes: a content search, a content thread with its
 * cut body's rest loaded, a structured message, the label list (the safe
 * fallback until the kit has a component for it) and a rate-limit refusal,
 * each expanded under its own row. Nothing in the timeline scrolls sideways,
 * and every row keeps its class and view.
 * The captures are the placement the maintainer signs off.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { visibleToolName } from "@schlessera/brain-ui-sdk/client";
import { GMAIL_TOOL_NAMES } from "@schlessera/brain-ui-sdk/tool-contracts";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { ToolCall } from "../../src/stores/chat-store.js";
import { RAFT, SESSION, THREAD, envelope, labelsRead, messageRead, raftBody, raftMessages, refusal, searchPage } from "../gmail-fixtures.js";

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement;
let viewport: { width: number; height: number }, outer: { width: number; height: number } | undefined, themeBefore: string | undefined;
beforeEach(() => { viewport = { width: innerWidth, height: innerHeight }; themeBefore = document.documentElement.dataset.theme; });
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  root?.dispose(); host?.remove(); renderer = undefined; root = undefined; host = undefined;
  document.documentElement.dataset.theme = themeBefore; await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});

/** A short letter the host cut, so the scene stays one screen tall; the real cut is 32,768 characters. */
const LETTER = [
  "Odysseus,",
  "",
  "The raft is lashed: twenty logs of poplar and fir, a mast, a yard and a steering oar. I have woven the sail from the cloth you saw on the loom.",
  "",
  "Take water in the dark skin and wine in the other. Keep the Pleiades on your left and the Bear on your right, and do not sleep while Orion is up.",
  "",
  "The raft is finished. Calypso has turned away; the wind is fair for Scheria.",
].join("\n");
const SHOWN = LETTER.slice(0, 160);
const newest = raftMessages[2]!;
const thread = envelope("read", {
  kind: "thread", view: "content", thread_id: THREAD, message_count: 3,
  messages: [raftMessages[0]!, raftMessages[1]!, { ...newest, untrusted: { ...newest.untrusted, body_text: SHOWN, body_truncated: true, body_length: LETTER.length } }],
});

const call = (id: string, tool: "search" | "read", input: Record<string, unknown>, output: unknown): ToolCall => ({
  id, name: visibleToolName(GMAIL_TOOL_NAMES[tool], "claude"), input, inputJson: JSON.stringify(input), output: JSON.stringify(output), status: "complete", isError: false,
});
const calls: ToolCall[] = [
  call("s1", "search", { query: "from:calypso raft", view: "content" }, searchPage("content")),
  call("r1", "read", { target: "thread", id: THREAD, view: "content" }, thread),
  call("r2", "read", { target: "message", id: RAFT, view: "structured" }, messageRead("structured")),
  call("r3", "read", { target: "labels" }, labelsRead()),
  call("r4", "read", { target: "thread", id: THREAD, view: "content" }, refusal("read", "rate_limited", null, "Gmail's request limit is used up. Try again in a few minutes.")),
];

for (const width of [320, 1280]) for (const theme of ["light", "dark"]) {
  test(`${theme} ${width}: the Gmail cards sit in the tool timeline without sideways scroll`, async () => {
    outer = await commands.formViewport(width, 900); await page.viewport(width, 900); document.documentElement.dataset.theme = theme;
    root = createBrainUiRoot({
      storage: null,
      request: async (url) => String(url).endsWith(`/google/gmail/messages/${RAFT}/body`)
        ? Response.json(raftBody({ body_text: LETTER, body_length: LETTER.length }))
        : Response.json({}, { status: 404 }),
    });
    root.stores.chat.setState({ activeSessionId: SESSION });
    host = document.createElement("div");
    host.style.cssText = `box-sizing:border-box;width:${Math.min(width, 760)}px;padding:16px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
    document.body.append(host); renderer = createRoot(host);
    flushSync(() => renderer!.render(<BrainUiProvider root={root!}><ToolCallTimeline live toolCalls={calls} onApproval={() => {}} /></BrainUiProvider>));

    const rows = () => [...host!.querySelectorAll<HTMLElement>("[data-tool-call] > div > button")];
    expect(rows().map((r) => r.textContent)).toEqual([
      "Gmail search“from:calypso raft”read · content view",
      "Gmailthread · 3 messagesread · content view",
      "Gmailmessageread · structured view",
      "Gmail3 labelsread · structured view",
      "Gmailread · no result",
    ]);
    for (const row of rows()) await userEvent.click(row);
    await expect.poll(() => host!.querySelectorAll("[data-gmail-thread='content']").length).toBe(1);
    const show = [...host.querySelectorAll<HTMLElement>("[role='button']")].find((b) => b.textContent?.startsWith("Show the rest"))!;
    await userEvent.click(show);
    await expect.poll(() => host!.querySelector("[data-gmail-detail]")?.getAttribute("data-gmail-detail")).toBe("loaded");
    // The kit sets each paragraph as its own element, so compare the words, not the line breaks.
    const words = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, "");
    expect(words(host.querySelector("[data-gmail-rest]")?.textContent), "the rest is the part after what Brain read").toBe(words(LETTER.slice(SHOWN.length)));
    // The label list is the tool's own output as text, every entry with its counts, not a thread's chips.
    const labels = host.querySelector("[data-tool-call='r3']")!;
    expect(labels.querySelector("[data-gmail-label]"), "no thread chip row").toBeNull();
    expect(labels.querySelector("pre")?.textContent, "every entry, as the tool returned it").toBe(JSON.stringify(labelsRead()));

    // The timeline's output frame clips (overflow: hidden), so a too-wide card
    // never widens the page: measure every element inside the rows instead.
    const column = host.getBoundingClientRect().right - 16 + 1;
    const past = [...host.querySelectorAll<HTMLElement>("[data-tool-call] *")].filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.right > column;
    });
    expect(past.map((el) => `${el.tagName.toLowerCase()} ${Math.round(el.getBoundingClientRect().right)}px`), "nothing in a row reaches past the column").toEqual([]);
    expect(document.documentElement.scrollWidth, "the page never scrolls sideways").toBeLessThanOrEqual(innerWidth);

    const height = Math.ceil(host.scrollHeight) + 32;
    await commands.formViewport(width, height); await page.viewport(width, height);
    await page.screenshot({ element: host, path: `../../.vitest-attachments/gmail-placement/${theme}-${width}.png` });
  });
}
