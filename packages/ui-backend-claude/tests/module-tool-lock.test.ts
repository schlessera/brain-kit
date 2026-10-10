import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { BackendBridge, PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { BRAIN_LOCK_KEY } from "@schlessera/brain-ui-sdk/server";
import { createClaudeBackend } from "../src/backend";
import { lockKeyForTool } from "../src/tool-policy";
import { runToolCall } from "./helpers/run-tool-call";

const MODULE_WRITE = "mcp__brain__stub_write";
const CORE_WRITE = "mcp__brain__brain_add";
const READ_TOOLS = [
  "mcp__brain__brain_search",
  "mcp__brain__brain_context",
  "mcp__brain__brain_read",
  "mcp__brain__brain_list",
  "mcp__brain__brain_graph",
  "mcp__brain__jobs_review",
];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function observed(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture execution did not reach its barrier")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const tick = () => new Promise<void>((done) => setTimeout(done, 0));

interface Call {
  tool: string;
  attempted: ReturnType<typeof deferred>;
  entered: ReturnType<typeof deferred>;
  execute: ReturnType<typeof deferred>;
  result: ReturnType<typeof deferred>;
  end: ReturnType<typeof deferred>;
}

function call(tool: string): Call {
  return { tool, attempted: deferred(), entered: deferred(), execute: deferred(), result: deferred(), end: deferred() };
}

/**
 * Exercise startTurn's actual SDK options, matching hooks and permission
 * callback, then run a local writer. The query driver follows the existing
 * measured SDK precedence; it makes no provider call. A result streams while
 * its turn stays open, so release cannot be supplied by the turn-end backstop.
 */
async function harness(calls: Call[], approve: boolean) {
  const root = await mkdtemp(join(tmpdir(), "brain-module-lock-"));
  roots.push(root);
  const trace = join(root, "writes.txt");
  const events: string[] = [];
  const outcomes: boolean[] = [];
  const reads: Record<number, string> = {};
  const permissions: string[] = [];
  const writeLock = createKeyedLock();
  let index = 0;
  const queryFn = ((params: { options?: Options }) => {
    const options = params.options!;
    const i = index++;
    const item = calls[i]!;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: `session-${i}` };
      item.attempted.resolve();
      const outcome = await runToolCall(options, item.tool, {}, `tool-${i}`);
      outcomes[i] = outcome.executed;
      if (outcome.executed) {
        events.push(`${i}:start`);
        if (READ_TOOLS.includes(item.tool)) reads[i] = await readFile(trace, "utf8");
        else await appendFile(trace, `${i}:start\n`);
        item.entered.resolve();
        await item.execute.promise;
        if (!READ_TOOLS.includes(item.tool)) await appendFile(trace, `${i}:finish\n`);
        events.push(`${i}:finish`);
        yield {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: `tool-${i}`, content: "ok" }] },
        };
      }
      // The runner consumed the preceding result before asking for the next
      // message. Keep this turn alive while another tool acquires its key.
      item.result.resolve();
      await item.end.promise;
      yield { type: "result", subtype: "success", session_id: `session-${i}`, total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    })();
  }) as unknown as typeof query;
  const backend = createClaudeBackend({
    brainPath: root,
    queryFn,
    writeLock,
    allowedTools: approve ? [] : [...new Set(calls.map((item) => item.tool))],
    log: () => {},
  });
  const bridge: BackendBridge = {
    emit: () => {},
    requestPermission: async (request) => {
      permissions.push(request.toolName);
      return { behavior: "allow" };
    },
  };
  const turns: Promise<void>[] = [];
  return {
    root, trace, events, outcomes, reads, permissions, writeLock,
    start(customBridge = bridge) {
      const turn = backend.startTurn({ prompt: "Run the local fixture", signal: new AbortController().signal, bridge: customBridge });
      turns.push(turn);
      return turn;
    },
    async close() {
      for (const item of calls) { item.execute.resolve(); item.end.resolve(); }
      await Promise.allSettled(turns);
    },
  };
}

