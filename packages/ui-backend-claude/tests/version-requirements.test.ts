import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendBridge, ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { createClaudeBackend } from "../src/backend";
import type { ClaudeBackendOptions } from "../src/options";
import { defineProfiles } from "../src/profiles";
import { probeClaudeRuntime } from "../src/runtime-probe";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(js = false) {
  const dir = mkdtempSync(join(tmpdir(), "claude-requirements-")); scratch.push(dir);
  const path = join(dir, js ? "cli.js" : "claude");
  const set = (version: string) => {
    writeFileSync(path, js ? `console.log(${JSON.stringify(version + " (Claude Code)")});` : `#!/bin/sh\necho ${JSON.stringify(version + " (Claude Code)")}\n`);
    chmodSync(path, 0o755);
  };
  set("2.1.999");
  return { dir, path, set };
}
const apiProfiles = defineProfiles([{ id: "api", label: "API", apiKeyEnv: "FAKE_KEY", source: "declared" }]);
function harness(init: () => Promise<unknown> = async () => ({}), version = "2.1.999") {
  const released: SDKUserMessage[] = [];
  const calls: unknown[] = [];
  const frames: ServerMessage[] = [];
  const queryFn = ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options: unknown }) => {
    calls.push(params.options);
    return { initializationResult: init, getSettings: async () => ({ effective: {}, sources: [] }), async *[Symbol.asyncIterator]() {
      if (typeof params.prompt === "string") released.push({ message: { content: params.prompt } } as SDKUserMessage);
      else for await (const msg of params.prompt) released.push(msg);
      yield { type: "system", subtype: "init", session_id: "session", claude_code_version: version };
      yield { type: "result", subtype: "success", session_id: "session", duration_ms: 1, num_turns: 1, total_cost_usd: 0 };
    } };
  }) as unknown as typeof query;
  const bridge: BackendBridge = { emit: msg => frames.push(msg), requestPermission: async () => ({ behavior: "allow" }) };
  return { released, calls, frames, queryFn, bridge };
}
function options(f: ReturnType<typeof fixture>, h: ReturnType<typeof harness>) {
  return { brainPath: f.dir, claudeCodePath: f.path, profiles: apiProfiles, queryFn: h.queryFn,
    log: () => {}, versionRequirements: { runtime: "2.1.283" } } as ClaudeBackendOptions;
}
test("direct factory enforces the owning SDK upper bound against a conflicting host floor", () => {
  expect(() => createClaudeBackend({ brainPath: "/unused", versionRequirements: { sdk: "0.4.0" } } as ClaudeBackendOptions)).toThrow(/No version satisfies.*0\.3\.241.*0\.4\.0/);
});
for (const js of [false, true]) for (const resume of [false, true]) {
  test(`${js ? "JS" : "native"} changed override refuses ${resume ? "resume" : "start"} before user prompt release`, async () => {
    const f = fixture(js); const h = harness();
    // A successful boot cannot vouch for a replaceable binary later.
    const boot = await probeClaudeRuntime({ brainPath: f.dir, claudeCodePath: f.path, env: process.env, exec: {} });
    expect(boot.runtime.version).toBe("2.1.999");
    const backend = createClaudeBackend(options(f, h));
    f.set("2.1.282");
    await backend.startTurn({ prompt: "nonempty user work", signal: new AbortController().signal, bridge: h.bridge,
      ...(resume ? { sessionId: "existing" } : {}) });
    expect(h.released).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
    expect(h.frames.find(msg => msg.type === "error")).toMatchObject({ type: "error", message: expect.stringMatching(/runtime.*(?:start|resume).*detected "2\.1\.282".*host.*2\.1\.283/) });
    expect(h.frames.at(-1)).toMatchObject(resume ? { type: "result", outcome: "error", sessionId: "existing" } : { type: "error" });
  });
}
test("API prompt waits for a successful SDK handshake with a runtime requirement", async () => {
  const f = fixture(); let complete!: (value: unknown) => void;
  const h = harness(() => new Promise(resolve => { complete = resolve; }));
  const turn = createClaudeBackend(options(f, h)).startTurn({ prompt: "nonempty user work", signal: new AbortController().signal, bridge: h.bridge });
  for (let n = 0; n < 100 && !complete; n++) await Bun.sleep(10);
  expect(h.calls).toHaveLength(1);
  expect(h.released).toHaveLength(0);
  complete({}); await turn;
  expect(h.released).toHaveLength(1);
  expect(h.released[0]!.message.content).toBe("nonempty user work");
  expect(h.frames.at(-1)).toMatchObject({ type: "result", outcome: "success" });
});
test("contradictory init aborts the constrained turn with its normal terminal error", async () => {
  const f = fixture(); const h = harness(async () => ({}), "2.1.282");
  await createClaudeBackend(options(f, h)).startTurn({ prompt: "nonempty user work", signal: new AbortController().signal, bridge: h.bridge });
  expect(h.released).toHaveLength(1); // init is observation AFTER release
  expect(h.frames.at(-1)).toMatchObject({ type: "result", outcome: "error" });
  expect(h.frames.some(msg => msg.type === "result" && msg.outcome === "success")).toBe(false);
});

