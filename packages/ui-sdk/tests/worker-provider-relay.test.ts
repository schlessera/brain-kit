/**
 * The brain CLI's paid providers through the host relay (#1673), under real
 * bubblewrap. A governed or strict turn worker holds no provider key; the real
 * `brain search` embeds its query through the relay, which adds the host's key,
 * records the request's usage and refuses it once a budget is blocked. The
 * upstream is a fictional loopback Gemini endpoint the operator lists.
 */
import { launchFixtureAgentWorker } from "./helpers/worker-startup-view-fixture.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkerSandbox } from "../src/server/worker-sandbox.js";
import { startEgressProxy, type EgressRecord } from "../src/server/egress-proxy.js";
import { PROVIDER_RELAY_KEYS_NAME, PROVIDER_RELAY_SOCKET_NAME, startProviderRelay, type ProviderRelayReceipt } from "../src/server/provider-relay.js";
import { INFERENCE_PLACEHOLDER } from "../src/server/inference-relay.js";

const ROOT = resolve(import.meta.dir, "../../..");
const BRAIN_CLI = join(ROOT, "packages/core/src/cli/brain.ts");
const HOST_KEYS = {
  GEMINI_API_KEY: "odysseus-host-gemini-key", OPENAI_API_KEY: "odysseus-host-openai-key", ANTHROPIC_API_KEY: "odysseus-host-anthropic-key",
  TYPESAFE_API_KEY: "odysseus-host-typesafe-key", CLAUDE_CODE_OAUTH_TOKEN: "odysseus-host-oauth-token",
};
const DOTENV_KEY = "odysseus-dotenv-gemini-key";
const SECRETS = [DOTENV_KEY, ...Object.values(HOST_KEYS)];
const DIMENSIONS = 1536;
const vector = (seed: number) => Array.from({ length: DIMENSIONS }, (_, index) => ((index * 7 + seed) % 13) / 13);

interface Seen { method?: string; path: string; headers: Record<string, string> }
let upstream: ReturnType<typeof Bun.serve>;
const seen: Seen[] = [];
let root: string, brain: string, videoBrain: string;
/** Files the fictional provider still holds, by name. */
const stored = new Set<string>();

