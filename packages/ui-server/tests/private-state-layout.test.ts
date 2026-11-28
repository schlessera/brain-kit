/** One private-state layout for the server, cron jobs and cron module discovery (#4498). */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateStateLayout } from "../src/brain/operational-state.js";
import { resolveCronConfig, resolveServerConfig } from "../src/config/env.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), "odysseus-private-layout-")); roots.push(path); return path; }
const noCompute = { keys: {}, stateDir: null };

describe("privateStateLayout keeps the server's layout (#4498)", () => {
  test("a durable database: token, transfer cache, journal, lease, web executor, in the server's order", () => {
    const state = root(), db = join(state, "brain-ui.db"), token = join(state, "run", "poke.token");
    const layout = privateStateLayout({ dbPath: db, pokeTokenFile: token, compute: { keys: {}, stateDir: `${db}.compute` } });
    expect(layout.journalRoot).toBe(`${db}.journal`);
    expect(layout.nativeLeasePath).toBe(`${db}.native-leases.sqlite`);
    expect(layout.computeStateDir, "UNCONFIGURED_COMPUTE_HAS_NO_STATE").toBeUndefined();
    expect(layout.privateStatePaths, "SERVER_DURABLE_LAYOUT_UNCHANGED").toEqual([
      { setting: "BRAIN_UI_INBOX_POKE_TOKEN_FILE", path: token },
      { setting: "Storage transfer cache", path: `${db}.journal.storage-cache` },
      { setting: "turn journal", path: `${db}.journal` },
      { setting: "BRAIN_UI_NATIVE_BRAIN_LEASE_PATH", path: `${db}.native-leases.sqlite` },
      { setting: "web executor state", path: `${db}.journal.web-executor` },
    ]);
  });

  test("an ephemeral database uses the server's fresh journal and the configured lease; cron, without one, checks neither journal nor its siblings", () => {
    const state = root(), journal = join(state, "brain-ui-journal-ithaca"), lease = join(state, "native-leases.sqlite");
    const server = privateStateLayout({ dbPath: ":memory:", nativeLeasePath: lease, compute: noCompute, ephemeralJournalRoot: journal });
    expect(server.ephemeral).toBe(true);
    expect(server.privateStatePaths, "SERVER_EPHEMERAL_LAYOUT_UNCHANGED").toEqual([
      { setting: "Storage transfer cache", path: `${journal}.storage-cache` },
      { setting: "turn journal", path: journal },
      { setting: "BRAIN_UI_NATIVE_BRAIN_LEASE_PATH", path: lease },
      { setting: "web executor state", path: `${journal}.web-executor` },
    ]);
    expect(privateStateLayout({ dbPath: "", nativeLeasePath: lease, compute: noCompute }).privateStatePaths, "CRON_EPHEMERAL_LAYOUT")
      .toEqual([{ setting: "BRAIN_UI_NATIVE_BRAIN_LEASE_PATH", path: lease }]);
  });

  test("compute state joins the layout only when configured: a bound key, or earlier state on disk", () => {
    const state = root(), db = join(state, "brain-ui.db"), stateDir = join(state, "compute");
    const compute = (layout: ReturnType<typeof privateStateLayout>) => layout.privateStatePaths.filter(entry => entry.setting === "BRAIN_UI_COMPUTE_STATE_DIR");
    expect(compute(privateStateLayout({ dbPath: db, compute: { keys: {}, stateDir } }))).toEqual([]);
    expect(compute(privateStateLayout({ dbPath: db, compute: { keys: { boat: [] }, stateDir } })), "BOUND_KEY_CONFIGURES_COMPUTE")
      .toEqual([{ setting: "BRAIN_UI_COMPUTE_STATE_DIR", path: stateDir }]);
    mkdirSync(stateDir);
    const existing = privateStateLayout({ dbPath: db, compute: { keys: {}, stateDir } });
    expect(compute(existing), "EARLIER_STATE_CONFIGURES_COMPUTE").toEqual([{ setting: "BRAIN_UI_COMPUTE_STATE_DIR", path: stateDir }]);
    expect(existing.privateStatePaths.at(-1)?.setting, "COMPUTE_STAYS_LAST").toBe("BRAIN_UI_COMPUTE_STATE_DIR");
    expect(existing.computeStateDir).toBe(stateDir);
  });

  test("cron resolves the same layout as the server from the same environment", () => {
    const state = root(), db = join(state, "brain-ui.db");
    const env = { DB_PATH: db, BRAIN_PATH: join(state, "brain"), BRAIN_UI_INBOX_POKE_TOKEN_FILE: join(state, "poke.token"),
      BRAIN_UI_NATIVE_BRAIN_SOCKET: join(state, "native.sock"), BRAIN_UI_NATIVE_BRAIN_LEASE_PATH: join(state, "leases.sqlite"),
      BRAIN_UI_COMPUTE_KEYS: "boat", BRAIN_UI_COMPUTE_STATE_DIR: join(state, "compute") };
    const server = resolveServerConfig(env), cron = resolveCronConfig(env);
    const serverLayout = privateStateLayout({ dbPath: server.dbPath, nativeLeasePath: server.nativeBrain?.leasePath, pokeTokenFile: server.inbox?.pokeTokenFile, compute: server.compute! });
    const cronLayout = privateStateLayout({ dbPath: cron.dbPath, nativeLeasePath: cron.nativeBrain?.leasePath, pokeTokenFile: cron.inboxPokeTokenFile, compute: cron.compute });
    expect(cronLayout.privateStatePaths, "CRON_MATCHES_SERVER_LAYOUT").toEqual(serverLayout.privateStatePaths);
    expect(cronLayout.privateStatePaths.map(entry => entry.setting)).toEqual(["BRAIN_UI_INBOX_POKE_TOKEN_FILE", "Storage transfer cache", "turn journal",
      "BRAIN_UI_NATIVE_BRAIN_LEASE_PATH", "web executor state", "BRAIN_UI_COMPUTE_STATE_DIR"]);
  });
});
