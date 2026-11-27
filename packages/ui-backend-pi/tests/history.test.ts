import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/server";

import { sessionPromptContext, sessionPromptContextLocation } from "@schlessera/brain-ui-sdk/internal";
import { normalizeMessages, getPiHistory, listPiSessions } from "../src/history";

describe("normalizeMessages (pure)", () => {
  test("threads tool results onto the assistant tool call and orders parts", () => {
    const messages = [
      { role: "user", content: "find my notes", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me search" },
          { type: "text", text: "Searching now." },
          { type: "toolCall", id: "tc1", name: "brain_search", arguments: { query: "notes" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "m",
        usage: emptyUsage(),
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "brain_search",
        content: [{ type: "text", text: "2 results" }],
        isError: false,
        timestamp: 3,
      },
    ] as unknown as AgentMessage[];

    const out = normalizeMessages(messages);
    expect(out).toHaveLength(2);

    expect(out[0]).toEqual({ role: "user", content: "find my notes", toolCalls: [] });

    const assistant = out[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Searching now.");
    expect(assistant.thinking).toBe("let me search");
    expect(assistant.toolCalls).toEqual([
      { id: "tc1", name: "brain_search", input: { query: "notes" }, output: "2 results", isError: false },
    ]);
    expect(assistant.parts).toEqual([
      { kind: "thinking", text: "let me search" },
      { kind: "text", text: "Searching now." },
      { kind: "tool", toolIndex: 0 },
    ]);
  });

  test("counts image attachments on a user message", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    ] as unknown as AgentMessage[];
    const out = normalizeMessages(messages);
    expect(out[0].content).toBe("look at this");
    expect(out[0].attachmentCount).toBe(1);
  });

  test("skips non-conversation entries (compaction/branch summaries)", () => {
    const messages = [
      { role: "compactionSummary", summary: "...", tokensBefore: 10, timestamp: 1 },
      { role: "user", content: "hi", timestamp: 2 },
    ] as unknown as AgentMessage[];
    const out = normalizeMessages(messages);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });
});

describe("SessionManager-backed history", () => {
  let cwd: string;
  let sessionDir: string;
  let sessionId: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-backend-cwd-"));
    sessionDir = mkdtempSync(join(tmpdir(), "pi-backend-history-"));
    const sm = SessionManager.create(cwd, sessionDir);
    sessionId = sm.getSessionId();
    sm.appendMessage({ role: "user", content: "hello brain", timestamp: 1 } as never);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: 2,
    } as never);
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  test("listPiSessions returns the created session", async () => {
    const sessions = await listPiSessions(cwd, sessionDir);
    expect(sessions.map((s) => s.id)).toContain(sessionId);
  });

  test("getPiHistory normalizes the active branch", async () => {
    const history = await getPiHistory(cwd, sessionId, sessionDir);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: "user", content: "hello brain" });
    expect(history[1]).toMatchObject({ role: "assistant", content: "hi there" });
  });

  test("getPiHistory returns [] for an unknown session", async () => {
    expect(await getPiHistory(cwd, "no-such-id", sessionDir)).toEqual([]);
  });
});

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