beforeAll(async () => {
  // A fictional Gemini Developer API: embeddings with reported usage, and the
  // Files lifecycle and generation a local video needs (#2738).
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    seen.push({ method: request.method, path: url.pathname, headers: Object.fromEntries(request.headers) });
    if (url.pathname === "/upload/v1beta/files" && !url.search) {
      return Response.json({}, { headers: { "x-goog-upload-url": `${upstream.url.origin}/upload/v1beta/files?upload_id=troy-session` } });
    }
    if (url.pathname === "/upload/v1beta/files") {
      await request.arrayBuffer();
      stored.add("files/troy-1");
      return Response.json({ file: { name: "files/troy-1", uri: `${upstream.url.origin}/v1beta/files/troy-1`, mimeType: "video/mp4", state: "PROCESSING" } },
        { headers: { "x-goog-upload-status": "final" } });
    }
    if (url.pathname === "/v1beta/files/troy-1") {
      if (request.method === "DELETE") stored.delete("files/troy-1");
      return Response.json(request.method === "DELETE" ? {} : { name: "files/troy-1", uri: `${upstream.url.origin}/v1beta/files/troy-1`, state: "ACTIVE" });
    }
    if (url.pathname.endsWith(":generateContent")) {
      const asked = await request.json() as { contents: Array<{ parts: Array<{ fileData?: { fileUri: string } }> }> };
      const fileUri = asked.contents[0]!.parts.find(part => part.fileData)?.fileData?.fileUri;
      return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: `00:10 The fleet leaves Troy (${fileUri}).` }] } }],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 12, promptTokenDetails: [{ modality: "VIDEO", tokenCount: 290 }, { modality: "TEXT", tokenCount: 10 }] } });
    }
    const body = await request.json() as { requests?: unknown[] };
    const count = body.requests?.length ?? 1;
    // Both synchronous shapes document usageMetadata; the installed SDK drops it.
    const usageMetadata = { promptTokenCount: 9 * count, promptTokenDetails: [{ modality: "TEXT", tokenCount: 9 * count }] };
    if (url.pathname.endsWith(":batchEmbedContents")) {
      return Response.json({ embeddings: Array.from({ length: count }, () => ({ values: vector(1) })), usageMetadata });
    }
    if (url.pathname.endsWith(":embedContent")) return Response.json({ embeddings: [{ values: vector(1) }], usageMetadata });
    if (url.pathname === "/v1/messages") {
      return request.headers.get("x-api-key") === HOST_KEYS.ANTHROPIC_API_KEY
        ? Response.json({ content: [{ type: "text", text: "Ithaca is in sight." }], usage: { input_tokens: 7, output_tokens: 3 } })
        : Response.json({ type: "error", error: { type: "authentication_error" } }, { status: 401 });
    }
    return new Response("not found", { status: 404 });
  } });
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  root = mkdtempSync(join(ROOT, "tmp/worker-provider-relay-"));
  brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes/ithaca.md"), "---\ntype: note\ntitle: Ithaca harbour\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n"
    + "Odysseus checks the harbour at Ithaca before the fleet sails.\n");
  writeFileSync(join(brain, "brain.config.json"), JSON.stringify({ embeddings: { provider: "gemini" } }));
  writeFileSync(join(brain, ".env"), `GEMINI_API_KEY=${DOTENV_KEY}\n`);
  // A second brain with the opt-in video module and a local recording.
  videoBrain = join(root, "video-brain");
  mkdirSync(videoBrain, { recursive: true });
  writeFileSync(join(videoBrain, "brain.config.ts"), `import { defineConfig } from "@schlessera/brain";
export default defineConfig({ modules: { "@schlessera/brain-module-video": {} } });
`);
  writeFileSync(join(videoBrain, "troy.mp4"), "fictional-video-bytes");
  // Vectors built on the host against the fictional endpoint. Asynchronous:
  // the endpoint serves from this process while the CLI runs.
  const index = Bun.spawn([process.execPath, BRAIN_CLI, "index", "--embeddings", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: root, BRAIN_ROOT: brain, BUN_OPTIONS: "--no-env-file", GEMINI_API_KEY: HOST_KEYS.GEMINI_API_KEY,
      GOOGLE_GEMINI_BASE_URL: upstream.url.origin } });
  const [code, stderr] = await Promise.all([index.exited, new Response(index.stderr).text()]);
  if (code !== 0) throw new Error(`brain index --embeddings failed: ${stderr}`);
  seen.length = 0;
});
afterAll(() => { upstream.stop(true); rmSync(root, { recursive: true, force: true }); });

const sandbox = (profile: "governed" | "strict", brainPath = brain): WorkerSandbox => ({ brain: brainPath, restricted: false, profile, areas: [],
  scratchAliasesRemoved: [], ...(profile === "governed" ? { protection: { paths: [], ancestors: [] } } : {}) });

