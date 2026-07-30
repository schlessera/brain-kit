import { expect, test, describe } from "bun:test";
import type { query, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@brainform/ui-sdk";
import type {
  BackendBridge,
  PermissionDecision,
  StartTurnRequest,
} from "@brainform/ui-sdk/server";
import {
  BackendBusyError,
  BackendRequestError,
  createWriteLock,
} from "@brainform/ui-sdk/server";
import { createClaudeBackend } from "../src/backend";

type Gen = (options: Options) => AsyncGenerator<unknown>;

function makeQueryFn(gen: Gen): typeof query {
  return ((params: { prompt: unknown; options?: Options }) =>
    gen(params.options ?? ({} as Options))) as unknown as typeof query;
}

/** Blocks until the SDK abortController fires, then throws like the real SDK. */
async function* abortableGen(options: Options): AsyncGenerator<unknown> {
  await new Promise<void>((_resolve, reject) => {
    const sig = options.abortController?.signal;
    if (sig?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    sig?.addEventListener(
      "abort",
      () => reject(new DOMException("Aborted", "AbortError")),
      { once: true }
    );
  });
}

function makeBridge(
  permission: PermissionDecision = { behavior: "allow" }
): { frames: ServerMessage[]; bridge: BackendBridge } {
  const frames: ServerMessage[] = [];
  return {
    frames,
    bridge: {
      emit: (m) => frames.push(m),
      requestPermission: async () => permission,
    },
  };
}

function makeReq(
  bridge: BackendBridge,
  signal: AbortSignal,
  extra?: Partial<StartTurnRequest>
): StartTurnRequest {
  return { prompt: "hi", signal, bridge, ...extra };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Spin until `pred` holds, so a test never races a background acquire/emit. */
async function until(pred: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("until: condition never became true");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A hand-driven stand-in for one SDK query() stream: the test pushes SDK
 * messages and closes it on its own schedule, so two turns can be interleaved
 * deterministically. Single-consumer by construction (one per turn).
 */
class Channel {
  private queue: unknown[] = [];
  private waiting: ((r: IteratorResult<unknown>) => void) | null = null;
  private closed = false;

  push(msg: unknown): void {
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w({ value: undefined, done: true });
    }
  }

  async *stream(): AsyncGenerator<unknown> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift();
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<unknown>>((res) => {
        this.waiting = res;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

/** A queryFn that hands out one Channel per call, in order. */
function channelQueryFn(channels: Channel[]): typeof query {
  let call = 0;
  return ((_params: { prompt: unknown; options?: Options }) => {
    const ch = channels[call++];
    if (!ch) throw new Error(`unexpected query() call #${call}`);
    return ch.stream();
  }) as unknown as typeof query;
}

const initMsg = (sessionId: string) => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
});
const textMsg = (sessionId: string, text: string) => ({
  type: "stream_event",
  session_id: sessionId,
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const resultMsg = (sessionId: string) => ({
  type: "result",
  subtype: "success",
  session_id: sessionId,
  total_cost_usd: 0,
  duration_ms: 1,
  num_turns: 1,
});

/**
 * A turn that asks permission for one tool, then (when a gate opens) streams
 * its tool_result and finishes. `onResolved` fires the instant the backend's
 * canUseTool resolves — for an approved MUTATING tool that is exactly when the
 * write lock was acquired, so tests can observe blocking.
 */
function toolTurn(
  options: Options,
  cfg: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    gate: Promise<void>;
    onResolved?: () => void;
  }
): AsyncGenerator<unknown> {
  return (async function* () {
    yield initMsg(cfg.sessionId);
    await options.canUseTool!(cfg.toolName, { arg: 1 }, {
      signal: new AbortController().signal,
      toolUseID: cfg.toolUseId,
    } as never);
    cfg.onResolved?.();
    await cfg.gate;
    yield {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: cfg.toolUseId, content: "ok" },
        ],
      },
    };
    yield resultMsg(cfg.sessionId);
  })();
}

/** Invoke the backend's PreToolUse hook the way the SDK would. */
function firePreToolUse(
  options: Options,
  cfg: { toolName: string; toolUseId: string }
): Promise<unknown> {
  const matcher = options.hooks?.PreToolUse?.[0];
  if (!matcher) throw new Error("no PreToolUse hook registered");
  return matcher.hooks[0]!(
    {
      hook_event_name: "PreToolUse",
      tool_name: cfg.toolName,
      tool_input: { arg: 1 },
      tool_use_id: cfg.toolUseId,
    } as never,
    cfg.toolUseId,
    { signal: new AbortController().signal }
  );
}

/** Invoke the backend's PermissionDenied hook the way the SDK would. */
function firePermissionDenied(
  options: Options,
  toolUseId: string
): Promise<unknown> {
  const matcher = options.hooks?.PermissionDenied?.[0];
  if (!matcher) throw new Error("no PermissionDenied hook registered");
  return matcher.hooks[0]!(
    { hook_event_name: "PermissionDenied" } as never,
    toolUseId,
    { signal: new AbortController().signal }
  );
}

/**
 * A turn whose mutating tool is AUTO-ALLOWED (allowlisted): the SDK never
 * calls canUseTool, only the PreToolUse hook, then executes. `onAcquired`
 * fires when the hook resolves — i.e. when the write lock was taken.
 */
function autoAllowedToolTurn(
  options: Options,
  cfg: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    gate: Promise<void>;
    onAcquired?: () => void;
  }
): AsyncGenerator<unknown> {
  return (async function* () {
    yield initMsg(cfg.sessionId);
    await firePreToolUse(options, cfg);
    cfg.onAcquired?.();
    await cfg.gate;
    yield {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: cfg.toolUseId, content: "ok" },
        ],
      },
    };
    yield resultMsg(cfg.sessionId);
  })();
}

