import { expect, test, describe } from "bun:test";
import type { query, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@brainform/ui-sdk";
import type {
  BackendBridge,
  StartTurnRequest,
} from "@brainform/ui-sdk/server";
import { BackendBusyError, BackendRequestError } from "@brainform/ui-sdk/server";
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

function makeBridge(): { frames: ServerMessage[]; bridge: BackendBridge } {
  const frames: ServerMessage[] = [];
  return {
    frames,
    bridge: {
      emit: (m) => frames.push(m),
      requestPermission: async () => ({ behavior: "allow" }),
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

  test("a second concurrent turn rejects with BackendBusyError", async () => {
    const backend = createClaudeBackend({
      brainPath: "/brain",
      queryFn: makeQueryFn(abortableGen),
    });
    const c1 = new AbortController();
    const first = makeBridge();
    const turn1 = backend.startTurn(makeReq(first.bridge, c1.signal));

    try {
      const second = makeBridge();
      await expect(
        backend.startTurn(makeReq(second.bridge, new AbortController().signal))
      ).rejects.toBeInstanceOf(BackendBusyError);
    } finally {
      c1.abort();
      await turn1;
    }

    // After the first turn drains, the backend is free again.
    const c2 = new AbortController();
    const third = makeBridge();
    const turn3 = backend.startTurn(makeReq(third.bridge, c2.signal));
    c2.abort();
    await turn3;
    expect(
      third.frames.some((f) => f.type === "status" && f.status === "cancelled")
    ).toBe(true);
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
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      yield {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        total_cost_usd: 0.01,
        duration_ms: 100,
        num_turns: 1,
      };
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
      costUsd: 0.01,
      durationMs: 100,
      numTurns: 1,
      isError: false,
    });
    expect(frames.at(-1)).toEqual({ type: "status", status: "idle" });
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