/** One worker on a turn proxy with the provider relay linked beside it, as the server composes a turn. */
async function run(profile: "governed" | "strict", command: string[], options: { blocked?: boolean; listed?: boolean; brainPath?: string;
  env?: Record<string, string>; credentialEnv?: readonly string[]; relayEgress?: false; customKeys?: string[]; relayMode?: number } = {}) {
  const records: EgressRecord[] = [], receipts: ProviderRelayReceipt[] = [];
  // Offline by construction: the worker's proxy admits only the loopback fixture, so a
  // request that bypasses the relay is refused rather than sent to a real provider.
  const proxy = await startEgressProxy({ mode: "allowlist", allow: ["127.0.0.1"], deny: [], maxBytes: 64 * 1024 * 1024, outwardHosts: [],
    observe: record => records.push(record) });
  const relay = startProviderRelay({ ...(options.relayEgress === false ? {} : { egress: proxy }), credential: name => HOST_KEYS[name as keyof typeof HOST_KEYS],
    origins: new Map(options.listed === false ? [] : [["GEMINI_API_KEY", [upstream.url.origin]]]),
    admit: () => options.blocked ? { allowed: false, message: "Turn inference budget reached." } : { allowed: true },
    // Each attempt reports `dispatched` before contact, then its settled outcome.
    observe: receipt => { if (receipt.outcome !== "dispatched") receipts.push(receipt); } });
  try {
    linkSync(relay.socketPath, join(proxy.dir, PROVIDER_RELAY_SOCKET_NAME));
    if (options.relayMode !== undefined) chmodSync(join(proxy.dir, PROVIDER_RELAY_SOCKET_NAME), options.relayMode);
    if (options.customKeys) writeFileSync(join(proxy.dir, PROVIDER_RELAY_KEYS_NAME), `${options.customKeys.join("\n")}\n`);
    const worker = launchFixtureAgentWorker({ brainPath: options.brainPath ?? brain, command, sandbox: sandbox(profile, options.brainPath ?? brain), turnTempBytes: 64 * 1024 * 1024,
      egress: { proxyDir: proxy.dir }, ...(options.credentialEnv ? { credentialEnv: options.credentialEnv } : {}),
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", BRAIN_ROOT: options.brainPath ?? brain, GOOGLE_GEMINI_BASE_URL: upstream.url.origin, ...HOST_KEYS, ...options.env } });
    try {
      worker.stdin.end();
      const [exit, stdout, stderr] = await Promise.all([worker.exited, new Response(worker.stdout as never).text(),
        new Response(worker.stderr as never).text()]);
      return { exit, stdout, stderr, records, receipts };
    } finally { worker.turnTemp?.close(); }
  } finally { await relay.stop(); proxy.stop(); }
}

const SEARCH = [process.execPath, BRAIN_CLI, "search", "Ithaca harbour", "--json"];
// Every place a key could reach the worker: its environment, every process's
// environment it can see, and the files under the paths it can write or that
// hold host runtime state.
const INSPECT = [process.execPath, "-e", `const { readdirSync, readFileSync, statSync } = require("node:fs");
  const found = [];
  const secrets = JSON.parse(process.argv[1]);
  const check = (path, text) => { for (const secret of secrets) if (text.includes(secret)) found.push(path); };
  const walk = (path, depth) => {
    let info; try { info = statSync(path); } catch { return; }
    if (info.isDirectory()) { if (depth > 6) return; let names = []; try { names = readdirSync(path); } catch { return; }
      for (const name of names) walk(path + "/" + name, depth + 1); return; }
    if (!info.isFile() || info.size > 1024 * 1024) return;
    try { check(path, readFileSync(path, "latin1")); } catch {}
  };
  for (const pid of readdirSync("/proc").filter(name => /^[0-9]+$/.test(name))) {
    try { check("/proc/" + pid + "/environ", readFileSync("/proc/" + pid + "/environ", "latin1")); } catch {}
  }
  for (const path of ["/tmp", "/run", "/etc", "/root", "/var", process.cwd()]) walk(path, 0);
  console.log(JSON.stringify({ env: process.env, found: [...new Set(found)] }));`, JSON.stringify(SECRETS)];

describe.each(["governed", "strict"] as const)("a %s turn worker with the provider relay", (profile) => {
  test("holds no provider key in its environment or any file it can read", async () => {
    const { exit, stdout, stderr } = await run(profile, INSPECT);
    expect(exit, stderr).toBe(0);
    const { env, found } = JSON.parse(stdout) as { env: Record<string, string>; found: string[] };
    expect(SECRETS.filter(secret => Object.values(env).includes(secret)), "RELAYED_WORKER_ENV_HOLDS_NO_PROVIDER_KEY").toEqual([]);
    expect(found, "RELAYED_WORKER_FILESYSTEM_HOLDS_NO_PROVIDER_KEY").toEqual([]);
    expect(env.BRAIN_PROVIDER_RELAY_SOCKET, "RELAYED_WORKER_NAMES_THE_RELAY").toBe("/run/brain-egress/providers.sock");
    expect(env.BRAIN_WITHHELD_KEYS?.split(","), "RELAYED_WORKER_KNOWS_HOST_KEYS_BY_NAME").toContain("GEMINI_API_KEY");
  });

  test("brain search embeds its query through the relay with the host's key", async () => {
    seen.length = 0;
    const { exit, stdout, stderr, records, receipts } = await run(profile, SEARCH);
    expect(exit, stderr).toBe(0);
    const found = JSON.parse(stdout) as { results: Array<{ path: string }>; warnings: string[] };
    expect(found.warnings.join("\n"), "RELAYED_SEARCH_NO_KEYWORD_FALLBACK").not.toMatch(/provider_unavailable|FTS-only|vector search/);
    expect(found.results.map(result => result.path)).toContain("notes/ithaca.md");
    expect(seen.map(request => request.path), "RELAYED_SEARCH_REACHED_PROVIDER").toEqual(["/v1beta/models/gemini-embedding-2:batchEmbedContents"]);
    expect(seen[0]!.headers["x-goog-api-key"], "RELAY_ADDS_HOST_KEY").toBe(HOST_KEYS.GEMINI_API_KEY);
    expect(Object.keys(seen[0]!.headers).filter(name => /^(authorization|x-api-key|x-brain-provider)/.test(name)), "RELAY_FORWARDS_NO_WORKER_CREDENTIAL").toEqual([]);
    expect(receipts, "RELAYED_REQUEST_METERED").toMatchObject([{ family: "gemini", operation: "embeddings", model: "gemini-embedding-2",
      origin: upstream.url.origin, key: "GEMINI_API_KEY", outcome: "completed", status: 200,
      usage: { inputTokens: 9, inputByModality: { TEXT: 9 } } }]);
    // Ordinary turn egress (G5): the provider connection is the turn's record.
    expect(records.filter(record => record.path?.endsWith(":batchEmbedContents")), "RELAYED_REQUEST_IS_TURN_EGRESS")
      .toMatchObject([{ method: "POST", host: "127.0.0.1", port: upstream.port, outcome: "completed" }]);
    expect(records.filter(record => record.inference)).toEqual([]);
    expect(SECRETS.filter(secret => stdout.includes(secret) || stderr.includes(secret))).toEqual([]);
  });

  test("a blocked budget refuses the request before any provider contact", async () => {
    seen.length = 0;
    const { exit, stdout, stderr, receipts } = await run(profile, SEARCH, { blocked: true });
    expect(exit, stderr).toBe(0);
    const found = JSON.parse(stdout) as { results: Array<{ path: string }>; warnings: string[] };
    expect(found.warnings.join("\n"), "RELAYED_SEARCH_BUDGET_REFUSED").toContain("budget_exceeded");
    expect(seen, "BUDGET_REFUSAL_BEFORE_CONTACT").toEqual([]);
    expect(receipts).toEqual([]);
    expect(found.results.map(result => result.path)).toContain("notes/ithaca.md");
  });

  test("brain video watch uploads, polls, generates and deletes through the relay with the host's key (#2738)", async () => {
    seen.length = 0;
    const { exit, stdout, stderr, receipts } = await run(profile, [process.execPath, BRAIN_CLI, "video", "watch", "troy.mp4",
      "--question", "What happens first?", "--json"], { brainPath: videoBrain });
    expect(exit, stderr).toBe(0);
    const watched = JSON.parse(stdout) as { answer: string };
    expect(watched.answer, "RELAYED_VIDEO_WATCH_ANSWERS").toContain("The fleet leaves Troy");
    expect(stderr, "RELAYED_VIDEO_NOT_UNAVAILABLE").not.toContain("provider_unavailable");
    expect(seen.map(request => `${request.method} ${request.path}`), "RELAYED_VIDEO_LIFECYCLE_REACHES_PROVIDER").toEqual([
      "POST /upload/v1beta/files", "POST /upload/v1beta/files", "GET /v1beta/files/troy-1",
      "POST /v1beta/models/gemini-3-flash-preview:generateContent", "DELETE /v1beta/files/troy-1",
    ]);
    expect(seen.map(request => request.headers["x-goog-api-key"]), "HOST_KEY_ON_EVERY_LIFECYCLE_REQUEST").toEqual(Array(5).fill(HOST_KEYS.GEMINI_API_KEY));
    expect(stored, "RELAYED_VIDEO_LEAVES_NO_FILE").toEqual(new Set());
    expect(receipts.map(receipt => receipt.operation), "RELAYED_VIDEO_METERED").toEqual(["files", "files", "files", "completions", "files"]);
    expect(receipts[3]).toMatchObject({ model: "gemini-3-flash-preview", usage: { inputTokens: 300, outputTokens: 12, inputByModality: { VIDEO: 290, TEXT: 10 } } });
    expect(SECRETS.filter(secret => stdout.includes(secret) || stderr.includes(secret)), "WORKER_SEES_NO_KEY").toEqual([]);
  });

  test("a blocked budget refuses brain video watch before any byte reaches the provider", async () => {
    seen.length = 0;
    const { exit, stderr, receipts } = await run(profile, [process.execPath, BRAIN_CLI, "video", "watch", "troy.mp4", "--json"],
      { brainPath: videoBrain, blocked: true });
    expect(exit, "BLOCKED_VIDEO_WATCH_FAILS").not.toBe(0);
    expect(stderr).toContain("budget");
    expect(seen, "BLOCKED_VIDEO_WATCH_SENDS_NO_BYTE").toEqual([]);
    expect(receipts).toEqual([]);
  });

  test("an origin the operator did not list never receives the key", async () => {
    seen.length = 0;
    const { exit, stdout, stderr } = await run(profile, SEARCH, { listed: false });
    expect(exit, stderr).toBe(0);
    const found = JSON.parse(stdout) as { warnings: string[] };
    expect(found.warnings.join("\n"), "UNLISTED_ORIGIN_REFUSED").toContain("BRAIN_UI_CLI_PROVIDER_ORIGINS");
    expect(seen, "UNLISTED_ORIGIN_NEVER_CONTACTED").toEqual([]);
  });
});

test("a relayed Claude API-key turn's anthropic-haiku completion uses the host key, never the placeholder", async () => {
  // The turn's own inference relay leaves its placeholder under ANTHROPIC_API_KEY (#2680).
  const hostKey = Object.getOwnPropertyDescriptor(process.env, "ANTHROPIC_API_KEY");
  const realFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
  process.env.ANTHROPIC_API_KEY = HOST_KEYS.ANTHROPIC_API_KEY;
  // The built-in provider's fixed first-party origin, answered by the fictional endpoint at the relay's own request.
  Object.defineProperty(globalThis, "fetch", { ...realFetch, value: (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://api.anthropic.com") return realFetch.value(input, init);
    return realFetch.value(`${upstream.url.origin}${url.pathname}`, init);
  } });
  seen.length = 0;
  try {
    const program = `const { anthropicCompletions } = await import(${JSON.stringify(join(ROOT, "packages/core/src/providers/completions/anthropic.ts"))});
      try { console.log(JSON.stringify({ text: await anthropicCompletions().complete({ prompt: "Where is Odysseus?" }) })); }
      catch (error) { console.log(JSON.stringify({ error: error.message })); }`;
    const { exit, stdout, stderr, receipts } = await run("governed", [process.execPath, "-e", program],
      // The relay's own dispatch to the first-party origin is answered by the
      // fetch double above; the worker's proxy still admits only loopback.
      { env: { ANTHROPIC_API_KEY: INFERENCE_PLACEHOLDER }, credentialEnv: ["ANTHROPIC_API_KEY"], relayEgress: false });
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout), "RELAYED_CLAUDE_TURN_HAIKU_COMPLETES").toEqual({ text: "Ithaca is in sight." });
    expect(seen.map(request => request.headers["x-api-key"]), "PLACEHOLDER_NEVER_SENT").toEqual([HOST_KEYS.ANTHROPIC_API_KEY]);
    expect(receipts).toMatchObject([{ family: "anthropic", origin: "https://api.anthropic.com", key: "ANTHROPIC_API_KEY",
      usage: { inputTokens: 7, outputTokens: 3 } }]);
  } finally {
    Object.defineProperty(globalThis, "fetch", realFetch);
    if (hostKey) Object.defineProperty(process.env, "ANTHROPIC_API_KEY", hostKey); else delete process.env.ANTHROPIC_API_KEY;
  }
});

test("an operator-listed custom key is named withheld, so the CLI relays it", async () => {
  const { exit, stdout, stderr } = await run("governed", INSPECT, { customKeys: ["ITHACA_GATEWAY_KEY"] });
  expect(exit, stderr).toBe(0);
  const { env } = JSON.parse(stdout) as { env: Record<string, string> };
  expect(env.BRAIN_WITHHELD_KEYS?.split(","), "LISTED_CUSTOM_KEY_NAMED_WITHHELD").toContain("ITHACA_GATEWAY_KEY");
});

test("a relay socket with the wrong mode is not handed to the worker", async () => {
  const { exit, stdout, stderr } = await run("governed", INSPECT, { relayMode: 0o666 });
  expect(exit, stderr).toBe(0);
  const { env } = JSON.parse(stdout) as { env: Record<string, string> };
  expect(env.BRAIN_PROVIDER_RELAY_SOCKET, "RELAY_SOCKET_MODE_VALIDATED").toBeUndefined();
});
