import { probeClaudeRuntime } from "../src/runtime-probe.js";
import { retainNativeRouteInputs } from "../src/native-route-inputs.js";
import { createClaudeSdkTurn } from "../src/sdk-options.js";
import { installTestHome } from "../../../scripts/test-home.js";
import { installIthacaModuleTool } from "./fixtures/brain-module-tool.js";
/** Real sandbox/stdio proof; copied immutable fixture storage stands in for native acquisition only. */
import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "@schlessera/brain/internal";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { launchLimits, processStateLedger, restrictedReadPaths, resolveTurnTempLimits } from "@schlessera/brain-ui-sdk/internal";
import { createFixtureWorkerStartupView, prepareFixtureWorkerSandbox } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../../ui-server/tests/helpers/fixture-native-startup.js";
import { createBrainToolForwarder, startBrainToolWorker, probeBrainBridgeInventory, brainInventoryEntry } from "../src/brain-tool-forwarder.js";

/** The brain's own installed core: this checkout's, so it is the host's version (#4325 F14). */
const CORE_MANIFEST = resolve("packages/core/package.json");
function installCore(brain: string) {
  mkdirSync(join(brain, "node_modules/@schlessera"), { recursive: true });
  symlinkSync(resolve("packages/core"), join(brain, "node_modules/@schlessera/brain"));
}
/** The template's own project entry, the only one the bridge stands in for. */
const CANONICAL_MCP = JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } });


function inventoryTiming(kind: string) {
  const spans: Array<{ name: string; durationMs: number; startedAt: number; endedAt: number; attributes?: unknown }> = [];
  const timing = { start(name: string, attributes?: unknown) { const startedAt = performance.now(); return () => { const endedAt = performance.now(); spans.push({ name, attributes, startedAt, endedAt, durationMs: endedAt - startedAt }); }; },
    worker() {}, missing() {}, received() {} };
  return { timing, spans, verify() {
    expect(spans.map(span => span.name), "INVENTORY_HAS_ITS_OWN_STARTUP_SPAN").toEqual(["brain_tool_inventory"]);
    expect(spans[0]!.attributes, "INVENTORY_SPAN_HAS_NO_CACHE_ATTRIBUTE").toBeUndefined();
    console.log("BRAIN_TOOL_INVENTORY_WALL", JSON.stringify({ kind, ...spans[0] }));
  } };
}

/** The probe's worker cleanup runs detached after its verdict; let it settle before the scratch tree goes. */
async function bridgeCleanupSettled() {
  for (let waited = 0; waited < 10_000 && processStateLedger().turnTempHeld > 0; waited += 10) await Bun.sleep(10);
}

