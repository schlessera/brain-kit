import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSdkTurn } from "../src/sdk-options";
import { createBrainUiMcpServer } from "../src/ask-user-tool";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BackendActivityEvent } from "@schlessera/brain-ui-sdk/server";

test("Claude hashes its actual assembled MCP roster in registration order", async () => {
  let assembled: any[] = [];
  const server = createBrainUiMcpServer({ stableRoster: true, brainPath: "/tmp/odyssey", observeTools: tools => { assembled = tools; } });
  const client = new Client({ name: "Odysseus", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.instance.connect(st); await client.connect(ct);
    const tools = (await client.listTools()).tools;
    expect(assembled.map(t => t.name), "ASSEMBLED_ROSTER_ORDER").toEqual(tools.map(t => t.name));
    for (let i = 0; i < tools.length; i++) {
      expect(assembled[i].description).toBe(tools[i]!.description);
      expect(assembled[i].schema).toEqual(tools[i]!.inputSchema);
    }
  } finally { await client.close(); }
});

test("Claude emits hash-only prefix assembly before inference and posture auto-allow does not change tool membership", async () => {
  const brain = mkdtempSync(join(tmpdir(), "odyssey-fingerprint-"));
  const fingerprints: any[] = [];
  try {
    for (const mode of ["ordinary", "no-grant"]) {
      const events: BackendActivityEvent[] = [];
      const turn = createClaudeSdkTurn({ backend: { brainPath: brain, systemPromptAppend: "Odysseus reads the raft plan." }, req: {
        prompt: "Review the sail", signal: new AbortController().signal,
        bridge: { emit() {}, activity: event => events.push(event), requestPermission: async () => ({ behavior: "deny", message: "Fixture" }) },
        ...(mode === "no-grant" ? { noGrantSurface: true, enforceAllowedTools: true } : {}),
      }, profile: { model: "odyssey-model", requiredEnvKeys: [], buildEnv: () => ({}) } as never,
      abortController: new AbortController(), allowedTools: [], confirmPatterns: [],
      turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never, log() {} });
      try {
        const prefixes = events.filter(e => e.kind === "prompt_prefix");
        expect(prefixes, "CLAUDE_ASSEMBLED_PREFIX_BEFORE_QUERY").toHaveLength(1);
        const prefix = prefixes[0]!;
        if (prefix.kind !== "prompt_prefix") throw Error("Missing prefix");
        fingerprints.push(prefix.prefix);
        for (const key of ["tools", "system", "model"] as const) expect(prefix.prefix[key]).toMatch(/^[a-f0-9]{64}$/);
        expect(prefix.prefix.gitStatusIncluded).toBe(false);
        expect(JSON.stringify(prefix)).not.toContain("raft plan");
      } finally { await turn.finishWorker(); }
    }
    expect(fingerprints[0]).toEqual(fingerprints[1]);
  } finally { rmSync(brain, { recursive: true, force: true }); }
});
