/**
 * The host's Google credential (#4206; plan docs/plans/google-workspace.md
 * §10, "Hosted: an enforced boundary"): the configuration is read once, the
 * gog home is checked at every use and a home that fails a check makes
 * Google `unavailable` with its reason while the host boots and serves
 * chats; the availability probe combines the pin, the home and whether the
 * account is connected; the home is an exact worker mask from boot; and no
 * Google name reaches a child of the host boundary or a cron job.
 *
 * Keyless and offline: the fake gog from packages/common/tests/support only.
 */
import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GOG_ENVIRONMENT_NAMES, type GogTransport } from "@schlessera/brain-common/internal/google-gog";
import { workerSystemPaths } from "@schlessera/brain-ui-sdk/internal";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createFakeGog, type FakeGog, type FakeGogScenario } from "../../common/tests/support/fake-gog.ts";
import { createApp } from "../src/app.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import { googleHostEnv, resolveCronConfig, resolveServerConfig, subprocessEnv } from "../src/config/env.js";
import { emitEnvironment } from "../src/cron/emit.js";
import { createPrincipal } from "../src/db/principals.js";
import {
  createGoogleCredential, GOOGLE_CONNECTED_TTL_MS, GOOGLE_UNAVAILABLE_REASONS,
  type GoogleAvailabilityStatus, type GoogleCredentialOptions, type GoogleUnavailableReason,
} from "../src/google/credential.js";
import {
  checkGoogleHome, GOG_DEFAULT_DIRS, googleHomeAreas, googleHomeMask, googleHostLayout, googleTempAreas, googleWorkerMasks, googleWorkerMounts,
  type GoogleHomeCheck, type GoogleHomeCheckOptions, type GoogleHomeLayout, type GoogleHomeMask, type GoogleHomeReason,
} from "../src/google/home.js";
import { createRecordingObservability } from "../src/observability/index.js";
import type { WSContext } from "../src/ws/clients.js";
import { createWsHandlers } from "../src/ws/connection.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { workerCommand } from "../../ui-sdk/src/server/worker-launcher.js";

const ROOT = resolve(import.meta.dir, "../../..");
const LABELS = JSON.parse(readFileSync(join(ROOT, "packages/common/tests/fixtures/gog/labels-list.json"), "utf8"));
const PASSWORD = "penelope-weaves-by-day-and-unweaves-by-night";
const GOOGLE_NAMES = ["BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_GOOGLE_LEDGER", "BRAIN_UI_GOG_PATH", "GOG_HOME", "GOG_ACCESS_TOKEN", "GOG_KEYRING_PASSWORD", "BRAIN_GOOGLE_HOME"] as const;
const GUARD = /^(?:GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|BRAIN_WORKSPACE_LEASE)$/;
const leaked = (env: Record<string, string | undefined>) => Object.keys(env).filter(name => /^(GOG_|BRAIN_UI_GOOGLE_|BRAIN_GOOGLE_|BRAIN_UI_GOG_PATH$)/.test(name) || String(env[name]).includes(PASSWORD));
/** The Bun runtime's directory, which every worker binds, and its parent. */
const RUNTIME = dirname(realpathSync(process.execPath));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/**
 * A layout under the repository's own tmp directory, outside every temp area:
 * a brain, a database directory, a server home bound into workers, a temp
 * area and a good gog home beside them.
 */
