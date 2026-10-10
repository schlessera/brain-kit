import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  compileConfirmPatterns,
  createKeyedLock,
  type AgentBackend,
} from "@schlessera/brain-ui-sdk/server";
import { DEFAULT_CONFIRM_BASH_PATTERNS } from "@schlessera/brain-ui-sdk/server";
import {
  API_FAILURE_DETAIL,
  runBackendContract,
  runBackendModuleContract,
  type BackendContractHarness,
  type PermissionProbe,
  type PermissionScenario,
  type TurnScript,
} from "@schlessera/brain-ui-sdk/testing";

import { createPiBackend, type PiSessionLike } from "../src/backend";
import { createBrainAccess } from "../src/brain-access";
import { backendModule } from "../src/module";
import { createSessionResources } from "../src/session-resources";
import { toolLockFromKeyed } from "../src/tools";

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
  permission: piPermissionProbe,
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
  retriedFailure: (script) => piEventBackend(script, (emit) => {
    for (const attempt of [1, 2]) {
      emit(failedAnswer("429 rate limited"));
      emit({ type: "auto_retry_start", attempt, maxAttempts: 3, delayMs: 1000, errorMessage: "429 rate limited" });
    }
    emit(failedAnswer("429 rate limited"));
  }),
  unknownProfileId: "no-such-profile",
};

runBackendContract(harness, { describe, test, expect });

function piPermissionProbe(scenario: PermissionScenario): PermissionProbe {
  const brainPath = tempBrain();
  const witness = join(brainPath, "tool-body-ran");
  const toolName = scenario === "mutation" ? "write_file" : "bash";
  const input = scenario === "mutation"
    ? { path: "note.md", content: "fixture" }
    : { command: scenario === "command" ? "rm -rf notes/old" : "echo contract" };
  const allowedTools = scenario === "command" ? [toolName] : [];
  let starts = 0;
  let attempts = 0;
  const backend = createPiBackend({
    brainPath, allowedTools, loadExtensions: false,
    profiles: [{ id: "contract", label: "Contract", vendor: "anthropic", model: "contract-model" }],
    sessionFactory: {
      newSession: async (_profile, toolkit) => {
        starts++;
        if (!toolkit) throw new Error("the adapter did not supply its real toolkit");
        // sessionFactory bypasses upstream acquisition. Build the actual
        // production resource loader around the adapter's toolkit, so deleting
        // its gate registration (or failing to bind this turn) breaks the test.
        const resources = createSessionResources({
          backend: { brainPath, loadExtensions: false }, brain: createBrainAccess(brainPath),
          lock: toolLockFromKeyed(createKeyedLock()), allowedTools: new Set(allowedTools),
          confirmPatterns: compileConfirmPatterns(DEFAULT_CONFIRM_BASH_PATTERNS, () => {}), loadExtensions: false,
        });
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = join(brainPath, "agent-config");
        let loaded: Awaited<ReturnType<typeof resources.build>>;
        try {
          loaded = await resources.build(toolkit, { caps: { location: false, activity: false, mask: false, askUser: false, askUserList: false, askUserRank: false } });
        } finally {
          if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
        const base = piFakeSession({ sessionId: "permission-probe", textDeltas: [] });
        const listeners = new Set<(event: unknown) => void>();
        return {
          ...base,
          subscribe(listener) { listeners.add(listener as (event: unknown) => void); return () => { listeners.delete(listener as (event: unknown) => void); }; },
          async prompt() {
            attempts++;
            let refusal: string | undefined;
            for (const extension of loaded.loader.getExtensions().extensions) {
              for (const handler of extension.handlers.get("tool_call") ?? []) {
                const decision = await handler({ type: "tool_call", toolName, toolCallId: "probe-tool", input }, {} as never) as { block?: boolean; reason?: string } | undefined;
                if (decision?.block) refusal = decision.reason;
              }
            }
            if (refusal === undefined) {
              const tool = toolkit.tools.find((t) => t.name === toolName);
              if (!tool) throw new Error(`missing real tool ${toolName}`);
              await tool.execute("probe-tool", input as never, undefined, undefined, {} as never);
              writeFileSync(witness, "tool body executed");
            }
            for (const listener of listeners) listener({
              type: "tool_execution_end", toolCallId: "probe-tool", toolName, isError: refusal !== undefined,
              result: { content: [{ type: "text", text: refusal ?? "tool body executed" }] },
            });
          },
        };
      },
      openSession: async () => { throw new Error("probe does not resume"); },
    },
  });
  return { backend, toolName, toolUseId: "probe-tool", starts: () => starts, attempts: () => attempts, effects: () => existsSync(witness) ? 1 : 0 };
}

test("pi executes approved restricted turns instead of rejecting them", async () => {
  const probe = piPermissionProbe("mutation");
  await probe.backend.startTurn({ prompt: "write", signal: new AbortController().signal, enforceAllowedTools: true,
    bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) } });
  expect(probe.starts()).toBe(1);
  expect(probe.effects()).toBe(1);
});

runBackendModuleContract({
  name: "pi", module: backendModule,
  validProfilesJson: JSON.stringify([{ id: "contract-profile", label: "Contract profile", vendor: "anthropic", model: "contract-model" }]),
  profileIds: ["contract-profile"],
  context: () => ({ brainPath: tempBrain(), config: {}, confirmBashPatterns: null, settings: {} }),
}, { describe, test, expect });

for (const scenario of ["mutation", "shortcut", "command"] as const) {
  test("pi: no-grant " + scenario + " is enforced rather than rejected", async () => {
    const probe = piPermissionProbe(scenario);
    let cards = 0;
    await probe.backend.startTurn({ prompt: "exercise tool", signal: new AbortController().signal,
      enforceAllowedTools: true, noGrantSurface: true,
      bridge: { emit: () => {}, requestPermission: async () => { cards++; return { behavior: "allow" }; } } });
    expect(probe.starts()).toBe(1);
    expect(probe.attempts()).toBe(1);
    expect(probe.effects()).toBe(0);
    expect(cards).toBe(0);
  });
}
