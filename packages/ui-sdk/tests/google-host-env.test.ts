/**
 * The host-only Google environment (#4206; plan docs/plans/google-workspace.md
 * §10 and §11, "Credential isolation"): no subprocess audience, operator
 * extra or per-spawn addition admits the Google home, its keyring password,
 * the Google ledger or any GOG_*, BRAIN_UI_GOOGLE_* or BRAIN_GOOGLE_* name,
 * and every launch path drops them from what its caller passed, transports
 * included. A real worker shows it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HOST_ONLY_ENV_PREFIXES, HOST_ONLY_SECRET_ENV, SUBPROCESS_ENV, isHostOnlyEnv } from "../src/internal";
import { filterSubprocessEnv, parseSubprocessEnvExtra } from "../src/server";
import { maintenanceLaunch } from "../src/server/maintenance-worker.js";
import { workerCommand, type WorkerLaunch } from "../src/server/worker-launcher.js";

const CANARY = "penelope-unweaves-the-shroud-by-night";
/** The listed names, gog's own names, and unlisted names under each host-only prefix. */
const GOOGLE_NAMES = [
  "BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_GOOGLE_LEDGER", "BRAIN_UI_GOG_PATH",
  "GOG_HOME", "GOG_ACCESS_TOKEN", "GOG_KEYRING_PASSWORD", "GOG_KEYRING_BACKEND", "GOG_ACCOUNT", "GOG_CLIENT", "GOG_TIMEZONE",
  "GOG_ITHACA", "BRAIN_UI_GOOGLE_ITHACA", "BRAIN_GOOGLE_HOME", "BRAIN_GOOGLE_ITHACA",
] as const;
const AUDIENCES = ["cron", "agent", "brainCli"] as const;
const hostEnv = (): Record<string, string> => ({
  PATH: "/usr/bin:/bin", CUSTOM_TOKEN: "ithaca", ...Object.fromEntries(GOOGLE_NAMES.map(name => [name, `${CANARY}-${name}`])),
});
const leaked = (env: Record<string, string | undefined>) => Object.keys(env).filter(name => (GOOGLE_NAMES as readonly string[]).includes(name)
  || HOST_ONLY_ENV_PREFIXES.some(prefix => name.startsWith(prefix)) || String(env[name]).includes(CANARY));

describe("google host-only environment", () => {
  test("google: the credential home, keyring password and ledger are host-only secrets, and the three prefixes host-only names", () => {
    expect(HOST_ONLY_SECRET_ENV, "GOOGLE_HOST_ONLY_NAMES").toEqual(expect.arrayContaining(["BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_GOOGLE_LEDGER"]));
    expect([...HOST_ONLY_ENV_PREFIXES].sort(), "GOOGLE_HOST_ONLY_PREFIXES").toEqual(["BRAIN_GOOGLE_", "BRAIN_UI_GOOGLE_", "GOG_"]);
    for (const name of GOOGLE_NAMES) expect(isHostOnlyEnv(name), `HOST_ONLY: ${name}`).toBe(true);
    // The pinned binary's path is no secret, but no extra may hand a worker the host's gog either.
    expect(isHostOnlyEnv("BRAIN_UI_GOG_PATH"), "GOG_PATH_HOST_ONLY").toBe(true);
    expect(SUBPROCESS_ENV.BRAIN_UI_GOG_PATH, "GOG_PATH_NO_AUDIENCE").toEqual([]);
  });

  test("google: no descriptor entry gives a host-only name an audience", () => {
    const admitted = Object.entries(SUBPROCESS_ENV).filter(([name, audiences]) => isHostOnlyEnv(name) && audiences.length > 0).map(([name]) => name);
    expect(admitted, "HOST_ONLY_DESCRIPTOR_ENTRIES_HAVE_NO_AUDIENCE").toEqual([]);
    for (const name of ["BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_GOOGLE_LEDGER"] as const) expect(SUBPROCESS_ENV[name]).toEqual([]);
  });

  // Every audience, under every way a name can be asked for: not at all, by
  // the operator escape hatch, by a spawn's own addition, and by both.
  const extras: Record<string, (env: Record<string, string>) => string[]> = {
    none: () => [],
    operator: env => parseSubprocessEnvExtra([...GOOGLE_NAMES, "CUSTOM_TOKEN"].join(",")).concat(parseSubprocessEnvExtra(env.BRAIN_UI_SUBPROCESS_ENV_EXTRA)),
    spawn: () => [...GOOGLE_NAMES, "CUSTOM_TOKEN"],
    both: env => [...parseSubprocessEnvExtra(env.BRAIN_UI_SUBPROCESS_ENV_EXTRA), ...GOOGLE_NAMES, "CUSTOM_TOKEN"],
  };
  for (const audience of AUDIENCES) for (const [how, names] of Object.entries(extras)) {
    test(`google: the ${audience} audience admits no google name when ${how === "none" ? "nothing asks" : `the ${how} extra asks`}`, () => {
      const env = { ...hostEnv(), BRAIN_UI_SUBPROCESS_ENV_EXTRA: [...GOOGLE_NAMES, "CUSTOM_TOKEN"].join(",") };
      const filtered = filterSubprocessEnv(env, audience, names(env));
      expect(leaked(filtered), `GOOGLE_NAMES_WITHHELD: ${audience} ${how}`).toEqual([]);
      // The control: the same extra does admit an ordinary name, so the filter was asked.
      expect(filtered.CUSTOM_TOKEN, `ORDINARY_EXTRA_ADMITTED: ${audience} ${how}`).toBe(how === "none" ? undefined : "ithaca");
      expect(filtered.PATH).toBe("/usr/bin:/bin");
    });
  }

  test("google: the operator escape hatch parses to no google name", () => {
    expect(parseSubprocessEnvExtra([...GOOGLE_NAMES, "CUSTOM_TOKEN"].join(",")), "GOOGLE_EXTRA_REFUSED").toEqual(["CUSTOM_TOKEN"]);
  });

  for (const credentials of [true, false]) for (const transport of [false, true]) {
    test(`google: a ${credentials ? "credentialed" : "credential-free"} maintenance${transport ? " transport" : ""} launch drops every google name`, () => {
      const env = hostEnv();
      const launch = maintenanceLaunch({ brainPath: "/odysseus/brain", command: ["/bin/true"], env, credentials, ...(transport ? { transport: { mirror: "/odysseus/mirror.git", readPaths: [] } } : {}) });
      expect(leaked(launch.env), "SDK_MAINTENANCE_GOOGLE_NAMES_ABSENT").toEqual([]);
      if (credentials) expect(launch.env.CUSTOM_TOKEN, "CREDENTIALED_MAINTENANCE_KEEPS_ITS_OTHER_ENV").toBe("ithaca");
      expect(env, "HOST_SOURCE_UNCHANGED").toEqual(hostEnv());
    });
  }
});