function layout() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = realpathSync(mkdtempSync(join(ROOT, "tmp/odysseus-google-home-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain"), state = join(root, "state"), serverHome = join(root, "server-home"), temp = join(root, "temp"), home = join(root, "gog-home");
  for (const path of [brain, state, serverHome, temp]) mkdirSync(path, { recursive: true });
  mkdirSync(home, { mode: 0o700 }); chmodSync(home, 0o700);
  const homeLayout: GoogleHomeLayout = { brainPath: brain, dbPath: join(state, "ui.db"), workerMounts: [serverHome], tempAreas: [temp] };
  return { root, brain, state, serverHome, temp, home, homeLayout };
}

const env = (home: string | undefined, overrides: Partial<{ password: string | undefined; gogPath: string | undefined }> = {}) =>
  googleHostEnv("/odysseus/state/ui.db", {
    ...(home !== undefined ? { BRAIN_UI_GOOGLE_HOME: home } : {}),
    ...("password" in overrides ? (overrides.password !== undefined ? { BRAIN_UI_GOOGLE_KEYRING_PASSWORD: overrides.password } : {}) : { BRAIN_UI_GOOGLE_KEYRING_PASSWORD: PASSWORD }),
    ...("gogPath" in overrides ? (overrides.gogPath !== undefined ? { BRAIN_UI_GOG_PATH: overrides.gogPath } : {}) : { BRAIN_UI_GOG_PATH: "/opt/gog/bin/gog" }),
  });

let accounts = 0;
/** A fresh alias per credential, so no test shares another's transport concurrency limits. */
const alias = () => `ithaca-${++accounts}`;

function fakeGog(scenario: FakeGogScenario): FakeGog {
  const fake = createFakeGog(scenario);
  cleanups.push(() => fake.dispose());
  return fake;
}

function credential(home: string | undefined, homeLayout: GoogleHomeLayout, options: Partial<GoogleCredentialOptions> = {}) {
  const reports: { message: string; status: GoogleAvailabilityStatus }[] = [];
  const google = createGoogleCredential({ env: env(home), layout: homeLayout, transport: { retryDelayMs: 0 },
    report: (message, status) => reports.push({ message, status }), ...options });
  return { google, reports };
}

const reasonOf = (status: GoogleAvailabilityStatus): GoogleUnavailableReason | "available" => {
  // Every unavailable answer names one of the published reasons.
  if (status.state === "unavailable") expect(GOOGLE_UNAVAILABLE_REASONS, "REASON_IS_PUBLISHED").toContain(status.reason);
  return status.state === "available" ? "available" : status.reason;
};

describe("google host environment", () => {
  test("google: the home, binary, ledger and keyring password are read once, with no GOG_* fallback", () => {
    const source: NodeJS.ProcessEnv = { BRAIN_UI_GOOGLE_HOME: " /srv/ithaca/gog ", BRAIN_UI_GOG_PATH: " /opt/gog/bin/gog ", BRAIN_UI_GOOGLE_KEYRING_PASSWORD: ` ${PASSWORD} `,
      GOG_HOME: "/srv/suitors/gog", GOG_KEYRING_PASSWORD: "antinous" };
    const read = googleHostEnv("/srv/ithaca/state/ui.db", source);
    source.BRAIN_UI_GOOGLE_KEYRING_PASSWORD = "changed-after-boot";
    expect({ home: read.home, gogPath: read.gogPath, ledgerPath: read.ledgerPath, password: read.keyringPassword() }, "GOOGLE_ENV_READ_ONCE").toEqual({
      home: "/srv/ithaca/gog", gogPath: "/opt/gog/bin/gog", ledgerPath: "/srv/ithaca/state/ui.db.google-ledger.sqlite", password: ` ${PASSWORD} ` });
    const fallback = googleHostEnv("/srv/ithaca/state/ui.db", { GOG_HOME: "/srv/suitors/gog", GOG_KEYRING_PASSWORD: "antinous", BRAIN_GOOGLE_LEDGER: " /srv/ithaca/google.sqlite " });
    expect({ home: fallback.home, password: fallback.keyringPassword(), ledgerPath: fallback.ledgerPath }, "GOOGLE_ENV_NO_GOG_FALLBACK").toEqual({
      home: undefined, password: undefined, ledgerPath: "/srv/ithaca/google.sqlite" });
    expect(googleHostEnv("/d/ui.db", { BRAIN_UI_GOOGLE_HOME: "  ", BRAIN_UI_GOOGLE_KEYRING_PASSWORD: "" }).home).toBeUndefined();
  });

  test("google: every ui-server subprocess audience drops google names, whatever the operator extra says", () => {
    const names = [...GOOGLE_NAMES, "CUSTOM_TOKEN"];
    const previous = Object.fromEntries([...names, "BRAIN_UI_SUBPROCESS_ENV_EXTRA"].map(name => [name, process.env[name]]));
    cleanups.push(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
    for (const name of GOOGLE_NAMES) process.env[name] = `${PASSWORD}-${name}`;
    process.env.CUSTOM_TOKEN = "ithaca";
    process.env.BRAIN_UI_SUBPROCESS_ENV_EXTRA = names.join(",");
    for (const audience of ["agent", "cron", "brainCli"] as const) {
      const child = subprocessEnv(audience, {}, names);
      expect(leaked(child), `UI_SERVER_GOOGLE_NAMES_WITHHELD: ${audience}`).toEqual([]);
      expect(child.CUSTOM_TOKEN, `UI_SERVER_ORDINARY_EXTRA_ADMITTED: ${audience}`).toBe("ithaca");
    }
  });
});

describe("google home validation", () => {
  // Every row: where the configured home points → the reason it is refused.
  type Row = [name: string, home: (f: ReturnType<typeof layout>) => string | undefined, reason: GoogleHomeReason, options?: Pick<GoogleHomeCheckOptions, "hostUid">];
  const rows: Row[] = [
    ["unset", () => undefined, "home_unset"],
    ["a relative path", () => "gog-home", "home_relative"],
    ["mode 0755", f => { chmodSync(f.home, 0o755); return f.home; }, "home_mode"],
    ["mode 0750", f => { chmodSync(f.home, 0o750); return f.home; }, "home_mode"],
    ["owned by another user", f => f.home, "home_owner", { hostUid: (process.getuid?.() ?? 0) + 1 }],
    ["inside the brain", f => { const home = join(f.brain, ".gog"); mkdirSync(home, { mode: 0o700 }); return home; }, "home_overlaps_brain"],
    ["holding the brain", f => f.root, "home_overlaps_brain"],
    ["inside the database directory", f => { const home = join(f.state, "gog"); mkdirSync(home, { mode: 0o700 }); return home; }, "home_overlaps_database"],
    ["inside a worker mount", f => { const home = join(f.serverHome, ".config/gogcli"); mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700); return home; }, "home_overlaps_worker_mount"],
    ["holding a worker mount", f => { const home = join(f.root, "outer"); mkdirSync(home, { mode: 0o700 }); return home; }, "home_overlaps_worker_mount"],
    // The default inventory: what a transport worker binds whatever its masks.
    ["inside a system directory", () => "/usr/share/odysseus-gog-home", "home_overlaps_worker_mount"],
    ["inside the certificate store a transport binds", () => "/etc/ssl/certs/odysseus-gog-home", "home_overlaps_worker_mount"],
    ["holding the Bun runtime", () => dirname(RUNTIME), "home_overlaps_worker_mount"],
    ["under /proc", () => "/proc/self", "home_overlaps_worker_mount"],
    ["inside a temp area", f => { const home = join(f.temp, "gog"); mkdirSync(home, { mode: 0o700 }); return home; }, "home_overlaps_temp"],
    ["a symlink into the brain", f => { const target = join(f.brain, ".gog"); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, join(f.root, "linked")); return join(f.root, "linked"); }, "home_overlaps_brain"],
    ["a symlink into a temp area", f => { const target = join(f.temp, "gog"); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, join(f.root, "linked")); return join(f.root, "linked"); }, "home_overlaps_temp"],
    ["through a linked parent into a worker mount", f => { symlinkSync(f.serverHome, join(f.root, "parent")); mkdirSync(join(f.serverHome, "gog"), { mode: 0o700 }); return join(f.root, "parent/gog"); }, "home_overlaps_worker_mount"],
    ["missing", f => join(f.root, "absent"), "home_missing"],
    ["a file", f => { writeFileSync(join(f.root, "file"), "Argos"); return join(f.root, "file"); }, "home_not_directory"],
  ];
  const DEFAULT_INVENTORY = new Set(["inside a system directory", "inside the certificate store a transport binds", "holding the Bun runtime", "under /proc"]);
  // "holding a worker mount" needs the worker mount below it; the default-inventory rows the server's own.
  const prepared = (row: Row, f: ReturnType<typeof layout>) => {
    if (row[0] === "holding a worker mount") return { ...f, homeLayout: { ...f.homeLayout, workerMounts: [join(f.root, "outer/server-home")] } };
    if (DEFAULT_INVENTORY.has(row[0])) return { ...f, homeLayout: { ...f.homeLayout, workerMounts: googleWorkerMounts(f.serverHome) } };
    return f;
  };

  for (const row of rows) test(`google: a home ${row[0]} is refused as ${row[2]}, and Google answers unavailable with it`, async () => {
    const f = prepared(row, layout());
    const home = row[1](f);
    const areas = googleHomeAreas(f.homeLayout);
    const check: GoogleHomeCheck = checkGoogleHome(home, areas, { ...row[3], mask: googleHomeMask(home, areas) });
    expect(check.ok ? "ok" : check.reason, `HOME_CHECK: ${row[0]}`).toBe(row[2]);
    if (!check.ok) expect(check.detail, "DETAIL_NAMES_THE_SETTING_NOT_THE_PATH").toStartWith("BRAIN_UI_GOOGLE_HOME ");
    if (!check.ok && home) expect(check.detail).not.toContain(f.root);
    // An overlap means a worker may already hold the token: the detail says so.
    if (!check.ok && check.reason.startsWith("home_overlaps_")) expect(check.detail, "OVERLAP_TOKEN_EXPOSED").toContain("treat any token stored there as exposed");
    // Through the probe: the same reason, and gog never runs.
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    const { google } = credential(home, f.homeLayout, { binary: fake.binary, ...(row[3] ?? {}) });
    const status = await google.status(alias());
    expect(status, `PROBE_UNAVAILABLE: ${row[0]}`).toMatchObject({ state: "unavailable", reason: row[2] });
    expect(fake.calls(), `NO_GOG_FOR_A_REFUSED_HOME: ${row[0]}`).toEqual([]);
  });

  test("google: a good home passes with its links resolved, and a home that moved after boot is refused", () => {
    const f = layout();
    const link = join(f.root, "linked-home"); symlinkSync(f.home, link);
    const areas = googleHomeAreas(f.homeLayout);
    const mask = googleHomeMask(f.home, areas);
    expect(checkGoogleHome(f.home, areas, { mask }), "GOOD_HOME_PASSES").toEqual({ ok: true, path: f.home });
    expect(checkGoogleHome(link, areas, { mask: googleHomeMask(link, areas) }), "LINKED_HOME_RESOLVED").toEqual({ ok: true, path: f.home });
    const elsewhere = join(f.root, "elsewhere"); mkdirSync(elsewhere, { mode: 0o700 });
    expect(checkGoogleHome(elsewhere, areas, { mask }), "MOVED_HOME_REFUSED").toMatchObject({ ok: false, reason: "home_moved" });
    expect(checkGoogleHome(f.home, areas, { mask: { path: null } }), "UNMASKED_HOME_REFUSED").toMatchObject({ ok: false, reason: "home_moved" });
  });

  test("google: a home missing at boot and created later is refused until a restart, and never becomes available", async () => {
    const f = layout();
    const later = join(f.root, "later");
    const areas = googleHomeAreas(f.homeLayout);
    const mask: GoogleHomeMask = googleHomeMask(later, areas);
    expect(mask, "NO_MASK_FOR_A_MISSING_HOME").toEqual({ path: null, absentAtBoot: true });
    expect(checkGoogleHome(later, areas, { mask }), "MISSING_HOME_SAYS_CREATE_BEFORE_START").toMatchObject({ ok: false, reason: "home_missing",
      detail: expect.stringContaining("exists when the server starts") });
    // Built while the home is missing, as at boot; then the operator creates it right.
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    const { google } = credential(later, f.homeLayout, { binary: fake.binary });
    expect(google.maskPaths, "NOTHING_MASKED_FOR_A_MISSING_HOME").toEqual([]);
    mkdirSync(later, { mode: 0o700 }); chmodSync(later, 0o700);
    expect(checkGoogleHome(later, areas, { mask }), "CREATED_HOME_REFUSED").toMatchObject({ ok: false, reason: "home_created_after_boot",
      detail: expect.stringContaining("did not exist when the server started") });
    for (let call = 0; call < 2; call++) {
      expect(await google.status(alias()), `CREATED_HOME_UNAVAILABLE_UNTIL_RESTART: ${call}`).toMatchObject({ state: "unavailable", reason: "home_created_after_boot" });
    }
    expect(fake.calls(), "NO_GOG_FOR_A_HOME_CREATED_AFTER_BOOT").toEqual([]);
    // A restart lays the mask, and the same home is available.
    const restarted = credential(later, f.homeLayout, { binary: fake.binary }).google;
    expect(restarted.maskPaths, "RESTART_MASKS_IT").toEqual([later]);
    expect(reasonOf(await restarted.status(alias())), "AVAILABLE_AFTER_A_RESTART").toBe("available");
  });

  test("google: a home replaced after boot is refused until a restart, though it has the same path, mode and owner", async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    const account = alias();
    const { google } = credential(f.home, f.homeLayout, { binary: fake.binary });
    expect(reasonOf(await google.status(account))).toBe("available");
    rmSync(f.home, { recursive: true }); mkdirSync(f.home, { mode: 0o700 }); chmodSync(f.home, 0o700);
    expect(await google.status(account), "REPLACED_HOME_REFUSED").toMatchObject({ state: "unavailable", reason: "home_created_after_boot",
      detail: expect.stringContaining("was replaced after the server started") });
    expect(fake.calls(), "NO_GOG_FOR_A_REPLACED_HOME").toHaveLength(1);
  });

  test("google: the default temp areas and worker mounts", () => {
    expect(googleTempAreas(), "GOOGLE_TEMP_AREAS").toEqual(expect.arrayContaining([tmpdir(), "/tmp", "/var/tmp", "/dev/shm"]));
    const f = layout();
    const inTemp = mkdtempSync(join(tmpdir(), "odysseus-gog-home-")); chmodSync(inTemp, 0o700);
    cleanups.push(() => rmSync(inTemp, { recursive: true, force: true }));
    const defaults = googleHomeAreas({ brainPath: f.brain });
    expect(checkGoogleHome(inTemp, defaults, { mask: googleHomeMask(inTemp, defaults) }), "DEFAULT_TEMP_REFUSED").toMatchObject({ ok: false, reason: "home_overlaps_temp" });
    // Every host path a worker sees whatever its masks: the server's HOME, the
    // runtime, and the system paths a transport binds with no mask at all.
    const mounts = googleWorkerMounts("/srv/ithaca/home");
    expect(mounts, "WORKER_MOUNTS_NAME_THE_SERVER_HOME_RUNTIME_AND_SYSTEM").toEqual(["/srv/ithaca/home", RUNTIME, ...workerSystemPaths()]);
    expect(mounts, "WORKER_MOUNTS_HOLD_THE_SYSTEM_PATHS").toEqual(expect.arrayContaining(["/usr", "/bin", "/lib", "/etc/passwd", "/etc/resolv.conf", "/etc/ssl/certs", "/proc", "/dev"]));
    expect(googleWorkerMounts("/"), "A_ROOT_HOME_IS_NO_MOUNT").toEqual([RUNTIME, ...workerSystemPaths()]);
    expect(googleHostLayout({ brainPath: f.brain, dbPath: join(f.state, "ui.db"), serverHome: f.serverHome }), "HOST_LAYOUT").toEqual({
      brainPath: f.brain, dbPath: join(f.state, "ui.db"), workerMounts: googleWorkerMounts(f.serverHome), serverHome: f.serverHome });
  });

  test("google: the worker mask is the home as it resolves at boot, and only where a mask is safe to lay", () => {
    const f = layout();
    const link = join(f.root, "linked-home"); symlinkSync(f.home, link);
    const areas = googleHomeAreas({ ...f.homeLayout, workerMounts: googleWorkerMounts(f.serverHome) });
    expect(googleHomeMask(link, areas).path, "MASK_IS_RESOLVED_HOME").toBe(f.home);
    // Mode and owner do not make a mask unsafe: a 0755 home is still covered while its check refuses it.
    chmodSync(f.home, 0o755);
    expect(googleHomeMask(f.home, areas).path, "MASK_FOR_A_WRONG_MODE_HOME").toBe(f.home);
    // Strictly inside an area other than the brain: refused by its check, and covered.
    const inHome = join(f.serverHome, "gog"), inDatabase = join(f.state, "gog");
    for (const path of [inHome, inDatabase]) mkdirSync(path, { mode: 0o700 });
    expect(googleHomeMask(inHome, areas).path, "MASK_INSIDE_THE_SERVER_HOME").toBe(inHome);
    expect(googleHomeMask(inDatabase, areas).path, "MASK_INSIDE_THE_DATABASE_DIRECTORY").toBe(inDatabase);
    // A directory under /usr that holds nothing workers bind (not /usr/share itself, which holds /etc/localtime's zone file).
    const holdsNone = (path: string) => areas.every(area => area.path !== path && !area.path.startsWith(`${path}/`));
    const inSystem = readdirSync("/usr/share").sort().map(name => join("/usr/share", name)).find(path => lstatSync(path).isDirectory() && holdsNone(path))!;
    expect(googleHomeMask(inSystem, areas).path, "MASK_INSIDE_A_SYSTEM_DIRECTORY").toBe(inSystem);
    expect(googleHomeMask("/usr/share", areas), "NO_MASK_HOLDING_A_FILE_WORKERS_BIND").toEqual({ path: null });
    expect(googleHomeMask(join(f.root, "not-yet"), areas), "NO_MASK_FOR_A_HOME_NOT_CREATED_YET").toEqual({ path: null, absentAtBoot: true });
    writeFileSync(join(f.root, "file"), "Argos");
    expect(googleHomeMask(join(f.root, "file"), areas), "NO_MASK_FOR_A_FILE").toEqual({ path: null, absentAtBoot: true });
    expect(googleHomeMask("/bin/sh", areas), "NO_MASK_FOR_THE_SHELL").toEqual({ path: null, absentAtBoot: true });
    // Holding an area: the runtime, a system directory, the server's HOME, the database directory.
    expect(googleHomeMask(dirname(RUNTIME), areas), "NO_MASK_HOLDING_THE_RUNTIME").toEqual({ path: null });
    expect(googleHomeMask("/usr", areas), "NO_MASK_FOR_A_SYSTEM_DIRECTORY").toEqual({ path: null });
    expect(googleHomeMask(f.serverHome, areas), "NO_MASK_AT_THE_SERVER_HOME").toEqual({ path: null });
    expect(googleHomeMask(f.state, areas), "NO_MASK_AT_THE_DATABASE_DIRECTORY").toEqual({ path: null });
    // Below a root every worker replaces with its own: in no worker's view, and a mask under /proc breaks every launch.
    expect(googleHomeMask("/proc/self", areas), "NO_MASK_UNDER_PROC").toEqual({ path: null });
    expect(googleHomeMask("/dev/shm", areas), "NO_MASK_UNDER_DEV").toEqual({ path: null });
    // The brain, either way round.
    mkdirSync(join(f.brain, ".gog"));
    expect(googleHomeMask(join(f.brain, ".gog"), areas), "NO_MASK_INSIDE_THE_BRAIN").toEqual({ path: null });
    expect(googleHomeMask(f.root, areas), "NO_MASK_HOLDING_THE_BRAIN").toEqual({ path: null });
    expect(googleHomeMask(undefined, areas)).toEqual({ path: null });
    expect(googleHomeMask("gog-home", areas)).toEqual({ path: null });
  });

  test("google: gog's default directories under the server's HOME are masked where they are, alongside the configured home", () => {
    const f = layout();
    const homeLayout = { ...f.homeLayout, serverHome: f.serverHome };
    expect(GOG_DEFAULT_DIRS, "GOG_DEFAULT_DIRS").toEqual([".config/gogcli", ".local/share/gogcli", ".local/state/gogcli", ".cache/gogcli"]);
    expect(googleWorkerMasks(f.home, homeLayout).paths, "NO_DEFAULT_HOME_NO_MASK").toEqual([f.home]);
    // gog's configuration and its data, where the keyring and OAuth client live.
    const [config, data] = [join(f.serverHome, ".config/gogcli"), join(f.serverHome, ".local/share/gogcli")];
    for (const path of [config, data]) mkdirSync(path, { recursive: true, mode: 0o700 });
    const masks = googleWorkerMasks(f.home, homeLayout);
    expect(masks.paths, "DEFAULT_DIRECTORIES_MASKED").toEqual([f.home, config, data]);
    expect(masks.home.path, "CONFIGURED_HOME_MASKED").toBe(f.home);
    // Configured as the home itself: refused, and still covered.
    expect(googleWorkerMasks(config, homeLayout).paths, "REFUSED_DEFAULT_HOME_STILL_MASKED").toEqual([config, data]);
    // Linked into the brain, a mask would refuse every launch: none for it.
    rmSync(config, { recursive: true });
    const intoBrain = join(f.brain, "gogcli"); mkdirSync(intoBrain);
    symlinkSync(intoBrain, config);
    expect(googleWorkerMasks(f.home, homeLayout).paths, "NO_DEFAULT_MASK_INTO_THE_BRAIN").toEqual([f.home, data]);
    // A brain that is the server's HOME, or lies inside it, holds its gog defaults: a mask there would refuse every launch.
    expect(googleWorkerMasks(undefined, { ...homeLayout, brainPath: f.serverHome }).paths, "NO_DEFAULT_MASK_IN_A_BRAIN_AT_HOME").toEqual([]);
    expect(googleWorkerMasks(undefined, { ...homeLayout, brainPath: join(f.serverHome, ".local") }).paths, "NO_DEFAULT_MASK_IN_A_BRAIN_INSIDE_HOME").toEqual([]);
    expect(googleWorkerMasks(undefined, f.homeLayout).paths).toEqual([]);
  });
});

