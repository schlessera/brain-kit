/**
 * The brain's secrets in governed and strict turn workers (#1666), under real
 * bubblewrap: no present `.env*` file can be read, the environment holds
 * no provider key the turn's own inference does not need, and the real `brain`
 * CLI names the withheld provider and falls back to keyword search.
 */
import { launchFixtureAgentWorker } from "./helpers/worker-startup-view-fixture.js";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkerSandbox } from "../src/server/worker-sandbox.js";

const ROOT = resolve(import.meta.dir, "../../..");
const BRAIN_CLI = join(ROOT, "packages/core/src/cli/brain.ts");
const ENV_KEY = "odysseus-env-gemini-key";
const DOTENV_KEY = "odysseus-dotenv-gemini-key";
const HOST_KEYS = {
  GEMINI_API_KEY: ENV_KEY, OPENAI_API_KEY: "odysseus-env-openai-key", TYPESAFE_API_KEY: "odysseus-env-typesafe-key",
  ANTHROPIC_API_KEY: "odysseus-env-anthropic-key", OPENROUTER_API_KEY: "odysseus-env-openrouter-key",
  CLAUDE_CODE_OAUTH_TOKEN: "odysseus-env-oauth-token",
};
const FIXTURE_VALUES = [DOTENV_KEY, ...Object.values(HOST_KEYS)];

function fixture() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/worker-provider-keys-"));
  const brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes/ithaca.md"), "---\ntype: note\ntitle: Ithaca harbour\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n"
    + "Odysseus checks the harbour at Ithaca before the fleet sails.\n");
  writeFileSync(join(brain, "brain.config.json"), JSON.stringify({ embeddings: { provider: "gemini" } }));
  writeFileSync(join(brain, ".env"), `GEMINI_API_KEY=${DOTENV_KEY}\n`);
  writeFileSync(join(brain, ".env.local"), `OPENAI_API_KEY=${DOTENV_KEY}\n`);
  // The keyword index, built keyless on the host so the worker only searches.
  const index = Bun.spawnSync([process.execPath, BRAIN_CLI, "index", "--json"], { cwd: root, stdout: "pipe", stderr: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: root, BRAIN_ROOT: brain, BUN_OPTIONS: "--no-env-file" } });
  if (index.exitCode !== 0) throw new Error(`brain index failed: ${index.stderr.toString()}`);
  return { root, brain, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const sandbox = (brain: string, profile: "governed" | "strict"): WorkerSandbox => ({ brain, restricted: false, profile, areas: [],
  scratchAliasesRemoved: [], ...(profile === "governed" ? { protection: { paths: [], ancestors: [] } } : {}) });

async function run(brain: string, profile: "governed" | "strict", command: string[], credentialEnv?: readonly string[]) {
  const worker = launchFixtureAgentWorker({ brainPath: brain, command, sandbox: sandbox(brain, profile), turnTempBytes: 64 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", BRAIN_ROOT: brain, ...HOST_KEYS },
    ...(credentialEnv ? { credentialEnv } : {}) });
  try {
    worker.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([worker.exited, new Response(worker.stdout as never).text(),
      new Response(worker.stderr as never).text()]);
    return { exit, stdout, stderr };
  } finally { worker.turnTemp?.close(); }
}

// The mask binds /dev/null, which the worker's nodev mount cannot open: no byte is readable.
const READ = [process.execPath, "-e", `const { readFileSync } = require("node:fs");
  const read = name => { try { return readFileSync(name, "utf8"); } catch (error) { return error.code; } };
  console.log(JSON.stringify({ env: process.env, dotenv: read(".env"), local: read(".env.local") }));`];

describe.each(["governed", "strict"] as const)("a %s turn worker", (profile) => {
  test("cannot read any .env* file and holds no provider key", async () => {
    const f = fixture();
    try {
      const { exit, stdout, stderr } = await run(f.brain, profile, READ);
      expect(stderr).toBe(""); expect(exit).toBe(0);
      const seen = JSON.parse(stdout) as { env: Record<string, string>; dotenv: string; local: string };
      expect({ dotenv: seen.dotenv, local: seen.local }, "WORKER_DOTENV_UNREADABLE").toEqual({ dotenv: "EACCES", local: "EACCES" });
      // Bun loads the brain's .env into every process started in it; the mask leaves nothing to load.
      expect(FIXTURE_VALUES.filter(value => Object.values(seen.env).includes(value)), "WORKER_ENV_HOLDS_NO_PROVIDER_KEY").toEqual([]);
      expect(seen.env.BRAIN_WITHHELD_KEYS, "WORKER_NAMES_WITHHELD_KEYS").toBe(Object.keys(HOST_KEYS).sort().join(","));
    } finally { f.cleanup(); }
  });

  test("keeps exactly the credentials its unrelayed inference declares", async () => {
    const f = fixture();
    try {
      const { exit, stdout, stderr } = await run(f.brain, profile, READ, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
      expect(stderr).toBe(""); expect(exit).toBe(0);
      const { env } = JSON.parse(stdout) as { env: Record<string, string> };
      expect(Object.fromEntries(Object.keys(HOST_KEYS).filter(name => env[name] !== undefined).map(name => [name, env[name]])),
        "WORKER_KEEPS_DECLARED_INFERENCE_CREDENTIALS")
        .toEqual({ ANTHROPIC_API_KEY: HOST_KEYS.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: HOST_KEYS.CLAUDE_CODE_OAUTH_TOKEN });
      expect(env.BRAIN_WITHHELD_KEYS).toBe("GEMINI_API_KEY,OPENAI_API_KEY,OPENROUTER_API_KEY,TYPESAFE_API_KEY");
    } finally { f.cleanup(); }
  });

  test("brain search names the withheld provider and falls back to keyword results", async () => {
    const f = fixture();
    try {
      const { exit, stdout, stderr } = await run(f.brain, profile, [process.execPath, BRAIN_CLI, "search", "Ithaca harbour", "--json"]);
      expect(exit, stderr).toBe(0);
      const found = JSON.parse(stdout) as { results: Array<{ path: string }>; warnings: string[] };
      expect(found.results.map(result => result.path), "WORKER_SEARCH_KEYWORD_RESULTS").toEqual(["notes/ithaca.md"]);
      expect(found.warnings.join("\n"), "WORKER_SEARCH_NAMES_WITHHELD_PROVIDER")
        .toContain("[provider_unavailable provider=gemini capability=embeddings key=GEMINI_API_KEY degraded_to=keyword_search]");
      expect(FIXTURE_VALUES.some(value => stdout.includes(value) || stderr.includes(value))).toBe(false);
    } finally { f.cleanup(); }
  });
});
