/**
 * `createApp({ dbPath })` places hosted compute state beside the database it
 * actually opens (#4821), as it does the journal, the native leases and the
 * Apify ledger; an explicit BRAIN_UI_COMPUTE_STATE_DIR keeps winning.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveServerConfig } from "../src/config/env";
import { createSilentObservability } from "../src/observability/index";
import { createFixtureApp } from "./helpers/native-app-fixture.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function boot(env: Record<string, string>, dbPath: string) {
  const root = mkdtempSync(join(tmpdir(), "brain-compute-state-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brainPath = join(root, "brain");
  mkdirSync(brainPath);
  // The environment's DB_PATH names a different file from the one the app opens.
  const envDb = join(root, "elsewhere", "env.db");
  const resolvedDbPath = dbPath.replace("<tmp>", root);
  const config = resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", BRAIN_PATH: brainPath, DB_PATH: envDb,
    BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_COASTLINE: "0", BRAIN_UI_COMPUTE_KEYS: "boat", ...env });
  const app = await createFixtureApp({ config, dbPath: resolvedDbPath, observability: createSilentObservability() });
  cleanup.push(() => app.close());
  const status = async () => (await (await app.fetch(new Request("http://localhost/api/status"))).json()).runtime.compute;
  return { root, app, envDb, dbPath: resolvedDbPath, status };
}

test("a derived compute state directory follows createApp's dbPath, not the environment's DB_PATH", async () => {
  const t = await boot({}, "<tmp>/x.db");
  expect(t.app.config.compute?.stateDir).toBe(`${t.dbPath}.compute`);
  expect(existsSync(`${t.dbPath}.compute`)).toBe(true);
  expect(existsSync(`${t.envDb}.compute`), "nothing is created beside the other DB_PATH").toBe(false);
});

test("an in-memory database has no compute state directory, so hosted compute is off", async () => {
  const t = await boot({}, ":memory:");
  expect(t.app.config.compute?.stateDir).toBeNull();
  expect(existsSync(`${t.envDb}.compute`)).toBe(false);
  expect(await t.status()).toMatchObject({ enabled: false });
});

test("an explicit BRAIN_UI_COMPUTE_STATE_DIR wins over createApp's dbPath", async () => {
  const explicit = join(mkdtempSync(join(tmpdir(), "brain-compute-explicit-")), "compute");
  cleanup.push(() => rmSync(join(explicit, ".."), { recursive: true, force: true }));
  const t = await boot({ BRAIN_UI_COMPUTE_STATE_DIR: explicit }, "<tmp>/x.db");
  expect(t.app.config.compute?.stateDir).toBe(explicit);
  expect(existsSync(explicit)).toBe(true);
  expect(existsSync(`${t.dbPath}.compute`)).toBe(false);
});
