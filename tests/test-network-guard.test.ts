/** Real isolated test/runtime processes, with native sentinels under the guard. */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { experimentRunArgv } from "../scripts/test-experiments";
import { isolateGogEnvironment } from "../scripts/test-network-guard";

const ROOT = join(import.meta.dir, "..");
const sentinel = join(import.meta.dir, "helpers/network-sentinels.ts");
const probe = join(import.meta.dir, "helpers/network-probe.ts");
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

async function run(scenario: string, entry: "direct" | "targeted" | "full" | "package" | "experiments" = "direct", packageDir = ROOT, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "network-guard-"));
  try {
    // An explicit offline harness: this alias is intentionally outside the
    // guard's recognized Bun commands. Every test process loads sentinels
    // before its guard. node:child_process alone is not a bypass under Bun,
    // where it delegates to the patched Bun.spawn.
    const probeRuntime = join(dir, "probe-runtime");
    symlinkSync(process.execPath, probeRuntime);
    const configFile = join(packageDir, "bunfig.toml");
    const config = (existsSync(configFile) ? Bun.TOML.parse(readFileSync(configFile, "utf8")) : {}) as { test?: { preload?: string[] } };
    const configured = entry === "direct" || entry === "package" ? (config.test?.preload ?? []).map((file) => join(packageDir, file)) : [];
    // Direct commands exercise the actual bunfig configuration. Wrapper
    // probes have only sentinels configured, so they prove its CLI preload.
    writeFileSync(join(dir, "bunfig.toml"), `[test]\npreload = ${JSON.stringify([sentinel, ...configured])}\n`);
    writeFileSync(join(dir, "probe.test.ts"), `import { test } from "bun:test";\nimport { runProbe } from ${JSON.stringify(probe)};\ntest(${JSON.stringify(scenario)}, () => runProbe(${JSON.stringify(scenario === "mock-files" ? "partial" : scenario)}));\n`);
    if (scenario === "mock-files") {
      writeFileSync(join(dir, "mocks.test.ts"), `import {test} from "bun:test"; import {runProbe} from ${JSON.stringify(probe)}; test("restore mocks in another file", () => runProbe("restore-only"));`);
    }
    // A controlled Bun wrapper puts sentinels below any propagated preload.
    // Losing child propagation still cannot contact the internet.
    const fixtureBun = join(dir, "bun");
    writeFileSync(fixtureBun, `#!/bin/sh\ncase "$1" in\n  test|run) subcommand="$1"; shift; exec ${shellQuote(process.execPath)} "$subcommand" --preload ${shellQuote(sentinel)} "$@" ;;\n  *) exec ${shellQuote(process.execPath)} --preload ${shellQuote(sentinel)} "$@" ;;\nesac\n`);
    chmodSync(fixtureBun, 0o755);
    // The experiment tier's own run (scripts/test-experiments.ts), minus the
    // runtime, which is the probe alias here.
    const args = entry === "package" ? ["run", "test"] : entry === "direct" ? ["test", ...(scenario === "mock-files" ? ["./mocks.test.ts"] : []), "./probe.test.ts", "--timeout", "30000"] :
      entry === "experiments" ? experimentRunArgv(join(dir, "junit.xml")).slice(1) :
      [join(ROOT, "scripts/test.ts"), ...(entry === "targeted" ? ["./probe.test.ts"] : []), "--timeout", "30000"];
    if (entry === "full" || entry === "package" || entry === "experiments") {
      const { mkdirSync, renameSync } = await import("node:fs");
      const where = entry === "experiments" ? "experiments" : "tests";
      mkdirSync(join(dir, where));
      renameSync(join(dir, "probe.test.ts"), join(dir, where, "probe.test.ts"));
    }
    if (entry === "package") {
      const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: manifest.scripts.test } }));
    }
    const child = spawn(probeRuntime, args, { cwd: dir,
      env: { ...extraEnv, PATH: process.env.PATH!, PROBE_BUN: fixtureBun, PROBE_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    const calls = [...output.matchAll(/NATIVE_CALLS=(\[[^\n]*\])/g)].map((match) => JSON.parse(match[1]!) as string[]);
    return { code, output, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("offline test guard", () => {
  const packageManifests = [...new Bun.Glob("packages/*/package.json").scanSync({ cwd: ROOT })];
  test("package entry-point probes have workspace packages to cover", () => expect(packageManifests.length).toBeGreaterThan(0));
  for (const file of packageManifests) {
    test(`${dirname(file)} test command loads its guard`, async () => {
      const result = await run("partial", "package", join(ROOT, dirname(file)));
      expect(result.calls.length, result.output).toBeGreaterThan(0);
      expect(result.calls.flat(), result.output).toEqual([]);
      expect(result.output).toContain("Offline test guard");
      expect(result.code).not.toBe(0);
    });
  }
  for (const scenario of ["net-connect", "net-forms", "tls-forms", "bun-connect", "socket-exit-zero", "socket-mocks",
    "partial", "robots", "proxy", "curl-forms", "gog-forms", "hosts", "retries", "exit-zero", "mocks", "mock-files", "redirect"]) {
    test(`${scenario} fails despite caught errors without dispatching native transport`, async () => {
      const result = await run(scenario);
      expect(result.calls.length, result.output).toBeGreaterThan(0);
      expect(result.calls.flat(), result.output).toEqual([]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("Offline test guard");
      expect(result.output).toContain(scenario === "curl-forms" ? "curl" : scenario === "gog-forms" ? "gog version" : "escape.example.invalid");
      if (scenario === "mock-files") expect(result.output).toContain("(pass) restore mocks in another file");
      if (scenario === "gog-forms") {
        for (const label of ["stand-in", "true", "elsewhere", "impostor"]) expect(result.output).toContain(`GOG_REGISTRATION=${label}:refused`);
      }
    });
  }
  test("a gog form the guard cannot see still finds no account: no inherited GOG_* name, an empty private GOG_HOME, the file keyring", async () => {
    const planted = {
      GOG_ACCESS_TOKEN: "ya29.suitor-probe", GOG_ACCOUNT: "suitor@example.com", GOG_CLIENT: "suitors", GOG_KEYRING_PASSWORD: "suitors-feast",
      GOG_KEYRING_BACKEND: "auto", GOG_AUTH_MODE: "adc", GOG_HOME: "/srv/ithaca/gog", GOG_CONFIG_DIR: "/srv/ithaca/gog-config", GOG_DATA_DIR: "/srv/ithaca/gog-data",
    };
    const result = await run("gog-environment", "direct", ROOT, planted);
    const report = /GOG_ENV=(\{[^\n]*\})/.exec(result.output);
    expect(report, result.output).not.toBeNull();
    const seen = JSON.parse(report![1]!) as { gog: Record<string, string>; home: unknown };
    // The stand-in ran: shell quoting is outside token matching. It got nothing it could use.
    expect(result.output).toContain("GOG_ENV_EXIT=0");
    expect(Object.keys(seen.gog).sort(), result.output).toEqual(["GOG_HOME", "GOG_KEYRING_BACKEND"]);
    expect(seen.gog.GOG_KEYRING_BACKEND).toBe("file");
    expect(seen.gog.GOG_HOME).not.toBe(planted.GOG_HOME);
    expect(seen.home).toEqual({ dir: true, entries: 0, mode: "700", uid: process.getuid!() });
    // The test process made that home and removed it when it ended.
    expect(existsSync(seen.gog.GOG_HOME!)).toBe(false);
    expect(result.code, result.output).toBe(0);
  });
  test("a guarded child reuses its test process's gog home, so one killed with SIGKILL leaves no home behind", async () => {
    const temp = mkdtempSync(join(tmpdir(), "network-guard-tmp-"));
    try {
      const result = await run("gog-home-descendants", "direct", ROOT, { TMPDIR: temp });
      const report = /GOG_HOMES=(\{[^\n]*\})/.exec(result.output);
      expect(report, result.output).not.toBeNull();
      const seen = JSON.parse(report![1]!) as { own: string; children: unknown[]; own_after: boolean };
      expect(seen.own.startsWith(`${temp}/`), seen.own).toBe(true);
      // Inherited or replaced environment, killed or not: one home, the test process's own.
      expect(seen.children).toEqual([
        { home: seen.own, signal: "SIGKILL", exit: null },
        { home: seen.own, signal: "SIGKILL", exit: null },
        { home: seen.own, signal: null, exit: 0 },
      ]);
      // A child that ends normally leaves it to its maker, which removed it when it ended.
      expect(seen.own_after).toBe(true);
      expect(readdirSync(temp).filter(name => name.startsWith("brain-test-gog-"))).toEqual([]);
      expect(result.code, result.output).toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
  test("a test process started with the host's Google settings holds none of them, nor do its Bun and shell children, while an ordinary variable reaches all three", async () => {
    const planted = {
      BRAIN_UI_GOOGLE_HOME: "/srv/ithaca/gog", BRAIN_UI_GOOGLE_KEYRING_PASSWORD: "suitors-feast", BRAIN_UI_GOG_PATH: "/srv/ithaca/bin/gog",
      BRAIN_GOOGLE_LEDGER: "/srv/ithaca/google-ledger.sqlite", ODYSSEUS_VOYAGE: "ithaca",
    };
    const result = await run("google-host-environment", "direct", ROOT, planted);
    const report = /GOOGLE_HOST_ENV=(\{[^\n]*\})/.exec(result.output);
    expect(report, result.output).not.toBeNull();
    expect(JSON.parse(report![1]!), "HOST_GOOGLE_SETTINGS_DROPPED_ORDINARY_KEPT").toEqual({ own: ["ODYSSEUS_VOYAGE"], bun: ["ODYSSEUS_VOYAGE"], shell: ["ODYSSEUS_VOYAGE"] });
    expect(result.code, result.output).toBe(0);
  });
  test("a shell child given a product-filtered environment, which drops GOG_HOME, resolves gog's directories only under the guard's empty ones and the test HOME, with the file keyring", async () => {
    // A desktop session's environment: XDG bases on the host and a D-Bus session bus.
    const planted = {
      XDG_CONFIG_HOME: "/srv/ithaca/xdg-config", XDG_DATA_HOME: "/srv/ithaca/xdg-data", XDG_STATE_HOME: "/srv/ithaca/xdg-state", XDG_CACHE_HOME: "/srv/ithaca/xdg-cache",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/srv/ithaca/bus", GOG_HOME: "/srv/ithaca/gog",
    };
    const result = await run("gog-filtered-environment", "direct", ROOT, planted);
    const report = /GOG_FILTERED=(\{[^\n]*\})/.exec(result.output);
    expect(report, result.output).not.toBeNull();
    type Report = { gog: string[]; home: string | null; xdg: Record<string, string | null>; dirs: Record<string, string>; entries: Record<string, number | null>; keyring: string };
    const seen = JSON.parse(report![1]!) as { guard: string; home: string; filtered: string[]; reports: Record<string, Report | null> };
    const guard = dirname(seen.guard);
    // The filter is not what protects the child: it hands it HOME and XDG_CONFIG_HOME.
    expect(seen.filtered, "FILTER_PASSES_HOME_AND_XDG_CONFIG_HOME").toEqual(expect.arrayContaining(["HOME", "XDG_CONFIG_HOME"]));
    expect(Object.keys(seen.reports).sort(), result.output).toEqual(["bun-shell", "bun-spawn", "child-process"]);
    for (const [label, got] of Object.entries(seen.reports)) {
      expect(got, `GOG_STAND_IN_RAN: ${label}`).not.toBeNull();
      expect(JSON.stringify(got), `NO_HOST_DIRECTORY_REACHES_GOG: ${label}`).not.toContain("/srv/ithaca");
      expect({ gog: got!.gog, home: got!.home, xdg: got!.xdg, keyring: got!.keyring }, `FILTERED_CHILD_ENVIRONMENT: ${label}`).toEqual({
        gog: [], home: seen.home, keyring: "file",
        xdg: { XDG_CONFIG_HOME: join(guard, "xdg/config"), XDG_DATA_HOME: null, XDG_STATE_HOME: null, XDG_CACHE_HOME: null },
      });
      expect(got!.dirs, `GOG_DIRECTORIES: ${label}`).toEqual({
        config: join(guard, "xdg/config/gogcli"), data: join(seen.home, ".local/share/gogcli"),
        state: join(seen.home, ".local/state/gogcli"), cache: join(seen.home, ".cache/gogcli"),
      });
      expect(got!.entries, `GOG_DIRECTORIES_ABSENT: ${label}`).toEqual({ config: null, data: null, state: null, cache: null });
    }
    expect(result.code, result.output).toBe(0);
  });
  for (const scenario of ["local-sockets", "local-tls", "local", "local-unix", "manual", "redirect-error"]) {
    test(`${scenario} retains real loopback fixture behavior`, async () => {
      const result = await run(scenario);
      expect(result.calls.length).toBeGreaterThan(0);
      expect(result.calls.flat()).toEqual([]);
      expect(result.code, result.output).toBe(0);
    });
  }
  for (const scenario of ["child-async", "child-object", "child-sync", "child-test"]) {
    test(`${scenario} propagates the guard with a replaced environment and cwd`, async () => {
      const result = await run(scenario);
      expect(result.calls.length, result.output).toBe(2);
      expect(result.calls.flat()).toEqual([]);
      expect(result.output).toContain("Offline test guard");
      // The child fails, and its parent asserts that failure as test evidence.
      expect(result.code, result.output).toBe(0);
    });
  }

  test("intentional measurement clients capture 410/403 outside test mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "network-measurement-"));
    try {
      const script = join(dir, "measure.ts");
      const probeRuntime = join(dir, "probe-runtime");
      symlinkSync(process.execPath, probeRuntime);
      writeFileSync(script, `
        if (globalThis.fetch.name === "offlineFetch") throw new Error("guard loaded outside tests");
        const calls = [];
        globalThis.fetch = async (input) => {
          const url = input instanceof Request ? input.url : String(input);
          calls.push(url);
          return new Response("fixture response", { status: url.endsWith("/gone") ? 410 : 403 });
        };
        const { TeeingClient } = await import(${JSON.stringify(join(ROOT, "packages/module-jobs/scripts/measure-boards.ts"))});
        const client = new TeeingClient({ respectRobots: false, defaultDelayMs: 0 });
        for (const path of ["gone", "denied"]) await client.getText("https://measurement.example.invalid/" + path, { retries: 0 }).catch(() => {});
        console.log(JSON.stringify({ calls, captures: client.captures }));
      `);
      const child = spawn(probeRuntime, [script], { cwd: ROOT, env: { PATH: process.env.PATH! }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let error = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { error += data; });
      const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      expect(code, error).toBe(0);
      const result = JSON.parse(output);
      expect(result.calls).toHaveLength(2);
      expect(result.captures.map((capture: { status: number; body: string }) => [capture.status, capture.body]))
        .toEqual([[410, "fixture response"], [403, "fixture response"]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  for (const entry of ["targeted", "full", "experiments"] as const) {
    test(`${entry} repository test entry point loads the guard`, async () => {
      const result = await run("partial", entry);
      expect(result.calls.length, result.output).toBeGreaterThan(0);
      expect(result.calls.flat()).toEqual([]);
      expect(result.output).toContain("Offline test guard");
      expect(result.code).not.toBe(0);
    });
  }
});

describe("the guard's gog home", () => {
  test("a descendant's guard reuses the home its test process made, and only the maker removes it", () => {
    const parent = mkdtempSync(join(tmpdir(), "network-guard-home-"));
    try {
      const made = isolateGogEnvironment({ GOG_ACCOUNT: "suitor@example.com" }, parent);
      const env: Record<string, string | undefined> = { GOG_HOME: made.home, GOG_ACCESS_TOKEN: "ya29.suitor-probe" };
      const reused = isolateGogEnvironment(env, parent);
      expect(reused.home).toBe(made.home);
      expect(env).toEqual({ GOG_HOME: made.home, GOG_KEYRING_BACKEND: "file" });
      reused.dispose();
      expect(existsSync(made.home)).toBe(true);
      made.dispose();
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("the test process drops every host-only name and points each XDG base it inherited at an empty directory of its own; a descendant keeps what a test gave it", () => {
    const parent = mkdtempSync(join(tmpdir(), "network-guard-home-"));
    try {
      const host: Record<string, string | undefined> = {
        BRAIN_UI_GOOGLE_HOME: "/srv/ithaca/gog", BRAIN_UI_GOOGLE_KEYRING_PASSWORD: "suitors-feast", BRAIN_UI_GOG_PATH: "/srv/ithaca/bin/gog",
        BRAIN_GOOGLE_LEDGER: "/srv/ithaca/google-ledger.sqlite", BRAIN_UI_GOOGLE_ITHACA: "suitors", APIFY_TOKEN: "apify-suitor",
        XDG_CONFIG_HOME: "/srv/ithaca/xdg-config", XDG_STATE_HOME: "/srv/ithaca/xdg-state", ODYSSEUS_VOYAGE: "ithaca",
      };
      const made = isolateGogEnvironment(host, parent);
      expect(host, "HOST_ONLY_DROPPED_XDG_REPOINTED_ORDINARY_KEPT").toEqual({
        XDG_CONFIG_HOME: made.xdg.XDG_CONFIG_HOME, XDG_STATE_HOME: made.xdg.XDG_STATE_HOME, ODYSSEUS_VOYAGE: "ithaca",
        GOG_HOME: made.home, GOG_KEYRING_BACKEND: "file",
      });
      for (const dir of Object.values(made.xdg)) {
        expect(dir.startsWith(`${dirname(made.home)}/`), dir).toBe(true);
        expect([readdirSync(dir), (statSync(dir).mode & 0o777).toString(8)], dir).toEqual([[], "700"]);
      }
      // A descendant: a test chose these, after its maker removed the host's.
      const chosen: Record<string, string | undefined> = { GOG_HOME: made.home, GOG_ACCOUNT: "suitor", BRAIN_UI_GOOGLE_HOME: "/odysseus/gog", XDG_CONFIG_HOME: "/odysseus/config" };
      isolateGogEnvironment(chosen, parent).dispose();
      expect(chosen, "DESCENDANT_KEEPS_WHAT_A_TEST_CHOSE").toEqual({ GOG_HOME: made.home, GOG_KEYRING_BACKEND: "file", BRAIN_UI_GOOGLE_HOME: "/odysseus/gog", XDG_CONFIG_HOME: "/odysseus/config" });
      made.dispose();
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a GOG_HOME the guard did not make is never reused, however like one it looks", () => {
    const parent = mkdtempSync(join(tmpdir(), "network-guard-home-"));
    try {
      const made = isolateGogEnvironment({}, parent);
      const marker = readFileSync(join(dirname(made.home), "guard"), "utf8");
      // The guard's layout, `<dir>/guard` beside `<dir>/home`, with one thing changed.
      const forge = (prefix: string, text: string | null, name = "home", home = (path: string) => mkdirSync(path, { mode: 0o700 })) => {
        const dir = mkdtempSync(join(parent, prefix));
        if (text !== null) writeFileSync(join(dir, "guard"), text, { mode: 0o600 });
        home(join(dir, name));
        return join(dir, name);
      };
      const cases: [string, string][] = [
        ["no marker", forge("brain-test-gog-", null)],
        ["another marker", forge("brain-test-gog-", "brain-kit offline test guard\n")],
        ["another place", forge("ithaca-gog-", marker)],
        ["another name", forge("brain-test-gog-", marker, "elsewhere")],
        ["a home others can read", forge("brain-test-gog-", marker, "home", path => { mkdirSync(path); chmodSync(path, 0o750); })],
        ["a symlink to a private home", forge("brain-test-gog-", marker, "home", path => symlinkSync(made.home, path))],
        ["a maintainer's gog home", "/srv/ithaca/gog"],
      ];
      for (const [label, home] of cases) {
        const env: Record<string, string | undefined> = { GOG_HOME: home };
        const got = isolateGogEnvironment(env, parent);
        expect(got.home, label).not.toBe(home);
        expect(env.GOG_HOME, label).toBe(got.home);
        got.dispose();
      }
      made.dispose();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
