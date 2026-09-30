import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  function turnFor(brain: string, bridge: Record<string, unknown>) {
    return createClaudeSdkTurn({
      backend: { brainPath: brain } as never,
      req: {
        prompt: "hello",
        turnBudgetMs: 180_000,
        bridge,
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
        getLocation: unreachable,
        requestMask: unreachable,
        queryActivity: unreachable,
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
});
