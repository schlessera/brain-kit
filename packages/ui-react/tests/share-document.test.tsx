import { trackDisplayFixture } from "./track-fixtures.js";
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
import { BLOCKS, SUGGESTIONS, type AnswerBlockKind } from "./block-fixtures.js";

const SHOW_BLOCK = visibleToolName(SHOW_BLOCK_CONTRACT.name, "claude");
const identity = { renderBlock: (block: Block) => renderBlockHtml(block, block.kind === "track" ? trackDisplayFixture() : undefined), inlineMermaid: async (md: string) => md };

beforeEach(() => {
  useChatStore.setState({ buffers: {}, draft: null, activeSessionId: null, runStates: {} });
});

const store = () => useChatStore.getState();
const lastMessage = (): ChatMessage => {
  const messages = store().draft!.messages;
  return messages[messages.length - 1]!;
};

/**
 * A `show_block` call as a live turn records it: started, input complete,
 * result later. A string is a raw result: an error text, or JSON as written.
 */
function showBlock(id: string, block: Block | string) {
  store().startToolCall(null, id, SHOW_BLOCK);
  store().completeToolCall(null, id, SHOW_BLOCK, {});
  return () => {
    const raw = typeof block === "string";
    const isError = raw && !block.trimStart().startsWith("{");
    store().setToolResult(null, id, raw ? block : JSON.stringify({ block }), isError);
  };
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

describe("a message with no usable block, in shapes the live stream does not make", () => {
  test("history content that differs from its parts is still what is sent", async () => {
    // A replayed message's `content` comes from the server, not from joining
    // its parts; with no block, the share sends `content`, never the parts.
    const message = {
      id: "h",
      role: "assistant",
      content: "The history's own text.",
      parts: [{ kind: "text", text: "Different text in the parts." }],
      toolCalls: [],
      isStreaming: false,
      timestamp: 0,
    } as ChatMessage;
    expect((await sentBody(message, "png")) as { content: string }).toMatchObject({ content: "The history's own text." });
  });

  test("a payload that is valid JSON but fails the schema is left out", async () => {
    store().startAssistantMessage(null);
    store().appendText(null, "Only prose.");
    // Two columns are the minimum; one is JSON the schema rejects.
    showBlock("s1", JSON.stringify({ block: { kind: "comparison", columns: [{ label: "Only" }], rows: [] } }))();
    const message = lastMessage();
    const tool = message.toolCalls[0]!;
    expect(tool.isError).toBe(false);
    expect(() => JSON.parse(tool.output!)).not.toThrow();
    expect(shareSegments(message).filter((s) => s.kind === "block")).toEqual([]);
    expect(await shareMarkdown(message, identity)).toBe(message.content);
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
    const kinds = Object.keys(BLOCKS) as AnswerBlockKind[];
    expect(kinds).toHaveLength(17);
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

  test("leaves answer suggestions out: they are an offer in the app, not the answer (D50)", async () => {
    store().startAssistantMessage(null);
    store().appendText(null, "Before the quote.");
    showBlock("s1", BLOCKS.quote)();
    store().appendText(null, "After the quote.");
    showBlock("s2", SUGGESTIONS)();
    store().finishAssistantMessage(null);

    const segments = shareSegments(lastMessage());
    expect(segments.map((s) => (s.kind === "block" ? `block:${s.block.kind}` : s.text))).toEqual([
      "Before the quote.",
      "block:quote",
      "After the quote.",
    ]);
    const markdown = await shareMarkdown(lastMessage(), identity);
    expect(markdown).not.toContain("Charybdis");
  });

  test("a classified span is never swapped for suggestions, so the prose stays", () => {
    store().startAssistantMessage(null, "turn-s");
    store().appendText(null, "Intro. The prose that must stay. Outro.");
    store().finishAssistantMessage(null);
    const text = lastMessage().content;
    const start = text.indexOf("The prose");
    store().setMessageBlocks(null, [{ partIndex: 0, start, end: start + 23, block: SUGGESTIONS, confidence: 0.9 }], "turn-s");
    expect(lastMessage().blocks).toHaveLength(1);
    expect(shareSegments(lastMessage())).toEqual([{ kind: "markdown", text }]);
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

  test("counts a whitespace-only text part, as the transcript does, to find a classified block", async () => {
    store().startAssistantMessage(null, "turn-w");
    store().appendText(null, "  ");
    store().appendThinking(null, "Hm.");
    store().appendText(null, "Intro.\n\n| a | b |\n| - | - |\n| 1 | 2 |");
    store().finishAssistantMessage(null);
    const message = lastMessage();
    expect(message.parts.map((p) => p.kind)).toEqual(["text", "thinking", "text"]);
    const text = (message.parts[2] as { text: string }).text;
    // Ordinal 1: the second TEXT part, the whitespace-only one being the first.
    store().setMessageBlocks(null, [{ partIndex: 1, start: text.indexOf("| a"), end: text.length, block: BLOCKS.table, confidence: 0.9 }], "turn-w");
    expect(shareSegments(lastMessage()).map((s) => (s.kind === "block" ? `block:${s.block.kind}` : s.text.trim()))).toEqual([
      "Intro.",
      "block:table",
    ]);
  });

  test("a block's HTML is one line, so markdown cannot split it", async () => {
    // Every line break marked reads: LF, CRLF, and a bare CR.
    const block = { ...BLOCKS.comparison, footnote: "First line.\n\nSecond.\r\n\r\nThird.\r\rFourth." } as Block;
    const html = await renderBlockHtml(block);
    expect(html).toContain("First line.");
    expect(html).toContain("Fourth.");
    expect(html).not.toMatch(/[\r\n]/);
  });

  test("a tracker block draws every event in a static render, with no collapse control", async () => {
    const block = BLOCKS.tracker;
    if (block.kind !== "tracker") throw new Error("Expected the tracker fixture");
    expect(block.events.length).toBeGreaterThan(6);
    const html = await renderBlockHtml(block);
    const { Window } = await import("happy-dom");
    const { document } = new Window();
    document.body.innerHTML = html;
    expect(document.querySelectorAll("[data-tracker-pill], [data-tracker-withheld]")).toHaveLength(block.events.length);
    expect(document.querySelector("[data-tracker-more]")).toBeNull();
    // The screen-reader line hides itself: the share document carries the
    // print tokens, not the kit stylesheet that defines `.bk-sr-only`.
    const sr = document.querySelector("[data-tracker-sr]") as unknown as HTMLElement;
    expect(sr.getAttribute("class")).toBeNull();
    expect(sr.style.position).toBe("absolute");
    expect(sr.style.clipPath).toBe("inset(50%)");
  });
});


test("shared ordinary code fences preserve complete raw commands and markup in PNG and PDF requests", async () => {
  const source = 'brain search "Scylla" --path ' + 'knowledge/'.repeat(24) + '--final-argument\n<b>Odysseus</b>\n[[circe|guide]]';
  const message = { id: "code-share", role: "assistant", content: '```bash\n' + source + '\n```', parts: [], toolCalls: [], isStreaming: false, timestamp: 0 } as ChatMessage;
  expect(source.length).toBeGreaterThan(200);
  for (const format of ["png", "pdf"] as const) expect(await sentBody(message, format)).toMatchObject({ content: message.content, contentType: "markdown", format });
});
