/**
 * Published AgentBackend contract suite. The SAME assertions run against all
 * backends. This is the executable form of the startTurn contract documented
 * in ../server/backend.ts:
 *
 *   1. capabilities is a complete, honest boolean set
 *   2. listProfiles() yields safe ProviderInfo shapes
 *   3. a turn emits session_info before content, streams deltas, and ends
 *      with a terminal `result` frame (outcome: success) before the promise
 *      resolves
 *   4. host abort → diagnostic `status: cancelled`, then the unified terminal
 *      `result` frame with outcome: cancelled; the promise RESOLVES
 *   5. busy-ness is PER SESSION (rev 2): resuming a running session rejects
 *      with BackendBusyError; a second NEW session runs in parallel when
 *      capabilities.concurrentSessions; the backend recovers after drains
 *   6. an unknown profileId rejects with BackendRequestError and emits nothing
 *
 * Backends run against caller-supplied fake runtimes — no live models. Test
 * registration and assertion primitives are injected so this module remains
 * importable by plain Node consumers without depending on a test runner.
 */

import type { ProviderInfo, ServerMessage } from "../protocol.js";
import type { AgentBackend, BackendBridge } from "../server/backend.js";
import { BackendBusyError, BackendRequestError } from "../server/backend.js";

interface ContractMatchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatch(expected: RegExp): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeDefined(): void;
  toHaveLength(expected: number): void;
  toBeInstanceOf(expected: abstract new (...args: never[]) => unknown): void;
  readonly not: Pick<ContractMatchers, "toBe" | "toMatch">;
  readonly rejects: Pick<ContractMatchers, "toBeInstanceOf">;
}

/** The minimal test-runner surface used by the backend contract assertions. */
export interface ContractTestPrimitives {
  describe(name: string, fn: () => void): void;
  test(name: string, fn: () => void | Promise<void>): void;
  expect(actual: unknown): ContractMatchers;
}

export interface TurnScript {
  sessionId: string;
  textDeltas: string[];
}

