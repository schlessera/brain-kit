import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as inventory from "../src/brain-tool-forwarder.js";
import * as runtime from "../src/runtime-probe.js";
import { createClaudeBackend } from "../src/backend.js";
import { checksBrainInventory } from "../src/turn-runner.js";
import { bridgedToolSearch } from "../src/sdk-options.js";
import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
mockWorkerHostForSdkStream();

test("a pending inventory does not serialize independent runtime preparation", async () => {
  const brain = mkdtempSync(join(tmpdir(), "ithaca-parallel-inventory-"));
  const gate = Promise.withResolvers<"unavailable">(), started = Promise.withResolvers<void>();
  let runtimeStarted = false, queried = false;
  const resolveInventory = spyOn(inventory, "probeBrainBridgeInventory").mockImplementation(async () => { started.resolve(); return gate.promise; });
  const probe = spyOn(runtime, "probeClaudeRuntime").mockImplementation(async () => {
    runtimeStarted = true; return { runtime: { version: "2.1.293" } } as never;
  });
  const controller = new AbortController();
  const backend = createClaudeBackend({ brainPath: brain, versionRequirements: { runtime: "2.1.283" },
    profiles: [{ id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: [], buildEnv: () => ({}) }], log() {},
    queryFn: (() => {
      queried = true;
      return { initializationResult: async () => ({ account: { apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" } }),
        async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", session_id: crypto.randomUUID(), is_error: false,
          result: "Odysseus checks Ithaca.", total_cost_usd: 0, duration_ms: 1, num_turns: 1, usage: {}, modelUsage: {} }; } };
    }) as never,
  });
  const work = backend.startTurn({ prompt: "Odysseus checks Ithaca.", signal: controller.signal, applicationAuthority: "server",
    workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
    bridge: { emit() {}, async requestPermission() { return { behavior: "deny", message: "The fixture cannot grant." }; } } });
  try {
    await Promise.race([started.promise, work.then(() => { throw new Error("The fixture never reached inventory selection."); })]);
    expect(runtimeStarted, "RUNTIME_PREPARATION_STARTS_BEFORE_INVENTORY_RELEASE").toBe(true);
    expect(queried, "ONLY_THE_ROSTER_DECISION_WAITS").toBe(false);
    gate.resolve("unavailable"); await work;
    expect(queried).toBe(true);
  } finally { gate.resolve("unavailable"); await work; controller.abort(); resolveInventory.mockRestore(); probe.mockRestore(); rmSync(brain, { recursive: true, force: true }); }
});

test("each new session checks inventory while resumes keep their retained roster without another helper", async () => {
  const brain = mkdtempSync(join(tmpdir(), "ithaca-session-inventory-"));
  let calls = 0;
  const resolveInventory = spyOn(inventory, "probeBrainBridgeInventory").mockImplementation(async () => { calls++; return "unavailable"; });
  const backend = createClaudeBackend({ brainPath: brain, log() {},
    profiles: [{ id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: [], buildEnv: () => ({}) }],
    queryFn: (() => ({ initializationResult: async () => ({}), async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", session_id: "ithaca", is_error: false,
        result: "Odysseus checks Ithaca.", total_cost_usd: 0, duration_ms: 1, num_turns: 1, usage: {}, modelUsage: {} };
    } })) as never });
  const request = { prompt: "Odysseus checks Ithaca.", signal: new AbortController().signal, applicationAuthority: "server" as const,
    workerSandbox: { brain, profile: "governed" as const, restricted: false, areas: [], scratchAliasesRemoved: [] },
    bridge: { emit() {}, async requestPermission() { return { behavior: "deny" as const, message: "The fixture cannot grant." }; } } };
  try {
    await backend.startTurn(request);
    expect(calls, "FIRST_NEW_SESSION_CHECKS_INVENTORY").toBe(1);
    await backend.startTurn(request);
    expect(calls, "SECOND_NEW_SESSION_CHECKS_INVENTORY_AGAIN").toBe(2);
    await backend.startTurn({ ...request, sessionId: "ithaca" });
    expect(calls, "RESUMED_SESSION_SKIPS_INVENTORY").toBe(2);
  } finally { resolveInventory.mockRestore(); rmSync(brain, { recursive: true, force: true }); }
});

// #4325 F18: brain configuration never runs before the prompt gate refuses a
// login the worker could read.
test("a login inside the brain skips the inventory helper", () => {
  const request = { workerSandbox: { brain: "/ithaca", profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] } } as never;
  expect(checksBrainInventory(request, undefined, true), "NEW_HOSTED_SESSION_CHECKS").toBe(true);
  expect(checksBrainInventory(request, { inBrain: false }, true)).toBe(true);
  expect(checksBrainInventory(request, { inBrain: true }, true), "LOGIN_IN_BRAIN_SKIPS_HELPER").toBe(false);
  expect(checksBrainInventory({ ...request as object, sessionId: "ithaca" } as never, undefined, true), "RESUME_SKIPS_HELPER").toBe(false);
  expect(checksBrainInventory(request, undefined, false), "UNHOSTED_SKIPS_HELPER").toBe(false);
  expect(checksBrainInventory({} as never, undefined, true), "UNSANDBOXED_SKIPS_HELPER").toBe(false);
});

// #4325 F23: the helper evaluates configuration under the setting the bridged
// session pins, which its forwarder and runtime also see.
test("the inventory helper runs under the bridged session's tool-search setting", async () => {
  expect(bridgedToolSearch({ proxyDir: "/run/ithaca" }, { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }), "FIRST_PARTY_RELAY_PINS_ON").toBe("true");
  expect(bridgedToolSearch({ proxyDir: "/run/ithaca" }, { ANTHROPIC_BASE_URL: "https://gateway.example.com" }), "GATEWAY_PINS_OFF").toBe("false");
  expect(bridgedToolSearch(undefined, { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }), "DIRECT_TURN_PINS_OFF").toBe("false");
  const brain = mkdtempSync(join(tmpdir(), "ithaca-inventory-env-"));
  const seen: (string | undefined)[] = [];
  const resolveInventory = spyOn(inventory, "probeBrainBridgeInventory").mockImplementation(async input => { seen.push(input.env.ENABLE_TOOL_SEARCH); return "unavailable"; });
  const backend = createClaudeBackend({ brainPath: brain, log() {},
    profiles: [{ id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: [], buildEnv: () => ({ ENABLE_TOOL_SEARCH: "true" }) }],
    queryFn: (() => ({ initializationResult: async () => ({}), async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", session_id: "ithaca", is_error: false,
        result: "Odysseus checks Ithaca.", total_cost_usd: 0, duration_ms: 1, num_turns: 1, usage: {}, modelUsage: {} };
    } })) as never });
  try {
    await backend.startTurn({ prompt: "Odysseus checks Ithaca.", signal: new AbortController().signal, applicationAuthority: "server",
      workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
      bridge: { emit() {}, async requestPermission() { return { behavior: "deny", message: "The fixture cannot grant." }; } } });
    // An inherited value never reaches the helper: a new direct session pins off.
    expect(seen, "HELPER_SEES_THE_PINNED_SETTING").toEqual(["false"]);
  } finally { resolveInventory.mockRestore(); rmSync(brain, { recursive: true, force: true }); }
});