describe("module-tool lock classification", () => {
  test("unlisted brain MCP names take the brain key, including read-looking names", () => {
    for (const tool of [MODULE_WRITE, "mcp__brain__stub_read", "mcp__brain__jobs_review_extra", "mcp__brain__brain_search_extra"]) {
      expect(lockKeyForTool(tool, {}, "/brain"), tool).toBe(BRAIN_LOCK_KEY);
    }
  });

  test.each(READ_TOOLS)("the named read %s takes no lock", (tool) => {
    expect(lockKeyForTool(tool, {}, "/brain")).toBeNull();
  });

  test("other servers and similar prefixes keep their existing no-lock classification", () => {
    for (const tool of ["mcp__other__stub_write", "mcp__brain-ui__stub_write", "mcp__brain_stub_write", "Read"]) {
      expect(lockKeyForTool(tool, {}, "/brain"), tool).toBeNull();
    }
  });
});

describe("module-tool execution through registered hooks", () => {
  test.each([
    { name: "auto-allowed module writers", first: MODULE_WRITE, approve: false },
    { name: "approved module writers", first: MODULE_WRITE, approve: true },
    { name: "a core writer and a module writer", first: CORE_WRITE, approve: false },
  ])("$name serialize until the first tool result, before its turn ends", async ({ first, approve }) => {
    const firstCall = call(first);
    const secondCall = call(MODULE_WRITE);
    const h = await harness([firstCall, secondCall], approve);
    try {
      h.start();
      await observed(firstCall.entered.promise);
      h.start();
      await observed(secondCall.attempted.promise);
      await tick();
      // This ordering assertion must fail if module names leave the matcher:
      // both fixture executors then enter, despite correct classification.
      expect(h.events).toEqual(["0:start"]);
      expect(h.writeLock.heldKeys).toEqual([BRAIN_LOCK_KEY]);
      expect(await readFile(h.trace, "utf8")).toBe("0:start\n");

      firstCall.execute.resolve();
      await observed(firstCall.result.promise);
      await tick();
      expect(h.events).toEqual(["0:start", "0:finish", "1:start"]);
      await observed(secondCall.entered.promise);
      expect(h.outcomes).toEqual([true, true]);
      expect(h.permissions).toEqual(approve ? [first, MODULE_WRITE] : []);
      secondCall.execute.resolve();
      await observed(secondCall.result.promise);
      expect(await readFile(h.trace, "utf8")).toBe("0:start\n0:finish\n1:start\n1:finish\n");
      expect(h.writeLock.locked).toBe(false);
    } finally {
      await h.close();
    }
  });

  test.each(READ_TOOLS)("%s executes while a module writer holds the brain key", async (tool) => {
    const writer = call(MODULE_WRITE);
    const reader = call(tool);
    const h = await harness([writer, reader], false);
    try {
      h.start();
      await observed(writer.entered.promise);
      h.start();
      await observed(reader.attempted.promise);
      await tick();
      expect(h.events).toEqual(["0:start", "1:start"]);
      await observed(reader.entered.promise);
      expect(h.reads[1]).toBe("0:start\n");
      reader.execute.resolve();
      await observed(reader.result.promise);
      // Finishing a read must not release the other tool's held key.
      expect(h.writeLock.heldKeys).toEqual([BRAIN_LOCK_KEY]);
      expect(h.outcomes).toEqual([true, true]);
      expect(h.permissions).toEqual([]);
    } finally {
      await h.close();
    }
  });

  test.each(["allow", "deny"] as const)("an approval wait parks the module lock and %s releases correctly", async (behavior) => {
    const item = call(MODULE_WRITE);
    const pending = deferred();
    let decide!: (decision: PermissionDecision) => void;
    const h = await harness([item], true);
    try {
      h.start({
        emit: () => {},
        requestPermission: () => new Promise((resolve) => { decide = resolve; pending.resolve(); }),
      });
      await observed(pending.promise);
      expect(h.writeLock.locked).toBe(false);
      decide(behavior === "allow" ? { behavior } : { behavior, message: "Fixture denied" });
      if (behavior === "allow") {
        await observed(item.entered.promise);
        expect(h.writeLock.heldKeys).toEqual([BRAIN_LOCK_KEY]);
        item.execute.resolve();
      }
      await observed(item.result.promise);
      expect(h.outcomes).toEqual([behavior === "allow"]);
      expect(h.events).toEqual(behavior === "allow" ? ["0:start", "0:finish"] : []);
      expect(h.writeLock.locked).toBe(false);
    } finally {
      await h.close();
    }
  });
});

mockWorkerHostForSdkStream();