test("forwarded core reads use the immutable worker view and refuse provider-masked paths while the host copy remains readable", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ithaca-brain-forwarding-")), brain = join(scratch, "brain"), home = join(scratch, "home");
  let view: ReturnType<typeof createFixtureWorkerStartupView> | undefined;
  let restore: (() => void) | undefined;
  let forward: ReturnType<typeof createBrainToolForwarder> | undefined;
  let client: Client | undefined;
  const controller = new AbortController();
  try {
  cpSync(resolve("packages/core/fixtures/corpus"), brain, { recursive: true });
  mkdirSync(home); mkdirSync(join(brain, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(brain, ".mcp.json"), CANONICAL_MCP); installCore(brain);
  mkdirSync(join(brain, "notes"), { recursive: true }); mkdirSync(join(brain, "sealed"));
  writeFileSync(join(brain, "notes/raft.md"), "Odysseus checks the original raft.\n");
  writeFileSync(join(brain, "sealed/route.md"), "Athena keeps the route private.\n");
  const mcp = resolve("packages/core/src/cli/brain.ts"), entry = join(brain, "node_modules/.bin/brain");
  writeFileSync(entry, `#!/usr/bin/env bun\nimport ${JSON.stringify(mcp)};\n`); chmodSync(entry, 0o755);
  const config = join(brain, "brain.config.ts");
  // The fixture's config is data from the canonical corpus, with its package resolved locally.
  const configText = await Bun.file(config).text();
  writeFileSync(config, configText.replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
  openDatabase(join(brain, ".brain-index/brain.db")).close();
  view = createFixtureWorkerStartupView(brain);
  writeFileSync(join(brain, "notes/raft.md"), "Penelope changed the host raft after the snapshot.\n");
  restore = replaceNativeStartupAcquisitionForFixture();
  const errors: unknown[] = [];
  const base = prepareFixtureWorkerSandbox(brain, { profile: "strict", areas: [] });
  const sandbox = { ...base, readPaths: restrictedReadPaths([mcp, entry, brainInventoryEntry(), CORE_MANIFEST]),
    providerMasks: { folders: ["sealed"], index: join(scratch, "index") } };
  cpSync(join(brain, ".brain-index"), join(scratch, "index"), { recursive: true });
  let starts = 0;
  const input = { brainPath: brain, exec: {}, sandbox: sandbox as never, startupView: view,
    env: { PATH: process.env.PATH, HOME: home }, limits: launchLimits({}), turnTempLimits: resolveTurnTempLimits({}),
    credentialEnv: [], req: { workerStarted(worker: { stderr: NodeJS.ReadableStream; exited: Promise<number> }) { starts++; worker.stderr.on("data", chunk => errors.push(String(chunk)));  }, bridge: {} } as never };
  forward = createBrainToolForwarder(startBrainToolWorker(input), controller.signal, error => errors.push(error));
  client = new Client({ name: "odysseus-runtime", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const measured = inventoryTiming("core-only");
    const inventory = probeBrainBridgeInventory({ ...input, req: { bridge: {}, startupTiming: measured.timing } as never }, controller.signal);
    // These are the same independent pre-query operations as the turn runner.
    // Copied fixture storage supplies route inputs; this is offline component
    // timing, not a native-host or provider first-frame measurement.
    const preparationStarted = performance.now();
    let preparationEnded = 0;
    let routes: Awaited<ReturnType<typeof retainNativeRouteInputs>> | undefined;
    const preparation = Promise.all([
      probeClaudeRuntime({ brainPath: brain, env: input.env, exec: {}, signal: controller.signal }),
      retainNativeRouteInputs(view.root).then(owner => { routes = owner; }),
    ]).finally(() => { preparationEnded = performance.now(); });
    try {
      const [verdict, [runtime]] = await Promise.all([inventory, preparation]);
      expect(verdict, "CORE_ONLY_INVENTORY_QUALIFIES").toBe("core-only");
      measured.verify();
      const span = measured.spans[0]!;
      const overlapMs = Math.max(0, Math.min(span.endedAt, preparationEnded) - Math.max(span.startedAt, preparationStarted));
      console.log("BRAIN_TOOL_INVENTORY_OVERLAP", JSON.stringify({ inventoryMs: span.durationMs,
        independentPreparationMs: preparationEnded - preparationStarted, overlapMs,
        exposedInventoryMs: span.durationMs - overlapMs,
        runtimeVersion: runtime.runtime.version }));
    } finally { await Promise.allSettled([inventory, preparation]); await routes?.close(); }
    await forward.server.instance.connect(serverTransport); await client.connect(clientTransport);
    forward.start();
    const visible = await client.callTool({ name: "brain_read", arguments: { path: "notes/raft.md" } });
    expect(visible.isError, JSON.stringify(errors.map(String))).not.toBe(true);
    expect((visible.content as unknown[])[0]).toEqual({ type: "text", text: "Odysseus checks the original raft.\n" });
    const hidden = await client.callTool({ name: "brain_read", arguments: { path: "sealed/route.md" } });
    expect(hidden.isError, "HOST_FALLBACK_MUST_NOT_EXPOSE_MASKED_CONTENT").toBe(true);
    expect(JSON.stringify(hidden)).not.toContain("Athena keeps the route private.");
    expect(await Bun.file(join(brain, "sealed/route.md")).text()).toBe("Athena keeps the route private.\n");
    expect(starts, "ONE_SANDBOXED_BRAIN_SERVER").toBe(1);
  } finally {
    controller.abort();
    try { await client?.close(); } finally { try { await forward?.close(); await bridgeCleanupSettled(); } finally { restore?.(); view?.cleanup(); rmSync(scratch, { recursive: true, force: true }); } }
  }
});


test("a config change between two new sessions preserves the second session module MCP tool under its original name", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ithaca-module-forwarding-")), brain = join(scratch, "brain"), home = join(scratch, "home");
  const restore = replaceNativeStartupAcquisitionForFixture();
  const testHome = installTestHome();
  let firstTurn: ReturnType<typeof createClaudeSdkTurn> | undefined;
  let turn: ReturnType<typeof createClaudeSdkTurn> | undefined;
  let view: ReturnType<typeof createFixtureWorkerStartupView> | undefined;
  let resource: Awaited<ReturnType<ReturnType<typeof startBrainToolWorker>>> | undefined;
  const client = new Client({ name: "odysseus-module-runtime", version: "1" });
  const controller = new AbortController();
  try {
    cpSync(resolve("packages/core/fixtures/corpus"), brain, { recursive: true });
    mkdirSync(home); mkdirSync(join(brain, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(brain, ".mcp.json"), CANONICAL_MCP); installCore(brain);
    const config = join(brain, "brain.config.ts");
    writeFileSync(config, (await Bun.file(config).text()).replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
    const cli = resolve("packages/core/src/cli/brain.ts"), entry = join(brain, "node_modules/.bin/brain");
    writeFileSync(entry, `import ${JSON.stringify(cli)};`);
    openDatabase(join(brain, ".brain-index/brain.db")).close();
    view = createFixtureWorkerStartupView(brain);
    const sandbox = { ...prepareFixtureWorkerSandbox(brain, { profile: "strict", areas: [] }), readPaths: restrictedReadPaths([cli, entry, brainInventoryEntry(), CORE_MANIFEST]) };
    const input = { brainPath: brain, exec: {}, sandbox, startupView: view, env: { PATH: process.env.PATH, HOME: home },
      limits: launchLimits({}), turnTempLimits: resolveTurnTempLimits({}), credentialEnv: [], req: { bridge: {} } as never };
    const firstInventory = await probeBrainBridgeInventory(input, controller.signal);
    firstTurn = createClaudeSdkTurn({ backend: { brainPath: brain }, brainBridgeInventory: firstInventory,
      req: { prompt: "Odysseus checks the first route.", applicationAuthority: "server", workerSandbox: sandbox,
        workerStartupView: view, bridge: { emit() {}, async requestPermission() { return { behavior: "deny" as const, message: "The fixture cannot grant." }; } }, signal: controller.signal },
      profile: { id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: [], buildEnv: () => ({}) },
      turnEnvironment: { HOME: home }, abortController: controller, allowedTools: [], confirmPatterns: [],
      turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never, log() {} });
    expect(firstTurn.options.mcpServers!.brain?.type, "FIRST_NEW_SESSION_USES_CORE_BRIDGE").toBe("sdk");
    await firstTurn.finishWorker(); firstTurn = undefined;
    view.cleanup();
    installIthacaModuleTool(brain);
    view = createFixtureWorkerStartupView(brain);
    const changedInput = { ...input, startupView: view };
    const measured = inventoryTiming("module-tools");
    const inventory = await probeBrainBridgeInventory({ ...changedInput, req: { bridge: {}, startupTiming: measured.timing } as never }, controller.signal);
    expect(inventory, "SECOND_NEW_SESSION_USES_UPDATED_MODULE_CONFIG").toBe("module-tools");
    measured.verify();
    const diagnostics: string[] = [];
    turn = createClaudeSdkTurn({ backend: { brainPath: brain }, brainBridgeInventory: inventory,
      req: { prompt: "Odysseus checks the route.", applicationAuthority: "server", workerSandbox: sandbox,
        workerStartupView: view, bridge: { emit() {}, async requestPermission() { return { behavior: "deny" as const, message: "The fixture cannot grant." }; } }, signal: controller.signal },
      profile: { id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: [], buildEnv: () => ({}) },
      turnEnvironment: { HOME: home }, abortController: controller, allowedTools: [], confirmPatterns: [],
      turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never,
      log(_level, message) { diagnostics.push(message); } });
    const selected = turn.options.mcpServers!.brain;
    if (selected?.type === "sdk") {
      const [local, remote] = InMemoryTransport.createLinkedPair();
      await selected.instance.connect(remote); await client.connect(local);
    } else {
      resource = await startBrainToolWorker(changedInput)(controller.signal);
      await client.connect(resource.transport);
    }
    expect((await client.listTools()).tools.map(tool => tool.name), "ORIGINAL_MODULE_TOOL_NAME_REACHABLE").toContain("ithaca_route");
    expect(await client.callTool({ name: "ithaca_route", arguments: {} })).toMatchObject({ structuredContent: { route: "Odysseus sails to Ithaca." } });
    expect(turn.options.env!.ENABLE_TOOL_SEARCH, "MODULE_STDIO_SEARCH_REMAINS_OFF").toBe("false");
    expect(diagnostics).toContain("brain_bridge_fallback_module_tools: keeping the project brain stdio entry and tool search off.");
  } finally {
    controller.abort();
    try { await client.close(); } finally { try { await resource?.close(); await firstTurn?.finishWorker(); await turn?.finishWorker(); await bridgeCleanupSettled(); } finally { restore(); testHome.dispose(); view?.cleanup(); rmSync(scratch, { recursive: true, force: true }); } }
  }
});
