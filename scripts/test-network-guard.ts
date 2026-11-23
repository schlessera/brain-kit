/** Test-only subprocess and transport safeguards; never imported by a published package. */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isIP, Socket } from "node:net";
import { inheritWorkspaceLease } from "./workspace-lease.mjs";

/*
 * No test may run a real gog (plan §11): its home holds a Google credential.
 * Three layers keep it so.
 *
 * 1. Only a fake the fake-gog helper made is registered, and only while its
 *    file is still that fake ({@link registerFakeGog}).
 * 2. Every spawn is refused when a word names a gog that is not a
 *    registered fake ({@link unregisteredGog}): the executable, resolved
 *    through PATH and symlinks; through `env` and a shell's `-c` script,
 *    nested to any depth, every word, each resolved the same way; and every
 *    word of a Bun Shell command.
 * 3. Whatever the first two miss finds no account: the guard drops every
 *    inherited `GOG_*` name and points `GOG_HOME` at an empty private home
 *    with the file keyring, one per test process, which its descendants
 *    share. The test process also drops every other host-only name it
 *    inherited (`BRAIN_UI_GOOGLE_*`, `BRAIN_GOOGLE_*`, `BRAIN_UI_GOG_PATH`
 *    and the rest of ui-sdk's list, {@link GUARD_HOST_ONLY_ENV}) and points
 *    each XDG base directory it inherited at an empty one of its own, so a
 *    child whose environment a product filter stripped of `GOG_HOME` still
 *    resolves gog's directories only there or under the test HOME. Every
 *    guarded descendant does the same, because Bun may have read a `.env`
 *    file into it, and then takes back only the values its spawner chose,
 *    from a file the spawn wrapper wrote ({@link isolateGogEnvironment}).
 *
 * Token matching cannot read a shell: quoting (`go""g`), expansion
 * (`$(printf gog)`, variables), functions, aliases, a script on disk that
 * calls gog, an exec wrapper other than `env` (`timeout`, `xargs`, `nohup`)
 * or an interpreter (`python3 -c`) all pass layer 2. Those are left to layer
 * 3, not chased with more patterns.
 */

/**
 * Fakes a test made and may run although they are named `gog`, each with the
 * exact bytes it must still hold. Kept on a global so every copy of this
 * module in a process shares one registry.
 */
const FAKE_GOGS = Symbol.for("brain-kit.test-network-guard.fake-gogs");
const fakeGogs = (): Map<string, string> => ((globalThis as Record<symbol, Map<string, string>>)[FAKE_GOGS] ??= new Map());

/** The module every fake gog runs (packages/common/tests/support/fake-gog-child.ts). */
const FAKE_GOG_CHILD = resolve(import.meta.dir, "../packages/common/tests/support/fake-gog-child.ts");
const FAKE_GOG_DIR = /^fake-gog-[A-Za-z0-9]{6}$/;

/**
 * The only bytes a fake gog may hold: Bun running {@link FAKE_GOG_CHILD} with
 * the scenario and call log of the fake's own directory. `executable` is
 * where the fake-gog helper puts it, `<tmpdir>/fake-gog-XXXXXX/bin/gog`.
 */
