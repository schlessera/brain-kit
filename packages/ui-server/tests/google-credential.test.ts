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
import { spawn as spawnChild } from "node:child_process";
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GOG_ENVIRONMENT_NAMES, type GogTransport } from "@schlessera/brain-common/internal/google-gog";
import { workerSystemPaths } from "@schlessera/brain-ui-sdk/internal";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { GOG_PIN_RETRY_MS } from "../../common/src/google/gog/transport.ts";
import { failNextRead } from "../../common/tests/support/failing-read.ts";
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
  BRAIN_GOOGLE_DEFAULT_DIR, checkGoogleHome, cronWorkerMaskPaths, GOG_DEFAULT_DIRS, GOOGLE_DEFAULT_DIRS, googleHomeAreas, googleHomeMask, googleHostLayout, googleTempAreas, googleWorkerMasks, googleWorkerMounts,
  type GoogleHomeArea, type GoogleHomeCheck, type GoogleHomeCheckOptions, type GoogleHomeLayout, type GoogleHomeMask, type GoogleHomeReason, type GoogleWorkerMasks,
} from "../src/google/home.js";
import { serverInstallation } from "../src/brain/host-boundary.js";
import { syncTransportCommand } from "../src/brain/sync-mirror.js";
import { createRecordingObservability } from "../src/observability/index.js";
import type { WSContext } from "../src/ws/clients.js";
import { createWsHandlers } from "../src/ws/connection.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { workerCommand } from "../../ui-sdk/src/server/worker-launcher.js";

const ROOT = resolve(import.meta.dir, "../../..");
const LABELS = JSON.parse(readFileSync(join(ROOT, "packages/common/tests/fixtures/gog/labels-list.json"), "utf8"));
const PASSWORD = "penelope-weaves-by-day-and-unweaves-by-night";
const GOOGLE_NAMES = ["BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_GOOGLE_LEDGER", "BRAIN_UI_GOG_PATH", "GOG_HOME", "GOG_ACCESS_TOKEN", "GOG_KEYRING_PASSWORD", "BRAIN_GOOGLE_HOME"] as const;
const GUARD = /^(?:GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|BRAIN_WORKSPACE_LEASE|BUN_OPTIONS)$/;
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

/** The masks boot lays, the home held open as the app holds it, closed when the test ends. */
function heldMasks(home: string | undefined, homeLayout: GoogleHomeLayout): GoogleWorkerMasks {
  const masks = googleWorkerMasks(home, homeLayout, { hold: true });
  cleanups.push(() => masks.close());
  return masks;
}
/** One home's mask, held open, closed when the test ends. */
function heldMask(home: string | undefined, areas: readonly GoogleHomeArea[]): GoogleHomeMask {
  const mask = googleHomeMask(home, areas, { hold: true });
  cleanups.push(() => { if (typeof mask.descriptor === "number") closeSync(mask.descriptor); });
  return mask;
}

function credential(home: string | undefined, homeLayout: GoogleHomeLayout, options: Partial<GoogleCredentialOptions> = {}) {
  const reports: { message: string; status: GoogleAvailabilityStatus }[] = [];
  const google = createGoogleCredential({ env: env(home), layout: homeLayout, masks: options.masks ?? heldMasks(home, homeLayout), transport: { retryDelayMs: 0 },
    report: (message, status) => reports.push({ message, status }), ...options });
  return { google, reports };
}

/**
 * A directory strictly inside a system directory that holds nothing workers
 * bind: not /usr/share itself, which holds /etc/localtime's zone file.
 */
