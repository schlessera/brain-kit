/**
 * An embedder's own compute settings under `createApp({ dbPath })` (#4904):
 * whether a state directory still follows the database is decided by its
 * value, not by which object carries it, and the returned handle reports the
 * settings compute uses.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../src/config/env";
import { createSilentObservability } from "../src/observability/index";
import { createFixtureApp } from "./helpers/native-app-fixture.js";
import { testServerConfig } from "./helpers/test-config";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

/** A resolved configuration whose DB_PATH names a different file from the one the app opens. */
function resolved() {
  const root = mkdtempSync(join(tmpdir(), "brain-compute-embedder-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brainPath = join(root, "brain");
  mkdirSync(brainPath);
  const envDb = join(root, "elsewhere", "env.db");
  return { root, envDb, config: testServerConfig({ brain: brainPath, db: envDb }, { BRAIN_UI_COMPUTE_KEYS: "boat" }) };
}
async function boot(config: ServerConfig, dbPath: string) {
  const app = await createFixtureApp({ config, dbPath, observability: createSilentObservability() });
  cleanup.push(() => app.close());
  return app;
}

test("a resolved compute directory changed in place is the embedder's, and stays", async () => {
  const { root, config } = resolved();
  const mine = join(root, "mine");
  config.compute!.stateDir = mine;
  const app = await boot(config, join(root, "x.db"));
  expect(app.config.compute?.stateDir, "IN_PLACE_DIRECTORY_KEPT").toBe(mine);
  expect(existsSync(mine)).toBe(true);
  expect(existsSync(join(root, "x.db.compute"))).toBe(false);
});

test("a spread copy of resolved compute settings still follows createApp's dbPath", async () => {
  const { root, envDb, config } = resolved();
  const dbPath = join(root, "x.db");
  const app = await boot({ ...config, compute: { ...config.compute!, keys: { boat: ["BOAT_TOKEN"] } } }, dbPath);
  expect(app.config.compute?.stateDir, "COPY_FOLLOWS_DB_PATH").toBe(`${dbPath}.compute`);
  expect(app.config.compute?.keys).toEqual({ boat: ["BOAT_TOKEN"] });
  expect(existsSync(`${dbPath}.compute`)).toBe(true);
  expect(existsSync(`${envDb}.compute`), "nothing is created beside the other DB_PATH").toBe(false);
});

test("a spread copy is cleared for an in-memory database", async () => {
  const { envDb, config } = resolved();
  const app = await boot({ ...config, compute: { ...config.compute! } }, ":memory:");
  expect(app.config.compute?.stateDir, "COPY_CLEARED_IN_MEMORY").toBeNull();
  expect(existsSync(`${envDb}.compute`)).toBe(false);
});

test("a configuration without compute settings reports the directory compute uses", async () => {
  const { root, config } = resolved();
  const dbPath = join(root, "x.db");
  const app = await boot({ ...config, compute: undefined }, dbPath);
  expect(app.config.compute?.stateDir, "ABSENT_COMPUTE_REPORTED").toBe(`${dbPath}.compute`);
  expect(app.config.compute?.keys).toEqual({});
});