describe("google availability probe", () => {
  test("google: configuration rows each answer unavailable with their own reason, and run no gog", async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    const rows: [string, GoogleCredentialOptions["env"], string | null, GoogleUnavailableReason][] = [
      ["no keyring password", env(f.home, { password: undefined }), alias(), "keyring_password_unset"],
      ["no gog path", env(f.home, { gogPath: undefined }), alias(), "gog_path_unset"],
      ["no account", env(f.home), null, "account_unset"],
      ["an address for an account", env(f.home), "penelope@example.com", "account_invalid"],
      ["gog's own auto account", env(f.home), "auto", "account_invalid"],
    ];
    for (const [name, google, account, reason] of rows) {
      const probe = createGoogleCredential({ env: google, layout: f.homeLayout, ...(name === "no gog path" ? {} : { binary: fake.binary }) });
      // The probe answers; it never throws, whatever the configuration lacks.
      const got: string = await probe.status(account).then(reasonOf, (error: unknown) => `threw: ${String(error)}`);
      expect(got, `CONFIGURATION: ${name}`).toBe(reason);
    }
    expect(fake.calls(), "NO_GOG_FOR_CONFIGURATION").toEqual([]);
  });

  test("google: a good home, the binary and a connected account are available, through one read-only labels call", async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    let clock = 1_000_000;
    const account = alias();
    const { google, reports } = credential(f.home, f.homeLayout, { binary: fake.binary, now: () => clock });
    const status = await google.status(account);
    expect(status, "GOOGLE_AVAILABLE").toEqual({ state: "available", account, binary: { kind: "fake" }, connected_at: 1_000_000 });
    const [call, ...more] = fake.calls();
    expect(more, "ONE_CONNECTED_CHECK").toEqual([]);
    expect(call!.command, "CONNECTED_CHECK_IS_LABELS_LIST").toBe("gmail.labels.list");
    expect(call!.argv, "CONNECTED_CHECK_DISCIPLINE").toEqual(expect.arrayContaining(["--readonly", "--gmail-no-send", "--enable-commands-exact=gmail.labels.list", `--account=${account}`]));
    // The offline test guard adds its own Git policy and workspace lease to every child (scripts/test-network-guard.ts).
    expect(call!.env_names.filter(name => !GUARD.test(name)).sort(), "GOG_ENVIRONMENT_IS_THE_ALLOW_LIST").toEqual([...GOG_ENVIRONMENT_NAMES].sort());
    // Within the window the probe checks the home and the pin, not Google; after it, Google again.
    clock += 60_000;
    expect(reasonOf(await google.status(account))).toBe("available");
    expect(fake.calls(), "CONNECTED_CHECK_CACHED").toHaveLength(1);
    clock += GOOGLE_CONNECTED_TTL_MS;
    expect(reasonOf(await google.status(account))).toBe("available");
    expect(fake.calls(), "CONNECTED_CHECK_EXPIRES").toHaveLength(2);
    expect(reports.map(report => report.status.state), "REPORTED_ONCE_PER_CHANGE").toEqual(["available"]);
  });

  test("google: the account's transport opens only on a good home, with the home resolved at boot as its mask", () => {
    const f = layout();
    const link = join(f.root, "linked-home"); symlinkSync(f.home, link);
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    const { google } = credential(link, f.homeLayout, { binary: fake.binary });
    expect(google.maskPaths, "CREDENTIAL_MASKS_THE_RESOLVED_HOME").toEqual([f.home]);
    expect(google.transport(alias()).ok, "TRANSPORT_OPENS_ON_A_GOOD_HOME").toBe(true);
    chmodSync(f.home, 0o755);
    const refused = google.transport(alias());
    expect(refused.ok ? null : refused.status.reason, "TRANSPORT_REFUSED_ON_A_BAD_HOME").toBe("home_mode");
  });

  test("google: gog's own answers map to unavailable reasons, and a later success recovers without a restart", async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": [{ exit: 4, stderr: "no token" }, { exit: 7 }, { exit: 10 }, { stdout: "not json" }, { stdout: LABELS }] });
    const account = alias();
    const { google, reports } = credential(f.home, f.homeLayout, { binary: fake.binary });
    const seen: [string, string | null][] = [];
    for (let i = 0; i < 5; i++) {
      const status = await google.status(account);
      seen.push(status.state === "available" ? ["available", null] : [status.reason, status.cause]);
    }
    expect(seen, "CONNECTED_CHECK_OUTCOMES").toEqual([
      ["not_connected", "auth_required"], ["account_unverified", "rate_limited"], ["not_connected", "config"], ["transport_incompatible", "unexpected_output"], ["available", null]]);
    expect(reports.map(report => reasonOf(report.status)), "EACH_CHANGE_REPORTED").toEqual(["not_connected", "account_unverified", "not_connected", "transport_incompatible", "available"]);
    for (const report of reports) expect(report.message, "REPORT_HOLDS_NO_SECRET").not.toContain(PASSWORD);
  });

  test("google: a pinned binary that is not a listed release is binary_refused, and gog is never run as a pinned binary", async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    const { google } = credential(f.home, f.homeLayout, { binary: { kind: "pinned", path: fake.executable } });
    const status = await google.status(alias());
    expect(status, "UNPINNED_BINARY_REFUSED").toMatchObject({ state: "unavailable", reason: "binary_refused" });
    expect(status.state === "unavailable" && status.cause, "PIN_REASON_CARRIED").toBeTruthy();
    expect(fake.calls(), "UNPINNED_BINARY_NEVER_ANSWERED").toEqual([]);
    const missing = createGoogleCredential({ env: env(f.home, { gogPath: join(f.root, "no-gog") }), layout: f.homeLayout });
    expect(await missing.status(alias()), "MISSING_BINARY_REFUSED").toMatchObject({ state: "unavailable", reason: "binary_refused", cause: "binary_missing" });
  });

  test("google: a home repaired after a refusal is used on the next call", async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    const account = alias();
    const { google } = credential(f.home, f.homeLayout, { binary: fake.binary });
    chmodSync(f.home, 0o755);
    expect(reasonOf(await google.status(account)), "OPEN_HOME_REFUSED").toBe("home_mode");
    chmodSync(f.home, 0o700);
    expect(reasonOf(await google.status(account)), "REPAIRED_HOME_AVAILABLE").toBe("available");
    // A connected check never outlives a refusal: the next refusal drops it.
    chmodSync(f.home, 0o711);
    expect(reasonOf(await google.status(account))).toBe("home_mode");
    chmodSync(f.home, 0o700);
    expect(reasonOf(await google.status(account))).toBe("available");
    expect(fake.calls(), "RECHECKED_AFTER_A_REFUSAL").toHaveLength(2);
  });
});

