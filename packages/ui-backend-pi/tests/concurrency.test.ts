/**
 * Parallel-session + native-followUp behaviour for the pi backend (no LLM).
 *
 * These drive createPiBackend through the @internal sessionFactory seam with
 * controllable fake pi sessions, exercising the rev-2 startTurn contract:
 *   (a) two sessions stream concurrently, frames demux by sessionId
 *   (b) a second turn on a RUNNING session rejects BackendBusyError, and the
 *       session is usable again once that turn drains
 *   (c) followUp() injects into the running turn (streamingBehavior "followUp")
 *       and rejects BackendRequestError when the session isn't running
 *   (d) the shared WriteLock serializes mutating tool executions; reads bypass it
 *   (e) each session's curated tools see THEIR OWN turn bridge (per-session bind)
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  BackendBusyError,
  BackendRequestError,
  createKeyedLock,
  GIT_LOCK_KEY,
  type BackendBridge,
  type ServerMessage,
} from "@schlessera/brain-ui-sdk/server";

import { createPiBackend, type PiSessionLike, type SessionToolkit } from "../src/backend";
import { createBrainAccess } from "../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { makeEmptyBrain, resultText } from "./helpers";
import { makeMockBridge } from "./mock-bridge";

const CTX = {} as never;
const settle = () => new Promise((r) => setTimeout(r, 15));

/** A bridge whose frames land in a shared array (so tests demux by sessionId). */
function sharedBridge(frames: ServerMessage[]): BackendBridge {
  return {
    emit: (m) => frames.push(m),
    requestPermission: async () => ({ behavior: "allow" }),
  };
}

/**
 * A fake pi session under full test control: emit text deltas on demand, hang or
 * complete the initial prompt, and observe every prompt() call (text + options).
 * A prompt carrying `streamingBehavior` (a follow-up/steer) always resolves
 * immediately, mirroring pi's queue-within-turn behaviour.
 */
function makeControllableSession(sessionId: string) {
  const listeners = new Set<(ev: AgentSessionEvent) => void>();
  const promptCalls: Array<{ text: string; opts?: { streamingBehavior?: string } }> = [];
  let shouldHang = false;
  let pending: (() => void) | null = null;
  let disposed = false;

  const session: PiSessionLike = {
    sessionId,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt(text, opts) {
      promptCalls.push({ text, opts });
      if (opts?.streamingBehavior) return Promise.resolve(); // queued follow-up/steer
      if (shouldHang) return new Promise<void>((res) => (pending = res));
      return Promise.resolve();
    },
    async abort() {
      pending?.();
      pending = null;
    },
    getSessionStats: () => ({ cost: 0 }),
    dispose() {
      disposed = true;
    },
  };

  return {
    session,
    control: {
      promptCalls,
      setHang: (v: boolean) => (shouldHang = v),
      release: () => {
        pending?.();
        pending = null;
      },
      emitText(text: string) {
        const ev = {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: text, contentIndex: 0 },
        } as unknown as AgentSessionEvent;
        for (const l of listeners) l(ev);
      },
      get disposed() {
        return disposed;
      },
    },
  };
}