describe("createClaudeBackend identity + profiles", () => {
  test("id and capabilities", () => {
    const backend = createClaudeBackend({ brainPath: "/brain" });
    expect(backend.id).toBe("claude");
    expect(backend.capabilities).toEqual({
      resume: true,
      permissions: true,
      thinking: true,
      attachments: true,
      askUser: true,
      costReporting: true,
      concurrentSessions: true,
      followUp: false,
    });
  });

  test("listProfiles returns the built-in claude profile by default", () => {
    const backend = createClaudeBackend({ brainPath: "/brain" });
    expect(backend.listProfiles()).toEqual([
      { id: "claude", label: "Claude", vendor: "anthropic" },
    ]);
  });
});

describe("startTurn", () => {
  test("unknown profileId rejects with BackendRequestError", async () => {
    const backend = createClaudeBackend({
      brainPath: "/brain",
      queryFn: makeQueryFn(abortableGen),
    });
    const { bridge } = makeBridge();
    await expect(
      backend.startTurn(
        makeReq(bridge, new AbortController().signal, { profileId: "nope" })
      )
    ).rejects.toBeInstanceOf(BackendRequestError);
  });

  test("host abort emits a cancelled status and resolves", async () => {
    const backend = createClaudeBackend({
      brainPath: "/brain",
      queryFn: makeQueryFn(abortableGen),
    });
    const controller = new AbortController();
    const { frames, bridge } = makeBridge();
    const turn = backend.startTurn(makeReq(bridge, controller.signal));
    await Promise.resolve();
    controller.abort();
    await turn;

    expect(frames).toContainEqual({ type: "status", status: "cancelled" });
    expect(frames.some((f) => f.type === "error")).toBe(false);
  });

  test("emits session_info before content and forwards result frames", async () => {
    async function* successGen(): AsyncGenerator<unknown> {
      yield initMsg("sess-1");
      yield resultMsg("sess-1");
    }
    const backend = createClaudeBackend({
      brainPath: "/brain",
      queryFn: makeQueryFn(successGen),
    });
    const { frames, bridge } = makeBridge();
    await backend.startTurn(makeReq(bridge, new AbortController().signal));

    expect(frames[0]).toEqual({
      type: "session_info",
      sessionId: "sess-1",
      isNew: true,
      providerId: "claude",
    });
    expect(frames).toContainEqual({
      type: "result",
      sessionId: "sess-1",
      costUsd: 0,
      durationMs: 1,
      numTurns: 1,
      isError: false,
    });
    expect(frames.at(-1)).toEqual({
      type: "status",
      status: "idle",
      sessionId: "sess-1",
    });
  });

  test("runtime failure surfaces a CLAUDE_ERROR frame and resolves", async () => {
    async function* boomGen(): AsyncGenerator<unknown> {
      throw new Error("provider unreachable");
      yield undefined; // unreachable; makes this a generator
    }
    const backend = createClaudeBackend({
      brainPath: "/brain",
      queryFn: makeQueryFn(boomGen),
    });
    const { frames, bridge } = makeBridge();
    await backend.startTurn(makeReq(bridge, new AbortController().signal));

    expect(frames).toContainEqual({
      type: "error",
      code: "CLAUDE_ERROR",
      message: "provider unreachable",
    });
  });
});

