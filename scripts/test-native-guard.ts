/** Test-only OS boundary for installed native Claude processes (#4313). */
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, statSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
const within = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
let qualified = false;
let denied = 0, reported = 0;
export function nativeIsolationFailed(): boolean { return denied > 0; }
export function assertNoNativeRefusals(): void {
  if (denied <= reported) return;
  reported = denied;
  throw new Error("Offline native Claude isolation refused a launch during this test");
}
let head: string | undefined;
function receiptHead(): string {
  if (head) return head;
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
  const value = result.stdout.toString().trim();
  return head = result.exitCode === 0 && /^[0-9a-f]{40}$/.test(value) ? value : "unavailable";
}

// Resolve from the installed SDK, exactly as its native package lookup does.
// This runs before test mocks can replace module resolution. No executable runs.
const installedRuntimes: { path: string; size: number }[] = [];
try {
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const fromSdk = createRequire(sdk);
  const manifest = JSON.parse(readFileSync(join(dirname(sdk), "package.json"), "utf8")) as { optionalDependencies?: Record<string, string> };
  for (const name of Object.keys(manifest.optionalDependencies ?? {}).filter(name => name.startsWith("@anthropic-ai/claude-agent-sdk-"))) {
    try {
      const path = realpathSync(fromSdk.resolve(`${name}/claude${name.includes("win32") ? ".exe" : ""}`));
      installedRuntimes.push({ path, size: statSync(path).size });
    } catch { /* Other-platform optional packages need not be installed. */ }
  }
  const cli = join(dirname(sdk), "cli.js");
  if (existsSync(cli)) installedRuntimes.push({ path: realpathSync(cli), size: statSync(cli).size });
} catch { /* Copied non-native harness fixtures need no installed SDK. */ }

