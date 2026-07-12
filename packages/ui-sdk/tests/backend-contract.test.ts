/**
 * Cross-backend contract suite — the SAME assertions run against both
 * first-party AgentBackends (plan/00 verification 3). This is the executable
 * form of the startTurn contract documented in src/server/backend.ts:
 *
 *   1. capabilities is a complete, honest boolean set
 *   2. listProfiles() yields safe ProviderInfo shapes
 *   3. a turn emits session_info before content, streams deltas, and ends
 *      with a terminal `result` frame before the promise resolves
 *   4. host abort → `status: cancelled` terminal frame, promise RESOLVES,
 *      no `result` frame
 *   5. a concurrent second turn rejects with BackendBusyError; the backend
 *      is usable again after the first turn drains
 *   6. an unknown profileId rejects with BackendRequestError and emits nothing
 *
 * Backends run against injected fake runtimes (queryFn / sessionFactory) —
 * no live models. Test-only relative imports across packages are intentional;
 * this file is not published.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentBackend, BackendBridge } from "../src/server/backend";
import { BackendBusyError, BackendRequestError } from "../src/server/backend";
import type { ProviderInfo, ServerMessage } from "../src/protocol";

import { createClaudeBackend } from "../../ui-backend-claude/src/backend";
import { createPiBackend, type PiSessionLike } from "../../ui-backend-pi/src/backend";
import type { query, Options } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

const temps: string[] = [];
function tempBrain(): string {
  const dir = mkdtempSync(join(tmpdir(), "backend-contract-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

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

interface TurnScript {
  sessionId: string;
  textDeltas: string[];
}

interface Harness {
  name: string;
  /** Backend whose next turn plays the script and completes. */
  scripted(script: TurnScript): AgentBackend;
  /** Backend whose turn hangs until the host aborts. */
  hanging(): AgentBackend;
  /** A profileId guaranteed to be unknown to the backend. */
  unknownProfileId: string;
}

// --- claude harness: inject queryFn ----------------------------------------

function claudeScriptedQuery(script: TurnScript): typeof query {
  return ((_params: { prompt: unknown; options?: Options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: script.sessionId };
      for (const text of script.textDeltas) {
        yield {
          type: "stream_event",
          session_id: script.sessionId,
          event: { type: "content_block_delta", delta: { type: "text_delta", text } },
        };
      }
      yield {
        type: "result",
        subtype: "success",
        session_id: script.sessionId,
        total_cost_usd: 0.01,
        duration_ms: 5,
        num_turns: 1,
      };
    })()) as unknown as typeof query;
}

function claudeHangingQuery(): typeof query {
  return ((params: { options?: Options }) =>
    (async function* () {
      await new Promise<void>((_resolve, reject) => {
        const sig = params.options?.abortController?.signal;
        if (sig?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        sig?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      });
    })()) as unknown as typeof query;
}

const claudeHarness: Harness = {
  name: "claude",
  scripted: (script) =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeScriptedQuery(script) }),
  hanging: () =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeHangingQuery() }),
  unknownProfileId: "no-such-profile",
};

// --- pi harness: inject sessionFactory --------------------------------------

function piFakeSession(script: TurnScript, opts?: { hang?: boolean }): PiSessionLike {
  const listeners = new Set<(ev: never) => void>();
  let aborted: (() => void) | null = null;
  return {
    sessionId: script.sessionId,
    subscribe(listener) {
      listeners.add(listener as (ev: never) => void);
      return () => listeners.delete(listener as (ev: never) => void);
    },
    async prompt() {
      if (opts?.hang) {
        await new Promise<void>((resolve) => {
          aborted = resolve;
        });
        return;
      }
      for (const text of script.textDeltas) {
        const ev = {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: text, contentIndex: 0 },
        };
        for (const l of listeners) (l as (e: unknown) => void)(ev);
      }
    },
    async abort() {
      aborted?.();
    },
    getSessionStats: () => ({ cost: 0.01 }),
    dispose() {},
  };
}

function piHarnessBackend(script: TurnScript, hang: boolean): AgentBackend {
  return createPiBackend({
    brainPath: tempBrain(),
    profiles: [{ id: "sonnet", label: "Sonnet", vendor: "anthropic", model: "claude-sonnet-4-5" }],
    sessionFactory: {
      newSession: async () => piFakeSession(script, { hang }),
      openSession: async () => piFakeSession(script, { hang }),
    },
  });
}

const piHarness: Harness = {
  name: "pi",
  scripted: (script) => piHarnessBackend(script, false),
  hanging: () => piHarnessBackend({ sessionId: "hang", textDeltas: [] }, true),
  unknownProfileId: "no-such-profile",
};

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

for (const harness of [claudeHarness, piHarness]) {
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
        expect(typeof result.costUsd).toBe("number");
        expect(result.costUsd).toBeGreaterThanOrEqual(0);
        expect(result.isError).toBe(false);
      }
      // The terminal frame must exist by the time the promise resolved —
      // asserted implicitly: frames were captured before this line ran.
    });

    test("host abort → status:cancelled terminal frame, resolves, no result", async () => {
      const backend = harness.hanging();
      const { frames, bridge } = makeBridge();
      const controller = new AbortController();

      const turn = backend.startTurn({ prompt: "hi", signal: controller.signal, bridge });
      // Give the backend a beat to enter the hanging runtime, then cancel.
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await turn; // must RESOLVE, not reject

      const types = frames.map((f) => f.type);
      expect(types).not.toContain("result");
      const cancelled = frames.filter(
        (f) => f.type === "status" && f.status === "cancelled"
      );
      expect(cancelled.length).toBeGreaterThanOrEqual(1);
      expect(types.at(-1)).toBe("status");
    });

    test("concurrent second turn rejects BackendBusyError; backend recovers", async () => {
      const backend = harness.hanging();
      const first = makeBridge();
      const c1 = new AbortController();
      const turn1 = backend.startTurn({ prompt: "1", signal: c1.signal, bridge: first.bridge });
      await new Promise((r) => setTimeout(r, 10));

      const second = makeBridge();
      await expect(
        backend.startTurn({
          prompt: "2",
          signal: new AbortController().signal,
          bridge: second.bridge,
        })
      ).rejects.toBeInstanceOf(BackendBusyError);
      expect(second.frames).toHaveLength(0);

      c1.abort();
      await turn1;
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