describe("per-session concurrency", () => {
  test("two concurrent new-session turns run in parallel with distinct sessionIds", async () => {
    const chA = new Channel();
    const chB = new Channel();
    const backend = createClaudeBackend({
      brainPath: "/brain",
      queryFn: channelQueryFn([chA, chB]),
    });

    const a = makeBridge();
    const b = makeBridge();
    // Both are NEW turns (no sessionId). Neither may reject: busy-ness is per
    // session and these have distinct (placeholder) identities.
    const turnA = backend.startTurn(makeReq(a.bridge, new AbortController().signal));
    const turnB = backend.startTurn(makeReq(b.bridge, new AbortController().signal));

    // Interleave frames from both live turns.
    chA.push(initMsg("sess-A"));
    chB.push(initMsg("sess-B"));
    chA.push(textMsg("sess-A", "A1"));
    chB.push(textMsg("sess-B", "B1"));
    chB.push(resultMsg("sess-B"));
    chA.push(resultMsg("sess-A"));
    chA.close();
    chB.close();

    await Promise.all([turnA, turnB]);

    // Each turn announced its own new session id first.
    expect(a.frames[0]).toMatchObject({
      type: "session_info",
      sessionId: "sess-A",
      isNew: true,
    });
    expect(b.frames[0]).toMatchObject({
      type: "session_info",
      sessionId: "sess-B",
      isNew: true,
    });
    // Content frames carry the scoping id — and never cross-contaminate.
    expect(a.frames.find((f) => f.type === "text_delta")).toMatchObject({
      text: "A1",
      sessionId: "sess-A",
    });
    expect(b.frames.find((f) => f.type === "text_delta")).toMatchObject({
      text: "B1",
      sessionId: "sess-B",
    });
    expect(a.frames.every((f) => !("sessionId" in f) || f.sessionId === "sess-A")).toBe(true);
    expect(b.frames.every((f) => !("sessionId" in f) || f.sessionId === "sess-B")).toBe(true);
    // Both reached a terminal result.
    expect(a.frames.some((f) => f.type === "result")).toBe(true);
    expect(b.frames.some((f) => f.type === "result")).toBe(true);
  });

  test("resuming a session with a running turn rejects BackendBusyError; recovers after", async () => {
    const ch1 = new Channel();
    const ch2 = new Channel();
    const backend = createClaudeBackend({
      brainPath: "/brain",
      queryFn: channelQueryFn([ch1, ch2]),
    });

    const a = makeBridge();
    const turn1 = backend.startTurn(makeReq(a.bridge, new AbortController().signal));
    // Let the SDK assign the id so the busy slot is re-keyed to sess-1.
    ch1.push(initMsg("sess-1"));
    await until(() => a.frames.some((f) => f.type === "session_info"));

    // A resume of sess-1 while turn1 still runs must reject and emit nothing.
    const b = makeBridge();
    await expect(
      backend.startTurn(
        makeReq(b.bridge, new AbortController().signal, { sessionId: "sess-1" })
      )
    ).rejects.toBeInstanceOf(BackendBusyError);
    expect(b.frames).toHaveLength(0);

    // Drain turn1 → the slot frees.
    ch1.push(resultMsg("sess-1"));
    ch1.close();
    await turn1;

    // Resuming sess-1 now succeeds.
    const c = makeBridge();
    const turn3 = backend.startTurn(
      makeReq(c.bridge, new AbortController().signal, { sessionId: "sess-1" })
    );
    ch2.push(initMsg("sess-1"));
    ch2.push(resultMsg("sess-1"));
    ch2.close();
    await turn3;

    expect(c.frames.find((f) => f.type === "session_info")).toMatchObject({
      type: "session_info",
      sessionId: "sess-1",
      isNew: false,
    });
    expect(c.frames.some((f) => f.type === "result")).toBe(true);
  });
});