describe("one session's history opens its fixed-name transcript directly (#4858)", () => {
  const dirs: string[] = [];
  const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
  afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
  const expected: SessionHistoryMessage[] = [
    { role: "user", content: "Odysseus asks for the way home.", toolCalls: [] },
    { role: "assistant", content: "Sail west past the island.", toolCalls: [], parts: [{ kind: "text", text: "Sail west past the island." }] },
  ];
  /** A current-version transcript, written once by the SDK under its own managed name. */
  function transcript(cwd: string) {
    const scratch = temp("pi-history-sdk-"), sm = SessionManager.create(cwd, scratch);
    sm.appendMessage({ role: "user", content: "Odysseus asks for the way home.", timestamp: 1 } as never);
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Sail west past the island." }], api: "anthropic-messages",
      provider: "anthropic", model: "m", usage: emptyUsage(), stopReason: "stop", timestamp: 2 } as never);
    const [file] = readdirSync(scratch).filter(name => name.endsWith(".jsonl"));
    return { id: sm.getSessionId(), name: file!, bytes: readFileSync(join(scratch, file!)) };
  }
  async function read(cwd: string, id: string, sessionDir: string) {
    const list = spyOn(SessionManager, "list");
    try { return { history: await getPiHistory(cwd, id, sessionDir), listings: list.mock.calls.length }; }
    finally { list.mockRestore(); }
  }
  const snapshot = (dir: string) => readdirSync(dir).sort().map(name => {
    const path = join(dir, name), stat = lstatSync(path);
    return [name, stat.mtimeMs, stat.isFile() ? readFileSync(path).toString("base64") : ""];
  });

  test("a transcript under the fixed name is read without listing the session directory", async () => {
    const cwd = temp("pi-history-cwd-"), saved = transcript(cwd);
    const canonical = temp("pi-history-dir-"), legacy = temp("pi-history-dir-");
    writeFileSync(join(canonical, `${saved.id}.jsonl`), saved.bytes);
    writeFileSync(join(legacy, saved.name), saved.bytes);
    const direct = await read(cwd, saved.id, canonical);
    expect(direct.history).toEqual(expected);
    expect(direct.listings, "FIXED_NAME_NEVER_LISTS").toBe(0);
    const listed = await read(cwd, saved.id, legacy);
    expect(listed.listings, "OLDER_NAME_LISTS_ONCE").toBe(1);
    expect(listed.history, "OLDER_NAME_STILL_RETURNED").toEqual(expected);
    expect(direct.history, "DIRECT_EQUALS_LISTING").toEqual(listed.history);
  });

  test("a fixed-name file naming another session or another brain, or a symlink, is not opened directly", async () => {
    const cwd = temp("pi-history-cwd-"), other = temp("pi-history-cwd-"), id = crypto.randomUUID();
    const foreignId = transcript(cwd), foreignBrain = transcript(other), aliased = transcript(cwd);
    const wrongId = temp("pi-history-dir-"), wrongBrain = temp("pi-history-dir-"), symlinked = temp("pi-history-dir-");
    writeFileSync(join(wrongId, `${id}.jsonl`), foreignId.bytes);
    writeFileSync(join(wrongBrain, `${foreignBrain.id}.jsonl`), foreignBrain.bytes);
    const target = join(temp("pi-history-target-"), "voyage.jsonl");
    writeFileSync(target, aliased.bytes); symlinkSync(target, join(symlinked, `${aliased.id}.jsonl`));
    const byId = await read(cwd, id, wrongId);
    expect(byId.history, "FOREIGN_SESSION_HEADER_NOT_USED").toEqual([]);
    expect(byId.listings).toBe(1);
    const byBrain = await read(cwd, foreignBrain.id, wrongBrain);
    expect(byBrain.history, "FOREIGN_BRAIN_HEADER_NOT_USED").toEqual([]);
    expect(byBrain.listings).toBe(1);
    // The listing path still follows the link, exactly as before.
    expect((await read(cwd, aliased.id, symlinked)).listings, "SYMLINK_NOT_OPENED_DIRECTLY").toBe(1);
  });

  test("reading known and unknown sessions leaves the session directory untouched", async () => {
    const cwd = temp("pi-history-cwd-"), saved = transcript(cwd), dir = temp("pi-history-dir-");
    writeFileSync(join(dir, `${saved.id}.jsonl`), saved.bytes);
    const before = snapshot(dir);
    await read(cwd, saved.id, dir);
    await read(cwd, crypto.randomUUID(), dir);
    expect(snapshot(dir), "HISTORY_READ_WRITES_NOTHING").toEqual(before);
  });
});

