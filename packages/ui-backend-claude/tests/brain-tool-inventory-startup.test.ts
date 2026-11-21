import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as inventory from "../src/brain-tool-forwarder.js";
import * as runtime from "../src/runtime-probe.js";
import { createClaudeBackend } from "../src/backend.js";
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
