import { expect, test, describe } from "bun:test";
import type {
  listSessions as sdkListSessions,
  getSessionMessages as sdkGetSessionMessages,
  SDKSessionInfo,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createHistory } from "../src/history";

// A transcript entry as `getSessionMessages` returns it; `message` is opaque
// (unknown) to the SDK, so fixtures only need the `.message.content` blocks the
// normalizer reads.
const entry = (type: string, content: unknown): SessionMessage =>
  ({
    type,
    uuid: crypto.randomUUID(),
    session_id: "sess",
    message: { content },
    parent_tool_use_id: null,
  }) as unknown as SessionMessage;

const messagesFn = (msgs: SessionMessage[]): typeof sdkGetSessionMessages =>
  (async () => msgs) as unknown as typeof sdkGetSessionMessages;

const sessionsFn = (infos: SDKSessionInfo[]): typeof sdkListSessions =>
  (async () => infos) as unknown as typeof sdkListSessions;

describe("getHistory normalization", () => {
  test("folds thinking/text/tool blocks into parts and matches tool results", async () => {
    const transcript = [
      entry("user", [{ type: "text", text: "Hello" }]),
      entry("assistant", [
        { type: "thinking", thinking: "let me look" },
        { type: "text", text: "Sure" },
        { type: "tool_use", id: "t1", name: "Read", input: { path: "a.md" } },
      ]),
      entry("user", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "file body",
          is_error: false,
        },
      ]),
    ];

    const history = createHistory({
      brainPath: "/brain",
      getSessionMessagesFn: messagesFn(transcript),
    });
    const out = await history.getHistory("sess");

    expect(out).toEqual([
      { role: "user", content: "Hello", toolCalls: [] },
      {
        role: "assistant",
        content: "Sure",
        thinking: "let me look",
        toolCalls: [
          {
            id: "t1",
            name: "Read",
            input: { path: "a.md" },
            output: "file body",
            isError: false,
          },
        ],
        parts: [
          { kind: "thinking", text: "let me look" },
          { kind: "text", text: "Sure" },
          { kind: "tool", toolIndex: 0 },
        ],
      },
    ]);
  });

  test("merges consecutive assistant entries and offsets tool indices", async () => {
    const transcript = [
      entry("assistant", [
        { type: "text", text: "one" },
        { type: "tool_use", id: "a", name: "Glob", input: {} },
      ]),
      entry("assistant", [
        { type: "text", text: "two" },
        { type: "tool_use", id: "b", name: "Grep", input: {} },
      ]),
    ];
    const history = createHistory({
      brainPath: "/brain",
      getSessionMessagesFn: messagesFn(transcript),
    });
    const [msg] = await history.getHistory("sess");

    expect(msg!.content).toBe("one\n\ntwo");
    expect(msg!.toolCalls.map((t) => t.id)).toEqual(["a", "b"]);
    expect(msg!.parts).toEqual([
      { kind: "text", text: "one" },
      { kind: "tool", toolIndex: 0 },
      { kind: "text", text: "two" },
      { kind: "tool", toolIndex: 1 },
    ]);
  });

  test("counts image attachments and skips empty tool-result-only user entries", async () => {
    const transcript = [
      entry("user", [
        { type: "text", text: "look at this" },
        { type: "image", source: {} },
      ]),
      // A tool-result-only user entry carries no renderable text → skipped.
      entry("user", [
        { type: "tool_result", tool_use_id: "x", content: "", is_error: false },
      ]),
    ];
    const history = createHistory({
      brainPath: "/brain",
      getSessionMessagesFn: messagesFn(transcript),
    });
    const out = await history.getHistory("sess");
    expect(out).toEqual([
      {
        role: "user",
        content: "look at this",
        toolCalls: [],
        attachmentCount: 1,
      },
    ]);
  });
});

describe("listSessions normalization", () => {
  test("maps SDK session info and filters automation sessions", async () => {
    const infos: SDKSessionInfo[] = [
      {
        sessionId: "s1",
        summary: "Chat about search",
        lastModified: 200,
        createdAt: 100,
        firstPrompt: "How does search work?",
      },
      {
        sessionId: "s2",
        summary: "sync",
        lastModified: 300,
        firstPrompt: "/sync",
      },
      {
        sessionId: "s3",
        summary: "auto",
        lastModified: 400,
        customTitle: "Renamed",
        firstPrompt: "hello",
      },
    ] as unknown as SDKSessionInfo[];

    const history = createHistory({
      brainPath: "/brain",
      listSessionsFn: sessionsFn(infos),
    });
    const out = await history.listSessions();

    expect(out).toEqual([
      {
        id: "s1",
        title: "Chat about search",
        createdAt: 100,
        lastActiveAt: 200,
        totalCostUsd: 0,
        numTurns: 0,
      },
      {
        id: "s3",
        title: "Renamed",
        createdAt: 400,
        lastActiveAt: 400,
        totalCostUsd: 0,
        numTurns: 0,
      },
    ]);
  });

  test("listSessions swallows SDK errors and returns []", async () => {
    const throwingFn = (async () => {
      throw new Error("no store");
    }) as unknown as typeof sdkListSessions;
    const history = createHistory({
      brainPath: "/brain",
      listSessionsFn: throwingFn,
    });
    expect(await history.listSessions()).toEqual([]);
  });
});
