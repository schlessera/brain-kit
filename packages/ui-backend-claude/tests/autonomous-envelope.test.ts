/**
 * The options an autonomous Claude turn is built with (#676). The runtime
 * proof is `tests/autonomous-containment.test.ts`; this pins the assembly the
 * proof exercises, including the refusals that never reach a worker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INFERENCE_PLACEHOLDER, WORKER_INFERENCE_SOCKET } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeSdkTurn } from "../src/sdk-options.js";

const brains: string[] = [];
const finishers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const finish of finishers.splice(0)) await finish();
  for (const brain of brains.splice(0)) rmSync(brain, { recursive: true, force: true });
});

function turn(profile: { billing?: "api" | "subscription"; env: Record<string, string> }, allowedTools = ["Bash", "mcp__brain-ui__show_block"],
  containment: "restricted" | "none" = "restricted") {
  const brain = mkdtempSync(join(tmpdir(), "claude-autonomous-envelope-"));
  brains.push(brain);
  const sdkTurn = createClaudeSdkTurn({
    backend: { brainPath: brain } as never,
    req: { prompt: "Odysseus triage", signal: new AbortController().signal, enforceAllowedTools: true, noGrantSurface: true,
      bridge: { emit: () => {}, checkpointPermission: () => {}, requestPermission: async () => ({ behavior: "deny", message: "no" }) },
      autonomous: { origin: "autonomous", persistence: "none", ...(containment === "restricted" ? { containment } : {}), allowedTools, systemPromptAppend: "Server snapshot." } } as never,
    profile: { id: "fixture", label: "Fixture", requiredEnvKeys: [], billing: profile.billing, buildEnv: () => profile.env } as never,
    abortController: new AbortController(),
    allowedTools,
    confirmPatterns: [],
    turnLock: { acquire: () => undefined, release: () => undefined } as never,
    log: () => undefined,
  });
  finishers.push(sdkTurn.finishWorker);
  return sdkTurn;
}

describe("autonomous Claude envelope", () => {
  test("no ambient settings or MCP server; instructions are the server snapshot", () => {
    const { options } = turn({ billing: "api", env: { ANTHROPIC_API_KEY: "sk-odysseus-real" } });
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    // Membership is enforced, not hidden: an out-of-roster call must escalate.
    expect(options.tools).toBeUndefined();
    expect(options.persistSession).toBe(false);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["brain-ui"]);
    expect(options.systemPrompt).toMatchObject({ append: "Server snapshot." });
  });

  test("the worker environment holds a placeholder and the relay route, never the credential or host variables", () => {
    process.env.ODYSSEUS_HOST_ONLY = "host-only";
    try {
      const { options, pinnedSettingsEnv } = turn({ billing: "api", env: { ANTHROPIC_API_KEY: "sk-odysseus-real", ANTHROPIC_BASE_URL: "https://api.example" } });
      const env = options.env as Record<string, string>;
      expect(env.ANTHROPIC_API_KEY).toBe(INFERENCE_PLACEHOLDER);
      expect(env.ANTHROPIC_UNIX_SOCKET).toBe(WORKER_INFERENCE_SOCKET);
      expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost");
      expect(JSON.stringify(env)).not.toContain("sk-odysseus-real");
      expect(JSON.stringify(env)).not.toContain("api.example");
      expect(env.ODYSSEUS_HOST_ONLY).toBeUndefined();
      expect(env.HOME).toBeUndefined();
      // Flag settings pin the same route, so no settings tier can reroute it.
      expect(options.settings).toMatchObject({ apiKeyHelper: "", env: pinnedSettingsEnv });
    } finally { delete process.env.ODYSSEUS_HOST_ONLY; }
  });

  test("a subscription turn crosses only with an explicit OAuth token, held by the relay", () => {
    const { options } = turn({ env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-odysseus" } });
    const env = options.env as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(INFERENCE_PLACEHOLDER);
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(() => turn({ env: {} })).toThrow("need CLAUDE_CODE_OAUTH_TOKEN");
  });

  const relayDirs = () => new Set(readdirSync(tmpdir()).filter(name => name.startsWith("brain-inference-")));

  test("an API profile without a credential refuses before a relay or worker exists", () => {
    const before = relayDirs();
    expect(() => turn({ billing: "api", env: {} })).toThrow("has no inference credential");
    expect([...relayDirs()].filter(name => !before.has(name))).toEqual([]);
  });

  test("a nonpersistent turn without restricted containment, such as a handoff summary, is unchanged", () => {
    const { options } = turn({ env: {} }, [], "none");
    expect(options.settingSources).toEqual(["project"]);
    expect(options.strictMcpConfig).toBeUndefined();
    expect(options.persistSession).toBe(false);
    expect((options.env as Record<string, string>).ANTHROPIC_UNIX_SOCKET).toBe("");
  });

  test("finishing the turn stops its relay", async () => {
    const before = relayDirs();
    const sdkTurn = turn({ billing: "api", env: { ANTHROPIC_API_KEY: "sk-odysseus-real" } });
    const created = [...relayDirs()].filter(name => !before.has(name));
    expect(created).toHaveLength(1);
    await sdkTurn.finishWorker();
    expect(existsSync(join(tmpdir(), created[0]!))).toBe(false);
  });
});