describe("google availability probe failures", () => {
  type Steps = Pick<GogTransport, "availability" | "execute">;
  const settled = (pending: Promise<GoogleAvailabilityStatus>) => pending.then(status => status, (error: unknown) => ({ rejected: String(error) }));

  test("google: a probe step that throws answers probe_failed without its text, drops a cached success, and the next call recovers", async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    let clock = 1_000_000;
    const account = alias();
    const { google, reports } = credential(f.home, f.homeLayout, { binary: fake.binary, now: () => clock });
    expect(reasonOf(await google.status(account)), "AVAILABLE_FIRST").toBe("available");
    const opened = google.transport(account);
    if (!opened.ok) throw new Error(opened.status.detail);
    const steps = opened.transport as Steps, { availability, execute } = steps;
    const secret = join(f.root, "penelope@example.com");
    // A synchronous throw from the pin step, within the connected check's window.
    steps.availability = () => { throw new Error(`pin exploded at ${secret}`); };
    const pin = await settled(google.status(account));
    expect(pin, "PIN_THROW_UNAVAILABLE").toEqual({ state: "unavailable", reason: "probe_failed", detail: expect.any(String), cause: "pin" });
    expect(JSON.stringify(pin), "PIN_THROW_TEXT_WITHHELD").not.toContain("exploded");
    steps.availability = availability;
    expect(reasonOf(await google.status(account)), "RECOVERED_AFTER_PIN_THROW").toBe("available");
    expect(fake.calls(), "PIN_THROW_DROPPED_THE_CACHED_SUCCESS").toHaveLength(2);
    // An asynchronous rejection from the connected check, after the window.
    clock += GOOGLE_CONNECTED_TTL_MS;
    steps.execute = (async () => { throw new Error(`labels exploded for ${secret}`); }) as Steps["execute"];
    const labels = await settled(google.status(account));
    expect(labels, "CONNECTED_CHECK_THROW_UNAVAILABLE").toEqual({ state: "unavailable", reason: "probe_failed", detail: expect.any(String), cause: "connected_check" });
    expect(JSON.stringify(labels), "CONNECTED_CHECK_THROW_TEXT_WITHHELD").not.toContain("exploded");
    steps.execute = execute;
    expect(reasonOf(await google.status(account)), "RECOVERED_AFTER_CONNECTED_CHECK_THROW").toBe("available");
    expect(fake.calls(), "RECHECKED_AFTER_THE_THROW").toHaveLength(3);
    for (const report of reports) expect(report.message, "REPORT_HOLDS_NO_EXCEPTION_TEXT").not.toMatch(/exploded|penelope@/);
  });

  test("google: a throw while opening the transport, or from the log, still answers", async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    const broken = { ...env(f.home), keyringPassword: () => { throw new Error(`keyring exploded: ${PASSWORD}`); } };
    const opening = createGoogleCredential({ env: broken, layout: f.homeLayout, binary: fake.binary });
    const status = await settled(opening.status(alias()));
    expect(status, "OPEN_THROW_UNAVAILABLE").toEqual({ state: "unavailable", reason: "probe_failed", detail: expect.any(String), cause: "transport" });
    expect(JSON.stringify(status), "OPEN_THROW_TEXT_WITHHELD").not.toContain(PASSWORD);
    const loud = credential(f.home, f.homeLayout, { binary: fake.binary, report: () => { throw new Error("the log is down"); } }).google;
    expect(await settled(loud.status(alias())), "A_FAILING_LOG_NEVER_CHANGES_THE_ANSWER").toMatchObject({ state: "available" });
    // A throw outside every named step (here the clock, after a successful connected check) still answers.
    const clockless = credential(f.home, f.homeLayout, { binary: fake.binary, now: () => { throw new Error(`no clock at ${f.root}`); } }).google;
    const late = await settled(clockless.status(alias()));
    expect(late, "UNNAMED_STEP_THROW_UNAVAILABLE").toEqual({ state: "unavailable", reason: "probe_failed", detail: expect.any(String), cause: "probe" });
    expect(JSON.stringify(late), "UNNAMED_STEP_TEXT_WITHHELD").not.toContain(f.root);
  });

  test("google: a home the server may not inspect is home_unresolvable, never a throw, and recovers on the next call", async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    const account = alias();
    // Built first, as at boot, so the mask is laid before the home goes uninspectable.
    const { google } = credential(f.home, f.homeLayout, { binary: fake.binary });
    const real = fs.lstatSync;
    // Only the home's own final look fails, as when it changes between resolution and inspection.
    const spy = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (String(path) === f.home && options?.throwIfNoEntry === false) throw Object.assign(new Error(`EACCES: permission denied, lstat '${f.home}'`), { code: "EACCES" });
      return real(path, options as never);
    }) as typeof fs.lstatSync);
    cleanups.push(() => spy.mockRestore());
    const areas = googleHomeAreas(f.homeLayout);
    const check = (() => { try { return checkGoogleHome(f.home, areas); } catch (error) { return { threw: String(error) }; } })();
    expect(check, "UNINSPECTABLE_HOME_REFUSED").toMatchObject({ ok: false, reason: "home_unresolvable" });
    const status = await settled(google.status(account));
    expect(status, "UNINSPECTABLE_HOME_UNAVAILABLE").toMatchObject({ state: "unavailable", reason: "home_unresolvable" });
    expect(JSON.stringify(status), "UNINSPECTABLE_DETAIL_HOLDS_NO_PATH").not.toContain(f.root);
    spy.mockRestore();
    expect(reasonOf(await google.status(account)), "INSPECTABLE_HOME_RECOVERS").toBe("available");
    expect(fake.calls(), "ONE_CONNECTED_CHECK_AFTER_RECOVERY").toHaveLength(1);
  });
});

