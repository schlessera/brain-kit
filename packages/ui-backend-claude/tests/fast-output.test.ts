import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { FastOutputUnavailableError, type ServerMessage, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { INFERENCE_PLACEHOLDER, sessionPromptContextLocation } from "@schlessera/brain-ui-sdk/internal";
import type { OutputSpeed } from "@schlessera/brain-ui-sdk/protocol";
import { installTestHome } from "../../../scripts/test-home.js";
import { createClaudeSdkTurn } from "../src/sdk-options.js";
import { promptGateCheck } from "../src/turn-prompt-gate.js";
import { TurnFrames, TurnTerminal, thrownTurnFailure } from "../src/turn-terminal.js";
import { brainProcessesMayStart, checksBrainInventory } from "../src/turn-runner.js";

let home: ReturnType<typeof installTestHome>, brain: string;
beforeEach(() => { home = installTestHome(); brain = mkdtempSync(join(tmpdir(), "ithaca-fast-output-")); });
afterEach(() => { rmSync(brain, { recursive: true, force: true }); home.dispose(); });

/** Production SDK assembly of one hosted, relayed turn. */
function assemble(outputSpeed: OutputSpeed | undefined, environment: Record<string, string> = {}, extra: Partial<StartTurnRequest> = {}) {
  return createClaudeSdkTurn({
    backend: { brainPath: brain },
    req: { prompt: "Odysseus checks Ithaca.", bridge: { emit() {} }, applicationAuthority: "server", signal: new AbortController().signal,
      workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
      ...(outputSpeed ? { outputSpeed } : {}), ...extra } as never,
    profile: { id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: [], buildEnv: () => ({}) },
    turnEnvironment: environment,
    // An autonomous turn has its own transport; ordinary turns go through the relay.
    ...(extra.autonomous ? {} : { hostInference: { proxyDir: brain, placeholders: { ANTHROPIC_API_KEY: INFERENCE_PLACEHOLDER } } }),
    abortController: new AbortController(), allowedTools: ["Read"], confirmPatterns: [],
    turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never, log() {},
  });
}

test("a session's speed reaches the runtime as a flag setting, and a predating session keeps the runtime default", async () => {
  for (const [speed, expected] of [["fast", true], ["standard", false], [undefined, undefined]] as const) {
    const turn = assemble(speed);
    try {
      expect((turn.options.settings as { fastMode?: boolean }).fastMode, `FAST_MODE_FLAG_${speed ?? "absent"}`).toBe(expected);
      expect(turn.outputSpeed, `PROMPT_GATE_HOLDS_${speed ?? "absent"}`).toBe(speed);
    } finally { await turn.finishWorker(); }
  }
});

test("a fast session on an unqualified route is refused before anything persists, never run at standard speed", async () => {
  for (const [label, environment, extra, reason] of [
    ["gateway", { ANTHROPIC_BASE_URL: "https://gateway.example.com" }, {}, "not_first_party"],
    ["cloud provider", { CLAUDE_CODE_USE_BEDROCK: "1" }, {}, "CLAUDE_CODE_USE_BEDROCK"],
    ["autonomous", {}, { autonomous: { persistence: "none", allowedTools: ["Read"], systemPromptAppend: "Odysseus works alone." } }, "standard speed"],
  ] as const) {
    let error: unknown;
    try { assemble("fast", environment, extra as never); } catch (caught) { error = caught; }
    expect(error, `FAST_REFUSED_${label}`).toBeInstanceOf(FastOutputUnavailableError);
    expect((error as FastOutputUnavailableError).errorClass).toBe("fast_output_unavailable");
    expect((error as Error).message, `FAST_REFUSAL_NAMES_REASON_${label}`).toContain(reason);
  }
  // Nothing was prepared for any refused turn: no prompt context was saved.
  const { dir } = sessionPromptContextLocation(process.env.CLAUDE_CONFIG_DIR!, brain, crypto.randomUUID());
  expect(existsSync(dir) ? readdirSync(dir) : [], "REFUSAL_PERSISTS_NOTHING").toEqual([]);
  // The same route serves a standard session.
  const standard = assemble("standard", { ANTHROPIC_BASE_URL: "https://gateway.example.com" });
  await standard.finishWorker();
  expect((standard.options.settings as { fastMode?: boolean }).fastMode, "GATEWAY_SERVES_STANDARD").toBe(false);
});

function gate(outputSpeed: OutputSpeed | undefined, initialized: Record<string, unknown>) {
  const frames: ServerMessage[] = [], activity: unknown[] = [];
  const abortController = new AbortController();
  const terminal = new TurnTerminal({ frames: new TurnFrames({ emit: (msg: ServerMessage) => frames.push(msg), activity: (event: unknown) => activity.push(event) } as never, "s1"),
    hostSignal: new AbortController().signal, abortController, startedAt: Date.now(), pendingFailure: () => null });
  const check = promptGateCheck({ queryHandle: Promise.resolve({} as Query), initialize: async () => initialized as never,
    sdkTurn: { subscriptionOnly: false, ...(outputSpeed ? { outputSpeed } : {}) }, relay: undefined, terminal, runtimeRequirements: [],
    phase: "start", abortController, profileId: "fixture", log() {}, reportActivity: event => activity.push(event), reportRuntime() {} });
  return { check, terminal, activity };
}

test("the prompt gate releases a fast session only when the runtime reports fast output on", async () => {
  const on = gate("fast", { fast_mode_state: "on" });
  expect(await on.check(), "FAST_ON_RELEASES_PROMPT").toBe(true);
  for (const [initialized, reason] of [
    [{ fast_mode_state: "off", fast_mode_disabled_reason: "model_not_allowed" }, "off (model_not_allowed)"],
    [{ fast_mode_state: "off", fast_mode_disabled_reason: "extra_usage_disabled" }, "off (extra_usage_disabled)"],
    [{ fast_mode_state: "cooldown" }, "cooldown"],
    [{}, "unreported"],
  ] as const) {
    const refused = gate("fast", initialized);
    expect(await refused.check(), `FAST_${reason}_WITHHELD`).toBe(false);
    expect(refused.terminal.withheld).toBe(true);
    expect(refused.terminal.refused, `FAST_${reason}_NAMED`).toMatchObject({ failure: { errorClass: "fast_output_unavailable", message: expect.stringContaining(reason) } });
    expect(refused.activity, "FAST_REFUSAL_IS_NOT_AN_AUTH_FAILURE").toEqual([]);
  }
});

test("a standard session is refused when native settings turn fast output on, and a predating session is unchanged", async () => {
  const conflict = gate("standard", { fast_mode_state: "on" });
  expect(await conflict.check(), "STANDARD_ON_WITHHELD").toBe(false);
  expect(conflict.terminal.refused).toMatchObject({ failure: { errorClass: "settings_conflict", message: expect.stringContaining("fast output") } });
  expect(await gate("standard", { fast_mode_state: "off", fast_mode_disabled_reason: "preference" }).check(), "STANDARD_OFF_RELEASES").toBe(true);
  expect(await gate(undefined, { fast_mode_state: "on" }).check(), "PREDATING_SESSION_UNCHANGED").toBe(true);
});

// #4325 F6: a route refusal thrown during assembly keeps its machine-readable class.
test("a fast route refusal thrown during the turn reaches the client with its named class", () => {
  const { refusal } = thrownTurnFailure(new FastOutputUnavailableError("not_first_party: this profile's upstream is not the provider's first-party origin"));
  expect(refusal, "ROUTE_REFUSAL_NAMED").toMatchObject({ code: "CLAUDE_ERROR", failure: { errorClass: "fast_output_unavailable", message: expect.stringContaining("not_first_party") } });
});

// #4325 F11: no brain process may start while the login sits inside the brain,
// for a resumed bridge session as for a new one.
test("no brain process starts before the prompt gate while the host login is inside the brain", () => {
  expect(brainProcessesMayStart(undefined)).toBe(true);
  expect(brainProcessesMayStart({ inBrain: false })).toBe(true);
  expect(brainProcessesMayStart({ inBrain: true }), "LOGIN_IN_BRAIN_STARTS_NO_BRAIN_PROCESS").toBe(false);
  const resumed = { sessionId: "ithaca", workerSandbox: { brain: "/ithaca", profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] } } as never;
  expect(checksBrainInventory(resumed, undefined, true), "RESUME_SKIPS_INVENTORY").toBe(false);
});