const hashes = new Map<string, string>();
function fileHash(path: string): string {
  const stat = statSync(path, { bigint: true });
  const key = `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const cached = hashes.get(key);
  if (cached) return cached;
  const fd = openSync(path, "r"), chunk = Buffer.alloc(1024 * 1024), hash = createHash("sha256");
  try { for (;;) { const count = readSync(fd, chunk); if (!count) break; hash.update(chunk.subarray(0, count)); } }
  finally { closeSync(fd); }
  const digest = hash.digest("hex"); hashes.set(key, digest); return digest;
}

interface SpawnContext { cwd?: string; env?: Record<string, string | undefined> }
function resolveExecutable(command: string, options: SpawnContext): string {
  const cwd = resolve(options.cwd ?? process.cwd());
  const path = options.env?.PATH ?? process.env.PATH;
  return realpathSync(command.includes("/") ? resolve(cwd, command) : Bun.which(command, { cwd, PATH: path }) ?? resolve(cwd, command));
}

export function isNativeClaude(command: string, args: readonly unknown[] = [], options: SpawnContext = {}): boolean {
  for (const value of [command, ...args]) {
    if (typeof value !== "string" || value.startsWith("-")) continue;
    let path: string;
    try { path = resolveExecutable(value, options); } catch { continue; }
    if (installedRuntimes.some(runtime => runtime.path === path)) return true;
    // Size eliminates ordinary fixture scripts and interpreters before hashing.
    const size = statSync(path).size;
    const candidates = installedRuntimes.filter(runtime => runtime.size === size);
    if (candidates.length && candidates.some(runtime => fileHash(runtime.path) === fileHash(path))) return true;
  }
  return false;
}

function refuse(reason: string): never {
  denied++;
  // Fixed classifications only: arguments, settings, credentials and addresses
  // never enter a denial receipt.
  console.error(JSON.stringify({ kind: "native-offline-boundary", success: false, nativeLaunched: false, reason, head: receiptHead() }));
  throw new Error(`Offline native Claude refused before launch: ${reason}`);
}

export function refuseNativeClaude(command: string, args: readonly unknown[] = [], options: SpawnContext = {}): void {
  if (isNativeClaude(command, args, options)) refuse("OS isolation has not been qualified");
}

function qualify(): void {
  // Positive native proof is reserved for disposable hosted runners. Namespace
  // availability on a developer machine never authorizes a native test launch.
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    refuse("positive native proof requires a hosted runner");
  }
  if (qualified) return;
  let result: ReturnType<typeof Bun.spawnSync>;
  try { result = Bun.spawnSync(["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "/usr/bin/true"],
  { env: {}, stdout: "pipe", stderr: "pipe", timeout: 5000 }); }
  catch { refuse("OS namespace setup failed"); }
  if (result.exitCode !== 0) refuse("OS namespace setup failed");
  let trace: ReturnType<typeof Bun.spawnSync>;
  try { trace = Bun.spawnSync(["strace", "-qq", "-e", "trace=connect", "-e", "raw=connect", "/usr/bin/true"],
    { env: {}, stdout: "pipe", stderr: "pipe", timeout: 5000 }); }
  catch { refuse("native connection audit setup failed"); }
  if (trace.exitCode !== 0) refuse("native connection audit setup failed");
  qualified = true;
}

function systemMounts(): string[] {
  const argv: string[] = [];
  for (const path of SYSTEM) {
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink()) argv.push("--symlink", readlinkSync(path), path);
    else argv.push("--ro-bind", path, path);
  }
  // No host account database or managed configuration enters the native view.
  for (const name of ["ld.so.cache", "alternatives", "localtime", "os-release"]) {
    const path = `/etc/${name}`;
    if (existsSync(path)) argv.push("--ro-bind", realpathSync(path), path);
  }
  return argv;
}

/** Runtime source and dependencies, without shared tmp, Git or host IPC. */
function testRuntimeMounts(): string[] {
  return ["packages", "node_modules", "package.json", "tsconfig.json", "bunfig.toml"].flatMap(name => {
    const path = join(ROOT, name);
    return existsSync(path) ? ["--ro-bind", path, path] : [];
  });
}

interface AuditReceipt { kind: "native-offline-audit"; head: string; nativeLaunched: true; deniedConnects: number }
interface Boundary { argv: string[]; env: Record<string, string>; dispose(): void; receipt(): AuditReceipt }

/** Raw connect arguments are pointers/numbers: no addresses, paths or payloads. */
export function deniedNativeConnects(trace: string): number {
  return trace.split("\n").filter(line => /(?:connect\(|connect resumed>).*?= -1 (?:EACCES|EPERM|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ENOENT)\b/.test(line)).length;
}

function auditNativeLaunch(argv: string[], cleanup: () => void) {
  const directory = mkdtempSync(join(tmpdir(), "odysseus-native-audit-"));
  const log = join(directory, "connect.log");
  writeFileSync(log, "", { mode: 0o600 });
  let receipt: AuditReceipt | undefined;
  const finish = (): AuditReceipt => {
    if (receipt) return receipt;
    try {
      const trace = readFileSync(log, "utf8");
      receipt = { kind: "native-offline-audit", head: receiptHead(), nativeLaunched: true, deniedConnects: deniedNativeConnects(trace) };
      console.error(JSON.stringify(receipt));
      return receipt;
    } finally { cleanup(); rmSync(directory, { recursive: true, force: true }); }
  };
  return { argv: ["strace", "-f", "-qq", "-e", "trace=connect", "-e", "raw=connect", "-o", log, "--", ...argv],
    dispose() { finish(); }, receipt: finish };
}

/** One Unix socket forwards only to the explicitly selected scripted service. */
export function startNativeTestRelay(upstream: string | undefined) {
  let target: URL;
  try { target = new URL(upstream!); } catch { return refuse("missing scripted loopback service"); }
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !target.port || target.username || target.password ||
      target.pathname !== "/" || target.search || target.hash) refuse("invalid scripted loopback service");
  if (target.hostname === "localhost") target.hostname = "127.0.0.1";
  const directory = mkdtempSync(join(tmpdir(), "odysseus-native-relay-"));
  const socket = join(directory, "relay.sock");
  const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
  writeFileSync(join(directory, "passwd"), `odysseus:x:${uid}:${gid}:Odysseus:/tmp/native-account:/bin/sh\n`);
  writeFileSync(join(directory, "group"), `odysseus:x:${gid}:\n`);
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    // Concatenate onto the fixed authority; never resolve a request-controlled
    // path as a relative URL, where // or backslashes could replace that host.
    const outbound = new URL(target.origin + url.pathname + url.search);
    if (url.origin !== "http://localhost" || !url.pathname.startsWith("/") || url.pathname.startsWith("//") ||
        url.pathname.includes("\\") || outbound.origin !== target.origin) {
      denied++;
      console.error(JSON.stringify({ kind: "native-offline-boundary", success: false, nativeLaunched: true, reason: "unintended native destination", head: receiptHead() }));
      return new Response("Offline native destination refused", { status: 403 });
    }
    // A redirect is returned to the isolated native process; it cannot make a
    // TCP connection or obtain another host socket through this bridge.
    return fetch(outbound, { method: request.method, headers: request.headers,
      body: request.body, redirect: "manual", signal: request.signal });
  };
  const server = Bun.serve({ unix: socket, fetch: handle });
  return { directory, handle, dispose() { server.stop(true); rmSync(directory, { recursive: true, force: true }); } };
}

/** Direct SDK launch: empty filesystem, fresh PID/network namespaces, one IPC. */
export function nativeClaudeBoundary(command: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; managedSettings?: string }): Boundary {
  qualify();
  const env = options.env ?? process.env;
  const versionOnly = args.at(-1) === "--version";
  const versionHome = versionOnly ? mkdtempSync(join(tmpdir(), "odysseus-native-version-")) : undefined;
  const cwd = versionHome ?? realpathSync(options.cwd ?? process.cwd());
  const home = versionHome ?? (env.HOME && realpathSync(env.HOME));
  if (!home || !within(tmpdir(), home) || home === tmpdir() || cwd === tmpdir() || !within(tmpdir(), cwd) && !within(ROOT, cwd)) {
    refuse("native launch requires fixture-owned storage");
  }
  const bridge = startNativeTestRelay(args.at(-1) === "--version" ? "http://127.0.0.1:1" : env.ANTHROPIC_BASE_URL);
  try {
    command = resolveExecutable(command, options);
    const executable = realpathSync(command);
    const argv = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", ...systemMounts(),
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", ...testRuntimeMounts(),
      "--ro-bind", executable, command, "--ro-bind", process.execPath, process.execPath, "--bind", home, home,
      ...(cwd === ROOT || within(ROOT, cwd) || within(home, cwd) ? [] : ["--bind", cwd, cwd]),
      "--ro-bind", bridge.directory, "/tmp/native-relay",
      "--ro-bind", join(bridge.directory, "passwd"), "/etc/passwd", "--ro-bind", join(bridge.directory, "group"), "/etc/group",
      ...(options.managedSettings ? ["--ro-bind", options.managedSettings, "/etc/claude-code"] : []), "--clearenv"];
    const childEnv: Record<string, string> = { HOME: home, CLAUDE_CONFIG_DIR: versionHome ?? env.CLAUDE_CONFIG_DIR ?? home,
      PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ANTHROPIC_API_KEY: "offline-odysseus",
      ANTHROPIC_BASE_URL: "http://localhost", ANTHROPIC_UNIX_SOCKET: "/tmp/native-relay/relay.sock",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
    // These are public model selectors, never ambient provider credentials.
    for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"]) {
      if (env[key]) childEnv[key] = env[key]!;
    }
    if (/^sk-ant-api03-([a-z])\1{94}AA$/.test(env.ANTHROPIC_API_KEY ?? "")) childEnv.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY!;
    // The core runner's pinned synthetic OAuth fixture tests that auth route.
    // No other ambient OAuth value may enter the native environment.
    if (/^sk-ant-oat01-([a-z])\1{94}AA$/.test(env.CLAUDE_CODE_OAUTH_TOKEN ?? "")) {
      delete childEnv.ANTHROPIC_API_KEY;
      childEnv.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN!;
    }
    for (const [key, value] of Object.entries(childEnv)) argv.push("--setenv", key, value);
    argv.push("--chdir", cwd, "--", command, ...args);
    const audited = auditNativeLaunch(argv, () => { bridge.dispose(); if (versionHome) rmSync(versionHome, { recursive: true, force: true }); });
    return { ...audited, env: {} };
  } catch (error) { bridge.dispose(); if (versionHome) rmSync(versionHome, { recursive: true, force: true }); throw error; }
}

/** Inspect the concrete existing worker bootstrap, including its exec payload. */
export function nativeWorkerBoundary(env: Record<string, string | undefined>): { env: Record<string, string | undefined>; dispose(): void } {
  const unchanged = { env, dispose() {} };
  if (!env.BRAIN_WORKER_LAUNCH) return unchanged;
  let launch: { command?: string[]; argv?: string[]; env?: Record<string, string> } | null;
  try { launch = JSON.parse(env.BRAIN_WORKER_LAUNCH); } catch { return unchanged; }
  if (!launch?.command?.[0] || !isNativeClaude(launch.command[0], launch.command.slice(1))) return unchanged;
  qualify();
  const argv = launch.argv;
  if (!argv) refuse("native worker lacks the OS launcher");
  const bwrap = argv.findIndex(value => basename(value) === "bwrap");
  if (bwrap < 0) refuse("native worker lacks the OS launcher");
  // Even ordinary test workers use a private network and a single bridge.
  // Do not rely on SDK options or the production profile to establish this.
  const socket = launch.env?.ANTHROPIC_UNIX_SOCKET;
  const existingRelay = socket && launch.env?.ANTHROPIC_BASE_URL === "http://localhost";
  if (existingRelay) {
    const separator = argv.indexOf("--", bwrap);
    let admitted = false;
    for (let i = bwrap + 1; i < separator; i++) {
      if (argv[i] !== "--ro-bind" || !argv[i + 1] || !argv[i + 2] || !within(argv[i + 2]!, socket)) continue;
      const source = argv[i + 1]!, directory = realpathSync(source);
      if (!within(tmpdir(), directory) || directory === tmpdir() || directory !== source) continue;
      const path = join(directory, socket.slice(argv[i + 2]!.length));
      const info = lstatSync(path);
      if (info.isSocket() && info.uid === process.getuid?.()) admitted = true;
    }
    if (!admitted || !argv.includes("--unshare-net")) refuse("native worker relay is not fixture-owned isolated IPC");
  }
  // Existing restricted workers already have a server-owned exact-route relay.
  // The unused bridge in that case supplies only synthetic account files.
  const bridge = startNativeTestRelay(existingRelay ? "http://127.0.0.1:1" : launch.env?.ANTHROPIC_BASE_URL);
  try {
    for (let i = bwrap + 1; i < argv.indexOf("--", bwrap); i++) {
      if (argv[i] === "--ro-bind" && argv[i + 1] === "/" && argv[i + 2] === "/") argv.splice(i--, 3);
    }
    argv.splice(bwrap + 1, 0, "--unshare-net", ...systemMounts(), ...testRuntimeMounts(), "--ro-bind", process.execPath, process.execPath);
    const pinned = { ANTHROPIC_BASE_URL: "http://localhost", ANTHROPIC_UNIX_SOCKET: existingRelay ? socket : "/tmp/native-relay/relay.sock",
      ANTHROPIC_API_KEY: "offline-odysseus", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
    const separator = argv.indexOf("--", bwrap);
    argv.splice(separator, 0, "--ro-bind", bridge.directory, "/tmp/native-relay",
      "--ro-bind", join(bridge.directory, "passwd"), "/etc/passwd", "--ro-bind", join(bridge.directory, "group"), "/etc/group",
      ...Object.entries(pinned).flatMap(([key, value]) => ["--setenv", key, value]));
    const audited = auditNativeLaunch(argv, bridge.dispose);
    launch.argv = audited.argv;
    return { env: { ...env, BRAIN_WORKER_LAUNCH: JSON.stringify(launch) }, dispose: audited.dispose };
  } catch (error) { bridge.dispose(); throw error; }
}