describe("pi backend — parallel sessions", () => {
  test("(a) two sessions stream concurrently; frames demux by sessionId", async () => {
    const brain = makeEmptyBrain();
    try {
      const a = makeControllableSession("A");
      const b = makeControllableSession("B");
      a.control.setHang(true);
      b.control.setHang(true);
      const queue = [a.session, b.session];
      const backend = createPiBackend({
        brainPath: brain.root,
        sessionFactory: {
          newSession: async () => queue.shift()!,
          openSession: async () => queue.shift()!,
        },
      });

      const frames: ServerMessage[] = [];
      const turnA = backend.startTurn({
        prompt: "a",
        signal: new AbortController().signal,
        bridge: sharedBridge(frames),
      });
      const turnB = backend.startTurn({
        prompt: "b",
        signal: new AbortController().signal,
        bridge: sharedBridge(frames),
      });
      await settle(); // both acquire, subscribe, emit session_info, park on prompt

      // Interleave emissions across the two live sessions.
      a.control.emitText("a1");
      b.control.emitText("b1");
      a.control.emitText("a2");
      b.control.emitText("b2");
      a.control.release();
      b.control.release();
      await Promise.all([turnA, turnB]);

      const combined = frames
        .filter((f) => f.type === "text_delta")
        .map((f) => `${f.sessionId}:${(f as { text: string }).text}`);
      // Emitted order proves the two turns advanced concurrently, not serially.
      expect(combined).toEqual(["A:a1", "B:b1", "A:a2", "B:b2"]);

      for (const id of ["A", "B"]) {
        expect(frames.some((f) => f.type === "session_info" && f.sessionId === id)).toBe(true);
        expect(frames.some((f) => f.type === "result" && f.sessionId === id)).toBe(true);
      }
    } finally {
      brain.cleanup();
    }
  });

  test("(b) second turn on a running session rejects BusyError, then recovers", async () => {
    const brain = makeEmptyBrain();
    try {
      const s = makeControllableSession("S");
      s.control.setHang(true);
      const backend = createPiBackend({
        brainPath: brain.root,
        sessionFactory: {
          newSession: async () => s.session,
          openSession: async () => s.session,
        },
      });

      const c1 = new AbortController();
      const mock1 = makeMockBridge();
      const turn1 = backend.startTurn({ prompt: "1", signal: c1.signal, bridge: mock1.bridge });
      await settle();
      expect(mock1.emitted.find((f) => f.type === "session_info")?.sessionId).toBe("S");

      const mock2 = makeMockBridge();
      await expect(
        backend.startTurn({
          prompt: "2",
          sessionId: "S",
          signal: new AbortController().signal,
          bridge: mock2.bridge,
        })
      ).rejects.toBeInstanceOf(BackendBusyError);
      expect(mock2.emitted).toHaveLength(0);

      // Drain turn 1.
      s.control.setHang(false);
      c1.abort();
      await turn1;

      // The same session accepts a fresh turn now that it is idle.
      const mock3 = makeMockBridge();
      await backend.startTurn({
        prompt: "3",
        sessionId: "S",
        signal: new AbortController().signal,
        bridge: mock3.bridge,
      });
      expect(mock3.emitted.some((f) => f.type === "result" && f.sessionId === "S")).toBe(true);
    } finally {
      brain.cleanup();
    }
  });

  test("(c) followUp injects into the running turn; rejects when not running", async () => {
    const brain = makeEmptyBrain();
    try {
      const f = makeControllableSession("F");
      f.control.setHang(true);
      const backend = createPiBackend({
        brainPath: brain.root,
        sessionFactory: {
          newSession: async () => f.session,
          openSession: async () => f.session,
        },
      });

      const c = new AbortController();
      const mock = makeMockBridge();
      const turn = backend.startTurn({ prompt: "start", signal: c.signal, bridge: mock.bridge });
      await settle();
      expect(mock.emitted.find((m) => m.type === "session_info")?.sessionId).toBe("F");

      // Follow-up lands in the running turn via streamingBehavior "followUp".
      await backend.followUp!({ sessionId: "F", prompt: "more please" });
      const followCall = f.control.promptCalls.find((p) => p.text === "more please");
      expect(followCall).toBeDefined();
      expect(followCall?.opts?.streamingBehavior).toBe("followUp");

      // Unknown session → BackendRequestError, nothing delivered.
      await expect(
        backend.followUp!({ sessionId: "nope", prompt: "x" })
      ).rejects.toBeInstanceOf(BackendRequestError);

      // Drain the turn, then a follow-up on the now-idle session rejects too.
      f.control.setHang(false);
      c.abort();
      await turn;
      await expect(
        backend.followUp!({ sessionId: "F", prompt: "y" })
      ).rejects.toBeInstanceOf(BackendRequestError);
    } finally {
      brain.cleanup();
    }
  });
});

