import { createClaudeSdkTurn } from "../src/sdk-options.js";
import { installTestHome } from "../../../scripts/test-home.js";
import { installIthacaModuleTool } from "./fixtures/brain-module-tool.js";
/** Real sandbox/stdio proof; copied immutable fixture storage stands in for native acquisition only. */
import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "@schlessera/brain/internal";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { launchLimits, restrictedReadPaths, resolveTurnTempLimits } from "@schlessera/brain-ui-sdk/internal";
import { createFixtureWorkerStartupView, prepareFixtureWorkerSandbox } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { replaceNativeStartupAcquisitionForFixture } from "../../ui-server/tests/helpers/fixture-native-startup.js";
import { createBrainToolForwarder, startBrainToolWorker, probeBrainBridgeInventory } from "../src/brain-tool-forwarder.js";

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
  const base = prepareFixtureWorkerSandbox(brain, { home, profile: "strict", areas: [] });
  const sandbox = { ...base, readPaths: restrictedReadPaths([mcp, entry]),
    providerMasks: { folders: ["sealed"], index: join(scratch, "index") } };
  cpSync(join(brain, ".brain-index"), join(scratch, "index"), { recursive: true });
  let starts = 0;
  const input = { brainPath: brain, sandbox: sandbox as never, startupView: view,
    env: { PATH: process.env.PATH, HOME: home }, limits: launchLimits({}), turnTempLimits: resolveTurnTempLimits({}),
    credentialEnv: [], req: { workerStarted(worker: { stderr: NodeJS.ReadableStream; exited: Promise<number> }) { starts++; worker.stderr.on("data", chunk => errors.push(String(chunk)));  }, bridge: {} } as never };
  forward = createBrainToolForwarder(startBrainToolWorker(input), controller.signal, error => errors.push(error));
  client = new Client({ name: "odysseus-runtime", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    expect(await probeBrainBridgeInventory({ ...input, req: { bridge: {} } as never }, controller.signal), "CORE_ONLY_INVENTORY_QUALIFIES").toBe("core-only");
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
    try { await client?.close(); } finally { try { await forward?.close(); } finally { restore?.(); view?.cleanup(); rmSync(scratch, { recursive: true, force: true }); } }
  }
});


test("a sandbox-resolved module MCP inventory keeps its original stdio tool reachable", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ithaca-module-forwarding-")), brain = join(scratch, "brain"), home = join(scratch, "home");
  const restore = replaceNativeStartupAcquisitionForFixture();
  const testHome = installTestHome();
  let turn: ReturnType<typeof createClaudeSdkTurn> | undefined;
  let view: ReturnType<typeof createFixtureWorkerStartupView> | undefined;
  let resource: Awaited<ReturnType<ReturnType<typeof startBrainToolWorker>>> | undefined;
  const client = new Client({ name: "odysseus-module-runtime", version: "1" });
  const controller = new AbortController();
  try {
    cpSync(resolve("packages/core/fixtures/corpus"), brain, { recursive: true });
    mkdirSync(home); mkdirSync(join(brain, "node_modules/.bin"), { recursive: true });
    installIthacaModuleTool(brain);
    const cli = resolve("packages/core/src/cli/brain.ts"), entry = join(brain, "node_modules/.bin/brain");
    writeFileSync(entry, `import ${JSON.stringify(cli)};`);
    openDatabase(join(brain, ".brain-index/brain.db")).close();
    view = createFixtureWorkerStartupView(brain);
    const sandbox = { ...prepareFixtureWorkerSandbox(brain, { home, profile: "strict", areas: [] }), readPaths: restrictedReadPaths([cli, entry]) };
    const input = { brainPath: brain, sandbox, startupView: view, env: { PATH: process.env.PATH, HOME: home },
      limits: launchLimits({}), turnTempLimits: resolveTurnTempLimits({}), credentialEnv: [], req: { bridge: {} } as never };
    const inventory = await probeBrainBridgeInventory(input, controller.signal);
    expect(inventory, "MODULE_TOOLS_MUST_DISABLE_STATIC_BRIDGE").toBe("module-tools");
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
      resource = await startBrainToolWorker(input)(controller.signal);
      await client.connect(resource.transport);
    }
    expect((await client.listTools()).tools.map(tool => tool.name), "ORIGINAL_MODULE_TOOL_NAME_REACHABLE").toContain("ithaca_route");
    expect(await client.callTool({ name: "ithaca_route", arguments: {} })).toMatchObject({ structuredContent: { route: "Odysseus sails to Ithaca." } });
    expect(turn.options.env!.ENABLE_TOOL_SEARCH, "MODULE_STDIO_SEARCH_REMAINS_OFF").toBe("false");
    expect(diagnostics).toContain("brain_bridge_fallback_module_tools: keeping the project brain stdio entry and tool search off.");
  } finally {
    controller.abort();
    try { await client.close(); } finally { try { await resource?.close(); await turn?.finishWorker(); } finally { restore(); testHome.dispose(); view?.cleanup(); rmSync(scratch, { recursive: true, force: true }); } }
  }
});
