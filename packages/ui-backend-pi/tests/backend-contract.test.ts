import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import {
  API_FAILURE_DETAIL,
  runBackendContract,
  type BackendContractHarness,
  type TurnScript,
} from "@schlessera/brain-ui-sdk/testing";

import { createPiBackend, type PiSessionLike } from "../src/backend";

const temps: string[] = [];
function tempBrain(): string {
  const dir = mkdtempSync(join(tmpdir(), "backend-contract-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

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

function piHangingBackend(): AgentBackend {
  // Unique session per acquisition so two concurrent NEW turns get distinct ids.
  return createPiBackend({
    brainPath: tempBrain(),
    profiles: [{ id: "sonnet", label: "Sonnet", vendor: "anthropic", model: "claude-sonnet-4-5" }],
    sessionFactory: {
      newSession: async () =>
        piFakeSession({ sessionId: `hang-${++hangCounter}`, textDeltas: [] }, { hang: true }),
      openSession: async (sessionId) =>
        piFakeSession({ sessionId, textDeltas: [] }, { hang: true }),
    },
  });
}

let hangCounter = 0;

function piFailingSession(script: TurnScript): PiSessionLike {
  const base = piFakeSession(script);
  return {
    ...base,
    async prompt() {
      throw new Error("provider exploded");
    },
  };
}

/** Emit one pi AgentSession event to every listener. */
type Emit = (event: unknown) => void;

/**
 * A session whose prompt plays `before` through its listeners, then the
 * script. pi reports a provider failure as events, not a throw (#575).
 */
function piEventSession(script: TurnScript, before: (emit: Emit) => void): PiSessionLike {
  const base = piFakeSession(script);
  const listeners = new Set<Emit>();
  return {
    ...base,
    subscribe(listener) {
      const unsubscribeBase = base.subscribe(listener);
      listeners.add(listener as Emit);
      return () => {
        listeners.delete(listener as Emit);
        unsubscribeBase();
      };
    },
    async prompt(...args) {
      before((event) => {
        for (const listener of listeners) listener(event);
      });
      await base.prompt(...args);
    },
  };
}

const failedAnswer = (errorMessage: string) => ({
  type: "message_end",
  message: { role: "assistant", model: "m", content: [], stopReason: "error", errorMessage, usage: {} },
});

function piEventBackend(script: TurnScript, before: (emit: Emit) => void): AgentBackend {
  return createPiBackend({
    brainPath: tempBrain(),
    profiles: [{ id: "sonnet", label: "Sonnet", vendor: "anthropic", model: "claude-sonnet-4-5" }],
    sessionFactory: {
      newSession: async () => piEventSession(script, before),
      openSession: async () => piEventSession(script, before),
    },
  });
}

const harness: BackendContractHarness = {
  name: "pi",
  scripted: (script) => piHarnessBackend(script, false),
  hanging: () => piHangingBackend(),
  failing: (script) =>
    createPiBackend({
      brainPath: tempBrain(),
      profiles: [{ id: "sonnet", label: "Sonnet", vendor: "anthropic", model: "claude-sonnet-4-5" }],
      sessionFactory: {
        newSession: async () => piFailingSession(script),
        openSession: async () => piFailingSession(script),
      },
    }),
  apiFailure: (script) =>
    piEventBackend(script, (emit) =>
      emit(failedAnswer(`400 {"type":"error","error":{"message":"${API_FAILURE_DETAIL}"}}`))
    ),
  retrying: (script) =>
    piEventBackend(script, (emit) => {
      emit(failedAnswer("429 rate limited"));
      emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "429 rate limited" });
      emit({ type: "message_end", message: { role: "assistant", model: "m", content: [], stopReason: "stop", usage: {} } });
    }),
  unknownProfileId: "no-such-profile",
};

runBackendContract(harness, { describe, test, expect });