describe("writeLock", () => {
  test("a second turn's mutating-tool approval blocks until the first's tool_result", async () => {
    const writeLock = createWriteLock();
    const gate1 = deferred();
    const gate2 = deferred();
    let t1Resolved = false;
    let t2Resolved = false;

    let call = 0;
    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      return call++ === 0
        ? toolTurn(options, {
            sessionId: "s1",
            toolUseId: "t1",
            toolName: "Bash",
            gate: gate1.promise,
            onResolved: () => (t1Resolved = true),
          })
        : toolTurn(options, {
            sessionId: "s2",
            toolUseId: "t2",
            toolName: "Edit",
            gate: gate2.promise,
            onResolved: () => (t2Resolved = true),
          });
    }) as unknown as typeof query;

    const backend = createClaudeBackend({ brainPath: "/brain", queryFn, writeLock });

    const b1 = makeBridge();
    const turn1 = backend.startTurn(makeReq(b1.bridge, new AbortController().signal));
    await until(() => t1Resolved); // turn1 holds the write lock
    expect(writeLock.locked).toBe(true);

    const b2 = makeBridge();
    const turn2 = backend.startTurn(makeReq(b2.bridge, new AbortController().signal));
    // turn2's mutating approval must park on the held lock.
    await tick();
    await tick();
    expect(t2Resolved).toBe(false);

    // turn1 emits its tool_result → lock releases → turn2 acquires.
    gate1.resolve();
    await turn1;
    await until(() => t2Resolved);
    expect(t2Resolved).toBe(true);

    gate2.resolve();
    await turn2;
    expect(writeLock.locked).toBe(false);
  });

  test("read-only tool approval does not take the lock (never blocks)", async () => {
    const writeLock = createWriteLock();
    const gate1 = deferred();
    const gate2 = deferred();
    let t1Resolved = false;
    let t2Resolved = false;

    let call = 0;
    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      return call++ === 0
        ? toolTurn(options, {
            sessionId: "s1",
            toolUseId: "t1",
            toolName: "Bash", // mutating: holds the lock
            gate: gate1.promise,
            onResolved: () => (t1Resolved = true),
          })
        : toolTurn(options, {
            sessionId: "s2",
            toolUseId: "t2",
            toolName: "Read", // read-only: must skip the lock
            gate: gate2.promise,
            onResolved: () => (t2Resolved = true),
          });
    }) as unknown as typeof query;

    const backend = createClaudeBackend({ brainPath: "/brain", queryFn, writeLock });

    const b1 = makeBridge();
    const turn1 = backend.startTurn(makeReq(b1.bridge, new AbortController().signal));
    await until(() => t1Resolved);
    expect(writeLock.locked).toBe(true); // turn1's Bash holds it

    const b2 = makeBridge();
    const turn2 = backend.startTurn(makeReq(b2.bridge, new AbortController().signal));
    // Read is not gated, so it resolves even while the write lock is held.
    await until(() => t2Resolved);
    expect(t2Resolved).toBe(true);
    expect(writeLock.locked).toBe(true); // still only turn1's hold

    gate2.resolve();
    await turn2;
    gate1.resolve();
    await turn1;
    expect(writeLock.locked).toBe(false);
  });

  test("a denied mutating tool takes no lock and blocks nobody", async () => {
    const writeLock = createWriteLock();
    const gate1 = deferred();
    const gate2 = deferred();
    let t1Resolved = false;
    let t2Resolved = false;

    let call = 0;
    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      return call++ === 0
        ? toolTurn(options, {
            sessionId: "s1",
            toolUseId: "t1",
            toolName: "Bash",
            gate: gate1.promise,
            onResolved: () => (t1Resolved = true),
          })
        : toolTurn(options, {
            sessionId: "s2",
            toolUseId: "t2",
            toolName: "Bash",
            gate: gate2.promise,
            onResolved: () => (t2Resolved = true),
          });
    }) as unknown as typeof query;

    const backend = createClaudeBackend({ brainPath: "/brain", queryFn, writeLock });

    // turn1's bridge DENIES the mutating tool → no lock is taken.
    const b1 = makeBridge({ behavior: "deny", message: "nope" });
    const turn1 = backend.startTurn(makeReq(b1.bridge, new AbortController().signal));
    await until(() => t1Resolved);
    expect(writeLock.locked).toBe(false);

    // turn2 approves a mutating tool and must acquire immediately.
    const b2 = makeBridge();
    const turn2 = backend.startTurn(makeReq(b2.bridge, new AbortController().signal));
    await until(() => t2Resolved);
    expect(writeLock.locked).toBe(true); // only turn2 holds it

    gate1.resolve();
    gate2.resolve();
    await Promise.all([turn1, turn2]);
    expect(writeLock.locked).toBe(false);
  });

  test("auto-allowed mutating tool takes the lock via the PreToolUse hook (canUseTool never runs)", async () => {
    const writeLock = createWriteLock();
    const gate1 = deferred();
    const gate2 = deferred();
    let t1Acquired = false;
    let t2Acquired = false;

    let call = 0;
    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      return call++ === 0
        ? autoAllowedToolTurn(options, {
            sessionId: "s1",
            toolUseId: "t1",
            toolName: "Bash",
            gate: gate1.promise,
            onAcquired: () => (t1Acquired = true),
          })
        : autoAllowedToolTurn(options, {
            sessionId: "s2",
            toolUseId: "t2",
            toolName: "Edit",
            gate: gate2.promise,
            onAcquired: () => (t2Acquired = true),
          });
    }) as unknown as typeof query;

    const backend = createClaudeBackend({ brainPath: "/brain", queryFn, writeLock });

    const b1 = makeBridge();
    const turn1 = backend.startTurn(makeReq(b1.bridge, new AbortController().signal));
    await until(() => t1Acquired);
    expect(writeLock.locked).toBe(true);

    // Second turn's auto-allowed mutating tool must park on the held lock.
    const b2 = makeBridge();
    const turn2 = backend.startTurn(makeReq(b2.bridge, new AbortController().signal));
    await tick();
    await tick();
    expect(t2Acquired).toBe(false);

    // turn1's tool_result streams → lock frees → turn2's hook resolves.
    gate1.resolve();
    await turn1;
    await until(() => t2Acquired);

    gate2.resolve();
    await turn2;
    expect(writeLock.locked).toBe(false);
  });

  test("read-only tool never matches the PreToolUse lock hook", async () => {
    const writeLock = createWriteLock();
    let hookRan = false;

    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      return (async function* () {
        yield initMsg("s1");
        await firePreToolUse(options, { toolName: "Read", toolUseId: "t1" });
        hookRan = true;
        yield resultMsg("s1");
      })();
    }) as unknown as typeof query;

    const backend = createClaudeBackend({ brainPath: "/brain", queryFn, writeLock });
    const b1 = makeBridge();
    await backend.startTurn(makeReq(b1.bridge, new AbortController().signal));

    expect(hookRan).toBe(true);
    expect(writeLock.locked).toBe(false);
  });

  test("canUseTool parks a hook-held lock during the approval wait, re-acquires on allow", async () => {
    const writeLock = createWriteLock();
    let approvalPending: (() => void) | null = null;
    let decisionResolved = false;

    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      return (async function* () {
        yield initMsg("s1");
        // Real SDK order: PreToolUse hook first (acquires), then canUseTool.
        await firePreToolUse(options, { toolName: "Bash", toolUseId: "t1" });
        await options.canUseTool!("Bash", { arg: 1 }, {
          signal: new AbortController().signal,
          toolUseID: "t1",
        } as never);
        decisionResolved = true;
        yield {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
        };
        yield resultMsg("s1");
      })();
    }) as unknown as typeof query;

    const frames: ServerMessage[] = [];
    const bridge: BackendBridge = {
      emit: (m) => frames.push(m),
      requestPermission: () =>
        new Promise((resolve) => {
          approvalPending = () => resolve({ behavior: "allow" });
        }),
    };

    const backend = createClaudeBackend({ brainPath: "/brain", queryFn, writeLock });
    const turn = backend.startTurn(makeReq(bridge, new AbortController().signal));

    // While the approval is pending, the hook-taken lock must be RELEASED.
    await until(() => approvalPending !== null);
    expect(writeLock.locked).toBe(false);

    // Approve → the lock is re-acquired for execution, then freed on result.
    approvalPending!();
    await until(() => decisionResolved);
    await turn;
    expect(writeLock.locked).toBe(false);
    expect(frames.some((f) => f.type === "result")).toBe(true);
  });

  test("PermissionDenied hook frees a lock the PreToolUse hook took", async () => {
    const writeLock = createWriteLock();
    let denied = false;

    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      return (async function* () {
        yield initMsg("s1");
        // A settings deny rule: hook acquires, then the deny path fires
        // without canUseTool ever running.
        await firePreToolUse(options, { toolName: "Write", toolUseId: "t1" });
        await firePermissionDenied(options, "t1");
        denied = true;
        yield resultMsg("s1");
      })();
    }) as unknown as typeof query;

    const backend = createClaudeBackend({ brainPath: "/brain", queryFn, writeLock });
    const b1 = makeBridge();
    await backend.startTurn(makeReq(b1.bridge, new AbortController().signal));

    expect(denied).toBe(true);
    expect(writeLock.locked).toBe(false);
  });

  test("turn-end backstop releases a lock whose tool_result never streamed", async () => {
    const writeLock = createWriteLock();
    let t1Resolved = false;
    const abort1 = new AbortController();

    let call = 0;
    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      if (call++ === 0) {
        // Acquire the lock for a mutating tool, then hang until aborted — the
        // tool_result never streams, so only the turn-end backstop can free it.
        return (async function* () {
          yield initMsg("s1");
          await options.canUseTool!("Write", { path: "x" }, {
            signal: new AbortController().signal,
            toolUseID: "t1",
          } as never);
          t1Resolved = true;
          await new Promise<void>((_res, rej) => {
            const sig = options.abortController?.signal;
            if (sig?.aborted) return rej(new DOMException("Aborted", "AbortError"));
            sig?.addEventListener(
              "abort",
              () => rej(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          });
        })();
      }
      return (async function* () {
        yield initMsg("s2");
        await options.canUseTool!("Write", { path: "y" }, {
          signal: new AbortController().signal,
          toolUseID: "t2",
        } as never);
        yield {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }],
          },
        };
        yield resultMsg("s2");
      })();
    }) as unknown as typeof query;

    const backend = createClaudeBackend({ brainPath: "/brain", queryFn, writeLock });

    const b1 = makeBridge();
    const turn1 = backend.startTurn(makeReq(b1.bridge, abort1.signal));
    await until(() => t1Resolved);
    expect(writeLock.locked).toBe(true);

    // Abort before any tool_result — the finally backstop must release.
    abort1.abort();
    await turn1;
    expect(writeLock.locked).toBe(false);

    // A later mutating turn acquires cleanly, proving the lock was freed.
    const b2 = makeBridge();
    const turn2 = backend.startTurn(makeReq(b2.bridge, new AbortController().signal));
    await turn2;
    expect(b2.frames.some((f) => f.type === "result")).toBe(true);
    expect(writeLock.locked).toBe(false);
  });
});
