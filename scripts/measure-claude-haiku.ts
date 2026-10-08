// #1238: actual bundled runtime, production model assembly, fixture inference.
// Run inside a network namespace with only loopback. No real credentials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SDKMessage, query as QueryFunction } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeBackend } from "../packages/ui-backend-claude/src/backend";
import { defineProfiles } from "../packages/ui-backend-claude/src/profiles";
import { probeClaudeRuntime, selectedSpawn } from "../packages/ui-backend-claude/src/runtime-probe";
import { CLEARED_API_CREDENTIALS } from "../packages/ui-backend-claude/src/subscription";

const model = "claude-haiku-5-5";
const entry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../packages/ui-backend-claude/src"));
const { query } = await import(entry) as { query: typeof QueryFunction };
const sdk = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(dirname(entry), "manifest.json"), "utf8"));
const root = mkdtempSync(join(tmpdir(), "haiku-native-"));
const env = { ...CLEARED_API_CREDENTIALS, HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin",
  CLAUDE_CONFIG_DIR: join(root, "config"), CLAUDE_CODE_OAUTH_TOKEN: "",
  ANTHROPIC_API_KEY: "offline-fixture", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 25_000);
const requests: Array<Record<string, unknown>> = [];
const otherRequests: Array<{ path: string; method: string }> = [];
let server: ReturnType<typeof Bun.serve> | undefined;
let init: unknown, handshake: unknown, terminal: unknown, sdkOptions: unknown, identity: unknown;
let failure: string | null = null;
let successful = false;
const saved = Object.fromEntries(["BRAIN_UI_EXEC_WRAPPER", "BRAIN_UI_EXEC_KILLER", "BRAIN_UI_SUBPROCESS_ENV_EXTRA"].map(key => [key, process.env[key]]));
try {
  for (const key of Object.keys(saved)) delete process.env[key];
  const spawn = selectedSpawn({ cwd: root, env });
  const bytes = readFileSync(spawn.command);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const observed = await probeClaudeRuntime({ brainPath: root, env, exec: {}, signal: controller.signal });
  identity = { sdk: sdk.version, declaredCli: sdk.claudeCodeVersion, manifestCli: manifest.version,
    runtime: observed.runtime.version, binary: { sha256, bytes: bytes.length }, optionalDependencies: sdk.optionalDependencies };
  assert.equal(sdk.version, "0.3.293", "require the actual candidate SDK");
  assert.equal(observed.runtime.version, "2.1.293");
  assert.equal(manifest.version, "2.1.293");
  assert.equal(sdk.claudeCodeVersion, "2.1.293");
  assert.equal(Object.keys(sdk.optionalDependencies).length, 8);
  assert.ok(Object.values(sdk.optionalDependencies).every(version => version === "0.3.293"));
  assert.equal(sha256, manifest.platforms["linux-x64"].checksum);
  if (!process.argv.includes("--identity-only")) {
    assert.deepEqual(readFileSync("/proc/net/dev", "utf8").split("\n").slice(2).filter(line => line.includes(":"))
      .map(line => line.split(":")[0]!.trim()), ["lo"], "require a loopback-only network namespace");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/v1/messages") { otherRequests.push({ path, method: req.method }); return Response.json({}); }
      const body = await req.json() as Record<string, unknown>;
      requests.push({ body, model: body.model, apiKey: req.headers.get("x-api-key"), authorization: req.headers.get("authorization") });
      const events = [
        { type: "message_start", message: { id: "msg_haiku", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Odysseus sails for Ithaca." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } },
        { type: "message_stop" },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    const profiles = defineProfiles([{ id: model, model, label: "Claude Haiku 5.5", apiKeyEnv: "OFFLINE_FIXTURE_KEY" }]);
    profiles[0]!.requiredEnvKeys = [];
    profiles[0]!.buildEnv = () => ({ ...env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server!.port}` });
    const observedQuery: typeof QueryFunction = params => {
      sdkOptions = { model: params.options?.model, effort: params.options?.effort, permissionMode: params.options?.permissionMode };
      const stream = query({ ...params, options: { ...params.options, maxTurns: 1, persistSession: false } });
      return new Proxy(stream, { get(target, key) {
        if (key === "initializationResult") return async () => { const value = await target.initializationResult(); handshake = value; return value; };
        if (key === Symbol.asyncIterator) return async function* () { for await (const msg of target) { observe(msg); yield msg; } };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    function observe(msg: SDKMessage) {
      if (msg.type === "system" && msg.subtype === "init") init = { cli: msg.claude_code_version, model: msg.model, permissionMode: msg.permissionMode, apiKeySource: msg.apiKeySource };
      if (msg.type === "result") terminal = msg;
    }
    const frames: Array<{ type: string; outcome?: string; message?: string }> = [];
    const backend = createClaudeBackend({ brainPath: root, profiles, queryFn: observedQuery, allowedTools: [], log: () => {} });
    await backend.startTurn({ profileId: model, prompt: "Reply with the fictional fixture sentence.", signal: controller.signal,
      bridge: { emit: frame => frames.push(frame), requestPermission: async () => ({ behavior: "deny", message: "No tools in this measurement." }) } });
    assert.equal(frames.at(-1)?.outcome, "success", JSON.stringify(frames.at(-1)));
    assert.ok(requests.length > 0, "observe a real native Messages request");
    assert.ok(requests.every(row => row.model === model), "the actual native request model must remain claude-haiku-5-5");
    for (const request of requests) {
      assert.equal(request.apiKey, "offline-fixture"); assert.equal(request.authorization, null);
      assert.equal((request.body as { output_config?: { effort?: string } }).output_config?.effort, "medium");
      for (const key of ["temperature", "top_p", "top_k"]) assert.ok(!(key in (request.body as object)), `omit ${key}`);
    }
    assert.deepEqual(sdkOptions, { model, effort: "medium", permissionMode: "default" });
    assert.equal((init as { cli: string }).cli, "2.1.293");
    assert.equal((init as { model: string }).model, model);
    assert.equal((init as { permissionMode: string }).permissionMode, "default");
    assert.deepEqual(Object.keys((terminal as { modelUsage: object }).modelUsage), [model]);
    const haiku = (handshake as { models: Array<{ value: string; resolvedModel: string; supportedEffortLevels: string[]; supportsAdaptiveThinking: boolean }> }).models.find(row => row.value === "haiku");
    assert.ok(haiku, "native initialization must describe the Haiku alias");
    assert.equal(haiku.resolvedModel, model);
    assert.deepEqual(haiku.supportedEffortLevels, ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(haiku.supportsAdaptiveThinking, true);
    const usage = (terminal as { modelUsage: Record<string, { canonicalModel: string; provider: string; contextWindow: number; maxOutputTokens: number; costBasis: string; costUSD: number }> }).modelUsage[model]!;
    assert.equal(usage.canonicalModel, model); assert.equal(usage.provider, "firstParty");
    assert.equal(usage.contextWindow, 1_000_000); assert.equal(usage.maxOutputTokens, 128_000);
    assert.equal(usage.costBasis, "list");
    // Fixed fixture tokens at the native short-prompt list prices, not billing.
    assert.ok(Math.abs(usage.costUSD - 0.000004) < 1e-15);
  }
  successful = true;
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally {
  clearTimeout(deadline); server?.stop(true);
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ identity, identityOnly: process.argv.includes("--identity-only"), successful, failure, sdkOptions, init, handshake, requests, otherRequests, terminal,
    billingReceipt: null, note: "Scripted loopback fixture. Native metadata is not proof of live model capacity, account eligibility or actual charges." }, null, 2));
}
if (!successful) process.exitCode = 1;
