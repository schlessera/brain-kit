/**
 * The scheduled `maintain` job reaches Gemini only through the metered relay
 * (#1673), end to end on the cron path (#3363): the real `brain-ui-cron run`
 * host execution, a credentialed maintenance worker under real bubblewrap, and
 * the real `brain maintain` indexing a note with embeddings and generated chunk
 * contexts. The upstream is a fictional loopback Gemini endpoint, listed the
 * way an operator lists one in `BRAIN_UI_CLI_PROVIDER_ORIGINS`; it records the
 * key each request carries and rejects any other key the way Google does. The
 * relay's receipts in the UI database show which requests went through it.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createNativeAppFixture } from "./helpers/native-app-fixture.js";

const ROOT = resolve(import.meta.dir, "../../..");
const BIN = resolve(import.meta.dir, "../src/bin/brain-ui-cron.ts");
const PRELOAD = resolve(import.meta.dir, "fixtures/cron-native-startup-preload.ts");
const BRAIN_CLI = join(ROOT, "packages/core/src/cli/brain.ts");
const HOST_KEY = "odysseus-host-gemini-key";
const DOTENV_KEY = "odysseus-dotenv-gemini-key";
const EMBED = /^\/v1beta\/models\/[^/]+:(?:batchEmbedContents|embedContent)$/;
const GENERATE = /^\/v1beta\/models\/[^/]+:generateContent$/;
const vector = () => Array.from({ length: 1536 }, (_, index) => (index % 13) / 13);
// Each section clears the chunker's minimum, so the note splits and every chunk needs a generated context.
const section = (heading: string, line: string) => `## ${heading}\n\n${Array.from({ length: 24 }, () => line).join(" ")}\n`;
const NOTE = "---\ntype: note\ntitle: Ithaca harbour watch\nsummary: How the harbour at Ithaca is watched.\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n"
  + section("Night watch", "Eurylochus keeps the lantern lit on the harbour wall until the fleet is counted home.")
  + "\n" + section("Morning muster", "Penelope checks the ledger of oars, sails and ropes against the quartermaster's tally.")
  + "\n" + section("Storm drill", "Telemachus moves the small boats behind the mole whenever the wind turns from the south.");

let upstream: ReturnType<typeof Bun.serve>;
const seen: Array<{ path: string; key: string | null }> = [];
let root: string;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(() => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname, key = request.headers.get("x-goog-api-key");
    seen.push({ path, key });
    const body = await request.json() as { requests?: unknown[] };
    if (key !== HOST_KEY) {
      return Response.json({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }] } }, { status: 400 });
    }
    if (GENERATE.test(path)) {
      return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Part of the Ithaca harbour watch." }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 7, totalTokenCount: 47 } });
    }
    const count = body.requests?.length ?? 1;
    return Response.json({ embeddings: Array.from({ length: count }, () => ({ values: vector() })),
      usageMetadata: { promptTokenCount: 9 * count, promptTokenDetails: [{ modality: "TEXT", tokenCount: 9 * count }] } });
  } });
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  root = mkdtempSync(join(ROOT, "tmp/cron-maintain-provider-relay-"));
});
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); seen.length = 0; });
afterAll(() => { upstream.stop(true); rmSync(root, { recursive: true, force: true }); });

/** A fresh brain whose first `maintain` has every chunk to embed and contextualize. */
function freshBrain() {
  const dir = mkdtempSync(join(root, "run-")), brain = join(dir, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes/harbour-watch.md"), NOTE);
  // A single-chunk note takes its context from its summary, so its embedding never waits on a generated context.
  writeFileSync(join(brain, "notes/ithaca.md"), "---\ntype: note\ntitle: Ithaca harbour\nsummary: The harbour at Ithaca.\ncreated: 2026-07-12\nupdated: 2026-07-12\n---\n"
    + "Odysseus checks the harbour at Ithaca before the fleet sails.\n");
  writeFileSync(join(brain, "brain.config.json"), JSON.stringify({ embeddings: { provider: "gemini" }, completions: { provider: "gemini-flash" } }));
  // The brain's own dotenv holds some other key: the worker must never send it.
  writeFileSync(join(brain, ".env"), `GEMINI_API_KEY=${DOTENV_KEY}\n`);
  return { brain, dbPath: join(dir, "brain-ui.db") };
}

/** `brain-ui-cron run <job> -- <command>` as cron starts it, with the server's environment. */
async function cron(job: string, command: string[], hostEnv: Record<string, string>) {
  const { brain, dbPath } = freshBrain();
  const native = createNativeAppFixture(brain); cleanup.push(native.close);
  const proc = Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", "--preload", PRELOAD, BIN,
    // The SDK's base-URL override is the one setting the cron audience does not already carry.
    "run", "--subprocess-env-extra", "GOOGLE_GEMINI_BASE_URL", job, "--", ...command], {
    cwd: "/", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", BRAIN_PATH: brain, DB_PATH: dbPath, ...native.env,
      BRAIN_UI_CLI_PROVIDER_ORIGINS: `GEMINI_API_KEY=${upstream.url.origin}`, GOOGLE_GEMINI_BASE_URL: upstream.url.origin, ...hostEnv } });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const db = createUiDb(dbPath);
  try {
    const receipts = db.query("SELECT family, operation, origin, outcome, status FROM provider_relay_usage ORDER BY observed_at, attempt_id")
      .all() as Array<{ family: string; operation: string; origin: string; outcome: string; status: number }>;
    return { exitCode, stdout, stderr, receipts };
  } finally { db.close(); }
}

