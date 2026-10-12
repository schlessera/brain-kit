import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as worker from "@schlessera/brain-ui-sdk/internal";
import { BRIDGE_TOOL_POSTURE } from "@schlessera/brain-ui-sdk/server";

import { createClaudeSdkTurn } from "../src/sdk-options.js";

/**
 * D44's guard at the production call site.
 *
 * `tests/bridge-tools.test.ts` asserts that `createBrainUiMcpServer` stamps
 * `_meta["anthropic/alwaysLoad"]` on every tool it registers. That is the
 * factory. This asserts the thing the model is actually handed: the
 * `mcpServers` entry `createClaudeSdkTurn` builds, which is what
 * `turn-runner.ts` passes to `query()`. Without it, a call site that stopped
 * going through the factory — or built its own server — would leave the
 * factory's test green while every turn shipped deferred tools again.
 */
describe("the SDK options a turn is built with", () => {
  function turnFor(brain: string, bridge: Record<string, unknown>, noGrantSurface = false, maintenance?: worker.MaintenanceHost) {
    return createClaudeSdkTurn({
      backend: { brainPath: brain, maintenance } as never,
      req: {
        prompt: "hello",
        turnBudgetMs: 180_000,
        bridge,
        noGrantSurface,
        enforceAllowedTools: noGrantSurface,
        client: undefined,
      } as never,
      profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never,
      abortController: new AbortController(),
      allowedTools: [],
      confirmPatterns: [],
      turnLock: { acquire: () => undefined, release: () => undefined } as never,
      // Required by the real signature, and deliberately a real function
      // rather than a cast: this test exists to exercise the production call
      // path, so anything it stubs away is coverage it does not have.
      log: () => undefined,
    });
  }

  test("the brain-ui server's tools are always loaded, on the path turn-runner uses", async () => {
    const brain = mkdtempSync(join(tmpdir(), "sdk-options-mcp-"));
    try {
      const unreachable = () => Promise.reject(new Error("not called in this test"));
      const { options } = turnFor(brain, {
        askUser: unreachable,
        askUserList: unreachable,
        askUserRank: unreachable,
        askUserForm: unreachable,
        getLocation: unreachable,
        requestMask: unreachable,
        queryActivity: unreachable,
        inboxList: unreachable, inboxGet: unreachable, inboxAdd: unreachable, resolveAction: unreachable,
      });
      const server = options.mcpServers?.["brain-ui"];
      expect(server).toBeDefined();

      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = await import(
        "@modelcontextprotocol/sdk/inMemory.js"
      );
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "sdk-options-test", version: "0.1.0" }, {});
      await (server as { instance: { connect(t: unknown): Promise<void> } })
        .instance.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();

      // The full roster, because a handler that silently failed to register
      // would leave a tool deferred by absence rather than by policy.
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...BRIDGE_TOOL_POSTURE.names].sort()
      );
      for (const tool of tools) {
        expect(tool._meta?.["anthropic/alwaysLoad"]).toBe(true);
      }
    } finally {
      rmSync(brain, { recursive: true, force: true });
    }
  });
  test("a no-grant turn withholds the form schema, allowlist entry and prompt brief", async () => {
    const brain = mkdtempSync(join(tmpdir(), "sdk-options-form-"));
    try {
      const { options } = turnFor(brain, { askUserForm: async () => ({ answers: {} }) }, true);
      const server = options.mcpServers?.["brain-ui"];
      expect(server).toBeDefined();
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "form-posture", version: "0.1.0" }, {});
      await (server as { instance: { connect(t: unknown): Promise<void> } }).instance.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.map((tool) => tool.name)).not.toContain("ask_user_form");
      expect(options.allowedTools).not.toContain("mcp__brain-ui__ask_user_form");
      expect(JSON.stringify(options.systemPrompt)).not.toContain("ask_user_form");
      await client.close();
    } finally { rmSync(brain, { recursive: true, force: true }); }
  });

});

test("an interactive turn's appended prompt carries the runtime-state note for the backend's resolved allowance (#1625)", () => {
  const brain = mkdtempSync(join(tmpdir(), "sdk-options-state-note-"));
  try {
    const { options, finishWorker } = createClaudeSdkTurn({
      backend: { brainPath: brain, workerState: { allowanceBytes: 32 * 1024 * 1024, budgetBytes: 96 * 1024 * 1024 } } as never,
      req: { prompt: "hello", turnBudgetMs: 180_000, bridge: {}, client: undefined } as never,
      profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never,
      abortController: new AbortController(), allowedTools: [], confirmPatterns: [],
      turnLock: { acquire: () => undefined, release: () => undefined } as never, log: () => undefined,
    });
    void finishWorker();
    expect((options.systemPrompt as { append?: string }).append).toContain("- **Runtime state: 32 MiB.**");
  } finally { rmSync(brain, { recursive: true, force: true }); }
});

