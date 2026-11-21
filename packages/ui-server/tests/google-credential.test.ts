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
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GOG_ENVIRONMENT_NAMES } from "@schlessera/brain-common/internal/google-gog";
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
  checkGoogleHome, googleHomeAreas, googleHomeMask, googleTempAreas, googleWorkerMounts,
  type GoogleHomeCheck, type GoogleHomeCheckOptions, type GoogleHomeLayout, type GoogleHomeReason,
} from "../src/google/home.js";
import { createRecordingObservability } from "../src/observability/index.js";
import type { WSContext } from "../src/ws/clients.js";
import { createWsHandlers } from "../src/ws/connection.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";

const ROOT = resolve(import.meta.dir, "../../..");
const LABELS = JSON.parse(readFileSync(join(ROOT, "packages/common/tests/fixtures/gog/labels-list.json"), "utf8"));
const PASSWORD = "penelope-weaves-by-day-and-unweaves-by-night";
const GOOGLE_NAMES = ["BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_GOOGLE_LEDGER", "GOG_HOME", "GOG_ACCESS_TOKEN", "GOG_KEYRING_PASSWORD", "BRAIN_GOOGLE_HOME"] as const;
const GUARD = /^(?:GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)|BRAIN_WORKSPACE_LEASE)$/;
const leaked = (env: Record<string, string | undefined>) => Object.keys(env).filter(name => /^(GOG_|BRAIN_UI_GOOGLE_|BRAIN_GOOGLE_)/.test(name) || String(env[name]).includes(PASSWORD));

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
    ["inside a temp area", f => { const home = join(f.temp, "gog"); mkdirSync(home, { mode: 0o700 }); return home; }, "home_overlaps_temp"],
    ["a symlink into the brain", f => { const target = join(f.brain, ".gog"); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, join(f.root, "linked")); return join(f.root, "linked"); }, "home_overlaps_brain"],
    ["a symlink into a temp area", f => { const target = join(f.temp, "gog"); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, join(f.root, "linked")); return join(f.root, "linked"); }, "home_overlaps_temp"],
    ["through a linked parent into a worker mount", f => { symlinkSync(f.serverHome, join(f.root, "parent")); mkdirSync(join(f.serverHome, "gog"), { mode: 0o700 }); return join(f.root, "parent/gog"); }, "home_overlaps_worker_mount"],
    ["missing", f => join(f.root, "absent"), "home_missing"],
    ["a file", f => { writeFileSync(join(f.root, "file"), "Argos"); return join(f.root, "file"); }, "home_not_directory"],
  ];
  // "holding a worker mount" needs the worker mount below it.
  const prepared = (row: Row, f: ReturnType<typeof layout>) => {
    if (row[0] === "holding a worker mount") return { ...f, homeLayout: { ...f.homeLayout, workerMounts: [join(f.root, "outer/server-home")] } };
    return f;
  };

  for (const row of rows) test(`google: a home ${row[0]} is refused as ${row[2]}, and Google answers unavailable with it`, async () => {
    const f = prepared(row, layout());
    const home = row[1](f);
    const check: GoogleHomeCheck = checkGoogleHome(home, googleHomeAreas(f.homeLayout), { ...row[3], masked: googleHomeMask(home, f.brain) ?? null });
    expect(check.ok ? "ok" : check.reason, `HOME_CHECK: ${row[0]}`).toBe(row[2]);
    if (!check.ok) expect(check.detail, "DETAIL_NAMES_THE_SETTING_NOT_THE_PATH").toStartWith("BRAIN_UI_GOOGLE_HOME ");
    if (!check.ok && home) expect(check.detail).not.toContain(f.root);
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
    expect(checkGoogleHome(f.home, areas, { masked: f.home }), "GOOD_HOME_PASSES").toEqual({ ok: true, path: f.home });
    expect(checkGoogleHome(link, areas, { masked: googleHomeMask(link, f.brain)! }), "LINKED_HOME_RESOLVED").toEqual({ ok: true, path: f.home });
    const elsewhere = join(f.root, "elsewhere"); mkdirSync(elsewhere, { mode: 0o700 });
    expect(checkGoogleHome(elsewhere, areas, { masked: f.home }), "MOVED_HOME_REFUSED").toMatchObject({ ok: false, reason: "home_moved" });
    expect(checkGoogleHome(f.home, areas, { masked: null }), "UNMASKED_HOME_REFUSED").toMatchObject({ ok: false, reason: "home_moved" });
  });

  test("google: the default temp areas are the process temp directory and the shared temp roots", () => {
    expect(googleTempAreas(), "GOOGLE_TEMP_AREAS").toEqual(expect.arrayContaining([tmpdir(), "/tmp", "/var/tmp", "/dev/shm"]));
    const f = layout();
    const inTemp = mkdtempSync(join(tmpdir(), "odysseus-gog-home-")); chmodSync(inTemp, 0o700);
    cleanups.push(() => rmSync(inTemp, { recursive: true, force: true }));
    const defaults = googleHomeAreas({ brainPath: f.brain });
    expect(checkGoogleHome(inTemp, defaults, { masked: realpathSync(inTemp) }), "DEFAULT_TEMP_REFUSED").toMatchObject({ ok: false, reason: "home_overlaps_temp" });
    expect(googleWorkerMounts("/srv/ithaca/home"), "WORKER_MOUNTS_NAME_THE_SERVER_HOME_AND_RUNTIME")
      .toEqual(["/srv/ithaca/home", dirname(realpathSync(process.execPath))]);
    expect(googleWorkerMounts("/"), "A_ROOT_HOME_IS_NO_MOUNT").toEqual([dirname(realpathSync(process.execPath))]);
  });

  test("google: the worker mask is the home as it resolves at boot, and none for a home in the brain", () => {
    const f = layout();
    const link = join(f.root, "linked-home"); symlinkSync(f.home, link);
    expect(googleHomeMask(link, f.brain), "MASK_IS_RESOLVED_HOME").toBe(f.home);
    expect(googleHomeMask(join(f.root, "not-yet"), f.brain), "MASK_FOR_A_HOME_NOT_CREATED_YET").toBe(join(f.root, "not-yet"));
    expect(googleHomeMask(join(f.brain, ".gog"), f.brain), "NO_MASK_INSIDE_THE_BRAIN").toBeUndefined();
    expect(googleHomeMask(f.root, f.brain), "NO_MASK_HOLDING_THE_BRAIN").toBeUndefined();
    expect(googleHomeMask(undefined, f.brain)).toBeUndefined();
    expect(googleHomeMask("gog-home", f.brain)).toBeUndefined();
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

describe("google and the host", () => {
  /** A real app on the fixture native manager, with a fake backend whose one turn runs `script`. */
  async function hostedApp(google: (paths: { root: string; brain: string }) => Record<string, string>,
    script: (app: Awaited<ReturnType<typeof createApp>>) => Promise<void>) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "odysseus-host-google-"))), brain = join(root, "brain");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    await createFixtureBrain(ROOT, brain);
    const names = ["BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_UI_GOG_PATH"] as const;
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    Object.assign(process.env, google({ root, brain }));
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
      for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
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