for (const version of ["v2.1.999", "2.1.999+build.1"]) test(`recognized Claude wrapper preserves strict version ${version}`, async () => {
  const f = fixture(); f.set(version);
  const report = await probeClaudeRuntime({ brainPath: f.dir, claudeCodePath: f.path, env: process.env, exec: {}, versionRequirements: { runtime: "2.1.283" } });
  expect(report.runtime.version).toBe(version.replace(/^v/, ""));
  expect(report.measured?.matches).toBe(false);
});
for (const version of ["02.1.999", "2.1", "2.1.999-beta.1", "junk 2.1.999", "2.1.999 extra", "\u00a02.1.999"]) test(`constrained runtime refuses ${JSON.stringify(version)} before prompt release`, async () => {
  const f = fixture(); f.set(version); const h = harness();
  await createClaudeBackend(options(f, h)).startTurn({ prompt: "nonempty user work", signal: new AbortController().signal, bridge: h.bridge });
  expect(h.released).toHaveLength(0);
  expect(h.calls).toHaveLength(0);
  expect(h.frames.find(msg => msg.type === "error")).toMatchObject({ type: "error", message: expect.stringContaining("host versionRequirements.runtime") });
  expect(h.frames.at(-1)).toMatchObject({ type: "error" });
});
test("failed SDK handshake refuses API input rather than treating init as verification", async () => {
  const f = fixture(); const h = harness(async () => { throw new Error("handshake refused"); });
  await createClaudeBackend(options(f, h)).startTurn({ prompt: "nonempty user work", signal: new AbortController().signal, bridge: h.bridge });
  expect(h.calls).toHaveLength(1);
  expect(h.released).toHaveLength(0);
  expect(h.frames.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("handshake refused") });
});
test("a stuck SDK handshake has a bounded pre-prompt refusal", async () => {
  const f = fixture(); const h = harness(() => new Promise(() => {})); const started = Date.now();
  await createClaudeBackend(options(f, h)).startTurn({ prompt: "nonempty user work", signal: new AbortController().signal, bridge: h.bridge });
  expect(h.calls).toHaveLength(1);
  expect(h.released).toHaveLength(0);
  expect(h.frames.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("SDK startup timed out after 5 s") });
  expect(Date.now() - started).toBeLessThan(7000);
});
test("host cancellation during handshake withholds input and preserves cancelled terminal", async () => {
  const f = fixture(); const host = new AbortController();
  const h = harness(async () => { setTimeout(() => host.abort(), 5); return new Promise(() => {}); });
  await createClaudeBackend(options(f, h)).startTurn({ prompt: "nonempty user work", signal: host.signal, bridge: h.bridge });
  expect(h.calls).toHaveLength(1); expect(h.released).toHaveLength(0);
  expect(h.frames.at(-1)).toMatchObject({ type: "error", code: "CANCELLED" });
});

for (const allowed of [true, false]) test(`constrained subscription turn ${allowed ? "passes" : "retains its account refusal"}`, async () => {
  const f = fixture(); const h = harness(async () => ({ account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty", ...(allowed ? {} : { apiKeySource: "ANTHROPIC_API_KEY" }) } }));
  await createClaudeBackend({ ...options(f, h), profiles: undefined }).startTurn({ prompt: "nonempty user work", signal: new AbortController().signal, bridge: h.bridge });
  expect(h.calls).toHaveLength(1);
  expect(h.released).toHaveLength(allowed ? 1 : 0);
  expect(h.frames.at(-1)).toMatchObject(allowed ? { type: "result", outcome: "success" } : { type: "error", code: "CLAUDE_AUTH" });
});