const maintain = [process.execPath, BRAIN_CLI, "maintain"];
const operations = (paths: Array<{ path: string }>) => ({
  embeddings: paths.filter(entry => EMBED.test(entry.path)).length, completions: paths.filter(entry => GENERATE.test(entry.path)).length });

test("cron maintain sends every Gemini embedding and chunk-context request through the relay with the host key", async () => {
  const run = await cron("maintain", maintain, { GEMINI_API_KEY: HOST_KEY });
  const output = `${run.stdout}\n${run.stderr}`;
  expect(run.exitCode, output).toBe(0);
  expect(output, "CRON_MAINTAIN_NO_PROVIDER_FAILURE").not.toMatch(/SKIP embed|chunk context\(s\) failed|API_KEY_INVALID|provider_unavailable/);
  expect(output).toMatch(/ok — 2 added, 0 updated, 0 deleted, [1-9]\d* embeddings/);
  const sent = operations(seen);
  expect(sent.embeddings, "CRON_MAINTAIN_EMBEDS").toBeGreaterThan(0);
  expect(sent.completions, "CRON_MAINTAIN_GENERATES_CHUNK_CONTEXTS").toBeGreaterThan(1);
  expect(seen.filter(entry => entry.key !== HOST_KEY), "CRON_MAINTAIN_HOST_KEY_AT_PROVIDER").toEqual([]);
  // One completed receipt per request the provider saw: nothing reached it around the relay.
  expect(run.receipts.filter(receipt => receipt.outcome !== "dispatched").map(receipt => [receipt.operation, receipt.status]).sort(),
    "CRON_MAINTAIN_EVERY_REQUEST_RELAYED").toEqual([
    ...Array.from({ length: sent.completions }, () => ["completions", 200]),
    ...Array.from({ length: sent.embeddings }, () => ["embeddings", 200]),
  ]);
  expect(new Set(run.receipts.map(receipt => `${receipt.family} ${receipt.origin}`))).toEqual(
    new Set([`gemini ${upstream.url.origin}`]));
}, 60_000);

test("the cron maintain worker holds neither the host key nor the brain's dotenv key", async () => {
  const program = `const read = name => { try { return require("node:fs").readFileSync(name, "utf8"); } catch (error) { return error.code; } };
    console.log(JSON.stringify({ key: process.env.GEMINI_API_KEY ?? null, withheld: process.env.BRAIN_WITHHELD_KEYS ?? null,
      socket: process.env.BRAIN_PROVIDER_RELAY_SOCKET ?? null, dotenv: read(".env") }));`;
  const run = await cron("maintain", [process.execPath, "--config=/dev/null", "-e", program], { GEMINI_API_KEY: HOST_KEY });
  expect(run.exitCode, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout), "CRON_MAINTAIN_WORKER_KEYLESS").toEqual({ key: null, withheld: "GEMINI_API_KEY",
    socket: "/run/brain-providers/relay.sock", dotenv: "EACCES" });
  expect([HOST_KEY, DOTENV_KEY].filter(secret => run.stdout.includes(secret))).toEqual([]);
}, 60_000);

test("a cron key value that differs from the provider's reaches it through the relay and is metered as its 400", async () => {
  // Quoting is one way a key value can differ between environments; the relay
  // forwards the run's own value, so the upstream's rejection is recorded.
  const run = await cron("maintain", maintain, { GEMINI_API_KEY: `"${HOST_KEY}"` });
  const output = `${run.stdout}\n${run.stderr}`;
  expect(output, "CRON_MAINTAIN_WRONG_VALUE_REPRODUCES_REPORT").toMatch(/SKIP embed batch: .*API_KEY_INVALID/);
  expect(output).toMatch(/\d+ chunk context\(s\) failed — deferred to the next --embeddings run/);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter(entry => entry.key !== `"${HOST_KEY}"`), "CRON_MAINTAIN_RELAY_SENDS_RUN_VALUE").toEqual([]);
  // The operator's discriminator: Gemini receipts carrying the upstream's 400.
  const settled = run.receipts.filter(receipt => receipt.outcome !== "dispatched");
  expect(settled.length, "CRON_MAINTAIN_WRONG_VALUE_METERED").toBe(seen.length);
  expect(new Set(settled.map(receipt => `${receipt.family} ${receipt.status}`))).toEqual(new Set(["gemini 400"]));
}, 60_000);

test("a cron run without the key never contacts the provider", async () => {
  const run = await cron("maintain", maintain, {});
  expect(run.exitCode, run.stderr).toBe(0);
  expect(seen, "CRON_MAINTAIN_KEYLESS_NO_CONTACT").toEqual([]);
  expect(run.receipts).toEqual([]);
}, 60_000);