export interface BackendContractHarness {
  name: string;
  /** Backend whose next turn plays the script and completes. */
  scripted(script: TurnScript): AgentBackend;
  /** Backend whose turn hangs until the host aborts. */
  hanging(): AgentBackend;
  /** Backend whose turn fails at runtime AFTER the session identity exists. */
  failing(script: TurnScript): AgentBackend;
  /** Backend whose stream ends WITHOUT a terminal result (claude-only shape). */
  truncated?(script: TurnScript): AgentBackend;
  /** A profileId guaranteed to be unknown to the backend. */
  unknownProfileId: string;
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

/** Poll until `cond` is true (or fail after ~2s). */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

function sessionIdOf(frames: ServerMessage[]): string {
  const info = frames.find((f) => f.type === "session_info");
  if (!info || info.type !== "session_info") throw new Error("no session_info frame");
  return info.sessionId;
}

/** Register the complete startTurn contract suite for one backend harness. */
export function runBackendContract(
  harness: BackendContractHarness,
  primitives: ContractTestPrimitives
): void {
  const { describe, expect, test } = primitives;

  describe(`AgentBackend contract: ${harness.name}`, () => {
    test("capabilities is a complete boolean set", () => {
      const backend = harness.scripted({ sessionId: "s", textDeltas: [] });
      const keys = [
        "resume",
        "permissions",
        "thinking",
        "attachments",
        "askUser",
        "costReporting",
        "concurrentSessions",
        "followUp",
      ] as const;
      for (const key of keys) {
        expect(typeof backend.capabilities[key]).toBe("boolean");
      }
      expect(Object.keys(backend.capabilities).sort()).toEqual([...keys].sort());
      expect(backend.id.length).toBeGreaterThan(0);
    });

    test("listProfiles yields safe ProviderInfo shapes", async () => {
      const backend = harness.scripted({ sessionId: "s", textDeltas: [] });
      const profiles: ProviderInfo[] = await backend.listProfiles();
      expect(Array.isArray(profiles)).toBe(true);
      for (const p of profiles) {
        expect(typeof p.id).toBe("string");
        expect(typeof p.label).toBe("string");
        // Never leak key material through profile listings.
        expect(JSON.stringify(p).toLowerCase()).not.toMatch(/api[_-]?key|token|secret/);
      }
    });

    test("turn lifecycle: session_info first, deltas, terminal result, then resolve", async () => {
      const backend = harness.scripted({ sessionId: "sess-42", textDeltas: ["a", "b"] });
      const { frames, bridge } = makeBridge();

      await backend.startTurn({
        prompt: "hello",
        signal: new AbortController().signal,
        bridge,
      });

      const types = frames.map((f) => f.type);
      const infoIdx = types.indexOf("session_info");
      const firstText = types.indexOf("text_delta");
      expect(infoIdx).toBeGreaterThanOrEqual(0);
      expect(firstText).toBeGreaterThan(infoIdx);

      const texts = frames.filter((f) => f.type === "text_delta").map((f) => f.text);
      expect(texts).toEqual(["a", "b"]);

      const result = frames.filter((f) => f.type === "result").at(-1);
      expect(result).toBeDefined();
      if (result?.type === "result") {
        expect(result.sessionId).toBe("sess-42");
        expect(result.outcome).toBe("success");
        expect(typeof result.costUsd).toBe("number");
        expect(result.costUsd).toBeGreaterThanOrEqual(0);
        expect(result.isError).toBe(false);
      }
      // The terminal frame must exist by the time the promise resolved —
      // asserted implicitly: frames were captured before this line ran.
    });

    test("host abort → status:cancelled diagnostic, then terminal result outcome:cancelled", async () => {
      const backend = harness.hanging();
      const { frames, bridge } = makeBridge();
      const controller = new AbortController();

      const turn = backend.startTurn({ prompt: "hi", signal: controller.signal, bridge });
      // Give the backend a beat to enter the hanging runtime, then cancel.
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await turn; // must RESOLVE, not reject

      const cancelled = frames.filter(
        (f) => f.type === "status" && f.status === "cancelled"
      );
      expect(cancelled.length).toBeGreaterThanOrEqual(1);

      // Both harnesses emit a session identity before hanging — the abort
      // path must therefore ALWAYS end on the unified terminal result.
      expect(frames.some((f) => f.type === "session_info")).toBe(true);
      const results = frames.filter((f) => f.type === "result");
      expect(results.length).toBe(1); // exactly one terminal frame
      const last = frames.at(-1);
      expect(last?.type).toBe("result");
      if (last?.type === "result") {
        expect(last.outcome).toBe("cancelled");
        expect(last.isError).toBe(false);
      }
    });

    test("a pre-aborted signal terminates promptly instead of hanging", async () => {
      const backend = harness.hanging();
      const { frames, bridge } = makeBridge();
      const controller = new AbortController();
      controller.abort(); // already aborted BEFORE startTurn

      await Promise.race([
        backend.startTurn({ prompt: "hi", signal: controller.signal, bridge }),
        new Promise((_r, reject) =>
          setTimeout(() => reject(new Error("startTurn hung on a pre-aborted signal")), 3_000)
        ),
      ]);

      // Terminal frame either way: a result when an identity existed, else a
      // bare error. Never zero frames, never a hang.
      const last = frames.at(-1);
      expect(last === undefined ? "none" : last.type).toMatch(/result|error/);
    });

    test("runtime failure → diagnostic error, then EXACTLY ONE terminal result outcome:error, last", async () => {
      const backend = harness.failing({ sessionId: "fail-1", textDeltas: [] });
      const { frames, bridge } = makeBridge();

      await backend.startTurn({ prompt: "hi", signal: new AbortController().signal, bridge });

      expect(frames.some((f) => f.type === "error")).toBe(true);
      const results = frames.filter((f) => f.type === "result");
      expect(results.length).toBe(1);
      const last = frames.at(-1);
      expect(last?.type).toBe("result");
      if (last?.type === "result") {
        expect(last.outcome).toBe("error");
        expect(last.isError).toBe(true);
      }
    });

    test("exactly one result frame on success, and outcome agrees with isError", async () => {
      const backend = harness.scripted({ sessionId: "one-1", textDeltas: ["x"] });
      const { frames, bridge } = makeBridge();
      await backend.startTurn({ prompt: "hi", signal: new AbortController().signal, bridge });

      const results = frames.filter((f) => f.type === "result");
      expect(results.length).toBe(1);
      const r = results[0]!;
      if (r.type === "result") {
        expect(r.outcome).toBe("success");
        expect(r.isError).toBe(false);
      }
      expect(frames.at(-1)?.type).toBe("result");
    });

    if (harness.truncated) {
      test("stream that ends without a result still gets a terminal result", async () => {
        const backend = harness.truncated!({ sessionId: "trunc-1", textDeltas: ["a"] });
        const { frames, bridge } = makeBridge();
        await backend.startTurn({ prompt: "hi", signal: new AbortController().signal, bridge });

        const results = frames.filter((f) => f.type === "result");
        expect(results.length).toBe(1);
        const last = frames.at(-1);
        expect(last?.type).toBe("result");
        if (last?.type === "result") {
          expect(last.outcome).toBe("error");
          expect(last.isError).toBe(true);
        }
      });
    }

    test("busy-ness is per session; parallel sessions per capability; recovers", async () => {
      const backend = harness.hanging();
      const first = makeBridge();
      const c1 = new AbortController();
      const turn1 = backend.startTurn({ prompt: "1", signal: c1.signal, bridge: first.bridge });
      await waitFor(() => first.frames.some((f) => f.type === "session_info"));
      const sid = sessionIdOf(first.frames);

      // Resuming a session whose turn is RUNNING is the busy condition (rev 2).
      const resumer = makeBridge();
      await expect(
        backend.startTurn({
          prompt: "2",
          sessionId: sid,
          signal: new AbortController().signal,
          bridge: resumer.bridge,
        })
      ).rejects.toBeInstanceOf(BackendBusyError);
      expect(resumer.frames).toHaveLength(0);

      if (backend.capabilities.concurrentSessions) {
        // A second NEW session runs in parallel with the first.
        const second = makeBridge();
        const c2 = new AbortController();
        const turn2 = backend.startTurn({
          prompt: "3",
          signal: c2.signal,
          bridge: second.bridge,
        });
        await waitFor(() => second.frames.some((f) => f.type === "session_info"));
        expect(sessionIdOf(second.frames)).not.toBe(sid);
        c2.abort();
        await turn2;
      }

      c1.abort();
      await turn1;

      // Recovery: the drained session accepts a new (hanging) turn again.
      const again = makeBridge();
      const c3 = new AbortController();
      const turn3 = backend.startTurn({
        prompt: "4",
        sessionId: sid,
        signal: c3.signal,
        bridge: again.bridge,
      });
      await waitFor(() => again.frames.some((f) => f.type === "session_info"));
      c3.abort();
      await turn3;
    });

    test("multi-session backends scope frames with sessionId", async () => {
      const backend = harness.scripted({ sessionId: "scope-1", textDeltas: ["x"] });
      if (!backend.capabilities.concurrentSessions) return;
      const { frames, bridge } = makeBridge();
      await backend.startTurn({ prompt: "hi", signal: new AbortController().signal, bridge });

      const info = frames.findIndex((f) => f.type === "session_info");
      for (const frame of frames.slice(info + 1)) {
        expect("sessionId" in frame ? frame.sessionId : undefined).toBe("scope-1");
      }
    });

    test("unknown profileId rejects BackendRequestError, emits nothing", async () => {
      const backend = harness.scripted({ sessionId: "s", textDeltas: [] });
      const { frames, bridge } = makeBridge();
      await expect(
        backend.startTurn({
          prompt: "hi",
          profileId: harness.unknownProfileId,
          signal: new AbortController().signal,
          bridge,
        })
      ).rejects.toBeInstanceOf(BackendRequestError);
      expect(frames).toHaveLength(0);
    });
  });
}
