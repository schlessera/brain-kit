import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import {
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
  unknownProfileId: "no-such-profile",
};

runBackendContract(harness, { describe, test, expect });
