// What a shared PNG or PDF of an answer contains (#46). Messages are built
// through the chat store's own actions, the way a live turn builds them, so
// the order under test is the order the store records, not a hand-made one.
import { beforeEach, describe, expect, test } from "bun:test";
import { SHOW_BLOCK_CONTRACT, visibleToolName, type Block } from "@schlessera/brain-ui-sdk/client";

import type { BrainUiRoot } from "../src/root.js";
import { buildMessageShareOptions } from "../src/components/chat/message-share.js";
import { renderBlockHtml, shareMarkdown, shareSegments } from "../src/components/chat/share-document.js";
import { inlineMermaidDiagrams } from "../src/lib/mermaid.js";
import { useChatStore } from "../src/stores/chat-store.js";
import type { ChatMessage } from "../src/stores/chat-state.js";
import { BLOCKS } from "./block-fixtures.js";

const SHOW_BLOCK = visibleToolName(SHOW_BLOCK_CONTRACT.name, "claude");
const identity = { renderBlock: renderBlockHtml, inlineMermaid: async (md: string) => md };

beforeEach(() => {
  useChatStore.setState({ buffers: {}, draft: null, activeSessionId: null, runStates: {} });
});

const store = () => useChatStore.getState();
const lastMessage = (): ChatMessage => {
  const messages = store().draft!.messages;
  return messages[messages.length - 1]!;
};

/** A `show_block` call as a live turn records it: started, input complete, result later. */
function showBlock(id: string, block: Block | string) {
  store().startToolCall(null, id, SHOW_BLOCK);
  store().completeToolCall(null, id, SHOW_BLOCK, {});
  return () =>
    store().setToolResult(null, id, typeof block === "string" ? block : JSON.stringify({ block }), typeof block === "string");
}

/** The request body sharing sends, captured at the one network call it makes. */
async function sentBody(message: ChatMessage, format: "png" | "pdf"): Promise<unknown> {
  let body: string | undefined;
  const root = {
    apiBase: () => "/api",
    config: { shareTitle: "Shared" },
    request: async (_url: string, init: RequestInit) => {
      body = String(init.body);
      throw new Error("captured");
    },
  } as unknown as BrainUiRoot;
  const option = buildMessageShareOptions(root, { message, renderedRef: { current: null } }).find((o) => o.id === (format === "png" ? "image" : "pdf"))!;
  await expect(option.run()).rejects.toThrow("captured");
  return JSON.parse(body!);
}

describe("a message with no blocks", () => {
  test("shares exactly the request it sent before blocks existed, as PNG and as PDF", async () => {
    store().startAssistantMessage(null);
    store().appendThinking(null, "Let me look.");
    store().appendText(null, "Ithaca is ");
    store().startToolCall(null, "b1", "Bash");
    store().completeToolCall(null, "b1", "Bash", { command: "ls" });
    store().setToolResult(null, "b1", "ithaca.md", false);
    store().appendText(null, "twenty years away.\n\n```mermaid\ngraph LR; Troy-->Ithaca\n```\n");
    // A show_block call whose payload the schema rejects draws no block in
    // the transcript's answer, so it draws none here either.
    showBlock("s1", "block.columns: Too small: expected array to have >=2 items")();
    store().finishAssistantMessage(null);
    const message = lastMessage();
    expect(message.parts.some((p) => p.kind === "tool")).toBe(true);

    for (const format of ["png", "pdf"] as const) {
      // What `message-share.ts` sent before #46, spelled out.
      const before = {
        content: await inlineMermaidDiagrams(message.content),
        contentType: "markdown",
        format,
        title: "Shared",
      };
      expect(await sentBody(message, format)).toEqual(before);
    }
  });
});

describe("a message with blocks", () => {
  test("keeps the order the model wrote, whenever a payload arrives", async () => {
    store().startAssistantMessage(null);
    store().appendText(null, "Before the quote.");
    const resultArrives = showBlock("s1", BLOCKS.quote);
    store().appendText(null, "After the quote.");
    // The payload lands only after the text that followed the call.
    resultArrives();
    store().finishAssistantMessage(null);

    const segments = shareSegments(lastMessage());
    expect(segments.map((s) => (s.kind === "block" ? `block:${s.block.kind}` : s.text))).toEqual([
      "Before the quote.",
      "block:quote",
      "After the quote.",
    ]);
  });

  test("draws every block kind, in order, in the print theme", async () => {
    const kinds = Object.keys(BLOCKS) as Block["kind"][];
    expect(kinds).toHaveLength(11);
    store().startAssistantMessage(null);
    store().appendText(null, "All of them.");
    kinds.forEach((kind, i) => showBlock(`s${i}`, BLOCKS[kind])());
    store().finishAssistantMessage(null);

    const markdown = await shareMarkdown(lastMessage(), identity);
    const drawn = [...markdown.matchAll(/<div data-block="([a-z]+)"/g)].map((m) => m[1]);
    expect(drawn).toEqual(kinds);
    // The print palette, not the dark or light one.
    expect(markdown).toContain("--bk-color-canvas:#ffffff;");
    expect(markdown).toContain("color-scheme:light;");
    expect(markdown.startsWith("<style>")).toBe(true);
  });

  test("cuts a classified block in at its span, as the transcript does", async () => {
    store().startAssistantMessage(null, "turn-1");
    store().appendText(null, "Intro.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nOutro.");
    store().finishAssistantMessage(null);
    const text = lastMessage().content;
    const start = text.indexOf("| a");
    const end = text.indexOf("\n\nOutro");
    store().setMessageBlocks(null, [{ partIndex: 0, start, end, block: BLOCKS.table, confidence: 0.9 }], "turn-1");

    const segments = shareSegments(lastMessage());
    expect(segments.map((s) => (s.kind === "block" ? `block:${s.block.kind}` : s.text.trim()))).toEqual([
      "Intro.",
      "block:table",
      "Outro.",
    ]);
  });

  test("a block's HTML is one line, so markdown cannot split it", async () => {
    const block = { ...BLOCKS.comparison, footnote: "First line.\n\nSecond line." } as Block;
    const html = await renderBlockHtml(block);
    expect(html).toContain("First line.");
    expect(html).not.toContain("\n");
  });
});
