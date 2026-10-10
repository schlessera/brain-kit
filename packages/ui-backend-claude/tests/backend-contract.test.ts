import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { query, Options } from "@anthropic-ai/claude-agent-sdk";
import {
  API_FAILURE_DETAIL,
  runBackendContract,
  runBackendModuleContract,
  type BackendContractHarness,
  type PermissionProbe,
  type PermissionScenario,
  type TurnScript,
} from "@schlessera/brain-ui-sdk/testing";

import { createClaudeBackend } from "../src/backend";
import { backendModule } from "../src/module";
import { runToolCall } from "./helpers/run-tool-call";

const temps: string[] = [];
function tempBrain(): string {
  const dir = mkdtempSync(join(tmpdir(), "backend-contract-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

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

let hangCounter = 0;

/** Emits a session identity, then hangs until the host aborts. */
function claudeHangingQuery(): typeof query {
  return ((params: { options?: Options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: `hang-${++hangCounter}` };
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

/** Emits a session identity, then throws like a provider failure. */
function claudeFailingQuery(script: TurnScript): typeof query {
  return ((_params: { options?: Options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: script.sessionId };
      throw new Error("provider exploded");
    })()) as unknown as typeof query;
}

/** Emits a session identity and deltas, then ends WITHOUT a result. */
function claudeTruncatedQuery(script: TurnScript): typeof query {
  return ((_params: { options?: Options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: script.sessionId };
      for (const text of script.textDeltas) {
        yield {
          type: "stream_event",
          session_id: script.sessionId,
          event: { type: "content_block_delta", delta: { type: "text_delta", text } },
        };
      }
    })()) as unknown as typeof query;
}

/**
 * The runtime's API-error path (#575): its API-error message, then a
 * `success` result with `is_error` and the status beside the text.
 */
function claudeApiFailureQuery(script: TurnScript): typeof query {
  const text = `API Error: 400 ${API_FAILURE_DETAIL}`;
  return ((_params: { options?: Options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: script.sessionId };
      yield {
        type: "assistant",
        session_id: script.sessionId,
        parent_tool_use_id: null,
        error: "invalid_request",
        message: { model: "<synthetic>", content: [{ type: "text", text }] },
      };
      yield {
        type: "result",
        subtype: "success",
        session_id: script.sessionId,
        is_error: true,
        api_error_status: 400,
        result: text,
        total_cost_usd: 0,
        duration_ms: 5,
        num_turns: 1,
      };
    })()) as unknown as typeof query;
}

/** One `api_retry` (429), then the scripted answer. */
function claudeRetryingQuery(script: TurnScript): typeof query {
  const answer = claudeScriptedQuery(script);
  return ((params: { prompt: unknown; options?: Options }) =>
    (async function* () {
      yield {
        type: "system",
        subtype: "api_retry",
        session_id: script.sessionId,
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 1000,
        error_status: 429,
        error: "rate_limit",
      };
      yield* answer(params as never) as AsyncIterable<unknown>;
    })()) as unknown as typeof query;
}

/** Two observed retries followed by a provider failure, through the real runner. */
function claudeRetriedFailureQuery(script: TurnScript): typeof query {
  return (() => (async function* () {
    yield { type: "system", subtype: "init", session_id: script.sessionId };
    for (const attempt of [1, 2]) yield { type: "system", subtype: "api_retry", session_id: script.sessionId,
      attempt, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: "rate_limit" };
    yield { type: "assistant", session_id: script.sessionId, parent_tool_use_id: null, error: "rate_limit",
      message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 429 Rate limited." }] } };
    yield { type: "result", subtype: "success", session_id: script.sessionId, is_error: true,
      api_error_status: 429, result: "API Error: 429 Rate limited.", total_cost_usd: 0, duration_ms: 5, num_turns: 1 };
  })()) as unknown as typeof query;
}

const harness: BackendContractHarness = {
  name: "claude",
  permission: claudePermissionProbe,
  scripted: (script) =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeScriptedQuery(script) }),
  hanging: () =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeHangingQuery() }),
  failing: (script) =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeFailingQuery(script) }),
  truncated: (script) =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeTruncatedQuery(script) }),
  apiFailure: (script) =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeApiFailureQuery(script) }),
  retrying: (script) =>
    createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeRetryingQuery(script) }),
  retriedFailure: (script) => createClaudeBackend({ brainPath: tempBrain(), queryFn: claudeRetriedFailureQuery(script) }),
  unknownProfileId: "no-such-profile",
};

runBackendContract(harness, { describe, test, expect });

function claudePermissionProbe(scenario: PermissionScenario): PermissionProbe {
  const brainPath = tempBrain();
  const witness = join(brainPath, "tool-body-ran");
  const toolName = scenario === "mutation" ? "Write" : "Bash";
  const input = scenario === "mutation"
    ? { file_path: join(brainPath, "note.md"), content: "fixture" }
    : { command: scenario === "command" ? "rm -rf notes/old" : "echo contract" };
  let starts = 0;
  let attempts = 0;
  const queryFn = ((params: { options: Options }) => {
    starts++;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "permission-probe" };
      attempts++;
      // Use the adapter's actual SDK options/hooks, including the runtime
      // shortcut that would skip canUseTool without the enforcement hook.
      const outcome = await runToolCall(params.options, toolName, input, "probe-tool", scenario === "shortcut");
      if (outcome.executed) writeFileSync(witness, "tool body executed");
      yield {
        type: "user", session_id: "permission-probe",
        message: { content: [{ type: "tool_result", tool_use_id: "probe-tool", is_error: !outcome.executed, content: outcome.message ?? "tool body executed" }] },
      };
      yield { type: "result", subtype: "success", session_id: "permission-probe", total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    })();
  }) as unknown as typeof query;
  return {
    backend: createClaudeBackend({ brainPath, queryFn, allowedTools: scenario === "command" ? [toolName] : [], log: () => {} }),
    toolName,
    toolUseId: "probe-tool",
    starts: () => starts,
    attempts: () => attempts,
    effects: () => existsSync(witness) ? 1 : 0,
  };
}

// First-party backends must demonstrate enforcement, rather than relying on
// the shared suite's permitted pre-runtime rejection for unsupported callers.
test("Claude executes approved restricted turns instead of rejecting them", async () => {
  const probe = claudePermissionProbe("mutation");
  await probe.backend.startTurn({ prompt: "write", signal: new AbortController().signal, enforceAllowedTools: true,
    bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) } });
  expect(probe.starts()).toBe(1);
  expect(probe.effects()).toBe(1);
});

runBackendModuleContract({
  name: "claude", module: backendModule,
  validProfilesJson: JSON.stringify([{ id: "contract-profile", label: "Contract profile", model: "contract-model" }]),
  profileIds: ["contract-profile"],
  context: () => ({ brainPath: tempBrain(), config: {}, confirmBashPatterns: null, settings: {} }),
}, { describe, test, expect });

for (const scenario of ["mutation", "shortcut", "command"] as const) {
  test("claude: no-grant " + scenario + " is enforced rather than rejected", async () => {
    const probe = claudePermissionProbe(scenario);
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

mockWorkerHostForSdkStream();
