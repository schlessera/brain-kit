/**
 * Credentialed maintenance on a host with managed native storage reaches the
 * brain CLI's providers only through the metered relay (#1673), under real
 * bubblewrap: the relayed keys and the brain's `.env*` never reach the worker,
 * the real `brain search` embeds its query through the relay with the host's
 * key, and each request is metered against the turn that started the run, or
 * its day. The upstream is a fictional loopback Gemini endpoint the operator lists.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeBrainManagerClient, type ProviderRelayReceipt } from "@schlessera/brain-ui-sdk/internal";
import { createHostBoundary, type BrainExecution } from "../src/brain/host-boundary.js";
import { createNativeAppFixture } from "./helpers/native-app-fixture.js";

const ROOT = resolve(import.meta.dir, "../../..");
const BRAIN_CLI = join(ROOT, "packages/core/src/cli/brain.ts");
const HOST_KEYS = { GEMINI_API_KEY: "odysseus-host-gemini-key", OPENAI_API_KEY: "odysseus-host-openai-key",
  ANTHROPIC_API_KEY: "odysseus-host-anthropic-key", TYPESAFE_API_KEY: "odysseus-host-typesafe-key" };
const DOTENV_KEY = "odysseus-dotenv-gemini-key";
const vector = () => Array.from({ length: 1536 }, (_, index) => (index % 13) / 13);

let upstream: ReturnType<typeof Bun.serve>;
const seen: Array<{ path: string; key: string | null }> = [];
let root: string, brain: string;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    seen.push({ path: url.pathname, key: request.headers.get("x-goog-api-key") });
    const count = ((await request.json()) as { requests?: unknown[] }).requests?.length ?? 1;
    return Response.json({ embeddings: Array.from({ length: count }, () => ({ values: vector() })),
      usageMetadata: { promptTokenCount: 9 * count, promptTokenDetails: [{ modality: "TEXT", tokenCount: 9 * count }] } });
  } });
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  root = mkdtempSync(join(ROOT, "tmp/maintenance-provider-relay-"));
  brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes/ithaca.md"), "---\ntype: note\ntitle: Ithaca harbour\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n"
    + "Odysseus checks the harbour at Ithaca before the fleet sails.\n");
  writeFileSync(join(brain, "brain.config.json"), JSON.stringify({ embeddings: { provider: "gemini" } }));
  writeFileSync(join(brain, ".env"), `GEMINI_API_KEY=${DOTENV_KEY}\n`);
  const index = Bun.spawn([process.execPath, BRAIN_CLI, "index", "--embeddings", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: root, BRAIN_ROOT: brain, BUN_OPTIONS: "--no-env-file", GEMINI_API_KEY: HOST_KEYS.GEMINI_API_KEY,
      GOOGLE_GEMINI_BASE_URL: upstream.url.origin } });
  const [code, stderr] = await Promise.all([index.exited, new Response(index.stderr).text()]);
  if (code !== 0) throw new Error(`brain index --embeddings failed: ${stderr}`);
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); seen.length = 0; });
afterAll(() => { upstream.stop(true); rmSync(root, { recursive: true, force: true }); });

function boundary(options: { blocked?: boolean } = {}) {
  const state = mkdtempSync(join(root, "state-"));
  const native = createNativeAppFixture(brain); cleanup.push(native.close);
  const metered: Array<{ turnId: string | null; attempt: ProviderRelayReceipt }> = [], admitted: Array<string | null> = [];
  const host = createHostBoundary({ brainPath: brain, dbPath: join(state, "ui.db"), exec: {},
    nativeManager: createNativeBrainManagerClient(native.nativeBrain),
    providerRelay: { origins: new Map([["GEMINI_API_KEY", [upstream.url.origin]]]),
      admit: turnId => { admitted.push(turnId); return options.blocked ? { allowed: false, message: "UTC day inference budget reached." } : { allowed: true }; },
      observe: (turnId, attempt) => { if (attempt.outcome !== "dispatched") metered.push({ turnId, attempt }); } } });
  return { host, metered, admitted };
}

async function execute(host: ReturnType<typeof createHostBoundary>, method: "run" | "launch", execution: BrainExecution) {
  if (method === "run") return host.run(execution);
  const child = await host.launch(execution);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

const hostEnv = () => ({ PATH: "/usr/bin:/bin", BRAIN_ROOT: brain, ...HOST_KEYS });
const search = (turnId?: string): BrainExecution => ({ argv: [process.execPath, BRAIN_CLI, "search", "Ithaca harbour", "--json"],
  env: { ...hostEnv(), GOOGLE_GEMINI_BASE_URL: upstream.url.origin }, credentials: true, gate: "shared", purpose: "Odysseus maintenance search",
  ...(turnId ? { turnId } : {}) });

for (const method of ["run", "launch"] as const) {
  test(`credentialed maintenance ${method} holds no relayed key and no .env`, async () => {
    const { host } = boundary();
    const program = `const read = name => { try { return require("node:fs").readFileSync(name, "utf8"); } catch (error) { return error.code; } };
      console.log(JSON.stringify({ env: process.env, dotenv: read(".env") }));`;
    const result = await execute(host, method, { argv: [process.execPath, "--config=/dev/null", "-e", program], env: hostEnv(), credentials: true,
      gate: "exclusive", purpose: "Odysseus credentialed maintenance" });
    expect(result.exitCode, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout) as { env: Record<string, string>; dotenv: string };
    expect(["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"].filter(name => observed.env[name] !== undefined),
      "RELAYED_MAINTENANCE_HOLDS_NO_RELAYED_KEY").toEqual([]);
    expect([DOTENV_KEY, HOST_KEYS.GEMINI_API_KEY, HOST_KEYS.OPENAI_API_KEY, HOST_KEYS.ANTHROPIC_API_KEY]
      .filter(secret => result.stdout.includes(secret)), "RELAYED_MAINTENANCE_LEAKS_NO_RELAYED_KEY").toEqual([]);
    expect(observed.dotenv, "RELAYED_MAINTENANCE_DOTENV_MASKED").toBe("EACCES");
    // JeV is not relayed: its key stays with credentialed maintenance (disclosed in status).
    expect(observed.env.TYPESAFE_API_KEY).toBe(HOST_KEYS.TYPESAFE_API_KEY);
    expect(observed.env.BRAIN_PROVIDER_RELAY_SOCKET).toBe("/run/brain-providers/relay.sock");
    expect(observed.env.BRAIN_WITHHELD_KEYS, "RELAYED_MAINTENANCE_NAMES_HELD_KEYS").toBe("ANTHROPIC_API_KEY,GEMINI_API_KEY,OPENAI_API_KEY");
  });

  test(`maintenance ${method} search embeds through the relay and is metered`, async () => {
    const { host, metered, admitted } = boundary();
    const turnId = method === "run" ? "voyage-turn" : undefined;
    const result = await execute(host, method, search(turnId));
    expect(result.exitCode, result.stderr).toBe(0);
    const found = JSON.parse(result.stdout) as { results: Array<{ path: string }>; warnings: string[] };
    expect(found.warnings.join("\n"), "RELAYED_MAINTENANCE_SEARCH_NO_FALLBACK").not.toMatch(/provider_unavailable|FTS-only|vector search/);
    expect(found.results.map(entry => entry.path)).toContain("notes/ithaca.md");
    expect(seen, "RELAYED_MAINTENANCE_HOST_KEY_AT_PROVIDER").toEqual([{ path: "/v1beta/models/gemini-embedding-2:batchEmbedContents", key: HOST_KEYS.GEMINI_API_KEY }]);
    // A tool-started run is charged to its turn; any other run to its day alone.
    // Admitted on arrival and again just before dispatch.
    expect(admitted, "RELAYED_MAINTENANCE_ADMITTED_PER_REQUEST").toEqual([turnId ?? null, turnId ?? null]);
    expect(metered, "RELAYED_MAINTENANCE_METERED").toMatchObject([{ turnId: turnId ?? null,
      attempt: { family: "gemini", operation: "embeddings", outcome: "completed", usage: { inputTokens: 9 } } }]);
  });
}

test("a blocked day refuses maintenance's provider request before contact", async () => {
  const { host, metered } = boundary({ blocked: true });
  const result = await host.run(search());
  expect(result.exitCode, result.stderr).toBe(0);
  const found = JSON.parse(result.stdout) as { warnings: string[] };
  expect(found.warnings.join("\n"), "RELAYED_MAINTENANCE_BUDGET_REFUSED").toContain("budget_exceeded");
  expect(seen, "RELAYED_MAINTENANCE_REFUSED_BEFORE_CONTACT").toEqual([]);
  expect(metered).toEqual([]);
});

test("a built-in key outside the run's own environment is neither released nor named", async () => {
  // A cron job's audience never held ANTHROPIC_API_KEY; the server's own value must not reach it through the relay.
  const saved = Object.getOwnPropertyDescriptor(process.env, "ANTHROPIC_API_KEY");
  process.env.ANTHROPIC_API_KEY = HOST_KEYS.ANTHROPIC_API_KEY;
  try {
    const { host } = boundary();
    const { ANTHROPIC_API_KEY: _omitted, ...cronKeys } = HOST_KEYS;
    void _omitted;
    const result = await host.run({ argv: [process.execPath, "--config=/dev/null", "-e", "console.log(process.env.BRAIN_WITHHELD_KEYS ?? '')"],
      env: { PATH: "/usr/bin:/bin", BRAIN_ROOT: brain, ...cronKeys }, credentials: true, gate: "exclusive", purpose: "Odysseus cron job" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim(), "MAINTENANCE_AUDIENCE_BOUNDS_RELAYED_KEYS").toBe("GEMINI_API_KEY,OPENAI_API_KEY");
  } finally { if (saved) Object.defineProperty(process.env, "ANTHROPIC_API_KEY", saved); else delete process.env.ANTHROPIC_API_KEY; }
});
