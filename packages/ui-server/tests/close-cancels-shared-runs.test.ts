/**
 * `app.close()` gives in-flight brain CLI runs a short grace period, then
 * cancels the shared ones (reads, plain index) and never a writer (#2473).
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { resolveServerConfig } from "../src/config/env";
import { createRecordingObservability } from "../src/observability/index";
import { makeFakeBackend } from "./helpers/fake-backend";
import { createFixtureApp as createApp } from "./helpers/native-app-fixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A brain whose CLI answers `--version` and runs `script` for every other command. */
async function appWithCli(script: string) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-close-grace-"));
  roots.push(root);
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "brain"), `#!/usr/bin/env bun\nconst args = process.argv.slice(2);\n` +
    `if (args.includes("--version")) { console.log("0.42.0"); process.exit(0); }\n${script}`);
  chmodSync(join(bin, "brain"), 0o755);
  return createApp({
    config: resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", DB_PATH: ":memory:", BRAIN_PATH: root, BRAIN_UI_PRICING_DISCOVERY: "0" }),
    observability: createRecordingObservability(),
    registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]),
  });
}

/** Resolves "closed", or "open" if close() is still waiting after `ms`. */
async function closeWithin(app: { close(): Promise<void> }, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = new Promise<"open">(resolve => { timer = setTimeout(() => resolve("open"), ms); });
  try { return await Promise.race([app.close().then(() => "closed" as const), open]); }
  finally { clearTimeout(timer); }
}

test("close cancels a read that never exits once the grace period ends", async () => {
  const app = await appWithCli(`if (args[0] === "stats") setInterval(() => {}, 1000);\nelse console.log("{}");\n`);
  const stats = Promise.resolve(app.fetch(new Request("http://localhost/api/brain/stats")));
  await Bun.sleep(300);
  const started = performance.now();
  expect(await closeWithin(app, 10_000), "CLOSE_MUST_NOT_WAIT_FOR_A_HUNG_SHARED_RUN").toBe("closed");
  const elapsed = performance.now() - started;
  expect(elapsed, "the grace period is honoured before cancelling").toBeGreaterThan(1_500);
  expect(elapsed).toBeLessThan(5_000);
  const answer = await stats.then(response => response.status, () => "rejected");
  expect(answer).not.toBe(200);
}, 30_000);

test("close lets a writer that outlasts the grace period finish", async () => {
  const added = { path: "notes/ithaca-landing.md", indexed: true, title: "Ithaca landing", type: "note", action: "created" };
  const app = await appWithCli(`if (args[0] === "add") { await Bun.sleep(3_500); console.log(${JSON.stringify(JSON.stringify(added))}); }\nelse console.log("{}");\n`);
  const add = app.fetch(new Request("http://localhost/api/brain/add", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Landed on Ithaca at dawn." }) }));
  await Bun.sleep(300);
  const started = performance.now();
  expect(await closeWithin(app, 20_000)).toBe("closed");
  expect(performance.now() - started, "the writer was waited for, not cancelled").toBeGreaterThan(2_500);
  const response = await add;
  expect(await response.json(), "WRITER_MUST_COMPLETE_ACROSS_CLOSE").toMatchObject({ success: true, path: added.path });
}, 30_000);

test("a read that finishes within the grace period is answered", async () => {
  const stats = { documents: 1, byType: { note: 1 }, byStatus: { active: 1 }, byRelevance: {}, tags: 0, links: 0, brokenLinks: 0, chunks: 1, embeddings: 1, health: {} };
  const app = await appWithCli(`if (args[0] === "stats") { await Bun.sleep(500); console.log(${JSON.stringify(JSON.stringify(stats))}); }\nelse console.log("{}");\n`);
  const response = app.fetch(new Request("http://localhost/api/brain/stats"));
  await Bun.sleep(100);
  expect(await closeWithin(app, 10_000)).toBe("closed");
  expect((await response).status, "SHARED_RUN_WITHIN_GRACE_IS_UNAFFECTED").toBe(200);
}, 30_000);
