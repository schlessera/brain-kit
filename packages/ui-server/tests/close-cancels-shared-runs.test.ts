/**
 * `app.close()` gives in-flight brain CLI runs a short grace period, then
 * cancels the shared ones (reads, plain index) and never a writer (#2473).
 * Each case waits until the fixture CLI is actually running, so none depends
 * on how long sandbox setup takes.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { resolveServerConfig } from "../src/config/env";
import { createRecordingObservability } from "../src/observability/index";
import { makeFakeBackend } from "./helpers/fake-backend";
import { createFixtureApp as createApp } from "./helpers/native-app-fixture.js";
import { createFixtureBrainClient as createBrainClient } from "./helpers/native-brain-client-fixture.js";

const roots: string[] = [];
const apps: { close(): Promise<void> }[] = [];
afterEach(async () => {
  // A broken cancellation must not leave a hung app behind for later cases.
  for (const app of apps.splice(0)) await closeWithin(app, 10_000);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ADDED = { path: "notes/ithaca-landing.md", indexed: true, title: "Ithaca landing", type: "note", action: "created" };
const STATS = { documents: 1, byType: { note: 1 }, byStatus: { active: 1 }, byRelevance: {}, tags: 0, links: 0, brokenLinks: 0, chunks: 1, embeddings: 1, health: {} };

/**
 * A brain whose CLI answers `--version`, and for `command` prints `output`
 * `afterMs` after it starts, or never (`afterMs: null`). The run executes in
 * an isolated worker with a read-only brain, so the host detects its start
 * from the process table rather than from a marker file.
 */
function brainWithCli(command: string, output: unknown, afterMs: number | null) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-close-grace-"));
  roots.push(root);
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const cli = join(bin, "brain");
  writeFileSync(cli, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("0.42.0"); process.exit(0); }
if (args[0] !== ${JSON.stringify(command)}) { console.log("{}"); process.exit(0); }
${afterMs === null ? "setInterval(() => {}, 1000);" : `await Bun.sleep(${afterMs});\nconsole.log(${JSON.stringify(JSON.stringify(output))});`}
`);
  chmodSync(cli, 0o755);
  const running = () => readdirSync("/proc").some(pid => {
    if (!/^\d+$/.test(pid)) return false;
    try { const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); return argv.includes(cli) && argv.includes(command); }
    catch { return false; }
  });
  return { root, started: () => until(running, `${command} started`) };
}

async function appFor(root: string) {
  const app = await createApp({
    config: resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", DB_PATH: ":memory:", BRAIN_PATH: root, BRAIN_UI_PRICING_DISCOVERY: "0" }),
    observability: createRecordingObservability(),
    registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]),
  });
  apps.push(app);
  return app;
}

async function until(ready: () => boolean, what: string, ms = 15_000) {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

/** Resolves "closed", or "open" if close() is still waiting after `ms`. */
async function closeWithin(app: { close(): Promise<void> }, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = new Promise<"open">(resolve => { timer = setTimeout(() => resolve("open"), ms); });
  try { return await Promise.race([app.close().then(() => "closed" as const, () => "closed" as const), open]); }
  finally { clearTimeout(timer); }
}

test("close cancels a read that never exits once the grace period ends", async () => {
  const cli = brainWithCli("stats", STATS, null);
  const app = await appFor(cli.root);
  const stats = Promise.resolve(app.fetch(new Request("http://localhost/api/brain/stats")));
  await cli.started();
  const begun = performance.now();
  expect(await closeWithin(app, 10_000), "CLOSE_MUST_NOT_WAIT_FOR_A_HUNG_SHARED_RUN").toBe("closed");
  expect(performance.now() - begun, "the grace period is honoured before cancelling").toBeGreaterThan(1_900);
  expect(await stats.then(response => response.status, () => "rejected")).not.toBe(200);
}, 30_000);

test("a read that finishes within the grace period is answered", async () => {
  const cli = brainWithCli("stats", STATS, 500);
  const app = await appFor(cli.root);
  const stats = Promise.resolve(app.fetch(new Request("http://localhost/api/brain/stats")));
  await cli.started();
  const closed = closeWithin(app, 10_000);
  expect((await stats).status, "SHARED_RUN_WITHIN_GRACE_IS_UNAFFECTED").toBe(200);
  expect(await closed).toBe("closed");
}, 30_000);

test("close lets a writer that outlasts the grace period finish", async () => {
  const cli = brainWithCli("add", ADDED, 3_000);
  const app = await appFor(cli.root);
  const add = Promise.resolve(app.fetch(new Request("http://localhost/api/brain/add", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Landed on Ithaca at dawn." }) })));
  await cli.started();
  const closed = closeWithin(app, 20_000);
  expect(await (await add).json(), "WRITER_MUST_COMPLETE_ACROSS_CLOSE").toMatchObject({ success: true, path: ADDED.path });
  expect(await closed).toBe("closed");
}, 30_000);

test("the client's shutdown signal cancels a plain index with its exact reason", async () => {
  const cli = brainWithCli("index", { indexed: 0 }, null);
  const shutdown = new AbortController();
  const brain = createBrainClient({ brainPath: cli.root, shutdown: shutdown.signal });
  const index = brain.index().then(() => "resolved", error => error);
  await cli.started();
  const reason = new Error("Server shutting down");
  shutdown.abort(reason);
  // The app suppresses exactly this reason, so it must arrive unwrapped.
  expect(await index, "SHUTDOWN_REASON_MUST_REACH_THE_INDEX_CALLER").toBe(reason);
}, 30_000);

test("the client's shutdown signal never cancels a writer", async () => {
  const cli = brainWithCli("add", ADDED, 1_000);
  const shutdown = new AbortController();
  const brain = createBrainClient({ brainPath: cli.root, shutdown: shutdown.signal });
  const add = brain.add("Landed on Ithaca at dawn.");
  await cli.started();
  shutdown.abort(new Error("Server shutting down"));
  expect(await add).toMatchObject({ path: ADDED.path });
}, 30_000);