test("an interactive turn states its turn-temp allowance next to the turn_temp tool, allows the tool and warns after steps (#1703)", async () => {
  const brain = mkdtempSync(join(tmpdir(), "sdk-options-turn-temp-"));
  try {
    const turn = createClaudeSdkTurn({
      backend: { brainPath: brain, turnTemp: { allowanceBytes: 128 * 1024 * 1024, budgetBytes: 384 * 1024 * 1024 } } as never,
      req: { prompt: "hello", turnBudgetMs: 180_000, bridge: {}, client: undefined } as never,
      profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never,
      abortController: new AbortController(), allowedTools: [], confirmPatterns: [],
      turnLock: { acquire: () => undefined, release: () => undefined } as never, log: () => undefined,
    });
    void turn.finishWorker();
    const append = (turn.options.systemPrompt as { append?: string }).append!;
    expect(append).toContain("- **Turn temp: 128 MiB.**");
    expect(append).toContain("`mcp__brain-ui__turn_temp` shows what uses it");
    // The prompt brief comes from the contract, with the name the model sees.
    expect(append).toContain("call `mcp__brain-ui__turn_temp` to see what");
    expect(turn.options.allowedTools).toContain("mcp__brain-ui__turn_temp");
    expect(turn.options.hooks?.PostToolUse?.length).toBeGreaterThan(0);
    expect(turn.options.hooks?.PostToolUseFailure?.length).toBeGreaterThan(0);
    // No worker runs yet, so the hook has no turn temp to read and says nothing.
    const hook = turn.options.hooks!.PostToolUse!.at(-1)!.hooks[0]!;
    expect(await hook({ hook_event_name: "PostToolUse", tool_name: "Bash" } as never, undefined, { signal: new AbortController().signal }))
      .toEqual({ continue: true });
  } finally { rmSync(brain, { recursive: true, force: true }); }
});

test("an autonomous turn states its turn-temp allowance without a tool it does not have (#1703)", () => {
  const brain = mkdtempSync(join(tmpdir(), "sdk-options-turn-temp-auto-"));
  try {
    const turn = createClaudeSdkTurn({
      backend: { brainPath: brain } as never,
      req: { prompt: "hello", bridge: {}, autonomous: { allowedTools: [], systemPromptAppend: "Autonomous." } } as never,
      profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never,
      abortController: new AbortController(), allowedTools: [], confirmPatterns: [],
      turnLock: { acquire: () => undefined, release: () => undefined } as never, log: () => undefined,
    });
    void turn.finishWorker();
    expect(turn.options.allowedTools).not.toContain("mcp__brain-ui__turn_temp");
    expect(turn.options.hooks?.PostToolUse ?? []).toHaveLength(0);
  } finally { rmSync(brain, { recursive: true, force: true }); }
});


test("Claude startup forwards host maintenance admission without adding it to worker environment",async()=>{
 const brain=mkdtempSync(join(tmpdir(),"claude-maintenance-context-"));
 const maintenance={tempLimits:{allowanceBytes:8388608,budgetBytes:16777216},tempDomain:{statePath:join(brain,"..","odysseus-ui.db")},maskPaths:["/tmp/odysseus-state"]};
 const prepare=worker.prepareWorkerSandbox;let seen:unknown;
 const capture=spyOn(worker,"prepareWorkerSandbox").mockImplementation((root,options)=>{seen=options?.maintenance;return prepare(root,options);});
 try{
  const turn=createClaudeSdkTurn({backend:{brainPath:brain,maintenance},req:{prompt:"Return to Ithaca",signal:new AbortController().signal,bridge:{emit:()=>{},requestPermission:async()=>({behavior:"allow"})}},
   profile:{requiredEnvKeys:[],buildEnv:()=>({})} as never,abortController:new AbortController(),allowedTools:[],confirmPatterns:[],turnLock:{acquire:()=>undefined,release:()=>undefined} as never,log:()=>{}});
  expect(seen,"CLAUDE_STARTUP_SHARED_ADMISSION").toEqual(maintenance);
  expect(JSON.stringify(turn.options.env)).not.toContain(maintenance.tempDomain.statePath);
  await turn.finishWorker();
 }finally{capture.mockRestore();rmSync(brain,{recursive:true,force:true});}
});