describe("google and the host", () => {
  /** A real app on the fixture native manager, with a fake backend whose one turn runs `script`. */
  async function hostedApp(google: (paths: { root: string; brain: string }) => Record<string, string>,
    script: (app: Awaited<ReturnType<typeof createApp>>) => Promise<void>) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "odysseus-host-google-"))), brain = join(root, "brain");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    await createFixtureBrain(ROOT, brain);
    const names = ["BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_UI_GOG_PATH"] as const;
    const previous: Record<string, string | undefined> = Object.fromEntries(names.map(name => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    // Whatever else a case sets (the server's HOME) is restored too.
    const settings = google({ root, brain });
    for (const name of Object.keys(settings)) if (!(name in previous)) previous[name] = process.env[name];
    Object.assign(process.env, settings);
    let finished = false, scriptError: unknown;
    let app!: Awaited<ReturnType<typeof createApp>>;
    const backend = makeFakeBackend({ id: "claude", startTurn: async ({ bridge }) => {
      await bridge.inputSafety!.ready("claude", 1);
      bridge.emit({ type: "session_info", sessionId: "sess-ithaca-google", isNew: true });
      try { await script(app); } catch (error) { scriptError = error; }
      finally {
        bridge.emit({ type: "result", sessionId: "sess-ithaca-google", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
        finished = true;
      }
    } });
    const observability = createRecordingObservability();
    const native = createNativeJournalFixture(brain, root), broker = native.serve();
    try {
      app = await createApp({ config: resolveServerConfig({ BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_PATH: brain, DB_PATH: join(root, "ui.db"), HOST: "127.0.0.1",
        AUTH_MODE: "password", NODE_ENV: "test", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash("the bow only Odysseus can string"),
        COOKIE_SECRET: "odysseus-google-cookie-secret-0123456789", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }),
        registry: createStaticBackendRegistry([backend], backend.id), observability });
      const sent: string[] = [];
      try {
        const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus Google", ttlSeconds: 60 });
        const handlers = createWsHandlers(app.wsHost, principal), ws = { send: (text: string) => { sent.push(text); }, close() {}, readyState: 1 } as WSContext;
        await handlers.onOpen(undefined as never, ws);
        handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Odysseus asks whether Google is connected.", requestId: "google-request" }) } as MessageEvent, ws);
        const until = Date.now() + 45_000;
        while (!finished || app.isTurnActive()) {
          if (Date.now() > until) throw new Error(`turn did not finish: ${sent.join("\n")}`);
          await Bun.sleep(10);
        }
        if (scriptError) throw scriptError;
        const warnings = observability.logs.find({ severity: "WARN" }).map(log => String(log.body));
        return { frames: sent.map(text => JSON.parse(text) as Record<string, unknown>), maskPaths: [...(app.wsHost.maintenance?.maskPaths ?? [])], warnings };
      } finally { await app.close(); }
    } finally {
      broker.close(); await native.close();
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  }
  const served = (frames: Record<string, unknown>[]) => frames.some(frame => frame.type === "result" && frame.outcome === "success");

  test("google: a host whose gog home is in the brain boots, serves a chat, and answers unavailable with the reason", async () => {
    let status: GoogleAvailabilityStatus | undefined;
    let home = "";
    const outcome = await hostedApp(({ brain }) => {
      home = join(brain, ".gog"); mkdirSync(home, { mode: 0o700 });
      return { BRAIN_UI_GOOGLE_HOME: home, BRAIN_UI_GOOGLE_KEYRING_PASSWORD: PASSWORD, BRAIN_UI_GOG_PATH: "/opt/gog/bin/gog" };
    }, async app => { status = await app.wsHost.google!.status("ithaca"); });
    expect(served(outcome.frames), "CHAT_SERVED_WITH_A_BAD_HOME").toBe(true);
    expect(status, "BAD_HOME_UNAVAILABLE_WITH_REASON").toMatchObject({ state: "unavailable", reason: "home_overlaps_brain" });
    expect(outcome.warnings.some(line => line.includes("Google is unavailable on this host (home_overlaps_brain)")), "CAUSE_IN_THE_SERVER_LOG").toBe(true);
    expect(outcome.warnings.join("\n"), "LOG_HOLDS_NO_SECRET").not.toContain(PASSWORD);
    // A worker view cannot cover part of the brain it binds; nothing was laid.
    expect(outcome.maskPaths, "NO_MASK_INSIDE_THE_BRAIN").not.toContain(home);
  });

  // Placements a mask must never be laid over: a file, the runtime, a system
  // path every worker needs. The host masks nothing, boots, serves a chat and says why.
  const unsafe: [name: string, home: () => string, reason: GoogleUnavailableReason][] = [
    ["a regular file", () => { const f = layout(); writeFileSync(join(f.root, "gog-file"), "Argos"); return join(f.root, "gog-file"); }, "home_not_directory"],
    ["an ancestor of the Bun runtime", () => dirname(RUNTIME), "home_overlaps_worker_mount"],
    ["a system directory", () => "/usr", "home_overlaps_worker_mount"],
  ];
  for (const [name, home, reason] of unsafe) test(`google: a host whose gog home is ${name} masks nothing, boots, serves a chat, and answers unavailable with the reason`, async () => {
    let status: GoogleAvailabilityStatus | undefined;
    const configured = home();
    const outcome = await hostedApp(() => ({ BRAIN_UI_GOOGLE_HOME: configured, BRAIN_UI_GOOGLE_KEYRING_PASSWORD: PASSWORD, BRAIN_UI_GOG_PATH: "/opt/gog/bin/gog" }),
      async app => { status = await app.wsHost.google!.status("ithaca"); });
    expect(served(outcome.frames), `CHAT_SERVED_WITH_AN_UNSAFE_HOME: ${name}`).toBe(true);
    expect(status, `UNSAFE_HOME_UNAVAILABLE_WITH_REASON: ${name}`).toMatchObject({ state: "unavailable", reason });
    expect(outcome.maskPaths, `NO_MASK_FOR_AN_UNSAFE_HOME: ${name}`).not.toContain(realpathSync(configured));
    expect(outcome.warnings.some(line => line.includes(`Google is unavailable on this host (${reason})`)), `UNSAFE_CAUSE_IN_THE_SERVER_LOG: ${name}`).toBe(true);
  });

  test("google: a host whose gog home is inside its own HOME masks it, and a credentialed maintenance worker built from that list cannot read it", async () => {
    const f = layout();
    const home = join(f.serverHome, "gog-home"); mkdirSync(home, { mode: 0o700 }); chmodSync(home, 0o700);
    writeFileSync(join(home, "keyring.json"), PASSWORD, { mode: 0o600 });
    let status: GoogleAvailabilityStatus | undefined;
    const outcome = await hostedApp(() => ({ HOME: f.serverHome, BRAIN_UI_GOOGLE_HOME: home, BRAIN_UI_GOOGLE_KEYRING_PASSWORD: PASSWORD, BRAIN_UI_GOG_PATH: "/opt/gog/bin/gog" }),
      async app => { status = await app.wsHost.google!.status("ithaca"); });
    expect(served(outcome.frames), "CHAT_SERVED_WITH_A_HOME_INSIDE_THE_SERVER_HOME").toBe(true);
    // Refused for the overlap, whether or not boot masked it: a worker may already have read it.
    expect(status, "HOME_INSIDE_THE_SERVER_HOME_REFUSED").toMatchObject({ state: "unavailable", reason: "home_overlaps_worker_mount" });
    expect(outcome.maskPaths, "HOME_INSIDE_THE_SERVER_HOME_IS_A_WORKER_MASK").toContain(home);
    // Credentialed maintenance binds that HOME back read-only; the launcher lays the masks inside it again.
    const program = `const fs = require("node:fs"); const attempt = f => { try { return f(); } catch { return null; } };
      console.log(JSON.stringify({ read: attempt(() => fs.readFileSync(${JSON.stringify(join(home, "keyring.json"))}, "utf8")), entries: attempt(() => fs.readdirSync(${JSON.stringify(home)})) }));`;
    const run = (maskPaths: readonly string[]) => {
      const result = Bun.spawnSync(workerCommand({ brainPath: f.brain, command: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program], env: { PATH: "/usr/bin:/bin" },
        maintenance: { network: false, credentials: true, home: { path: f.serverHome, overlay: false }, readPaths: [process.execPath], maskPaths } }),
      { env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!) as { read: string | null; entries: string[] | null };
    };
    expect(run(outcome.maskPaths), "APP_MASKS_HIDE_THE_HOME_FROM_CREDENTIALED_MAINTENANCE").toEqual({ read: null, entries: [] });
    // The control: the same worker, without the Google mask, reads the token.
    expect(run(outcome.maskPaths.filter(path => path !== home)).read, "UNMASKED_GOG_HOME_READABLE_CONTROL").toBe(PASSWORD);
  });

  test("google: a host with a good gog home masks it in every worker view and gets past the home to the binary", async () => {
    let status: GoogleAvailabilityStatus | undefined;
    const f = layout();
    const outcome = await hostedApp(() => ({ BRAIN_UI_GOOGLE_HOME: f.home, BRAIN_UI_GOOGLE_KEYRING_PASSWORD: PASSWORD, BRAIN_UI_GOG_PATH: join(f.root, "no-gog") }),
      async app => { status = await app.wsHost.google!.status("ithaca"); });
    expect(served(outcome.frames), "CHAT_SERVED_WITH_A_GOOD_HOME").toBe(true);
    expect(outcome.maskPaths, "GOOD_HOME_IS_A_WORKER_MASK").toContain(f.home);
    expect(status, "GOOD_HOME_REACHES_THE_PIN").toMatchObject({ state: "unavailable", reason: "binary_refused", cause: "binary_missing" });
  });

  test("google: a host boundary's child never holds a google name its caller passed", async () => {
    const f = layout();
    // No worker host: the pre-boundary path runs the command as a host process.
    const boundary = createHostBoundary({ brainPath: f.brain, dbPath: join(f.state, "ui.db"), workerHost: () => ({ ok: false, requirement: "no worker host in this test" }) });
    const env = { PATH: "/usr/bin:/bin", CUSTOM_TOKEN: "ithaca", ...Object.fromEntries(GOOGLE_NAMES.map(name => [name, `${PASSWORD}-${name}`])) };
    // Not Bun: the offline test guard gives every Bun child an empty gog home of its own.
    const result = await boundary.runSync({ argv: ["/usr/bin/env"], env, credentials: false, purpose: "Odysseus reads its environment", timeoutMs: 20_000 });
    expect(result.exitCode, result.stderr).toBe(0);
    const observed = Object.fromEntries(result.stdout.trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    expect(leaked(observed), "HOST_BOUNDARY_CHILD_HOLDS_NO_GOOGLE_NAME").toEqual([]);
    expect(observed.CUSTOM_TOKEN, "HOST_BOUNDARY_CHILD_KEEPS_ITS_OTHER_ENV").toBe("ithaca");
  });
});

describe("google and the cron runner", () => {
  test("google: the runner reads the gog home to mask it, emits it as control configuration, and no job receives a google name", () => {
    const source = { PATH: "/usr/bin:/bin", BRAIN_PATH: "/srv/ithaca/brain", BRAIN_UI_GOOGLE_HOME: " /srv/ithaca/gog ", BRAIN_UI_GOOGLE_KEYRING_PASSWORD: PASSWORD,
      GOG_ACCESS_TOKEN: PASSWORD, BRAIN_UI_SUBPROCESS_ENV_EXTRA: "BRAIN_UI_GOOGLE_HOME,BRAIN_UI_GOOGLE_KEYRING_PASSWORD,GOG_ACCESS_TOKEN" };
    const config = resolveCronConfig(source, ["GOG_ACCESS_TOKEN", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD"]);
    expect(config.googleHome, "CRON_RUNNER_READS_THE_GOG_HOME").toBe("/srv/ithaca/gog");
    expect(leaked(config.childEnv), "CRON_JOB_ENV_HOLDS_NO_GOOGLE_NAME").toEqual([]);
    expect(leaked(config.moduleDiscoveryEnv), "CRON_DISCOVERY_ENV_HOLDS_NO_GOOGLE_NAME").toEqual([]);
    const emitted = emitEnvironment(source, config.subprocessEnvExtraNames);
    expect(emitted, "GOG_HOME_EMITTED_FOR_THE_RUNNER").toContain('BRAIN_UI_GOOGLE_HOME=" /srv/ithaca/gog "\n');
    expect(emitted, "KEYRING_PASSWORD_NEVER_EMITTED").not.toContain(PASSWORD);
    expect(emitted).not.toContain("GOG_");
  });
});
