import { expect, test, describe } from "bun:test";
import type { query, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@schlessera/brain-ui-sdk";
import type {
  BackendBridge,
  PermissionDecision,
  StartTurnRequest,
} from "@schlessera/brain-ui-sdk/server";
import {
  BackendBusyError,
  BackendRequestError,
  createKeyedLock,
} from "@schlessera/brain-ui-sdk/server";
import {
  BRAIN_LOCK_KEY,
  GIT_LOCK_KEY,
  createClaudeBackend,
  lockKeyForTool,
} from "../src/backend";
import { defineProfiles } from "../src/profiles";

type Gen = (options: Options) => AsyncGenerator<unknown>;

function makeQueryFn(gen: Gen): typeof query {
  return ((params: { prompt: unknown; options?: Options }) =>
    gen(params.options ?? ({} as Options))) as unknown as typeof query;
}

/** Blocks until the SDK abortController fires, then throws like the real SDK. */
// oxlint-disable-next-line require-yield -- mock generator: only blocks/throws, never yields
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
    input?: Record<string, unknown>;
    gate: Promise<void>;
    onResolved?: () => void;
  }
): AsyncGenerator<unknown> {
  return (async function* () {
    yield initMsg(cfg.sessionId);
    await options.canUseTool!(cfg.toolName, cfg.input ?? { arg: 1 }, {
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
  cfg: { toolName: string; toolUseId: string; input?: Record<string, unknown> }
): Promise<unknown> {
  const matcher = options.hooks?.PreToolUse?.[0];
  if (!matcher) throw new Error("no PreToolUse hook registered");
  return matcher.hooks[0]!(
    {
      hook_event_name: "PreToolUse",
      tool_name: cfg.toolName,
      tool_input: cfg.input ?? { arg: 1 },
      tool_use_id: cfg.toolUseId,
    } as never,
    cfg.toolUseId,
    { signal: new AbortController().signal }
  );
}

/** Invoke the backend's Agent-rewrite PreToolUse hook the way the SDK would. */
function fireAgentPreToolUse(
  options: Options,
  input: Record<string, unknown>
): Promise<unknown> {
  const matcher = options.hooks?.PreToolUse?.[1];
  if (!matcher) throw new Error("no Agent PreToolUse hook registered");
  return matcher.hooks[0]!(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: input,
      tool_use_id: "agent-1",
    } as never,
    "agent-1",
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
    input?: Record<string, unknown>;
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
      autonomous: true,
      resume: true,
      permissions: true,
      thinking: true,
      attachments: true,
      askUser: true,
      costReporting: true,
      concurrentSessions: true,
      followUp: true,
    });
  });

  test("listProfiles returns the built-in claude profile by default", () => {
    const backend = createClaudeBackend({ brainPath: "/brain" });
    expect(backend.listProfiles()).toEqual([
      { id: "claude", label: "Claude", vendor: "anthropic", thinkingLevel: "medium", supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
    ]);
  });

  test("profile-declared auth and API key names reach the Agent SDK subprocess environment", async () => {
    const authName = "CUSTOM_PROFILE_AUTH_TOKEN";
    const apiName = "CUSTOM_PROFILE_API_KEY";
    const siblingName = "UNDECLARED_PROFILE_CREDENTIAL";
    const previousAuth = process.env[authName];
    const previousApi = process.env[apiName];
    const previousSibling = process.env[siblingName];
    process.env[authName] = "profile-auth-test-token";
    process.env[apiName] = "profile-api-test-key";
    process.env[siblingName] = "must-not-pass";
    let captured: Options | undefined;
    const queryFn = ((params: { options?: Options }) => {
      captured = params.options;
      return (async function* () {
        yield initMsg("profile-env-session");
        yield resultMsg("profile-env-session");
      })();
    }) as unknown as typeof query;

    try {
      const backend = createClaudeBackend({
        brainPath: "/brain",
        profiles: defineProfiles([
          {
            id: "custom",
            label: "Custom",
            authTokenEnv: authName,
            apiKeyEnv: apiName,
          },
        ]),
        queryFn,
      });
      const { bridge } = makeBridge();
      await backend.startTurn(
        makeReq(bridge, new AbortController().signal, { profileId: "custom" })
      );

      expect(captured?.env?.[authName]).toBe("profile-auth-test-token");
      expect(captured?.env?.[apiName]).toBe("profile-api-test-key");
      expect(captured?.env?.ANTHROPIC_AUTH_TOKEN).toBe(
        "profile-auth-test-token"
      );
      expect(captured?.env?.ANTHROPIC_API_KEY).toBe("profile-api-test-key");
      expect(captured?.env?.[siblingName]).toBeUndefined();
    } finally {
      if (previousAuth === undefined) delete process.env[authName];
      else process.env[authName] = previousAuth;
      if (previousApi === undefined) delete process.env[apiName];
      else process.env[apiName] = previousApi;
      if (previousSibling === undefined) delete process.env[siblingName];
      else process.env[siblingName] = previousSibling;
    }
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
    // No session identity was ever established, so the turn's terminal frame
    // is a bare error (a `result` needs a sessionId). Without it a client
    // keying on result/error would hang forever.
    const last = frames.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") expect(last.code).toBe("CANCELLED");
    expect(frames.some((f) => f.type === "result")).toBe(false);
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
      backendId: "claude",
    });
    expect(frames).toContainEqual({
      type: "result",
      sessionId: "sess-1",
      outcome: "success",
      costUsd: 0,
      durationMs: 1,
      numTurns: 1,
      isError: false,
    });
    // result is THE terminal frame — last on the wire; idle precedes it.
    expect(frames.at(-2)).toEqual({
      type: "status",
      status: "idle",
      sessionId: "sess-1",
    });
    expect(frames.at(-1)?.type).toBe("result");
  });

  test("runtime failure surfaces a CLAUDE_ERROR frame and resolves", async () => {
    async function* boomGen(): AsyncGenerator<unknown> {
      throw new Error("provider unreachable");
      // oxlint-disable-next-line no-unreachable -- the dead yield is what makes this a generator
      yield undefined;
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
    const writeLock = createKeyedLock();
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
            input: { command: "git add notes/a.md" },
            gate: gate1.promise,
            onResolved: () => (t1Resolved = true),
          })
        : toolTurn(options, {
            sessionId: "s2",
            toolUseId: "t2",
            toolName: "Bash",
            input: { command: "git commit -m update" },
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
    const writeLock = createKeyedLock();
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
            toolName: "Bash", // git-class: holds the repo-git lock
            input: { command: "git add ." },
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
    const writeLock = createKeyedLock();
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
            input: { command: "git add ." },
            gate: gate1.promise,
            onResolved: () => (t1Resolved = true),
          })
        : toolTurn(options, {
            sessionId: "s2",
            toolUseId: "t2",
            toolName: "Bash",
            input: { command: "git commit -m x" },
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
    const writeLock = createKeyedLock();
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
            input: { command: "git add ." },
            gate: gate1.promise,
            onAcquired: () => (t1Acquired = true),
          })
        : autoAllowedToolTurn(options, {
            sessionId: "s2",
            toolUseId: "t2",
            toolName: "Bash",
            input: { command: "git commit -m x" },
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
    const writeLock = createKeyedLock();
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
    const writeLock = createKeyedLock();
    let approvalPending: (() => void) | null = null;
    let decisionResolved = false;

    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      return (async function* () {
        yield initMsg("s1");
        // Real SDK order: PreToolUse hook first (acquires), then canUseTool.
        await firePreToolUse(options, {
          toolName: "Bash",
          toolUseId: "t1",
          input: { command: "git add ." },
        });
        await options.canUseTool!("Bash", { command: "git add ." }, {
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
    const writeLock = createKeyedLock();
    let denied = false;

    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      return (async function* () {
        yield initMsg("s1");
        // A settings deny rule: hook acquires, then the deny path fires
        // without canUseTool ever running.
        await firePreToolUse(options, {
          toolName: "Write",
          toolUseId: "t1",
          input: { file_path: "notes/a.md" },
        });
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
    const writeLock = createKeyedLock();
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
          await options.canUseTool!("Write", { file_path: "x" }, {
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
        await options.canUseTool!("Write", { file_path: "y" }, {
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

describe("brain MCP tools", () => {
  /** Run one no-op turn and hand back the Options the SDK was called with. */
  async function captureOptions(): Promise<Options> {
    let captured: Options | undefined;
    const queryFn = ((params: { options?: Options }) => {
      captured = params.options!;
      return (async function* () {
        yield initMsg("s1");
        yield resultMsg("s1");
      })();
    }) as unknown as typeof query;

    const backend = createClaudeBackend({ brainPath: "/brain", queryFn });
    const b1 = makeBridge();
    await backend.startTurn(makeReq(b1.bridge, new AbortController().signal));
    return captured!;
  }

  test("the brain's document tools are auto-allowed", async () => {
    const options = await captureOptions();
    for (const tool of [
      "brain_search",
      "brain_context",
      "brain_read",
      "brain_list",
      "brain_graph",
      "brain_add",
      "brain_update",
    ]) {
      expect(options.allowedTools).toContain(`mcp__brain__${tool}`);
    }
  });

  test("brain_archive is NOT auto-allowed — it moves files and keeps its approval card", async () => {
    const options = await captureOptions();
    expect(options.allowedTools).not.toContain("mcp__brain__brain_archive");
  });

  test("every brain tool that writes takes the write lock, auto-allowed or not", async () => {
    // brain_archive prompts, but once approved it mutates exactly like the
    // other two — the lock hook must fire for all three.
    for (const tool of ["brain_add", "brain_update", "brain_archive"]) {
      const writeLock = createKeyedLock();
      const queryFn = ((params: { options?: Options }) => {
        const options = params.options!;
        return (async function* () {
          yield initMsg("s1");
          await firePreToolUse(options, {
            toolName: `mcp__brain__${tool}`,
            toolUseId: "t1",
          });
          expect(writeLock.locked).toBe(true);
          yield {
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: "t1", content: "ok" },
              ],
            },
          };
          yield resultMsg("s1");
        })();
      }) as unknown as typeof query;

      const backend = createClaudeBackend({ brainPath: "/brain", queryFn, writeLock });
      const b1 = makeBridge();
      await backend.startTurn(makeReq(b1.bridge, new AbortController().signal));
      expect(writeLock.locked).toBe(false);
    }
  });

  test("a brain read tool never takes the write lock", async () => {
    const writeLock = createKeyedLock();
    let hookRan = false;
    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      return (async function* () {
        yield initMsg("s1");
        await firePreToolUse(options, {
          toolName: "mcp__brain__brain_read",
          toolUseId: "t1",
        });
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
});

describe("lockKeyForTool — the serialization policy", () => {
  const key = (tool: string, input: unknown) => lockKeyForTool(tool, input, "/brain");

  test("git staging/history commands take the repo-git key", () => {
    for (const command of [
      "git add notes/a.md",
      "git commit -m 'x'",
      "git -C /data/brain commit -m x",
      "cd /data/brain && git add . && git commit -m x",
      "git rebase -i HEAD~3",
      "git push origin main",
      "git checkout main",
      "git stash pop",
      "brain sync",
      "brain import ~/notes",
    ]) {
      expect(key("Bash", { command }), command).toBe(GIT_LOCK_KEY);
    }
  });

  test("git reads and ordinary commands take NO lock", () => {
    for (const command of [
      "git status",
      "git log --oneline -5",
      "git diff HEAD~1",
      "git show HEAD",
      "git branch -a",
      "bun run build",
      "curl -s https://example.com",
      "grep -r pattern notes",
      "ls -la",
      // A verb-looking word after a pipe must not classify: the segment guard.
      "git status | grep add",
    ]) {
      expect(key("Bash", { command }), command).toBeNull();
    }
  });

  test("brain CLI document commands take the brain-docs key", () => {
    expect(key("Bash", { command: "brain add 'note'" })).toBe(BRAIN_LOCK_KEY);
    expect(key("Bash", { command: "brain update x.md --status active" })).toBe(BRAIN_LOCK_KEY);
    expect(key("Bash", { command: "brain archive x.md" })).toBe(BRAIN_LOCK_KEY);
    // Reads stay lock-free.
    expect(key("Bash", { command: "brain search foo" })).toBeNull();
    expect(key("Bash", { command: "brain list --type note" })).toBeNull();
  });

  test("path tools take a per-path key, normalized against the brain root", () => {
    expect(key("Write", { file_path: "/brain/notes/a.md" })).toBe("path:/brain/notes/a.md");
    expect(key("Edit", { file_path: "notes/a.md" })).toBe("path:/brain/notes/a.md");
    expect(key("NotebookEdit", { notebook_path: "/brain/n.ipynb" })).toBe("path:/brain/n.ipynb");
    // Same file, different spelling → same key.
    expect(key("Write", { file_path: "/brain/notes/../notes/a.md" })).toBe(
      "path:/brain/notes/a.md"
    );
    // Different files → different keys (the whole point).
    expect(key("Write", { file_path: "/brain/notes/b.md" })).not.toBe(
      key("Write", { file_path: "/brain/notes/a.md" })
    );
  });

  test("a path tool without a usable path takes no lock", () => {
    expect(key("Write", { arg: 1 })).toBeNull();
    expect(key("Edit", {})).toBeNull();
    expect(key("Write", null)).toBeNull();
  });

  test("brain document MCP tools share the brain-docs key", () => {
    for (const tool of ["brain_add", "brain_update", "brain_archive"]) {
      expect(key(`mcp__brain__${tool}`, {})).toBe(BRAIN_LOCK_KEY);
    }
  });

  test("read tools and unknown tools take no lock", () => {
    expect(key("Read", { file_path: "/brain/a.md" })).toBeNull();
    expect(key("Glob", { pattern: "*" })).toBeNull();
    expect(key("mcp__brain__brain_search", { query: "x" })).toBeNull();
  });

  test("writes to DIFFERENT files never contend, even across sessions", async () => {
    const writeLock = createKeyedLock();
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
            toolName: "Write",
            input: { file_path: "/brain/notes/a.md" },
            gate: gate1.promise,
            onResolved: () => (t1Resolved = true),
          })
        : toolTurn(options, {
            sessionId: "s2",
            toolUseId: "t2",
            toolName: "Write",
            input: { file_path: "/brain/notes/b.md" },
            gate: gate2.promise,
            onResolved: () => (t2Resolved = true),
          });
    }) as unknown as typeof query;

    const backend = createClaudeBackend({ brainPath: "/brain", queryFn, writeLock });

    const b1 = makeBridge();
    const turn1 = backend.startTurn(makeReq(b1.bridge, new AbortController().signal));
    await until(() => t1Resolved);
    expect(writeLock.heldKeys).toEqual(["path:/brain/notes/a.md"]);

    // The second write targets a different file: it must NOT park behind the
    // first — this is the single-session-collapse regression guard.
    const b2 = makeBridge();
    const turn2 = backend.startTurn(makeReq(b2.bridge, new AbortController().signal));
    await until(() => t2Resolved);
    expect(writeLock.heldKeys.sort()).toEqual([
      "path:/brain/notes/a.md",
      "path:/brain/notes/b.md",
    ]);

    gate1.resolve();
    gate2.resolve();
    await Promise.all([turn1, turn2]);
    expect(writeLock.locked).toBe(false);
  });

  test("a non-git Bash command takes no lock and never parks behind one", async () => {
    const writeLock = createKeyedLock();
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
            input: { command: "git add ." },
            gate: gate1.promise,
            onAcquired: () => (t1Acquired = true),
          })
        : autoAllowedToolTurn(options, {
            sessionId: "s2",
            toolUseId: "t2",
            toolName: "Bash",
            input: { command: "bun run build" },
            gate: gate2.promise,
            onAcquired: () => (t2Acquired = true),
          });
    }) as unknown as typeof query;

    const backend = createClaudeBackend({ brainPath: "/brain", queryFn, writeLock });

    const b1 = makeBridge();
    const turn1 = backend.startTurn(makeReq(b1.bridge, new AbortController().signal));
    await until(() => t1Acquired);
    expect(writeLock.heldKeys).toEqual([GIT_LOCK_KEY]);

    // The build command is lock-free: it must proceed while git is held.
    const b2 = makeBridge();
    const turn2 = backend.startTurn(makeReq(b2.bridge, new AbortController().signal));
    await until(() => t2Acquired);
    expect(writeLock.heldKeys).toEqual([GIT_LOCK_KEY]);

    gate1.resolve();
    gate2.resolve();
    await Promise.all([turn1, turn2]);
  });
});

describe("bounded lock wait", () => {
  test("a waiter past lockWaitMs is DENIED with a retryable reason, not stalled", async () => {
    const writeLock = createKeyedLock();
    const gate1 = deferred();
    let t1Acquired = false;
    let hookOutput: unknown;

    let call = 0;
    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      return call++ === 0
        ? autoAllowedToolTurn(options, {
            sessionId: "s1",
            toolUseId: "t1",
            toolName: "Bash",
            input: { command: "git add ." },
            gate: gate1.promise,
            onAcquired: () => (t1Acquired = true),
          })
        : (async function* () {
            yield initMsg("s2");
            hookOutput = await firePreToolUse(options, {
              toolName: "Bash",
              toolUseId: "t2",
              input: { command: "git commit -m x" },
            });
            yield resultMsg("s2");
          })();
    }) as unknown as typeof query;

    const warns: string[] = [];
    const backend = createClaudeBackend({
      brainPath: "/brain",
      queryFn,
      writeLock,
      lockWaitMs: 25,
      log: (level, message) => {
        if (level === "warn") warns.push(message);
      },
    });

    const b1 = makeBridge();
    const turn1 = backend.startTurn(makeReq(b1.bridge, new AbortController().signal));
    await until(() => t1Acquired);

    const b2 = makeBridge();
    const turn2 = backend.startTurn(makeReq(b2.bridge, new AbortController().signal));
    await turn2;

    const out = hookOutput as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("retry");
    expect(warns.some((w) => w.includes("lock wait exceeded"))).toBe(true);

    // The holder is unaffected and still releases normally.
    gate1.resolve();
    await turn1;
    expect(writeLock.locked).toBe(false);
  });

  test("canUseTool denies with the same retryable reason when the lock stays busy", async () => {
    const writeLock = createKeyedLock();
    const hold = await writeLock.acquire(GIT_LOCK_KEY);
    let result: unknown;

    const queryFn = ((params: { options?: Options }) => {
      const options = params.options!;
      return (async function* () {
        yield initMsg("s1");
        result = await options.canUseTool!("Bash", { command: "git add ." }, {
          signal: new AbortController().signal,
          toolUseID: "t1",
        } as never);
        yield resultMsg("s1");
      })();
    }) as unknown as typeof query;

    const backend = createClaudeBackend({
      brainPath: "/brain",
      queryFn,
      writeLock,
      lockWaitMs: 25,
    });
    const b1 = makeBridge();
    await backend.startTurn(makeReq(b1.bridge, new AbortController().signal));

    const decision = result as { behavior: string; message?: string };
    expect(decision.behavior).toBe("deny");
    expect(decision.message).toContain("retry");
    hold();
  });
});

describe("Agent background rewrite", () => {
  async function captureOptions(): Promise<Options> {
    let captured: Options | undefined;
    const queryFn = ((params: { options?: Options }) => {
      captured = params.options!;
      return (async function* () {
        yield initMsg("s1");
        yield resultMsg("s1");
      })();
    }) as unknown as typeof query;
    const backend = createClaudeBackend({ brainPath: "/brain", queryFn });
    const b1 = makeBridge();
    await backend.startTurn(makeReq(b1.bridge, new AbortController().signal));
    return captured!;
  }

  test("a backgrounded (or default) Agent call is rewritten to foreground", async () => {
    const options = await captureOptions();
    for (const input of [
      { description: "x", prompt: "y" }, // background is the SDK DEFAULT
      { description: "x", prompt: "y", run_in_background: true },
    ]) {
      const out = (await fireAgentPreToolUse(options, input)) as {
        hookSpecificOutput?: {
          permissionDecision?: string;
          updatedInput?: Record<string, unknown>;
          additionalContext?: string;
        };
      };
      expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
      expect(out.hookSpecificOutput?.updatedInput?.run_in_background).toBe(false);
      expect(out.hookSpecificOutput?.updatedInput?.prompt).toBe("y");
      expect(out.hookSpecificOutput?.additionalContext).toContain("foreground");
    }
  });

  test("an explicitly-foreground Agent call passes through untouched", async () => {
    const options = await captureOptions();
    const out = (await fireAgentPreToolUse(options, {
      description: "x",
      prompt: "y",
      run_in_background: false,
    })) as { hookSpecificOutput?: unknown };
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  test("a remote-isolation Agent call is denied with an explanation", async () => {
    const options = await captureOptions();
    const out = (await fireAgentPreToolUse(options, {
      description: "x",
      prompt: "y",
      isolation: "remote",
    })) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("remote");
  });
});

describe("turn budget in the system prompt", () => {
  test("req.turnBudgetMs surfaces in the appended brief", async () => {
    let captured: Options | undefined;
    const queryFn = ((params: { options?: Options }) => {
      captured = params.options!;
      return (async function* () {
        yield initMsg("s1");
        yield resultMsg("s1");
      })();
    }) as unknown as typeof query;

    const backend = createClaudeBackend({ brainPath: "/brain", queryFn });
    const b1 = makeBridge();
    await backend.startTurn(
      makeReq(b1.bridge, new AbortController().signal, { turnBudgetMs: 25 * 60 * 1000 })
    );

    const sp = captured!.systemPrompt as { append?: string };
    expect(sp.append).toContain("about 25 minutes");
    expect(sp.append).toContain("Turn lifecycle");
  });
});