function systemDescendant(): string {
  const areas = googleHomeAreas({ brainPath: "/odysseus-no-brain", workerMounts: googleWorkerMounts(undefined), tempAreas: [] });
  const holdsNone = (path: string) => areas.every(area => area.path !== path && !area.path.startsWith(`${path}/`));
  return readdirSync("/usr/share").sort().map(name => join("/usr/share", name)).find(path => lstatSync(path).isDirectory() && holdsNone(path))!;
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
    // The server's own installation, which every maintenance worker binds back over any mask.
    ["inside an installed package directory", () => join(ROOT, "node_modules", "odysseus-gog-home"), "home_overlaps_worker_mount"],
    ["inside a temp area", f => { const home = join(f.temp, "gog"); mkdirSync(home, { mode: 0o700 }); return home; }, "home_overlaps_temp"],
    ["a symlink into the brain", f => { const target = join(f.brain, ".gog"); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, join(f.root, "linked")); return join(f.root, "linked"); }, "home_overlaps_brain"],
    ["a symlink into a temp area", f => { const target = join(f.temp, "gog"); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, join(f.root, "linked")); return join(f.root, "linked"); }, "home_overlaps_temp"],
    ["through a linked parent into a worker mount", f => { symlinkSync(f.serverHome, join(f.root, "parent")); mkdirSync(join(f.serverHome, "gog"), { mode: 0o700 }); return join(f.root, "parent/gog"); }, "home_overlaps_worker_mount"],
    ["missing", f => join(f.root, "absent"), "home_missing"],
    ["a file", f => { writeFileSync(join(f.root, "file"), "Argos"); return join(f.root, "file"); }, "home_not_directory"],
  ];
  const DEFAULT_INVENTORY = new Set(["inside a system directory", "inside the certificate store a transport binds", "holding the Bun runtime", "under /proc", "inside an installed package directory"]);
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
    const check: GoogleHomeCheck = checkGoogleHome(home, areas, { ...row[3], mask: heldMask(home, areas) });
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
    const mask = heldMask(f.home, areas);
    expect(checkGoogleHome(f.home, areas, { mask }), "GOOD_HOME_PASSES").toEqual({ ok: true, path: f.home });
    expect(checkGoogleHome(link, areas, { mask: heldMask(link, areas) }), "LINKED_HOME_RESOLVED").toEqual({ ok: true, path: f.home });
    const elsewhere = join(f.root, "elsewhere"); mkdirSync(elsewhere, { mode: 0o700 });
    expect(checkGoogleHome(elsewhere, areas, { mask }), "MOVED_HOME_REFUSED").toMatchObject({ ok: false, reason: "home_moved" });
    expect(checkGoogleHome(f.home, areas, { mask: { path: null } }), "UNMASKED_HOME_REFUSED").toMatchObject({ ok: false, reason: "home_moved" });
  });

  test("google: a home missing at boot and created later is refused until a restart, and never becomes available", async () => {
    const f = layout();
    const later = join(f.root, "later");
    const areas = googleHomeAreas(f.homeLayout);
    const mask: GoogleHomeMask = heldMask(later, areas);
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

  test("google: the directory boot held open tells a replacement from a repair, without a restart", () => {
    const f = layout();
    const areas = googleHomeAreas(f.homeLayout);
    const mask = heldMask(f.home, areas);
    expect(typeof mask.descriptor, "BOOT_HOLDS_THE_HOME_OPEN").toBe("number");
    expect(checkGoogleHome(f.home, areas, { mask }), "HELD_HOME_PASSES").toEqual({ ok: true, path: f.home });
    // A mode or owner repair is the same directory: refused while wrong, accepted once right.
    chmodSync(f.home, 0o755);
    expect(checkGoogleHome(f.home, areas, { mask }), "CHMOD_REFUSED_FOR_ITS_MODE").toMatchObject({ ok: false, reason: "home_mode" });
    chmodSync(f.home, 0o700);
    expect(checkGoogleHome(f.home, areas, { mask }), "CHMOD_REPAIR_CLEARS").toEqual({ ok: true, path: f.home });
    // Deleted and made again at the same path, mode and owner: the held descriptor keeps the old inode from being handed to it.
    rmSync(f.home, { recursive: true }); mkdirSync(f.home, { mode: 0o700 }); chmodSync(f.home, 0o700);
    expect(checkGoogleHome(f.home, areas, { mask }), "RECREATED_HOME_REFUSED").toMatchObject({ ok: false, reason: "home_created_after_boot" });
    // A mask nothing holds open cannot tell them apart, so it is never accepted.
    expect(checkGoogleHome(f.home, areas, { mask: googleHomeMask(f.home, areas) }), "UNHELD_MASK_REFUSED").toMatchObject({ ok: false, reason: "home_unresolvable",
      detail: expect.stringContaining("was not held open") });
    const closed = googleWorkerMasks(f.home, f.homeLayout, { hold: true });
    closed.close(); closed.close();
    expect(closed.home.descriptor, "CLOSE_RELEASES_THE_DESCRIPTOR").toBeNull();
    expect(checkGoogleHome(f.home, areas, { mask: closed.home }), "CLOSED_MASK_REFUSED").toMatchObject({ ok: false, reason: "home_unresolvable" });
  });

  /** The open flags the kernel records for one of this process's descriptors. */
  const openFlags = (descriptor: number) => parseInt(/^flags:\s+([0-7]+)$/m.exec(readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8"))![1]!, 8);
  /** Linux's path-only open flag (octal 010000000): a hold that needs no permission on the directory. */
  const O_PATH = 0o10000000;

  test("google: a home the server cannot read at boot (mode 0000) is held, and a repaired mode clears without a restart", async () => {
    const f = layout();
    chmodSync(f.home, 0o000);
    cleanups.push(() => { try { chmodSync(f.home, 0o700); } catch { /* removed already */ } });
    // Boot, as the app does it: the masks hold the home open, then the credential checks it at every use.
    const masks = heldMasks(f.home, f.homeLayout);
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    const { google } = credential(f.home, f.homeLayout, { binary: fake.binary, masks });
    expect(reasonOf(await google.status(alias())), "UNREADABLE_HOME_REFUSED_FOR_ITS_MODE").toBe("home_mode");
    chmodSync(f.home, 0o700);
    expect(reasonOf(await google.status(alias())), "UNREADABLE_AT_BOOT_REPAIR_CLEARS").toBe("available");
    const descriptor = masks.home.descriptor;
    if (typeof descriptor !== "number") throw new Error("UNREADABLE_HOME_HELD");
    expect(`${fstatSync(descriptor).dev}:${fstatSync(descriptor).ino}`, "HELD_DESCRIPTOR_IS_THE_HOME").toBe(`${lstatSync(f.home).dev}:${lstatSync(f.home).ino}`);
    expect(openFlags(descriptor) & O_PATH, "HELD_BY_PATH_ONLY").toBe(O_PATH);
  });

  test("google: a home another user owns at boot is held, and a repaired owner clears without a restart", () => {
    const f = layout();
    const uid = process.getuid!();
    const areas = googleHomeAreas(f.homeLayout);
    // Without root nothing can be chowned, so the server stands for another user (`hostUid`). The kernel
    // refuses that user every open that reads a 0700 home it does not own, and allows a path-only one.
    const real = fs.openSync;
    const spy = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(path) === f.home && typeof flags === "number" && !(flags & O_PATH)) throw Object.assign(new Error(`EACCES: permission denied, open '${f.home}'`), { code: "EACCES" });
      return real(path, flags, mode);
    }) as typeof fs.openSync);
    cleanups.push(() => spy.mockRestore());
    const mask = heldMask(f.home, areas);
    const opens = spy.mock.calls.filter(([path]) => String(path) === f.home).length;
    spy.mockRestore();
    expect(opens, "BOOT_OPENED_THE_HOME").toBe(1);
    expect(checkGoogleHome(f.home, areas, { hostUid: uid + 1, mask }), "FOREIGN_HOME_REFUSED_FOR_ITS_OWNER").toMatchObject({ ok: false, reason: "home_owner" });
    // Repaired: the home is chowned to the user the server runs as.
    expect(checkGoogleHome(f.home, areas, { hostUid: uid, mask }), "FOREIGN_OWNER_REPAIR_CLEARS").toEqual({ ok: true, path: f.home });
    expect(typeof mask.descriptor, "FOREIGN_HOME_HELD").toBe("number");
  });

  test("google: the home boot holds open is close-on-exec, and no child the host spawns holds it", async () => {
    const f = layout();
    const masks = heldMasks(f.home, f.homeLayout);
    const descriptor = masks.home.descriptor;
    if (typeof descriptor !== "number") throw new Error("BOOT_HOLDS_THE_HOME_OPEN");
    const home = lstatSync(f.home), id = `${home.dev}:${home.ino}`;
    expect(`${fstatSync(descriptor).dev}:${fstatSync(descriptor).ino}`, "DESCRIPTOR_IS_THE_HOME").toBe(id);
    // The kernel's own record of the open: O_CLOEXEC (octal 02000000) is set, so no exec carries it.
    expect(openFlags(descriptor) & 0o2000000, "HELD_HOME_IS_CLOSE_ON_EXEC").toBe(0o2000000);
    // Each child lists the device and inode behind every descriptor it holds.
    const scan = 'for f in /proc/$$/fd/*; do stat -L -c %d:%i "$f" 2>/dev/null; done; exit 0';
    const held = (out: string) => out.trim().split("\n").filter(Boolean);
    const viaBun = Bun.spawnSync(["/bin/sh", "-c", scan], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const viaNode = await new Promise<string>((done, fail) => {
      const child = spawnChild("/bin/sh", ["-c", scan], { stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; child.stdout.on("data", chunk => { out += chunk; });
      child.on("error", fail); child.on("close", code => code === 0 ? done(out) : fail(new Error(`scan exited ${code}`)));
    });
    for (const [via, out] of [["Bun.spawn", viaBun.stdout.toString()], ["node:child_process", viaNode]] as const) {
      expect(held(out).length, `CHILD_SCAN_SEES_ITS_DESCRIPTORS: ${via}`).toBeGreaterThanOrEqual(3);
      expect(held(out), `NO_CHILD_HOLDS_THE_HOME: ${via}`).not.toContain(id);
    }
    // The control: handed the descriptor on purpose, the same scan finds the home.
    const handed = Bun.spawnSync(["/bin/sh", "-c", scan], { stdio: ["ignore", "pipe", "pipe", descriptor] });
    expect(held(handed.stdout.toString()), "HANDED_DESCRIPTOR_FOUND_CONTROL").toContain(id);
  });

  test("google: the default temp areas and worker mounts", () => {
    expect(googleTempAreas(), "GOOGLE_TEMP_AREAS").toEqual(expect.arrayContaining([tmpdir(), "/tmp", "/var/tmp", "/dev/shm"]));
    const f = layout();
    const inTemp = mkdtempSync(join(tmpdir(), "odysseus-gog-home-")); chmodSync(inTemp, 0o700);
    cleanups.push(() => rmSync(inTemp, { recursive: true, force: true }));
    const defaults = googleHomeAreas({ brainPath: f.brain });
    expect(checkGoogleHome(inTemp, defaults, { mask: heldMask(inTemp, defaults) }), "DEFAULT_TEMP_REFUSED").toMatchObject({ ok: false, reason: "home_overlaps_temp" });
    // Every host path a worker sees whatever its masks: the server's HOME, the
    // runtime, the server's installation every maintenance worker binds back,
    // and the system paths a transport binds with no mask at all.
    const mounts = googleWorkerMounts("/srv/ithaca/home");
    const installation = serverInstallation();
    expect(installation, "SERVER_INSTALLATION_NAMES_THE_PACKAGE_AND_ITS_MODULES").toEqual(expect.arrayContaining([join(ROOT, "packages/ui-server"), realpathSync(join(ROOT, "node_modules"))]));
    expect(mounts, "WORKER_MOUNTS_NAME_THE_SERVER_HOME_RUNTIME_INSTALLATION_AND_SYSTEM").toEqual([...new Set(["/srv/ithaca/home", RUNTIME, ...installation, ...workerSystemPaths()])]);
    expect(mounts, "WORKER_MOUNTS_HOLD_THE_SYSTEM_PATHS").toEqual(expect.arrayContaining(["/usr", "/bin", "/lib", "/etc/passwd", "/etc/resolv.conf", "/etc/ssl/certs", "/proc", "/dev"]));
    expect(googleWorkerMounts("/"), "A_ROOT_HOME_IS_NO_MOUNT").toEqual([...new Set([RUNTIME, ...installation, ...workerSystemPaths()])]);
    expect(googleHostLayout({ brainPath: f.brain, dbPath: join(f.state, "ui.db"), serverHome: f.serverHome }), "HOST_LAYOUT").toEqual({
      brainPath: f.brain, dbPath: join(f.state, "ui.db"), workerMounts: googleWorkerMounts(f.serverHome), serverHome: f.serverHome });
  });

  test("google: a home inside or holding what the SSH sync transport binds, through any link, is refused and not masked", () => {
    const f = layout();
    // The server's `.ssh` is a link, through another link, to the directory that holds the home.
    const credentials = join(f.root, "ithaca-credentials"), home = join(credentials, "google");
    mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700);
    symlinkSync(credentials, join(f.root, "credentials-link"));
    symlinkSync(join(f.root, "credentials-link"), join(f.serverHome, ".ssh"));
    // An agent socket inside another home.
    const agentHome = join(f.root, "agent-home"); mkdirSync(agentHome, { mode: 0o700 }); chmodSync(agentHome, 0o700);
    writeFileSync(join(agentHome, "agent.sock"), "");
    const transportEnv = { HOME: f.serverHome, SSH_AUTH_SOCK: join(agentHome, "agent.sock") };
    const withTransport = googleHostLayout({ brainPath: f.brain, dbPath: join(f.state, "ui.db"), serverHome: f.serverHome, transportEnv });
    // What the transport binds for an SSH remote comes from the same function as the validation's inventory.
    const command = syncTransportCommand({ brain: f.brain, mirror: join(f.state, "mirror.git"), remote: "git@github.com:odysseus/ithaca.git", env: transportEnv, args: [] });
    expect(command.transport?.readPaths, "SSH_TRANSPORT_BINDS_ITS_READS").toEqual([join(f.serverHome, ".ssh"), join(agentHome, "agent.sock")]);
    expect(withTransport.transportReads, "LAYOUT_LISTS_THE_SSH_READS").toEqual(command.transport?.readPaths);
    const areas = googleHomeAreas(withTransport);
    const alias = join(f.root, "alias"); symlinkSync(credentials, alias);
    for (const [name, configured] of [["the home", home], ["the home through another link", join(alias, "google")]] as const) {
      expect(checkGoogleHome(configured, areas, { mask: heldMask(configured, areas) }), `HOME_INSIDE_THE_LINKED_SSH_REFUSED: ${name}`).toMatchObject({ ok: false, reason: "home_overlaps_worker_mount" });
    }
    expect(checkGoogleHome(agentHome, areas, { mask: heldMask(agentHome, areas) }), "HOME_HOLDING_THE_AGENT_SOCKET_REFUSED").toMatchObject({ ok: false, reason: "home_overlaps_worker_mount" });
    // Refused, and not masked: no mask reaches a transport worker.
    expect(googleWorkerMasks(home, withTransport).paths, "NO_MASK_INSIDE_THE_LINKED_SSH").not.toContain(home);
    // The control: the same homes with no SSH transport in the layout pass, and are masked.
    const without = googleHostLayout({ brainPath: f.brain, dbPath: join(f.state, "ui.db"), serverHome: f.serverHome });
    const plain = googleHomeAreas(without);
    expect(checkGoogleHome(home, plain, { mask: heldMask(home, plain) }), "CONTROL_HOME_PASSES_WITHOUT_THE_TRANSPORT").toEqual({ ok: true, path: home });
    expect(checkGoogleHome(agentHome, plain, { mask: heldMask(agentHome, plain) }), "CONTROL_AGENT_HOME_PASSES_WITHOUT_THE_TRANSPORT").toEqual({ ok: true, path: agentHome });
    expect(googleWorkerMasks(home, without).paths, "CONTROL_HOME_MASKED_WITHOUT_THE_TRANSPORT").toContain(home);
    // A read that does not resolve is bound by no transport, and refuses nothing.
    rmSync(join(f.serverHome, ".ssh")); symlinkSync("loop", join(f.serverHome, "loop")); symlinkSync(join(f.serverHome, "loop"), join(f.serverHome, ".ssh"));
    expect(syncTransportCommand({ brain: f.brain, mirror: join(f.state, "mirror.git"), remote: "git@github.com:odysseus/ithaca.git", env: { HOME: f.serverHome }, args: [] }).transport?.readPaths,
      "UNRESOLVABLE_SSH_NOT_BOUND").toEqual([]);
    const looping = googleHostLayout({ brainPath: f.brain, serverHome: f.serverHome, transportEnv: { HOME: f.serverHome } });
    expect(() => googleHomeAreas(looping), "UNRESOLVABLE_SSH_NEVER_THROWS").not.toThrow();
    expect(googleHomeAreas(looping).filter(area => area.path.includes("/.ssh") || area.path.endsWith("/loop")), "UNRESOLVABLE_SSH_SKIPPED").toEqual([]);
  });

  test("google: the worker mask is the home as it resolves at boot, and only where a mask is safe for every launcher to lay", () => {
    const f = layout();
    const link = join(f.root, "linked-home"); symlinkSync(f.home, link);
    const areas = googleHomeAreas({ ...f.homeLayout, serverHome: f.serverHome, workerMounts: googleWorkerMounts(f.serverHome) });
    expect(areas.filter(area => area.serverHome).map(area => area.path), "ONE_AREA_IS_THE_SERVER_HOME").toEqual([f.serverHome]);
    expect(googleHomeMask(link, areas).path, "MASK_IS_RESOLVED_HOME").toBe(f.home);
    // Mode and owner do not make a mask unsafe: a 0755 home is still covered while its check refuses it.
    chmodSync(f.home, 0o755);
    expect(googleHomeMask(f.home, areas).path, "MASK_FOR_A_WRONG_MODE_HOME").toBe(f.home);
    // Strictly inside the server's HOME, the database directory or another temp area: refused by its check, and covered.
    const inHome = join(f.serverHome, "gog"), inDatabase = join(f.state, "gog"), inTemp = join(f.temp, "gog");
    for (const path of [inHome, inDatabase, inTemp]) mkdirSync(path, { mode: 0o700 });
    expect(googleHomeMask(inHome, areas).path, "MASK_INSIDE_THE_SERVER_HOME").toBe(inHome);
    expect(googleHomeMask(inDatabase, areas).path, "MASK_INSIDE_THE_DATABASE_DIRECTORY").toBe(inDatabase);
    expect(googleHomeMask(inTemp, areas).path, "MASK_INSIDE_A_TEMP_AREA").toBe(inTemp);
    // Strictly inside any other worker mount: a system directory (the one holding the dynamic loader `/bin/sh` needs is one),
    // or the server's installation. The mask would hide part of what every worker runs.
    const inSystem = systemDescendant();
    expect(googleHomeMask(inSystem, areas), "NO_MASK_INSIDE_A_SYSTEM_DIRECTORY").toEqual({ path: null });
    expect(googleHomeMask(join(ROOT, "packages/ui-server/src"), areas), "NO_MASK_INSIDE_THE_SERVER_INSTALLATION").toEqual({ path: null });
    // Only the area flagged as the server's HOME has the exception: the same directory, as a plain worker mount, is no place for a mask.
    const unflagged = googleHomeAreas({ ...f.homeLayout, workerMounts: googleWorkerMounts(f.serverHome) });
    expect(googleHomeMask(inHome, unflagged), "NO_MASK_INSIDE_A_PLAIN_WORKER_MOUNT").toEqual({ path: null });
    expect(googleHomeMask("/usr/share", areas), "NO_MASK_HOLDING_A_FILE_WORKERS_BIND").toEqual({ path: null });
    expect(googleHomeMask(join(f.root, "not-yet"), areas), "NO_MASK_FOR_A_HOME_NOT_CREATED_YET").toEqual({ path: null, absentAtBoot: true });
    writeFileSync(join(f.root, "file"), "Argos");
    expect(googleHomeMask(join(f.root, "file"), areas), "NO_MASK_FOR_A_FILE").toEqual({ path: null, absentAtBoot: true });
    expect(googleHomeMask("/bin/sh", areas), "NO_MASK_FOR_THE_SHELL").toEqual({ path: null });
    // Holding an area: the runtime, a system directory, the server's HOME, the database directory.
    expect(googleHomeMask(dirname(RUNTIME), areas), "NO_MASK_HOLDING_THE_RUNTIME").toEqual({ path: null });
    expect(googleHomeMask("/usr", areas), "NO_MASK_FOR_A_SYSTEM_DIRECTORY").toEqual({ path: null });
    expect(googleHomeMask(f.serverHome, areas), "NO_MASK_AT_THE_SERVER_HOME").toEqual({ path: null });
    expect(googleHomeMask(f.state, areas), "NO_MASK_AT_THE_DATABASE_DIRECTORY").toEqual({ path: null });
    // Below a root every worker replaces with its own: in no worker's view, and a mask under /proc breaks every launch.
    // (/proc and /dev are worker mounts too; /tmp, a temp area elsewhere, is not one in this layout.)
    const inTmp = mkdtempSync("/tmp/odysseus-gog-home-"); cleanups.push(() => rmSync(inTmp, { recursive: true, force: true }));
    expect(googleHomeMask(inTmp, areas), "NO_MASK_UNDER_TMP").toEqual({ path: null });
    expect(googleHomeMask("/proc/self", areas), "NO_MASK_UNDER_PROC").toEqual({ path: null });
    expect(googleHomeMask("/dev/shm", areas), "NO_MASK_UNDER_DEV").toEqual({ path: null });
    // The brain, either way round.
    mkdirSync(join(f.brain, ".gog"));
    expect(googleHomeMask(join(f.brain, ".gog"), areas), "NO_MASK_INSIDE_THE_BRAIN").toEqual({ path: null });
    expect(googleHomeMask(f.root, areas), "NO_MASK_HOLDING_THE_BRAIN").toEqual({ path: null });
    expect(googleHomeMask(undefined, areas)).toEqual({ path: null });
    expect(googleHomeMask("gog-home", areas)).toEqual({ path: null });
  });

  test("google: the default homes under the server's HOME are masked where they are, alongside the configured home", () => {
    const f = layout();
    const homeLayout = { ...f.homeLayout, serverHome: f.serverHome };
    expect(GOG_DEFAULT_DIRS, "GOG_DEFAULT_DIRS").toEqual([".config/gogcli", ".local/share/gogcli", ".local/state/gogcli", ".cache/gogcli"]);
    expect(GOOGLE_DEFAULT_DIRS, "GOOGLE_DEFAULT_DIRS_ADD_THE_STANDALONE_HOME").toEqual([...GOG_DEFAULT_DIRS, ".local/share/brain/google"]);
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
    rmSync(config); mkdirSync(config, { mode: 0o700 });
    // A brain that is the server's HOME, or lies inside it, holds its gog defaults: a mask there would refuse every launch.
    expect(googleWorkerMasks(undefined, { ...homeLayout, brainPath: f.serverHome }).paths, "NO_DEFAULT_MASK_IN_A_BRAIN_AT_HOME").toEqual([]);
    expect(googleWorkerMasks(undefined, { ...homeLayout, brainPath: join(f.serverHome, ".local") }).paths, "NO_DEFAULT_MASK_IN_A_BRAIN_INSIDE_HOME").toEqual([config]);
    expect(googleWorkerMasks(undefined, f.homeLayout).paths).toEqual([]);
  });

  test("google: the standalone default home is masked, and a default home linked elsewhere masks the directory it names", () => {
    const f = layout();
    const homeLayout = { ...f.homeLayout, serverHome: f.serverHome, workerMounts: googleWorkerMounts(f.serverHome) };
    // `brain google`'s own default, as it resolves under HOME.
    const standalone = join(f.serverHome, BRAIN_GOOGLE_DEFAULT_DIR);
    mkdirSync(standalone, { recursive: true, mode: 0o700 });
    expect(googleWorkerMasks(undefined, homeLayout).paths, "STANDALONE_DEFAULT_MASKED").toEqual([standalone]);
    // gog's configuration linked to a directory outside HOME: the target is what gog opens, and root-bound workers see it.
    const target = join(f.root, "ithaca-default-gog"); mkdirSync(target, { mode: 0o700 });
    mkdirSync(join(f.serverHome, ".config"), { recursive: true });
    symlinkSync(target, join(f.serverHome, ".config/gogcli"));
    expect(googleWorkerMasks(undefined, homeLayout).paths, "LINKED_DEFAULT_TARGET_MASKED_OUTSIDE_HOME").toEqual([target, standalone]);
    // A target where no mask is safe gets none: inside a system directory, or the brain.
    rmSync(join(f.serverHome, ".config/gogcli"));
    symlinkSync(systemDescendant(), join(f.serverHome, ".config/gogcli"));
    expect(googleWorkerMasks(undefined, homeLayout).paths, "NO_DEFAULT_MASK_INTO_A_SYSTEM_DIRECTORY").toEqual([standalone]);
    rmSync(join(f.serverHome, ".config/gogcli"));
    symlinkSync(f.brain, join(f.serverHome, ".config/gogcli"));
    expect(googleWorkerMasks(undefined, homeLayout).paths, "NO_DEFAULT_MASK_INTO_THE_BRAIN").toEqual([standalone]);
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
      const probe = createGoogleCredential({ env: google, layout: f.homeLayout, masks: heldMasks(f.home, f.homeLayout), ...(name === "no gog path" ? {} : { binary: fake.binary }) });
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
    // The offline test guard adds its own Git policy, workspace lease and, to a child that is not Bun, BUN_OPTIONS (scripts/test-network-guard.ts).
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
    const missing = createGoogleCredential({ env: env(f.home, { gogPath: join(f.root, "no-gog") }), layout: f.homeLayout, masks: heldMasks(f.home, f.homeLayout) });
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

  /** Holds every connected check at its labels call until released. */
  function gatedConnectedCheck(google: ReturnType<typeof credential>["google"], account: string) {
    const opened = google.transport(account);
    if (!opened.ok) throw new Error(opened.status.detail);
    const steps = opened.transport as Pick<GogTransport, "execute">, execute = steps.execute;
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), atCheck = new Promise<void>(resolve => { reached = resolve; });
    steps.execute = (async (...args: Parameters<GogTransport["execute"]>) => { reached(); await gate; return execute(...args); }) as GogTransport["execute"];
    cleanups.push(() => { release(); steps.execute = execute; });
    return { atCheck, release: () => release(), restore: () => { steps.execute = execute; } };
  }

  test("google: a connected check overtaken by an unavailable answer neither answers available nor stands as the cached success", async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": [{ stdout: LABELS }, { exit: 4, stderr: "no token" }] });
    const account = alias();
    const { google } = credential(f.home, f.homeLayout, { binary: fake.binary });
    const gated = gatedConnectedCheck(google, account);
    const first = google.status(account);
    await gated.atCheck;
    chmodSync(f.home, 0o755);
    expect(reasonOf(await google.status(account)), "REFUSED_WHILE_A_CHECK_RUNS").toBe("home_mode");
    gated.release();
    expect(await first, "OVERTAKEN_CHECK_NOT_AVAILABLE").toMatchObject({ state: "unavailable", reason: "home_mode" });
    expect(fake.calls(), "OVERTAKEN_CHECK_RAN_ONCE").toHaveLength(1);
    gated.restore();
    // Repaired, with the account since disconnected: nothing cached stands in for a new check.
    chmodSync(f.home, 0o700);
    expect(await google.status(account), "REPAIRED_HOME_CHECKS_AGAIN").toMatchObject({ state: "unavailable", reason: "not_connected" });
    expect(fake.calls(), "LABELS_REQUESTED_AGAIN").toHaveLength(2);
  });

  test("google: a call after a refusal runs its own connected check rather than waiting on the one the refusal overtook", async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": [{ stdout: LABELS }, { stdout: LABELS }] });
    const account = alias();
    const { google } = credential(f.home, f.homeLayout, { binary: fake.binary });
    const gated = gatedConnectedCheck(google, account);
    const first = google.status(account);
    await gated.atCheck;
    chmodSync(f.home, 0o755);
    expect(reasonOf(await google.status(account))).toBe("home_mode");
    chmodSync(f.home, 0o700);
    const second = google.status(account);
    gated.release();
    expect(reasonOf(await first), "OVERTAKEN_CHECK_KEEPS_THE_REFUSAL").toBe("home_mode");
    expect(reasonOf(await second), "LATER_CALL_RUNS_ITS_OWN_CHECK").toBe("available");
    expect(fake.calls(), "TWO_CONNECTED_CHECKS").toHaveLength(2);
  });

  // The same race, overtaken through `transport()` rather than `status()`: by a refusal, and by an exception while it opens.
  const overtakers: [name: string, reason: GoogleUnavailableReason, overtake: (f: ReturnType<typeof layout>, hostEnv: GoogleCredentialOptions["env"]) => () => void][] = [
    ["a refused transport", "home_mode", f => { chmodSync(f.home, 0o755); return () => chmodSync(f.home, 0o700); }],
    ["a transport that throws while it opens", "probe_failed", (_f, hostEnv) => {
      const password = hostEnv.keyringPassword;
      hostEnv.keyringPassword = () => { throw new Error("the keyring exploded"); };
      return () => { hostEnv.keyringPassword = password; };
    }],
  ];
  for (const [name, reason, overtake] of overtakers) test(`google: a connected check overtaken by ${name} neither answers available nor stands as the cached success`, async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": [{ stdout: LABELS }, { exit: 4, stderr: "no token" }] });
    const account = alias();
    const hostEnv = env(f.home);
    const { google } = credential(f.home, f.homeLayout, { binary: fake.binary, env: hostEnv });
    const gated = gatedConnectedCheck(google, account);
    const first = google.status(account);
    await gated.atCheck;
    const repair = overtake(f, hostEnv);
    const refused = google.transport(account);
    expect(refused.ok ? "opened" : refused.status.reason, `TRANSPORT_REFUSED_WHILE_A_CHECK_RUNS: ${name}`).toBe(reason);
    gated.release();
    expect(await first, `OVERTAKEN_BY_THE_TRANSPORT_NOT_AVAILABLE: ${name}`).toMatchObject({ state: "unavailable", reason });
    expect(fake.calls(), "OVERTAKEN_CHECK_RAN_ONCE").toHaveLength(1);
    gated.restore();
    // Repaired, with the account since disconnected: the success the overtaken check saw is not cached.
    repair();
    expect(await google.status(account), `TRANSPORT_REFUSAL_LEAVES_NOTHING_CACHED: ${name}`).toMatchObject({ state: "unavailable", reason: "not_connected" });
    expect(fake.calls(), "LABELS_REQUESTED_AGAIN").toHaveLength(2);
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
    const opening = createGoogleCredential({ env: broken, layout: f.homeLayout, masks: heldMasks(f.home, f.homeLayout), binary: fake.binary });
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

  test("google: a pin check that throws answers binary_refused with its transient cause, never a lasting probe_failed, and the pin runs again after its backoff", async () => {
    const f = layout();
    const fake = fakeGog({ "gmail.labels.list": { stdout: LABELS } });
    const account = alias();
    // The real pinned path: production pins, so this fake, once read, is refused as no listed release.
    const { google, reports } = credential(f.home, f.homeLayout, { binary: { kind: "pinned", path: fake.executable } });
    const read = failNextRead(fake.executable);
    cleanups.push(read.restore);
    // The transport's backoff runs on performance.now; this moves it on without waiting.
    const own = Object.getOwnPropertyDescriptor(performance, "now");
    const now = performance.now.bind(performance);
    let shift = 0;
    Object.defineProperty(performance, "now", { configurable: true, enumerable: true, writable: true, value: () => now() + shift });
    cleanups.push(() => { if (own) Object.defineProperty(performance, "now", own); else delete (performance as { now?: unknown }).now; });
    expect(await settled(google.status(account)), "PIN_THROW_IS_TRANSIENT").toEqual(
      { state: "unavailable", reason: "binary_refused", detail: expect.stringContaining("checked again shortly"), cause: "verification_failed" });
    expect(await settled(google.status(account)), "PIN_THROW_STANDS_DURING_THE_BACKOFF").toMatchObject({ reason: "binary_refused", cause: "verification_failed" });
    expect(read.reads(), "NOT_CHECKED_AGAIN_DURING_THE_BACKOFF").toBe(1);
    shift += GOG_PIN_RETRY_MS;
    expect(await settled(google.status(account)), "PIN_CHECKED_AGAIN_AFTER_THE_BACKOFF").toMatchObject({ reason: "binary_refused", cause: "hash_not_pinned",
      detail: expect.stringContaining("not a gog release this host accepts") });
    expect(read.reads(), "THE_BINARY_WAS_READ_AGAIN").toBeGreaterThan(1);
    expect(fake.calls(), "UNPINNED_BINARY_NEVER_ANSWERED").toEqual([]);
    for (const report of reports) expect(report.message, "REPORT_HOLDS_NO_EXCEPTION_TEXT").not.toMatch(/EIO|fake-gog-/);
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
    ["a directory inside a system directory", () => systemDescendant(), "home_overlaps_worker_mount"],
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

  test("google: a host with a good gog home masks it in every worker view, gets past the home to the binary, and releases the home on close", async () => {
    let status: GoogleAvailabilityStatus | undefined;
    let whileServing: string[] = [];
    const f = layout();
    /** This process's descriptors open on the home. */
    const holding = () => readdirSync("/proc/self/fd").filter(fd => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`) === f.home; } catch { return false; } });
    const outcome = await hostedApp(() => ({ BRAIN_UI_GOOGLE_HOME: f.home, BRAIN_UI_GOOGLE_KEYRING_PASSWORD: PASSWORD, BRAIN_UI_GOG_PATH: join(f.root, "no-gog") }),
      async app => { status = await app.wsHost.google!.status("ithaca"); whileServing = holding(); });
    expect(served(outcome.frames), "CHAT_SERVED_WITH_A_GOOD_HOME").toBe(true);
    expect(outcome.maskPaths, "GOOD_HOME_IS_A_WORKER_MASK").toContain(f.home);
    expect(status, "GOOD_HOME_REACHES_THE_PIN").toMatchObject({ state: "unavailable", reason: "binary_refused", cause: "binary_missing" });
    expect(whileServing, "APP_HOLDS_THE_HOME_WHILE_SERVING").toHaveLength(1);
    expect(holding(), "APP_CLOSE_RELEASES_THE_HOME").toEqual([]);
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

describe("google masks under a separate worker identity", () => {
  test("google: with a separate worker identity, a home no worker can reach gets no mask and every launch plan stands, and a reachable one is masked", () => {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    const root = realpathSync(mkdtempSync(join(ROOT, "tmp/odysseus-google-identity-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    // The helper the launcher qualifies: root-owned inside the namespace, where this user is root. Nothing runs it.
    const helper = join(root, "identity-helper");
    writeFileSync(helper, "#!/bin/sh\nexit 1\n"); chmodSync(helper, 0o755);
    const result = Bun.spawnSync([Bun.which("bwrap")!, "--unshare-user", "--uid", "0", "--gid", "0", "--unshare-net", "--die-with-parent",
      "--ro-bind", "/", "/", "--tmpfs", "/opt", "--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev",
      "--setenv", "HOME", "/opt/server-home", "--setenv", "TMPDIR", "/tmp", "--setenv", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0",
      "--setenv", "BRAIN_UI_WORKER_IDENTITY_HELPER", helper,
      "--", process.execPath, "--config=/dev/null", "--no-env-file", join(import.meta.dir, "fixtures/google-identity-masks.ts")],
    { env: { PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    type Plan = { ok: true; tmpfs: string[] } | { ok: false; error: string };
    type Boot = { home: string; masks: string[]; unreachable: boolean; held: boolean; check: GoogleHomeCheck; plan: Plan; control: Plan };
    const seen = JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!) as { uid: number; closed: Boot; open: Boot; reopened: GoogleHomeCheck };
    expect(seen.uid, "NAMESPACE_ROOT_IS_THE_SERVER").toBe(0);
    // Brain and home under a server-owned 0700 directory: no worker can reach the home, so no mask, and the launch plan stands.
    expect(seen.closed.masks, "NO_MASK_FOR_AN_UNREACHABLE_HOME").not.toContain(seen.closed.home);
    expect(seen.closed.unreachable, "UNREACHABLE_HOME_MARKED").toBe(true);
    expect(seen.closed.check, "UNREACHABLE_HOME_PASSES_ITS_CHECK").toEqual({ ok: true, path: seen.closed.home });
    expect(seen.closed.plan, "LAUNCH_PLAN_STANDS_WITHOUT_THE_UNREACHABLE_MASK").toMatchObject({ ok: true });
    // The control: with that mask the launcher widens it over the brain and refuses the launch.
    expect(seen.closed.control, "CONTROL_WIDENED_MASK_REFUSED").toEqual({ ok: false, error: expect.stringContaining("a private mask ancestor overlaps the brain or required runtime") });
    // A searchable chain: the home is masked and the launcher covers exactly it.
    expect(seen.open.masks, "MASK_FOR_A_REACHABLE_HOME").toContain(seen.open.home);
    expect(seen.open.check, "REACHABLE_HOME_PASSES_ITS_CHECK").toEqual({ ok: true, path: seen.open.home });
    expect(seen.open.plan.ok && seen.open.plan.tmpfs, "LAUNCH_PLAN_COVERS_THE_REACHABLE_HOME").toContain(seen.open.home);
    // The default homes follow the same rule: gog's configuration is reachable and masked, its data behind a 0700 directory is not.
    for (const booted of [seen.closed, seen.open]) {
      expect(booted.masks, "REACHABLE_DEFAULT_MASKED").toContain("/opt/server-home/.config/gogcli");
      expect(booted.masks, "NO_MASK_FOR_AN_UNREACHABLE_DEFAULT").not.toContain("/opt/server-home/.local/share/gogcli");
    }
    expect(seen.open.plan.ok && seen.open.plan.tmpfs, "LAUNCH_PLAN_COVERS_THE_REACHABLE_DEFAULT").toContain("/opt/server-home/.config/gogcli");
    // Opened to the worker identity after boot: the unmasked home is refused until a restart.
    expect(seen.reopened, "REOPENED_HOME_REFUSED").toMatchObject({ ok: false, reason: "home_moved", detail: expect.stringContaining("no longer behind a directory workers cannot pass") });
  });
});

describe("google and the cron runner", () => {
  test("google: the runner masks the gog home and the default homes in every job's worker view, as the server does", () => {
    const f = layout();
    const data = join(f.serverHome, ".local/share/gogcli"); mkdirSync(data, { recursive: true, mode: 0o700 });
    const source = { PATH: "/usr/bin:/bin", HOME: f.serverHome, BRAIN_PATH: f.brain, DB_PATH: join(f.state, "ui.db"), BRAIN_UI_GOOGLE_HOME: ` ${f.home} ` };
    const config = resolveCronConfig(source);
    // The list the runner hands its host execution: the native manager's private paths, then the Google masks.
    const paths = cronWorkerMaskPaths(config, ["/odysseus/native-private"]);
    expect(paths, "CRON_RUNNER_MASKS_THE_GOG_HOME_AND_DEFAULTS").toEqual(["/odysseus/native-private", f.home, data]);
    expect(paths, "CRON_RUNNER_MASKS_MATCH_THE_SERVER").toEqual(["/odysseus/native-private",
      ...googleWorkerMasks(f.home, googleHostLayout({ brainPath: f.brain, dbPath: join(f.state, "ui.db"), serverHome: f.serverHome })).paths]);
  });

  test("google: the runner reads the gog home, emits it as control configuration, and no job receives a google name", () => {
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