describe("pi backend — shared working-tree safety", () => {
  test("(d) keyed lock: same-path writes serialize; different paths, reads and plain bash run free", async () => {
    const brain = makeEmptyBrain();
    try {
      writeFileSync(join(brain.root, "seed.md"), "hello read", "utf-8");
      const keyed = createKeyedLock();
      const lock = toolLockFromKeyed(keyed);
      const access = createBrainAccess(brain.root);

      const turnA = createTurnContext();
      turnA.bridge = makeMockBridge().bridge; // allow
      const toolsA = Object.fromEntries(
        createBrainTools({ brain: access, turn: turnA, lock }).map((t) => [t.name, t])
      );
      const turnB = createTurnContext();
      turnB.bridge = makeMockBridge().bridge; // allow
      const toolsB = Object.fromEntries(
        createBrainTools({ brain: access, turn: turnB, lock }).map((t) => [t.name, t])
      );

      // Hold the CONTESTED file's key so writes targeting it park.
      const release = await keyed.acquire(`path:${join(brain.root, "same.md")}`);

      const aWrite = toolsA.write_file.execute(
        "a",
        { path: "same.md", content: "A" },
        undefined,
        undefined,
        CTX
      );
      await settle();
      // Blocked on the held key — the file does not exist yet.
      expect(existsSync(join(brain.root, "same.md"))).toBe(false);

      // A write to a DIFFERENT path completes while the key is held.
      await toolsB.write_file.execute(
        "b",
        { path: "other.md", content: "B" },
        undefined,
        undefined,
        CTX
      );
      expect(readFileSync(join(brain.root, "other.md"), "utf-8")).toBe("B");

      // A read tool completes (reads never take a lock).
      const readRes = await toolsB.read_file.execute(
        "r",
        { path: "seed.md" },
        undefined,
        undefined,
        CTX
      );
      expect(resultText(readRes)).toContain("hello read");

      // A non-git bash command completes (no contention class → no lock).
      const bashRes = await toolsB.bash.execute(
        "sh",
        { command: "echo parallel-ok" },
        undefined,
        undefined,
        CTX
      );
      expect(resultText(bashRes)).toContain("parallel-ok");

      // Release; the parked same-path write drains.
      release();
      await aWrite;
      expect(readFileSync(join(brain.root, "same.md"), "utf-8")).toBe("A");
    } finally {
      brain.cleanup();
    }
  });

  test("(d2) git-mutating bash serializes on the repo-git key", async () => {
    const brain = makeEmptyBrain();
    try {
      const keyed = createKeyedLock();
      const lock = toolLockFromKeyed(keyed);
      const access = createBrainAccess(brain.root);
      const turn = createTurnContext();
      turn.bridge = makeMockBridge().bridge;
      const tools = Object.fromEntries(
        createBrainTools({ brain: access, turn, lock }).map((t) => [t.name, t])
      );

      const release = await keyed.acquire(GIT_LOCK_KEY);
      const gitCall = tools.bash.execute(
        "g",
        { command: "git add -A; touch git-ran" },
        undefined,
        undefined,
        CTX
      );
      await settle();
      // Parked on the repo-git key: nothing has run.
      expect(existsSync(join(brain.root, "git-ran"))).toBe(false);

      // A non-git command is unaffected.
      const echo = await tools.bash.execute(
        "e",
        { command: "echo free" },
        undefined,
        undefined,
        CTX
      );
      expect(resultText(echo)).toContain("free");

      release();
      await gitCall;
      expect(existsSync(join(brain.root, "git-ran"))).toBe(true);
    } finally {
      brain.cleanup();
    }
  });

  test("(e) each session's tools see their own turn bridge", async () => {
    const brain = makeEmptyBrain();
    try {
      // Barrier: both sessions must be mid-prompt (both bridges bound) before
      // either runs its tool, so a shared context would misroute deterministically.
      let arrived = 0;
      let releaseBoth!: () => void;
      const bothStarted = new Promise<void>((r) => (releaseBoth = r));

      const specs = [
        { id: "A", path: "a.md", content: "AAA" },
        { id: "B", path: "b.md", content: "BBB" },
      ];

      function makeToolSession(
        spec: { id: string; path: string; content: string },
        toolkit: SessionToolkit
      ): PiSessionLike {
        const writeTool = toolkit.tools.find((t) => t.name === "write_file")!;
        const askTool = toolkit.tools.find((t) => t.name === "ask_user")!;
        return {
          sessionId: spec.id,
          subscribe: () => () => {},
          async prompt() {
            if (++arrived === 2) releaseBoth();
            await bothStarted;
            // A bridge-backed call proves this session's tools reach THIS
            // turn's bridge (write_file no longer round-trips — approvals
            // live in the tool_call gate).
            await askTool.execute(
              spec.id,
              {
                questions: [
                  {
                    question: `Write ${spec.path}?`,
                    header: "Write",
                    options: [
                      { label: "Yes", description: "proceed" },
                      { label: "No", description: "stop" },
                    ],
                    multiSelect: false,
                  },
                ],
              },
              undefined,
              undefined,
              CTX
            );
            await writeTool.execute(
              spec.id,
              { path: spec.path, content: spec.content },
              undefined,
              undefined,
              CTX
            );
          },
          async abort() {},
          getSessionStats: () => ({ cost: 0 }),
          dispose() {},
        };
      }

      const queue = [...specs];
      const backend = createPiBackend({
        brainPath: brain.root,
        sessionFactory: {
          newSession: async (_p, toolkit) => makeToolSession(queue.shift()!, toolkit!),
          openSession: async (_id, toolkit) => makeToolSession(queue.shift()!, toolkit!),
        },
      });

      const bridgeA = makeMockBridge({ askUser: { answers: { Write: "Yes" } } });
      const bridgeB = makeMockBridge({ askUser: { answers: { Write: "Yes" } } });
      await Promise.all([
        backend.startTurn({
          prompt: "a",
          signal: new AbortController().signal,
          bridge: bridgeA.bridge,
        }),
        backend.startTurn({
          prompt: "b",
          signal: new AbortController().signal,
          bridge: bridgeB.bridge,
        }),
      ]);

      // Each turn's ask_user surfaced on its OWN bridge only.
      expect(bridgeA.askUserCalls).toHaveLength(1);
      expect(bridgeA.askUserCalls[0].requestId).toBe("A");
      expect(bridgeB.askUserCalls).toHaveLength(1);
      expect(bridgeB.askUserCalls[0].requestId).toBe("B");
      expect(readFileSync(join(brain.root, "a.md"), "utf-8")).toBe("AAA");
      expect(readFileSync(join(brain.root, "b.md"), "utf-8")).toBe("BBB");
    } finally {
      brain.cleanup();
    }
  });
});