describe("google host-only environment in a real worker", () => {
  const ROOT = resolve(import.meta.dir, "../../..");
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function fixture() {
    mkdirSync(join(ROOT, "tmp"), { recursive: true });
    const root = mkdtempSync(join(ROOT, "tmp/odysseus-google-worker-env-")); roots.push(root);
    const brain = join(root, "brain"), mirror = join(root, "mirror");
    mkdirSync(brain); mkdirSync(mirror);
    return { brain, mirror };
  }
  const modes = ["bare", "governed", "strict", "maintenance", "transport"] as const;
  function launch(f: ReturnType<typeof fixture>, mode: typeof modes[number], command: string[]): WorkerLaunch {
    // Raw: what a caller that skipped the filter would pass.
    const common = { brainPath: f.brain, command, env: hostEnv() };
    if (mode === "maintenance") return { ...common, maintenance: { network: false, credentials: true, readPaths: [process.execPath] } };
    if (mode === "transport") return { ...common, transport: { mirror: f.mirror, readPaths: [process.execPath] } };
    if (mode === "bare") return common;
    return { ...common, sandbox: { brain: f.brain, restricted: false, profile: mode, areas: [], scratchAliasesRemoved: [], readPaths: [process.execPath],
      ...(mode === "governed" ? { protection: { paths: [], ancestors: [] } } : {}) } };
  }
  for (const mode of modes) test(`google: a ${mode} worker holds no google name its caller passed`, () => {
    const f = fixture();
    const program = "console.log(JSON.stringify(process.env))";
    const result = Bun.spawnSync(workerCommand(launch(f, mode, [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program])),
      { env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    expect(result.exitCode, `GOOGLE_WORKER_${mode}: ${result.stderr}`).toBe(0);
    const observed = JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!) as Record<string, string>;
    expect(leaked(observed), `REAL_WORKER_GOOGLE_NAMES_ABSENT: ${mode}`).toEqual([]);
    // The control: the launcher did hand the worker its caller's environment.
    expect(observed.CUSTOM_TOKEN, `REAL_WORKER_KEEPS_ORDINARY_ENV: ${mode}`).toBe("ithaca");
  });

  test("google: a worker cannot read a masked gog home inside the server's home it binds, and reads it without the mask", () => {
    // Credentialed maintenance binds the server's home back over the host
    // masks, so a gog home inside it is visible unless its own mask is laid again.
    const f = fixture();
    const serverHome = join(f.brain, "..", "server-home"), home = join(serverHome, "gog-home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "keyring.json"), CANARY, { mode: 0o600 });
    const program = `const fs = require("node:fs"); const attempt = f => { try { return f(); } catch { return null; } };
      console.log(JSON.stringify({ read: attempt(() => fs.readFileSync(${JSON.stringify(join(home, "keyring.json"))}, "utf8")),
        entries: attempt(() => fs.readdirSync(${JSON.stringify(home)})), sibling: attempt(() => fs.readdirSync(${JSON.stringify(serverHome)})) }));`;
    const run = (maskPaths: string[]) => {
      const result = Bun.spawnSync(workerCommand({ brainPath: f.brain, command: [process.execPath, "--config=/dev/null", "--no-env-file", "-e", program], env: { PATH: "/usr/bin:/bin" },
        maintenance: { network: false, credentials: true, home: { path: serverHome, overlay: false }, readPaths: [process.execPath], maskPaths } }),
      { env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!) as { read: string | null; entries: string[] | null; sibling: string[] | null };
    };
    expect(run([home]), "MASKED_GOG_HOME_UNREADABLE").toEqual({ read: null, entries: [], sibling: ["gog-home"] });
    // The control: the same worker, as the same user, reads it when nothing covers it.
    expect(run([]).read, "UNMASKED_GOG_HOME_READABLE_CONTROL").toBe(CANARY);
  });
});