export function fakeGogShim(executable: string): string {
  const dir = dirname(dirname(executable));
  return `#!${process.execPath}\n// brain-kit fake gog: packages/common/tests/support/fake-gog.ts\n` +
    `import { runFakeGog } from ${JSON.stringify(FAKE_GOG_CHILD)};\n` +
    `await runFakeGog(${JSON.stringify({ scenario: join(dir, "scenario.json"), calls: join(dir, "calls") })});\n`;
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Whether `path` is a regular file holding exactly `text`. */
function holdsExactly(path: string, text: string): boolean {
  const stats = lstatOrNull(path);
  if (!stats?.isFile() || stats.size !== Buffer.byteLength(text)) return false;
  try {
    return readFileSync(path, "utf8") === text;
  } catch {
    return false;
  }
}

/**
 * Lets this process spawn `path`, a fake gog the fake-gog helper made (plan
 * §11): a regular file at `<tmpdir>/fake-gog-XXXXXX/bin/gog` holding exactly
 * {@link fakeGogShim}. Anything else throws, a real gog or
 * `/bin/true` included. A spawn checks the bytes again, so a fake whose file
 * was replaced afterwards is refused. Returns the undo.
 */
export function registerFakeGog(path: string): () => void {
  const dir = dirname(dirname(path));
  const placed = basename(path) === "gog" && basename(dirname(path)) === "bin" && FAKE_GOG_DIR.test(basename(dir)) && dirname(dir) === resolve(tmpdir());
  const shim = fakeGogShim(path);
  if (!placed || !holdsExactly(path, shim)) {
    throw new Error("Offline test guard: only a fake gog made by packages/common/tests/support/fake-gog.ts can be registered");
  }
  const real = realpathSync(path);
  fakeGogs().set(real, shim);
  return () => fakeGogs().delete(real);
}

const isRegisteredFake = (real: string) => {
  const shim = fakeGogs().get(real);
  return shim !== undefined && holdsExactly(real, shim);
};

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "mksh", "ash", "busybox"]);
const unquote = (word: string) => word.replace(/^['"]+|['"]+$/g, "");

/** Every word of a shell script, split on blanks and operators: a coarse superset of the commands it runs. */
const shellWords = (script: string) => script.split(/[\s;&|()<>`$]+/).map(unquote).filter(Boolean);

/** Where `execvp` looks with no PATH set, as after `env -i`. */
const EXECVP_DEFAULT_PATH = "/bin:/usr/bin";

/** GNU env's long options that take the next word as their value. */
const ENV_VALUE_OPTIONS = new Set(["--unset", "--chdir", "--argv0"]);

/**
 * What `env [options] [NAME=value…] command …` runs: the command, with
 * `-S`'s string split into words, and the PATH it is looked up on when an
 * assignment or `-i` changes it (`undefined` when neither does).
 */
function envCommand(args: readonly string[]): { command: string[]; path?: string } {
  let path: string | undefined;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    let split: string | undefined;
    if (arg === "--") return { command: args.slice(at + 1), path };
    if (arg.startsWith("--split-string=")) split = arg.slice("--split-string=".length);
    else if (arg === "--split-string") split = args[++at] ?? "";
    else if (arg === "--ignore-environment") path = EXECVP_DEFAULT_PATH;
    else if (arg.startsWith("--")) {
      if (ENV_VALUE_OPTIONS.has(arg)) at++;
    } else if (/^-[^-]/.test(arg)) {
      // A cluster such as `-iS'gog version'` or `-uHOME`: an option's value is the rest of it, or the next word.
      const valueAt = arg.search(/[uCaS]/);
      if (arg.slice(1, valueAt === -1 ? undefined : valueAt).includes("i")) path = EXECVP_DEFAULT_PATH;
      if (valueAt !== -1) {
        const value = arg.length > valueAt + 1 ? arg.slice(valueAt + 1) : args[++at] ?? "";
        if (arg[valueAt] === "S") split = value;
      }
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      if (arg.startsWith("PATH=")) path = arg.slice("PATH=".length);
    } else {
      return { command: args.slice(at), path };
    }
    if (split !== undefined) return { command: [...split.split(/\s+/).map(unquote).filter(Boolean), ...args.slice(at + 1)], path };
  }
  return { command: [], path };
}

/** A word that may name a gog: `resolve` words are followed through `path` (else the spawn's PATH) and symlinks, the rest only by name. */
interface GogWord { word: string; resolve: boolean; path?: string }

/** The words of one command that may run a program, through `env` and shell `-c` scripts nested to any depth. */
function commandWords(cmd: readonly string[], path?: string): GogWord[] {
  if (cmd.length === 0) return [];
  const [first, ...args] = cmd.map(String);
  const words: GogWord[] = [{ word: first!, resolve: true, path }];
  const program = basename(first!);
  if (program === "env") {
    // Each level runs a shorter command, so this ends.
    words.push(...args.map(word => ({ word, resolve: false })));
    const inner = envCommand(args);
    words.push(...commandWords(inner.command, inner.path ?? path));
  } else if (SHELLS.has(program)) {
    const flag = args.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
    // Every word of the script, nested scripts included, is a command it may run.
    if (flag >= 0 && args[flag + 1] !== undefined) words.push(...shellWords(args[flag + 1]!).map(word => ({ word, resolve: true, path })));
  }
  return words;
}

/** The file a word runs, or null when it names nothing that exists. */
function resolveExecutable(word: string, path: string | undefined, cwd: string | undefined): string | null {
  if (word.length === 0 || word.length > 4096) return null;
  const found = word.includes("/") ? resolve(cwd ?? process.cwd(), word) : Bun.which(word, { PATH: path ?? "", cwd });
  if (!found) return null;
  try {
    return realpathSync(found);
  } catch {
    return null;
  }
}

/** The first of `words` that names a gog that is not a registered fake. */
function firstUnregistered(words: readonly GogWord[], env: Readonly<Record<string, string | undefined>>, cwd?: string): string | null {
  for (const { word, resolve: follow, path } of words) {
    const named = basename(word) === "gog";
    if (!named && !follow) continue;
    const real = resolveExecutable(word, path ?? env.PATH ?? process.env.PATH, cwd);
    // A word under another name counts only when it is a file whose real name is gog.
    if (!named && (real === null || basename(real) !== "gog" || !lstatOrNull(real)?.isFile())) continue;
    if (real === null || !isRegisteredFake(real)) return word;
  }
  return null;
}

/**
 * The first word of a spawn naming a gog that is not a registered fake (see
 * layer 2 above). Any word named `gog` counts, which may over-match an
 * argument (`echo gog`) but never misses one; a word under another name
 * counts when it resolves to a file named `gog`.
 */
export function unregisteredGog(cmd: readonly string[], env: Readonly<Record<string, string | undefined>>, cwd?: string): string | null {
  return firstUnregistered(commandWords(cmd), env, cwd);
}

/** Where a guard keeps a gog home: `<parent>/brain-test-gog-XXXXXX/home`, beside a file `guard` holding exactly the marker. */
const GOG_HOME_DIR = /^brain-test-gog-[A-Za-z0-9]{6}$/;
const GOG_HOME_MARKER = "brain-kit offline test guard: the empty gog home beside this file belongs to the test process that made it\n";

/**
 * Whether `home` is a gog home a guard made: `home` in a
 * `brain-test-gog-XXXXXX` directory that holds the marker, both of them
 * directories, not symlinks, owned by this user, mode 0700. A gog home of
 * anyone else's never has that layout.
 */
function isGuardGogHome(home: string | undefined): home is string {
  if (!home) return false;
  const dir = dirname(home);
  if (basename(home) !== "home" || !GOG_HOME_DIR.test(basename(dir))) return false;
  for (const path of [dir, home]) {
    const stats = lstatOrNull(path);
    if (!stats?.isDirectory() || (stats.mode & 0o777) !== 0o700 || stats.uid !== process.getuid?.()) return false;
  }
  return holdsExactly(join(dir, "guard"), GOG_HOME_MARKER);
}

/**
 * ui-sdk's host-only names, which no product subprocess receives
 * (`HOST_ONLY_SECRET_ENV` and `HOST_ONLY_ENV_PREFIXES`,
 * `packages/ui-sdk/src/server/subprocess-env.ts`), and which no test process
 * inherits from its host. A copy rather than an import: this file also runs
 * where only the scripts are (`tests/local-checks.test.ts` copies it into a
 * fixture). `tests/test-network-guard.test.ts` holds both equal to ui-sdk's.
 */
export const GUARD_HOST_ONLY_ENV: readonly string[] = Object.freeze([
  "APIFY_TOKEN", "BRAIN_APIFY_LEDGER", "BRAIN_UI_GITHUB_TOOLS_TOKEN", "BRAIN_UI_MODULE_GITHUB_TOKEN",
  "BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_GOOGLE_LEDGER", "BRAIN_UI_GOG_PATH",
]);
export const GUARD_HOST_ONLY_ENV_PREFIXES: readonly string[] = Object.freeze(["GOG_", "BRAIN_UI_GOOGLE_", "BRAIN_GOOGLE_"]);
const isHostOnlyEnv = (name: string) => GUARD_HOST_ONLY_ENV.includes(name) || GUARD_HOST_ONLY_ENV_PREFIXES.some(prefix => name.startsWith(prefix));

/** The XDG base directories gog 0.48.1 resolves its config, data, state and cache under when `GOG_HOME` is unset, and the guard's empty stand-in for each. */
const XDG_BASES = Object.freeze({ XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache" });
type XdgBase = keyof typeof XDG_BASES;

/**
 * Layer 3: drops every `GOG_*` name from `env` (gog reads its home, config,
 * data, state and cache directories, account, OAuth client, access token,
 * auth mode, keyring backend, password and service, API endpoints and keys
 * from them), then points `GOG_HOME` at an empty 0700 directory and sets
 * `GOG_KEYRING_BACKEND=file`. `GOG_HOME` outranks `HOME` and `XDG_*` for
 * every gog directory, and the file keyring opens no desktop keyring, so a
 * gog that slips past layer 2 finds no credential.
 *
 * A product filter drops both of those from what it hands a child, as it
 * drops every `GOG_*` name. Without `GOG_HOME`, gog 0.48.1 resolves each
 * directory under its XDG base directory when that is absolute, else under
 * `HOME` (`internal/config/layout.go`, `resolveKind`, `defaultBase`), and an
 * environment without `GOG_KEYRING_BACKEND` and without a D-Bus session
 * address gets the file keyring on Linux (`internal/secrets/backend.go`,
 * `shouldForceFileBackend`). So the test process that makes the home also
 * points each XDG base it inherited at an empty 0700 directory beside the
 * home, and `HOME` is the preload's test home: a filtered child's gog finds
 * neither the host's directories nor a credential in them. It drops every
 * other host-only name it inherited too ({@link GUARD_HOST_ONLY_ENV}:
 * `BRAIN_UI_GOOGLE_*`, `BRAIN_GOOGLE_*`, `BRAIN_UI_GOG_PATH` and the other
 * host-only secrets), before any test code loads, so no test holds the
 * host's Google home, keyring password, binary or ledger; a test that needs
 * one sets a synthetic value itself.
 *
 * A test process makes the home under `parent`; its descendants share it.
 * A `GOG_HOME` that is a home a guard made ({@link isGuardGogHome}) is kept,
 * and the spawn wrapper hands this process's home to every guarded Bun
 * child, even one started with another environment. Only the maker's
 * `dispose` removes it, so a descendant killed with SIGKILL, which runs no
 * exit hook, leaves nothing behind.
 *
 * A descendant drops and repoints exactly as the maker does. Nothing in its
 * environment says what a test chose: Bun reads `.env`, `.env.local` and the
 * like, an explicit `--env-file` and one in `BUN_OPTIONS` before any preload
 * runs, expands variables in them, and `bun run` hands its script the
 * environment without running a preload at all. So the spawn wrapper writes
 * the host-only names and XDG bases a guarded Bun child is given into a file
 * of its own ({@link recordChosenEnv}) and passes only its path; the
 * child's guard applies those values over whatever it dropped or repointed,
 * and only from a file the wrapper could have written
 * ({@link readChosenEnv}). A synthetic value a test chose survives; one a
 * dotenv file supplied does not, and a forged path names nothing a guard did
 * not write.
 */
export function isolateGogEnvironment(env: Record<string, string | undefined>, parent: string): { home: string; xdg: Readonly<Record<XdgBase, string>>; dispose(): void } {
  const inherited = env.GOG_HOME;
  const descendant = isGuardGogHome(inherited);
  const chosen = env[CHOSEN_ENV];
  delete env[CHOSEN_ENV];
  for (const name of Object.keys(env)) if (isHostOnlyEnv(name)) delete env[name];
  let home: string;
  let dispose = () => {};
  if (descendant) {
    home = inherited;
  } else {
    const dir = mkdtempSync(join(parent, "brain-test-gog-"));
    home = join(dir, "home");
    mkdirSync(home);
    // Both 0700 whatever the umask: a descendant checks the mode before it shares them.
    chmodSync(dir, 0o700);
    chmodSync(home, 0o700);
    for (const kind of Object.values(XDG_BASES)) mkdirSync(join(dir, "xdg", kind), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, CHOSEN_DIR), { mode: 0o700 });
    chmodSync(join(dir, CHOSEN_DIR), 0o700);
    writeFileSync(join(dir, "guard"), GOG_HOME_MARKER, { mode: 0o600 });
    dispose = () => rmSync(dir, { recursive: true, force: true });
  }
  const xdg = Object.fromEntries(Object.entries(XDG_BASES).map(([name, kind]) => [name, join(dirname(home), "xdg", kind)])) as Record<XdgBase, string>;
  for (const name of Object.keys(XDG_BASES) as XdgBase[]) if (name in env) env[name] = xdg[name];
  if (descendant) Object.assign(env, readChosenEnv(chosen, home));
  env.GOG_HOME = home;
  env.GOG_KEYRING_BACKEND = "file";
  return { home, xdg, dispose };
}

/** The path of the file holding what a guarded Bun child's spawner chose; the child's guard reads and removes it. */
const CHOSEN_ENV = "BRAIN_TEST_GUARD_CHOSEN_ENV";
/** Where the spawn wrapper writes those files: beside the gog home, in the guard's own 0700 directory, and nothing else writes there. */
const CHOSEN_DIR = "chosen";
let chosenFiles = 0;

/** The names a chosen-environment file may restore: host-only names other than `GOG_*`, which the guard always sets itself, and the XDG bases. */
const restorable = (name: string) => !name.startsWith("GOG_") && (isHostOnlyEnv(name) || Object.prototype.hasOwnProperty.call(XDG_BASES, name));

/**
 * Writes the host-only names and XDG bases `env` holds into a new 0600 file
 * in the guard's directory beside `home`, and returns its path; undefined
 * when there are none. The spawn wrapper calls it for every guarded Bun
 * child, with the environment that child is about to get.
 *
 * An XDG base that already names the guard's own directory needs no record:
 * the child's guard repoints it there anyway. When the file cannot be
 * written, as inside a sandbox that mounts the guard's directory read-only,
 * there is no record and the child keeps none of the values, as a Bun a
 * shell starts keeps none; the spawn itself goes ahead.
 */
export function recordChosenEnv(env: Readonly<Record<string, string | undefined>>, home: string): string | undefined {
  const guardOwn = (name: string, value: string) =>
    Object.prototype.hasOwnProperty.call(XDG_BASES, name) && value === join(dirname(home), "xdg", XDG_BASES[name as XdgBase]);
  const chosen = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string" && restorable(entry[0]) && !guardOwn(entry[0], entry[1])));
  if (Object.keys(chosen).length === 0) return undefined;
  const path = join(dirname(home), CHOSEN_DIR, `${process.pid}-${++chosenFiles}-${randomBytes(8).toString("hex")}.json`);
  try {
    writeFileSync(path, JSON.stringify(chosen), { mode: 0o600, flag: "wx" });
  } catch {
    return undefined;
  }
  return path;
}

/**
 * The values a chosen-environment file holds, or none: only from a regular
 * 0600 file owned by this user, directly in the guard's 0700 directory
 * beside `home` (a symbolic link, a FIFO or a path through `..` names none),
 * and only for the names {@link recordChosenEnv} writes.
 */
export function readChosenEnv(path: string | undefined, home: string): Record<string, string> {
  const dir = join(dirname(home), CHOSEN_DIR);
  if (!path || dirname(path) !== dir) return {};
  const own = (stats: ReturnType<typeof lstatOrNull>, mode: number) => stats !== null && stats.uid === process.getuid?.() && (stats.mode & 0o777) === mode;
  const folder = lstatOrNull(dir), file = lstatOrNull(path);
  if (!folder?.isDirectory() || !own(folder, 0o700) || !file?.isFile() || !own(file, 0o600)) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && restorable(entry[0])));
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const socketLoopback = (host: string) => host === "localhost" || host === "::1" || isIP(host) === 4 && host.startsWith("127.");
let installed: { assertNoEscapes(): void; disposeGogHome(): void } | undefined;

/** Test-owned repositories must not acquire detached writers behind a fixture. */
function testGitEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 2_147_483_645) {
    throw new Error("Test Git environment requires a valid GIT_CONFIG_COUNT");
  }
  // Repeated preload/child propagation must not grow the inherited config.
  if (count >= 2 && env[`GIT_CONFIG_KEY_${count - 2}`] === "maintenance.auto" &&
    env[`GIT_CONFIG_VALUE_${count - 2}`] === "false" &&
    env[`GIT_CONFIG_KEY_${count - 1}`] === "gc.auto" && env[`GIT_CONFIG_VALUE_${count - 1}`] === "0") return { ...env };
  return { ...env,
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: "maintenance.auto", [`GIT_CONFIG_VALUE_${count}`]: "false",
    [`GIT_CONFIG_KEY_${count + 1}`]: "gc.auto", [`GIT_CONFIG_VALUE_${count + 1}`]: "0",
  };
}

/**
 * The environment of every child the spawn wrapper starts and of every Bun
 * Shell command: `--no-env-file` is added to BUN_OPTIONS, which every Bun
 * reads, so a Bun the child starts reads no `.env` from its working
 * directory (#4489). That covers a Bun a shell starts, and one that `bun run`,
 * `bun x` or a package script run by name starts, which run no preload. An explicit `--env-file` still loads; a guarded
 * descendant sanitizes what it holds either way ({@link isolateGogEnvironment}).
 *
 * Only `--no-env-file` is added, not the child preload. The preload drops
 * every host-only name and takes back only what a record names, and the
 * wrapper writes a record only for a Bun it starts itself; a Bun a shell
 * starts would find none, so a test's chosen values would be lost.
 * BUN_OPTIONS also reaches `bun install` and `bun build`, which a guard
 * preload must not change. Network access by such a child is outside this
 * guard (#3672).
 *
 * The one reader of BUN_OPTIONS under test, `attemptCiBuild`
 * (`scripts/ci-build-operation.ts`), takes a value of only `--no-env-file`
 * as no runtime override. The test process's own environment is left alone.
 *
 * It is appended to any other value, even one that seems to hold it: the
 * text may be a quoted value or the argument of another option, and Bun
 * takes the flag twice without complaint.
 */
export function testBunOptions(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const options = env.BUN_OPTIONS?.trim() ?? "";
  if (options === "--no-env-file") return { ...env };
  return { ...env, BUN_OPTIONS: options ? `${options} --no-env-file` : "--no-env-file" };
}


/** Set while the guard is installed, so maintainer-only scripts can refuse to run under it. */
export const NETWORK_GUARD_INSTALLED = Symbol.for("brain-kit.test-network-guard.installed");

export function installNetworkGuard(): { assertNoEscapes(): void; disposeGogHome(): void } {
  if (installed) return installed;
  (globalThis as Record<symbol, unknown>)[NETWORK_GUARD_INSTALLED] = true;
  Object.assign(process.env, testGitEnvironment(process.env));
  // A launcher-owned resource root outlives this process and is removed with the run.
  const gogHome = isolateGogEnvironment(process.env, process.env.BRAIN_TEST_RESOURCE_ROOT ?? tmpdir());
  const escapes: string[] = [];
  let reported = 0;
  const message = () => `Offline test guard: attempted real network access\n${escapes.join("\n")}`;
  function refuse(detail: string): never {
    escapes.push(detail);
    throw new Error(message());
  }
  function permitted(url: URL): void {
    if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK.has(url.hostname)) {
      refuse(`fetch ${url.href}`);
    }
  }

  // Bun's net.connect/createConnection and tls.connect (including saved
  // factory references) all dispatch through this shared Socket method.
  const nativeSocketConnect = Socket.prototype.connect;
  Object.defineProperty(Socket.prototype, "connect", {
    ...Object.getOwnPropertyDescriptor(Socket.prototype, "connect"),
    value: function offlineSocketConnect(this: Socket, ...args: unknown[]) {
      // Bun factories pass an already-normalized [options, callback] array;
      // direct Socket/TLSSocket callers use the public overloads instead.
      const values = Array.isArray(args[0]) ? args[0] : args;
      const first = values[0];
      const options = (typeof first === "object" && first !== null ? first
        : typeof first === "string" && Number.isNaN(Number(first)) ? { path: first }
        : { port: first, host: typeof values[1] === "string" ? values[1] : "localhost" }) as {
          host?: string; port?: unknown; path?: string; socket?: unknown; fd?: number;
        };
      // Unix paths and adoption/TLS upgrades of an existing socket open no
      // new TCP destination. SNI on an adopted socket is not its address.
      if (!options.path && !options.socket && options.fd == null) {
        const host = options.host ?? "localhost";
        if (!socketLoopback(host)) refuse(`socket.connect ${host}:${options.port}`);
      }
      return Reflect.apply(nativeSocketConnect, this, args);
    },
  });
  const nativeBunConnect = Bun.connect;
  Object.defineProperty(Bun, "connect", {
    ...Object.getOwnPropertyDescriptor(Bun, "connect"),
    value: async function offlineBunConnect(options: Bun.TCPSocketConnectOptions<unknown> | Bun.UnixSocketOptions<unknown>) {
      if ("hostname" in options && !socketLoopback(options.hostname)) {
        refuse(`Bun.connect ${options.hostname}:${options.port}`);
      }
      return "hostname" in options ? nativeBunConnect(options) : nativeBunConnect(options);
    },
  });

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async function offlineFetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    let request = new Request(input, init);
    permitted(new URL(request.url));
    // A loopback destination routed through an external proxy is not local.
    if ((init as RequestInit & { proxy?: unknown } | undefined)?.proxy) refuse(`fetch proxy for ${request.url}`);
    const mode = request.redirect;
    // A Unix socket never leaves the host; `new Request` drops Bun's `unix`
    // option, so every hop passes it on or a socket request becomes TCP.
    const unix = (init as RequestInit & { unix?: string } | undefined)?.unix;
    for (let hop = 0; ; hop++) {
      const replay = request.clone();
      let replayBody = replay.body;
      try {
        const response = await nativeFetch(request, { redirect: "manual", ...(unix ? { unix } : {}) } as RequestInit);
        const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
        if (mode === "manual" || location === null) {
          if (hop) Object.defineProperty(response, "redirected", { value: true });
          return response;
        }
        await response.body?.cancel();
        if (mode === "error") throw new TypeError("Fetch redirect mode is error");
        if (hop === 20) throw new TypeError("Fetch redirected more than 20 times");
        const next = new URL(location, request.url);
        permitted(next);
        const headers = new Headers(request.headers);
        if (next.origin !== new URL(request.url).origin) {
          for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);
        }
        const rewrite = (response.status === 303 && request.method !== "HEAD") ||
          ([301, 302].includes(response.status) && request.method === "POST");
        if (rewrite) {
          for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(name);
        }
        request = new Request(next, {
          method: rewrite ? "GET" : replay.method,
          headers,
          body: rewrite ? undefined : replay.body,
          signal: replay.signal,
          credentials: replay.credentials,
          redirect: mode,
        });
        // The next request now owns the replay stream. A rewrite has no body.
        if (!rewrite) replayBody = null;
      } finally {
        // Cancelling one tee branch can wait for its unread sibling. Initiate
        // disposal without awaiting it or replacing the transport error.
        void replayBody?.cancel().catch(() => {});
      }
    }
  }, nativeFetch);

  const childPreload = join(import.meta.dir, "test-network-child-preload.ts");
  for (const key of ["spawn", "spawnSync"] as const) {
    const native = Bun[key];
    Bun[key] = ((...args: unknown[]) => {
      const first = args[0] as string[] | { cmd: string[] };
      const cmd = Array.isArray(first) ? first : first.cmd;
      const executable = String(cmd[0]);
      if (basename(executable) === "curl") refuse(`${key} ${cmd.join(" ")}`);
      const spawnOptions = (Array.isArray(first) ? args[1] ?? {} : first) as { env?: Record<string, string | undefined>; cwd?: string };
      if (unregisteredGog(cmd, spawnOptions.env ?? process.env, spawnOptions.cwd)) refuse(`${key} ${cmd.join(" ")}`);
      const guardedBun = basename(executable) === "bun" || executable === process.execPath;
      if (guardedBun) {
        // Bun treats `bun --preload FILE test` as a package script. Keep the
        // builtin/subcommand first so child tests remain child tests. Nor
        // does the child read a `.env` file from its working directory, so a
        // name the guard leaves alone (HOME, a D-Bus address) comes only from
        // its spawner. Nothing relies on that: an explicit `--env-file` or one
        // in BUN_OPTIONS still loads, and the child's guard sanitizes what it
        // holds either way.
        const index = ["test", "run"].includes(cmd[1] ?? "") ? 2 : 1;
        const guarded = [...cmd.slice(0, index), "--preload", childPreload, "--no-env-file", ...cmd.slice(index)];
        args[0] = Array.isArray(first) ? guarded : { ...first, cmd: guarded };
      }
      // Resource ownership follows children even when a test replaces env or
      // cwd. Existing extra stdio channels keep their original descriptor ids.
      const defaultStderr = key === "spawnSync" ? "pipe" : "inherit";
      // The trusted worker bootstrap refuses inherited authority. Keep the
      // actual output owner in its ancestor, never pass its writable lock fd
      // into a pipe-only boundary. This is test coordination, not a worker flag.
      const pipeOnly = /\/ui-sdk\/(src|dist)\/server\/worker-entry\.(ts|js)$/.test(cmd[1] ?? "");
      const options = (Array.isArray(first) ? args[1] ?? {} : args[0]) as { env?: Record<string, string | undefined> };
      // Fixture helpers often replace env completely, including provider-history
      // probes. Carry test Git policy through those children as well as shells.
      // Every child carries `--no-env-file` to the Bun it starts.
      const childEnv = testBunOptions(testGitEnvironment(options.env ?? process.env));
      // A guarded Bun child's own guard drops every GOG_* name it is given;
      // this one makes it keep this process's gog home rather than make one.
      // Its guard drops every host-only name and repoints every XDG base, then
      // takes back what this spawn gave it from the file recorded here.
      if (guardedBun) {
        childEnv.GOG_HOME = gogHome.home;
        const chosen = recordChosenEnv(childEnv, gogHome.home);
        if (chosen) childEnv[CHOSEN_ENV] = chosen;
        else delete childEnv[CHOSEN_ENV];
      }
      const inherited = inheritWorkspaceLease({ ...options, env: childEnv }, defaultStderr, pipeOnly);
      if (Array.isArray(first)) args[1] = inherited;
      else args[0] = inherited;
      const result = Reflect.apply(native, Bun, args);
      return result;
    }) as typeof Bun.spawn & typeof Bun.spawnSync;
  }

  // Bun Shell does not go through Bun.spawn. Its template words and
  // interpolated values are checked the same way before it runs anything,
  // and again whenever `.env()` or `.cwd()` changes where a word resolves:
  // on one command, or as `Bun.$`'s defaults, which hand back the guarded
  // `Bun.$` so a chain through them stays guarded.
  type Shell = ReturnType<typeof Bun.$>;
  type Env = Record<string, string | undefined>;
  const nativeShell = Bun.$;
  const defaults: { env?: Env; cwd?: string } = {};
  const guardedShell: typeof Bun.$ = new Proxy(nativeShell, {
    apply(target, self, args: unknown[]) {
      const [strings, ...values] = args as [TemplateStringsArray | string, ...unknown[]];
      const words = [...(typeof strings === "string" ? [strings] : strings.raw).flatMap(shellWords),
        ...values.flat(2).filter((value): value is string => typeof value === "string")].map(word => ({ word, resolve: true }));
      const state = { env: defaults.env ?? process.env, cwd: defaults.cwd };
      const check = () => {
        const found = firstUnregistered(words, state.env, state.cwd);
        if (found !== null) refuse(`Bun.$ ${found}`);
      };
      check();
      const shell = Reflect.apply(target, self, args) as Shell;
      // A Bun the command starts reads no `.env`, whichever environment it is given (#4489).
      Reflect.apply(shell.env as (value: unknown) => Shell, shell, [testBunOptions(state.env)]);
      for (const key of ["env", "cwd"] as const) {
        const native = shell[key] as (value: unknown) => Shell;
        Object.defineProperty(shell, key, {
          configurable: true, writable: true,
          value(this: Shell, value: unknown) {
            if (key === "env") state.env = (value as Env | undefined) ?? process.env;
            else state.cwd = value as string | undefined;
            check();
            return Reflect.apply(native, this, [key === "env" ? testBunOptions(state.env) : value]);
          },
        });
      }
      return shell;
    },
    get(target, key, receiver) {
      if (key === "env" || key === "cwd" || key === "nothrow" || key === "throws") {
        return (...args: unknown[]) => {
          // A copy, as Bun keeps one: a later change to the caller's object reaches no command.
          if (key === "env") defaults.env = args[0] ? { ...(args[0] as Env) } : undefined;
          if (key === "cwd") defaults.cwd = args[0] as string | undefined;
          Reflect.apply(target[key] as (...rest: unknown[]) => unknown, target, args);
          return guardedShell;
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  Object.defineProperty(Bun, "$", { ...Object.getOwnPropertyDescriptor(Bun, "$"), value: guardedShell });

  installed = {
    assertNoEscapes() {
      if (escapes.length > reported) {
        reported = escapes.length;
        throw new Error(message());
      }
    },
    disposeGogHome: gogHome.dispose,
  };
  // Ordinary Bun children have no test hooks. A caught error, including one
  // followed by process.exit(0), must still make that process unsuccessful.
  process.on("exit", () => {
    gogHome.dispose();
    if (escapes.length) {
      console.error(message());
      process.exit(1);
    }
  });
  return installed;
}