describe("a history read never rewrites its transcript (#4866)", () => {
  const dirs: string[] = [];
  const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
  afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
  const expected: SessionHistoryMessage[] = [
    { role: "user", content: "Penelope asks when the ship returns.", toolCalls: [] },
    { role: "assistant", content: "Before the loom is finished.", toolCalls: [], parts: [{ kind: "text", text: "Before the loom is finished." }] },
  ];
  /** A current transcript as the SDK writes it, then rewritten into the form `variant` names. */
  function transcript(cwd: string, variant: "version 1" | "version 2" | "no last newline") {
    const scratch = temp("pi-history-sdk-"), sm = SessionManager.create(cwd, scratch);
    sm.appendMessage({ role: "user", content: "Penelope asks when the ship returns.", timestamp: 1 } as never);
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Before the loom is finished." }], api: "anthropic-messages",
      provider: "anthropic", model: "m", usage: emptyUsage(), stopReason: "stop", timestamp: 2 } as never);
    const [file] = readdirSync(scratch).filter(name => name.endsWith(".jsonl"));
    const entries = readFileSync(join(scratch, file!), "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    if (variant === "version 1") for (const entry of entries) { if (entry.type === "session") entry.version = 1; else { delete entry.id; delete entry.parentId; } }
    if (variant === "version 2") entries[0]!.version = 2;
    const text = entries.map(entry => JSON.stringify(entry)).join("\n");
    return { id: sm.getSessionId(), name: file!, bytes: variant === "no last newline" ? text : `${text}\n` };
  }

  test.each(["version 1", "version 2", "no last newline"] as const)("a %s transcript is read as pi migrates it, and its file keeps its bytes and time", async (variant) => {
    const cwd = temp("pi-history-cwd-"), saved = transcript(cwd, variant);
    const canonical = temp("pi-history-dir-"), legacy = temp("pi-history-dir-");
    // The fixed name is opened directly; the SDK's own name is found by listing.
    for (const [dir, name] of [[canonical, `${saved.id}.jsonl`], [legacy, saved.name]] as const) {
      const path = join(dir, name);
      writeFileSync(path, saved.bytes);
      const before = lstatSync(path).mtimeMs;
      expect(await getPiHistory(cwd, saved.id, dir), "HISTORY_AS_MIGRATED").toEqual(expected);
      expect(readFileSync(path, "utf8"), "TRANSCRIPT_BYTES_UNCHANGED").toBe(saved.bytes);
      expect(lstatSync(path).mtimeMs, "TRANSCRIPT_TIME_UNCHANGED").toBe(before);
      expect(readdirSync(dir), "NO_OTHER_FILE_WRITTEN").toEqual([name]);
    }
  });
});

test("a history read opens the prompt-context file once, whatever the number of user messages (#4859)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-history-opens-cwd-")), sessionDir = mkdtempSync(join(tmpdir(), "pi-history-opens-dir-"));
  try {
    const sm = SessionManager.create(cwd, sessionDir), session = sm.getSessionId(), store = sessionPromptContext(sessionDir, cwd, session);
    store.retainAppend("Odysseus keeps the log.");
    for (let turn = 0; turn < 20; turn++) {
      const sent = store.prepare(`Turn ${turn}: which way to Ithaca?`, { device: turn % 2 ? "phone" : "tablet" });
      const id = sm.appendMessage({ role: "user", content: [{ type: "text", text: sent.text }], timestamp: turn * 2 } as never);
      store.acknowledge(sent.id, id);
      sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Sail west." }], api: "anthropic-messages",
        provider: "anthropic", model: "m", usage: emptyUsage(), stopReason: "stop", timestamp: turn * 2 + 1 } as never);
    }
    const { dir, name } = sessionPromptContextLocation(sessionDir, cwd, session);
    const open = spyOn(fs, "openSync");
    let history, opens;
    try {
      history = await getPiHistory(cwd, session, sessionDir);
      opens = open.mock.calls.filter(([path]) => path === join(dir, name)).length;
    } finally { open.mockRestore(); }
    expect(opens, "ONE_PROMPT_CONTEXT_READ_PER_HISTORY").toBe(1);
    expect(history.filter(message => message.role === "user").map(message => message.content))
      .toEqual(Array.from({ length: 20 }, (_, turn) => `Turn ${turn}: which way to Ithaca?`));
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(sessionDir, { recursive: true, force: true }); }
});
