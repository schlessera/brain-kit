/** Test-only OS boundary for installed native Claude processes (#4313). */
import { cpSync, fstatSync, statfsSync, chmodSync, closeSync, mkdirSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

const ROOT = resolve(import.meta.dir, "..");
// Fixed Git metadata only. Discovery refusal must not recurse through admission.
const metadataSpawnSync = Bun.spawnSync.bind(Bun);
// Distribution-owned, read-only runtime bytes; never service/cache storage.
const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
const SYSTEM_FILES = ["/etc/ld.so.cache", "/etc/localtime", "/etc/os-release"];
const FORBIDDEN_BIND_ROOTS = new Set(["/", "/run", "/var/run", "/tmp", "/dev", "/dev/shm", "/home", "/var/lib", "/etc", "/var"]);
const WORKER_RUNTIME_ENV = new Set(["HOME", "CLAUDE_CONFIG_DIR", "LANG", "LC_ALL", "TERM", "SHELL", "USER", "LOGNAME", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "BRAIN_ROOT", "BRAIN_WORKER_DATA_ROOT", "BRAIN_WORKER_CONFIG_ROOT", "BRAIN_WORKER_SCRATCH", "BRAIN_WITHHELD_KEYS", "BRAIN_PROVIDER_RELAY_SOCKET",
  "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "ENABLE_TOOL_SEARCH"]);
const within = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
let qualified = false;
let bwrapExecutable = "bwrap", straceExecutable = "strace", socketPolicyExecutable = "";
let denied = 0, reported = 0;
export function nativeIsolationFailed(): boolean { return denied > 0; }
export function assertNoNativeRefusals(): void {
  if (denied <= reported) return;
  reported = denied;
  throw new Error("Offline native Claude isolation refused a launch during this test");
}
let head: string | undefined;
export function nativeTestHead(): string {
  if (head) return head;
  let value = "";
  try {
    const result = metadataSpawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) value = result.stdout.toString().trim();
  } catch { /* Containers carry the exact checkout identity without Git metadata. */ }
  return head = /^[0-9a-f]{40}$/.test(value) ? value
    : /^[0-9a-f]{40}$/.test(process.env.BRAIN_NATIVE_TEST_HEAD ?? "") ? process.env.BRAIN_NATIVE_TEST_HEAD! : "unavailable";
}

/** Metadata survives an outer fixture namespace's deliberate clearenv. */
export function nativeNamespaceEnvironment(): string[] {
  const values: Record<string, string> = { BRAIN_NATIVE_TEST_HEAD: nativeTestHead() };
  if (process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted") {
    values.GITHUB_ACTIONS = "true"; values.RUNNER_ENVIRONMENT = "github-hosted";
  }
  return Object.entries(values).flatMap(([name, value]) => ["--setenv", name, value]);
}

// Resolve from the installed SDK, exactly as its native package lookup does.
// This runs before test mocks can replace module resolution. No executable runs.
const installedRuntimes: { path: string; size: number }[] = [];
let discoveryFailed = false;
const sdkOwners = [...(existsSync(join(ROOT, "package.json")) ? [join(ROOT, "package.json")] : []), ...[...new Bun.Glob("packages/*/package.json").scanSync({ cwd: ROOT })].map(path => join(ROOT, path))];
function installedPackage(from: string, name: string): string | undefined {
  for (let directory = dirname(from); ; directory = dirname(directory)) {
    const path = join(directory, "node_modules", name, "package.json");
    if (existsSync(path)) return path;
    if (dirname(directory) === directory) return;
  }
}
const seenSdks = new Set<string>();
for (const owner of sdkOwners) {
  let required = false;
  try {
    const manifest = JSON.parse(readFileSync(owner, "utf8")) as Record<string, Record<string, string>>;
    required = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(key => Boolean(manifest[key]?.["@anthropic-ai/claude-agent-sdk"]));
    if (!installedPackage(owner, "@anthropic-ai/claude-agent-sdk")) {
      if (required) discoveryFailed = true;
      continue;
    }
    let sdk: string;
    try { sdk = realpathSync(createRequire(owner).resolve("@anthropic-ai/claude-agent-sdk")); }
    catch { if (required) discoveryFailed = true; continue; }
    if (seenSdks.has(sdk)) continue;
    seenSdks.add(sdk);
    const fromSdk = createRequire(sdk);
    const sdkManifest = JSON.parse(readFileSync(join(dirname(sdk), "package.json"), "utf8")) as { optionalDependencies?: Record<string, string> };
    const before = installedRuntimes.length;
    for (const name of Object.keys(sdkManifest.optionalDependencies ?? {}).filter(name => name.startsWith(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`))) {
      try {
        if (!installedPackage(sdk, name)) continue;
        const path = realpathSync(fromSdk.resolve(`${name}/claude${process.platform === "win32" ? ".exe" : ""}`));
        installedRuntimes.push({ path, size: statSync(path).size });
      } catch { /* The alternate libc package may not be installed. */ }
    }
    const cli = join(dirname(sdk), "cli.js");
    if (existsSync(cli)) installedRuntimes.push({ path: realpathSync(cli), size: statSync(cli).size });
    if (installedRuntimes.length === before) discoveryFailed = true;
  } catch { discoveryFailed = true; }
}

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
  const candidate = command.includes("/") ? resolve(cwd, command) : Bun.which(command, { cwd, PATH: path }) ?? resolve(cwd, command);
  // Inspect the accessible path first: realpath of an anonymous /proc fd can
  // return pipe:[N] or socket:[N], which is not itself a filesystem path.
  if (!statSync(candidate).isFile()) throw new Error("not a regular executable candidate");
  return realpathSync(candidate);
}

/** Every argv path remains a candidate, including the value after the first '='. */
function nativeExecutableCandidates(command: string, args: readonly unknown[]): string[] {
  return [command, ...args.flatMap(value => typeof value !== "string" ? [] :
    !value.startsWith("-") ? [value] : value.includes("=") ? [value.slice(value.indexOf("=") + 1)] : [])];
}

export function isNativeClaude(command: string, args: readonly unknown[] = [], options: SpawnContext = {}): boolean {
  if (discoveryFailed) refuse("installed SDK runtime discovery failed");
  for (const value of nativeExecutableCandidates(command, args)) {
    let path: string;
    try { path = resolveExecutable(value, options); } catch { continue; }
    if (installedRuntimes.some(runtime => runtime.path === path)) return true;
    // Size eliminates ordinary fixture scripts and interpreters before hashing.
    try {
      const metadata = statSync(path);
      if (!metadata.isFile()) continue;
      const size = metadata.size;
      const candidates = installedRuntimes.filter(runtime => runtime.size === size);
      if (candidates.length && candidates.some(runtime => fileHash(runtime.path) === fileHash(path))) return true;
    } catch { refuse("native executable metadata is unavailable"); }
  }
  return false;
}

function refuse(reason: string, mountEvidence?: Record<string, unknown>, compilerStderr?: string): never {
  denied++;
  // SDK callers may await an event that a refused launch can never emit.
  // End this failed test invocation after synchronous callers see the error.
  setImmediate(() => process.exit(1));
  // Classifications and mount evidence omit arguments/settings/credentials.
  // Compiler diagnostics are bounded and scrubbed before reaching this receipt.
  console.error(JSON.stringify({ kind: "native-offline-boundary", success: false, nativeLaunched: false, reason, head: nativeTestHead(), ...(mountEvidence ? { mountEvidence } : {}), ...(compilerStderr !== undefined ? { compilerStderr } : {}) }));
  throw new Error(`Offline native Claude refused before launch: ${reason}`);
}

export function refuseNativeClaude(command: string, args: readonly unknown[] = [], options: SpawnContext = {}): void {
  if (isNativeClaude(command, args, options)) refuse("OS isolation has not been qualified");
}

function qualify(): void {
  // Positive native proof is reserved for disposable hosted runners. Namespace
  // availability on a developer machine never authorizes a native test launch.
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    refuse("isolation unavailable: positive native proof requires a hosted runner");
  }
  if (qualified) return;
  let result: ReturnType<typeof Bun.spawnSync>;
  try { result = Bun.spawnSync(["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "/usr/bin/true"],
  { env: {}, stdout: "pipe", stderr: "pipe", timeout: 5000 }); }
  catch { refuse("OS namespace setup failed"); }
  if (result.exitCode !== 0) refuse("OS namespace setup failed");
  let trace: ReturnType<typeof Bun.spawnSync>;
  try { trace = Bun.spawnSync(["strace", "-I", "1", "--kill-on-exit", "-qq", "-e", "trace=connect", "-e", "raw=connect", "/usr/bin/true"],
    { env: {}, stdout: "pipe", stderr: "pipe", timeout: 5000 }); }
  catch { refuse("native connection audit setup failed"); }
  if (trace.exitCode !== 0) refuse("native connection audit setup failed");
  bwrapExecutable = Bun.which("bwrap") ?? refuse("OS namespace setup failed");
  straceExecutable = Bun.which("strace") ?? refuse("native connection audit setup failed");
  const policy = compileSocketPolicy();
  let socketProof: ReturnType<typeof Bun.spawnSync>;
  try { socketProof = Bun.spawnSync([policy, "--probe", nativeTestHead()], { env: {}, stdout: "pipe", stderr: "pipe", timeout: 5000 }); }
  catch { refuse("native socket lifetime policy unavailable"); }
  if (socketProof.exitCode !== 0) refuse("native socket lifetime policy unavailable");
  qualified = true;
}

export const RTK_SOCKET_POLICY = "/usr/local/bin/brain-native-connect";
// Isolated preload fixtures copy only the guard closure. Load the existing
// receipt scrubbers only for diagnostics, and never fall back to raw text.
function diagnosticRedactors() {
  const require = createRequire(import.meta.url);
  return {
    createRedactor: (require("../packages/compute-boat/src/redact.ts") as typeof import("../packages/compute-boat/src/redact")).createRedactor,
    redactCredentials: (require("../packages/ui-server/src/activity/runtime-status.ts") as typeof import("../packages/ui-server/src/activity/runtime-status")).redactCredentials,
    redactProviderMessage: (require("../packages/ui-react/src/lib/turn-failure.ts") as typeof import("../packages/ui-react/src/lib/turn-failure")).redactProviderMessage,
  };
}
function compilerDiagnostic(value: string): string {
  try {
  const {createRedactor,redactCredentials,redactProviderMessage}=diagnosticRedactors();
  const redactor = createRedactor(undefined);
  for (const [key, secret] of Object.entries(process.env)) if (/secret|token|password|credential|api.?key/i.test(key) && secret) redactor.add(secret);
  let text = Buffer.from(value).subarray(0, 4096).toString("utf8");
  if (Buffer.byteLength(value) > 4096) text = text.slice(0, Math.max(0, text.lastIndexOf("\n")));
  return redactProviderMessage(redactCredentials(redactor.text(text))).slice(0, 4096);
  } catch { return "[diagnostic redaction unavailable]"; }
}
/** Prepare before a fixture hides compiler inputs such as /etc/alternatives. */
export function nativeNamespacePolicy(): { mounts: string[]; args: string[] } {
  const policy = compileSocketPolicy();
  return { mounts: ["--ro-bind", policy, RTK_SOCKET_POLICY],
    args: ["--native-policy-view", `--native-socket-policy-sha256=${fileHash(policy)}`] };
}

/** Compile in the outer test process; namespace re-entry receives only this artifact. */
export function compileSocketPolicy(): string {
  if (socketPolicyExecutable) return socketPolicyExecutable;
  if (process.argv.includes("--native-rtk-view") || process.argv.includes("--native-policy-view")) {
    const digest = process.argv.find(value => value.startsWith("--native-socket-policy-sha256="))?.split("=")[1];
    try {
      const info = lstatSync(RTK_SOCKET_POLICY);
      if (!/^[0-9a-f]{64}$/.test(digest ?? "") || !info.isFile() || (info.mode & 0o222) || fileHash(RTK_SOCKET_POLICY) !== digest) throw Error("invalid artifact");
    } catch { return refuse("native socket policy artifact is unavailable or changed"); }
    return socketPolicyExecutable = RTK_SOCKET_POLICY;
  }
  const directory = mkdtempSync(join(tmpdir(), "odysseus-native-policy-"));
  const executable = join(directory, "native-connect");
  let compiled: ReturnType<typeof Bun.spawnSync>;
  try { compiled = metadataSpawnSync(["cc", "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror",
    join(import.meta.dir, "native-proof/native-connect.c"), "-o", executable],
    { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdout: "pipe", stderr: "pipe", timeout: 30000 }); }
  catch (error) { rmSync(directory, { recursive: true, force: true }); return refuse("native socket policy compiler unavailable", undefined, compilerDiagnostic(String(error))); }
  if (compiled.exitCode !== 0) { rmSync(directory, { recursive: true, force: true }); return refuse("native socket policy compilation failed", undefined, compilerDiagnostic(compiled.stderr?.toString() ?? "(no compiler stderr)")); }
  chmodSync(executable, 0o555); chmodSync(directory, 0o555);
  socketPolicyExecutable = executable;
  process.on("exit", () => { chmodSync(directory, 0o700); rmSync(directory, { recursive: true, force: true }); });
  return executable;
}

/** Kernel policy persists across native exec/fork and emulates only the pinned relay connection. */
function nativeSocketCommand(command: string[], source: string, allowed: string): string[] {
  const origin = ownedSocketOrigin(source), route = scriptedRoute.getStore();
  if (!origin || !route || normalizedOrigin(origin) !== normalizedOrigin(route.origin)) refuse("native socket policy lacks scripted authority");
  const info = lstatSync(realpathSync(source), { bigint: true });
  return [compileSocketPolicy(), "--head", nativeTestHead(), "--socket", allowed, "--device", String(info.dev),
    "--inode", String(info.ino), "--allowed", allowed, "--", ...command];
}

function systemMounts(): string[] {
  const argv: string[] = [];
  for (const path of SYSTEM) {
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink()) argv.push("--symlink", readlinkSync(path), path);
    else argv.push("--ro-bind", path, path);
  }
  // No host account database or managed configuration enters the native view.
  for (const path of SYSTEM_FILES) {
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

/** Read-only fixture tool directories, without exposing their sibling storage. */
function fixtureToolView(env: Record<string, string | undefined>, cwd: string, home?: string): { mounts: string[]; path: string } {
  const roots = new Set<string>(), storage = new Set<string>();
  for (const input of [cwd, home]) {
    if (!input) continue;
    try {
      const path = realpathSync(input);
      storage.add(path);
      if (!within(tmpdir(), path) || path === tmpdir()) continue;
      roots.add(path);
      const parent = dirname(path), info = statSync(parent);
      if (parent !== tmpdir() && within(tmpdir(), parent) && info.uid === process.getuid?.() && (info.mode & 0o077) === 0) roots.add(parent);
    } catch { /* A worker's fresh runtime home may not exist on the host. */ }
  }
  const directories = new Set<string>();
  for (const input of env.PATH?.split(":") ?? []) {
    if (!input) continue;
    try {
      const path = realpathSync(resolve(cwd, input)), info = statSync(path);
      if (!info.isDirectory()) continue;
      // Never expose a common fixture ancestor: it can hold a sentinel or
      // unrelated storage outside HOME. Existing HOME/cwd mounts stay writable.
      if (!storage.has(path) && [...storage].some(root => within(path, root))) continue;
      const source = [join(ROOT, "packages"), join(ROOT, "tests/fixtures"), join(ROOT, "scripts/fixtures")].some(root => within(root, path));
      const temporary = [...roots].some(root => within(root, path)) && info.uid === process.getuid?.();
      if (source || temporary) directories.add(path);
    } catch { /* Missing PATH entries do not grant filesystem authority. */ }
  }
  return { mounts: [...directories].filter(path => !storage.has(path)).flatMap(path => ["--ro-bind", path, path]),
    path: [...new Set([...directories, dirname(process.execPath), "/usr/bin", "/bin"])].join(":") };
}

interface AuditReceipt { kind: "native-offline-audit"; head: string; nativeLaunched: boolean; success: boolean; reason?: string; deniedConnects: number }
interface Boundary { beforeLaunch(): void; argv: string[]; env: Record<string, string>; dispose(): void; receipt(): AuditReceipt }

const generatedCredentials = new Map<string, string>();
/** Create and mark a clearly synthetic value; ambient strings cannot self-mark. */
export function nativeSyntheticCredential(key: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" | "CLAUDE_CODE_OAUTH_TOKEN"): string {
  if (!["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].includes(key)) refuse("invalid synthetic credential kind");
  const value = `${key === "CLAUDE_CODE_OAUTH_TOKEN" ? "sk-ant-oat01-" : ""}offline-odysseus-${crypto.randomUUID()}`;
  generatedCredentials.set(value, key); return value;
}
/** Retain only public synthetic credentials, including their absent/both cases. */
function syntheticCredentials(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  if (env.ANTHROPIC_API_KEY) result.ANTHROPIC_API_KEY = /^sk-ant-api03-([a-z])\1{94}AA$/.test(env.ANTHROPIC_API_KEY) ? env.ANTHROPIC_API_KEY : "offline-fixture";
  if (/^sk-ant-oat01-([a-z])\1{94}AA$/.test(env.CLAUDE_CODE_OAUTH_TOKEN ?? "")) result.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN!;
  if (/^sk-ant-declared-t{60}$/.test(env.ANTHROPIC_AUTH_TOKEN ?? "")) result.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN!;
  for (const [key, value] of Object.entries(env)) if (value && generatedCredentials.get(value) === key) result[key] = value;
  return result;
}

/** Raw connect arguments are pointers/numbers: no addresses, paths or payloads. */
export function deniedNativeConnects(trace: string): number {
  return trace.split("\n").filter(line => /(?:connect\(|connect resumed>).*?= -1 (?:EACCES|EPERM|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ENOENT)\b/.test(line)).length;
}

/** A successful exec trace for the expected program is the launch evidence. */
export function nativeExecObserved(trace: string, paths: readonly string[]): boolean {
  return trace.split("\n").some(line => paths.some(path => line.includes(`execve(${JSON.stringify(path)},`)) && /\)\s+= 0$/.test(line.trim()));
}

const AUDIT_ACL = `import os,struct,sys
operation,uid,directory,log=sys.argv[1:]
uid=int(uid)
def acl(owner,worker):
 return struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perms,identity) for tag,perms,identity in [(1,owner,0xffffffff),(2,worker,uid),(4,0,0xffffffff),(16,worker,0xffffffff),(32,0,0xffffffff)])
for path,value in [(directory,acl(7,3)),(log,acl(6,2))]:
 if operation=='set': os.setxattr(path,'system.posix_acl_access',value,follow_symlinks=False)
 else: assert os.getxattr(path,'system.posix_acl_access',follow_symlinks=False)==value
`;
function auditAcl(operation: "set" | "check", uid: number, directory: string, log: string): boolean {
  try { return metadataSpawnSync(["/usr/bin/python3", "-I", "-S", "-c", AUDIT_ACL, operation, String(uid), directory, log], { stdout: "pipe", stderr: "pipe" }).exitCode === 0; }
  catch { return false; }
}

/** Fixture-only tail: no syscall buffers, exec arguments or environment survive. */
export function scrubNativeStartupTrace(trace: string): string {
  try {
  const {createRedactor,redactCredentials,redactProviderMessage}=diagnosticRedactors();
  let tail = trace.slice(-65536);
  if (trace.length > tail.length) tail = tail.includes("\n") ? tail.slice(tail.indexOf("\n") + 1) : "";
  tail = tail.split("\n").map(line => line.replace(/\bexecve(?:at)?\(.*$/, "execve([arguments omitted])")).join("\n");
  const redactor = createRedactor(undefined);
  for (const [key, secret] of Object.entries(process.env)) if (/secret|token|password|credential|api.?key/i.test(key) && secret) redactor.add(secret);
  return redactProviderMessage(redactCredentials(redactor.text(tail))).slice(-65536);
  } catch { return "[diagnostic redaction unavailable]"; }
}

export function auditNativeLaunch(argv: string[], expected: readonly string[], cleanup: () => void, workerUid?: number) {
  const diagnosticRoot = workerUid === undefined ? undefined : process.argv.find(value => value.startsWith("--native-identity-startup-audit="))?.slice("--native-identity-startup-audit=".length);
  if (diagnosticRoot) {
    const info = lstatSync(diagnosticRoot);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) refuse("native startup audit storage is not private");
  }
  const directory = mkdtempSync(join(tmpdir(), "odysseus-native-audit-"));
  const log = join(directory, "connect.log");
  writeFileSync(log, "", { mode: 0o600 });
  if (workerUid !== undefined && !auditAcl("set", workerUid, directory, log)) {
    cleanup(); rmSync(directory, { recursive: true, force: true }); refuse("native audit access isolation is unavailable");
  }
  const owner = process.getuid?.(), directoryStamp = lstatSync(directory, { bigint: true }), logStamp = lstatSync(log, { bigint: true });
  const storageIntact = () => {
    try {
      const folder = lstatSync(directory, { bigint: true }), file = lstatSync(log, { bigint: true });
      return folder.isDirectory() && file.isFile() && folder.uid === BigInt(owner!) && file.uid === BigInt(owner!)
        && folder.dev === directoryStamp.dev && folder.ino === directoryStamp.ino && file.dev === logStamp.dev && file.ino === logStamp.ino
        && (folder.mode & 0o7777n) === (workerUid === undefined ? 0o700n : 0o730n)
        && (file.mode & 0o7777n) === (workerUid === undefined ? 0o600n : 0o620n)
        && (workerUid === undefined || auditAcl("check", workerUid, directory, log));
    } catch { return false; }
  };
  let receipt: AuditReceipt | undefined;
  const finish = (): AuditReceipt => {
    if (receipt) return receipt;
    try {
      if (!storageIntact()) {
        denied++;
        receipt = { kind: "native-offline-audit", head: nativeTestHead(), nativeLaunched: false, success: false, reason: "native audit storage integrity failed", deniedConnects: 0 };
        console.error(JSON.stringify(receipt)); return receipt;
      }
      let trace = "";
      try { trace = readFileSync(log, "utf8"); } catch { /* Missing evidence is a failed receipt. */ }
      if (diagnosticRoot) {
        try { writeFileSync(join(diagnosticRoot, `native-startup-audit-${directoryStamp.ino}.json`),
          JSON.stringify({ kind: "native-fixture-startup-audit", head: nativeTestHead(), text: scrubNativeStartupTrace(trace) }), { flag: "wx", mode: 0o600 }); }
        catch { console.error(JSON.stringify({kind:"native-fixture-startup-audit-failure",head:nativeTestHead(),success:false,reason:"startup audit snapshot unavailable"})); }
      }
      // Wider diagnostics may contain syscall-looking filenames; only actual
      // connect/exec records participate in the security receipt.
      const auditTrace = diagnosticRoot ? trace.split("\n").filter(line => /^\s*(?:[0-9]+\s+)?(?:execve\(|connect\(|<\.\.\. connect resumed>)/.test(line)).join("\n") : trace;
      const nativeLaunched = nativeExecObserved(auditTrace, expected);
      if (!nativeLaunched) denied++;
      receipt = { kind: "native-offline-audit", head: nativeTestHead(), nativeLaunched, success: nativeLaunched,
        ...(!nativeLaunched ? { reason: "native exec was not observed" } : {}), deniedConnects: deniedNativeConnects(auditTrace) };
      console.error(JSON.stringify(receipt));
      return receipt;
    } finally { cleanup(); rmSync(directory, { recursive: true, force: true }); }
  };
  // -o otherwise makes strace ignore SIGTERM; refusal/cancellation must kill
  // both the tracer and its entire traced sandbox, closing inherited pipes.
  return { argv: [straceExecutable, "-I", "1", "--kill-on-exit", "-f", "-qq", "-s", "0", "-e", diagnosticRoot ? "trace=connect,%file,%process,mmap,mprotect,munmap,brk,prlimit64,getrlimit,prctl,io_uring_setup,pidfd_open,pidfd_getfd,rt_sigaction,rt_sigprocmask,sched_getaffinity,rseq,futex" : "trace=connect,execve", "-e", "raw=connect", "-o", log, "--", ...argv],
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
  writeFileSync(join(directory, "passwd"), `${uid === 0 ? "" : "root:x:0:0:Odysseus:/tmp/native-account:/bin/sh\n"}odysseus:x:${uid}:${gid}:Odysseus:/tmp/native-account:/bin/sh\n`);
  writeFileSync(join(directory, "group"), `${gid === 0 ? "" : "root:x:0:\n"}odysseus:x:${gid}:\n`);
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    // Concatenate onto the fixed authority; never resolve a request-controlled
    // path as a relative URL, where // or backslashes could replace that host.
    const outbound = new URL(target.origin + url.pathname + url.search);
    if (url.origin !== "http://localhost" || !url.pathname.startsWith("/") || url.pathname.startsWith("//") ||
        url.pathname.includes("\\") || outbound.origin !== target.origin) {
      denied++;
      console.error(JSON.stringify({ kind: "native-offline-route-denial", success: false, reason: "unintended native destination", head: nativeTestHead() }));
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

function expectedNativeExec(command: string, args: readonly string[], options: SpawnContext): string[] {
  const native = nativeExecutableCandidates(command, args).filter(value => isNativeClaude(value, [], options));
  return [...new Set(native.flatMap(value => [resolve(options.cwd ?? process.cwd(), value), resolveExecutable(value, options)]))];
}

/** Direct SDK launch: empty filesystem, fresh PID/network namespaces, one IPC. */
export function nativeClaudeBoundary(command: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; managedSettings?: string }): Boundary {
  qualify();
  const env = options.env ?? process.env;
  const route = scriptedRoute.getStore();
  if (!route) refuse("scripted service authority was not registered");
  const versionOnly = args.at(-1) === "--version";
  const versionHome = versionOnly ? mkdtempSync(join(tmpdir(), "odysseus-native-version-")) : undefined;
  const cwd = versionHome ?? realpathSync(options.cwd ?? process.cwd());
  const home = versionHome ?? (env.HOME && realpathSync(env.HOME));
  if (!home || !within(tmpdir(), home) || home === tmpdir() || cwd === tmpdir() || !within(tmpdir(), cwd) && !within(ROOT, cwd)) {
    refuse("native launch requires fixture-owned storage");
  }
  const inheritedSocket = env.ANTHROPIC_UNIX_SOCKET;
  const inheritedOrigin = inheritedSocket ? ownedSocketOrigin(inheritedSocket) : undefined;
  if (inheritedSocket && !inheritedOrigin) refuse("pre-existing native relay is not guard-owned");
  if (inheritedOrigin && (!scriptedRoute.getStore() || normalizedOrigin(inheritedOrigin) !== normalizedOrigin(scriptedRoute.getStore()!.origin))) refuse("native relay did not match scripted authority");
  const bridge = startNativeTestRelay(route.origin);
  try {
    const tools = fixtureToolView(env, cwd, home);
    command = resolveExecutable(command, options);
    const executable = realpathSync(command);
    const mounts = [...systemMounts(),
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", ...testRuntimeMounts(),
      "--ro-bind", executable, command, "--ro-bind", process.execPath, process.execPath, "--ro-bind", compileSocketPolicy(), compileSocketPolicy(), "--bind", home, home,
      ...(cwd === ROOT || within(ROOT, cwd) || within(home, cwd) ? [] : ["--bind", cwd, cwd]),
      ...tools.mounts,
      "--ro-bind", bridge.directory, "/tmp/native-relay",
      "--ro-bind", join(bridge.directory, "passwd"), "/etc/passwd", "--ro-bind", join(bridge.directory, "group"), "/etc/group",
      ...(inheritedSocket && inheritedOrigin ? ["--ro-bind", inheritedSocket, "/tmp/native-relay/relay.sock", "--ro-bind", inheritedSocket, inheritedSocket] : []),
      ...(options.managedSettings ? ["--ro-bind", options.managedSettings, "/etc/claude-code"] : []),];
    const beforeLaunch = () => assertNativeMountSockets(mounts, route.origin);
    beforeLaunch();
    const argv = [bwrapExecutable, "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", ...mounts, "--clearenv"];
    const childEnv: Record<string, string> = { HOME: home, CLAUDE_CONFIG_DIR: versionHome ?? env.CLAUDE_CONFIG_DIR ?? home,
      PATH: tools.path, LANG: "C.UTF-8",
      ANTHROPIC_BASE_URL: "http://localhost", ANTHROPIC_UNIX_SOCKET: "/tmp/native-relay/relay.sock",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
    // These are public model selectors, never ambient provider credentials.
    for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "ENABLE_TOOL_SEARCH"]) {
      if (env[key]) childEnv[key] = env[key]!;
    }
    Object.assign(childEnv, syntheticCredentials(env));
    if (["0", "1"].includes(env.USE_BUILTIN_RIPGREP ?? "")) childEnv.USE_BUILTIN_RIPGREP = env.USE_BUILTIN_RIPGREP!;
    if (inheritedOrigin) Object.assign(childEnv, relayCredentialPlaceholders(env));
    if (args.some((value, index) => value === "auth" && args[index + 1] === "status")) {
      // Auth status inspects the isolated fixture login; injecting an API key
      // would change the very authentication method the fixture is testing.
      for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_UNIX_SOCKET"]) delete childEnv[key];
    }
    for (const [key, value] of Object.entries(childEnv)) argv.push("--setenv", key, value);
    argv.push("--chdir", cwd, "--", ...nativeSocketCommand([command, ...args], inheritedSocket && inheritedOrigin ? inheritedSocket : join(bridge.directory, "relay.sock"), "/tmp/native-relay/relay.sock"));
    const audited = auditNativeLaunch(argv, expectedNativeExec(command, args, options), () => { bridge.dispose(); if (versionHome) rmSync(versionHome, { recursive: true, force: true }); });
    beforeLaunch();
    return { ...audited, env: {}, beforeLaunch };
  } catch (error) { bridge.dispose(); if (versionHome) rmSync(versionHome, { recursive: true, force: true }); throw error; }
}

interface ScriptedAuthority { origin: string; fixtureRoots: readonly string[]; fixtureRootStamps: ReadonlyMap<string,{dev:bigint;ino:bigint}>; fixtureFiles: ReadonlyMap<string, Uint8Array> }
const scriptedRoute = new AsyncLocalStorage<ScriptedAuthority | undefined>();

/** Test code pins its scripted service before building a restricted turn. */
export function nativeScriptedService(origin: string, fixture?: { fixtureRoots?: readonly string[]; fixtureFiles?: readonly string[] }): () => void {
  const previous = scriptedRoute.getStore();
  scriptedRoute.enterWith(undefined);
  let target:URL;try{target=new URL(origin);}catch{refuse("invalid scripted route authority");}
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !target.port || target.username || target.password || target.pathname !== "/" || target.search || target.hash) refuse("invalid scripted route authority");
  const prior = previous?.origin === target.origin ? previous : undefined;
  let authority: ScriptedAuthority;
  try {
  const fixtureRoots = fixture?.fixtureRoots?.map(path => {
    let real:string;try{real=realpathSync(path);}catch{refuse("fixture root registration is unavailable");}
    if (FORBIDDEN_BIND_ROOTS.has(real) || !statSync(real).isDirectory()) refuse("invalid fixture root registration");
    return real;
  }) ?? prior?.fixtureRoots ?? [];
  const fixtureRootStamps = fixture?.fixtureRoots ? new Map(fixtureRoots.map(path=>{const info=lstatSync(path,{bigint:true});return [path,{dev:info.dev,ino:info.ino}] as const;})) : prior?.fixtureRootStamps ?? new Map<string,{dev:bigint;ino:bigint}>();
  const fixtureFiles = fixture?.fixtureFiles ? new Map(fixture.fixtureFiles.map(path => {
    let real:string;try{real=realpathSync(path);}catch{refuse("fixture file registration is unavailable");}
    if (!lstatSync(path).isFile()) refuse("fixture file registration requires a regular file");
    return [real, new Uint8Array(readFileSync(real))] as const;
  })) : prior?.fixtureFiles ?? new Map<string, Uint8Array>();
  authority = Object.freeze({ origin: target.origin, fixtureRoots, fixtureRootStamps, fixtureFiles });
  } catch(error) { if(String(error).includes("Offline native Claude refused before launch:"))throw error;refuse("fixture registration is unavailable"); }
  scriptedRoute.enterWith(authority);
  return () => { if(scriptedRoute.getStore()===authority)scriptedRoute.enterWith(previous); };
}

/** Keep fixture authority at the SDK's existing spawn hook, across its async work. */
export function nativeScriptedQuery(query: typeof sdkQuery, origin: string): typeof sdkQuery {
  const captured = scriptedRoute.getStore();
  return input => {
    const spawn = input.options?.spawnClaudeCodeProcess;
    if (!spawn) return query(input);
    return query({ ...input, options: { ...input.options, spawnClaudeCodeProcess: options => {
      const prior = scriptedRoute.getStore();
      const leave = nativeScriptedService(origin, {fixtureRoots:[],fixtureFiles:[]});
      if (captured?.origin === new URL(origin).origin) scriptedRoute.enterWith(captured);
      try { return spawn(options); } finally { leave(); scriptedRoute.enterWith(prior); }
    } } });
  };
}

const relayForwarding = new AsyncLocalStorage<Readonly<{ origin: string }>>();
const ownedRelaySockets = new Map<string, { path: string; origin: string; dev: bigint; ino: bigint; isLive(): boolean }>();
const socketIdentity = (stat: { dev: bigint; ino: bigint }) => `${stat.dev}:${stat.ino}`;

const ownedHttpServers = new WeakMap<object, Readonly<{ origin: string }>>();
function rememberRelay(path: string, origin: string, isLive: () => boolean = () => true): () => void {
  const stat = lstatSync(path, { bigint: true });
  const key = socketIdentity(stat), authority = { path, origin, dev: stat.dev, ino: stat.ino, isLive };
  ownedRelaySockets.set(key, authority);
  return () => { if (ownedRelaySockets.get(key) === authority) ownedRelaySockets.delete(key); };
}

export function guardNativeHttpListen(server: object, args: unknown[]): void {
  const route = scriptedRoute.getStore();
  const first = args[0] as string | { path?: string } | undefined;
  const path = typeof first === "string" ? first : first?.path;
  if (!route || !path?.startsWith("/")) return;
  ownedHttpServers.set(server, route);
  const events = server as { once(event: string, callback: () => void): void };
  events.once("listening", () => { const forget = rememberRelay(path, route.origin, () => (server as { listening: boolean }).listening); events.once("close", forget); });
}

export function guardNativeHttpEvent(server: object, event: unknown, invoke: () => unknown): unknown {
  const route = ownedHttpServers.get(server);
  return route && (event === "request" || event === "connect") ? relayForwarding.run(route, invoke) : invoke();
}

/** The guard creates the server and binds every transport in its handler. */
export function guardNativeRelayServer(options: any, create: (options: any) => any): any {
  const route = scriptedRoute.getStore();
  if (!route || typeof options.unix !== "string" || typeof options.fetch !== "function") return create(options);
  const original = options.fetch;
  const server = create({ ...options, fetch: function(this: unknown, ...args: unknown[]) {
    return relayForwarding.run(route, () => Reflect.apply(original, this, args));
  } });
  const forget = rememberRelay(options.unix, route.origin), stop = server.stop;
  // A hard link names the same live socket; a stopped server never leaves
  // admission authority behind for a later object that reuses its inode.
  server.stop = function(...args: unknown[]) { forget(); return Reflect.apply(stop, server, args); };
  return server;
}

function normalizedOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin;
}

export function assertNativeRelayDestination(url: URL): void {
  const route = relayForwarding.getStore();
  if (!route) return;
  const target = new URL(route.origin), requested = new URL(url);
  if (target.hostname === "localhost") target.hostname = "127.0.0.1";
  if (requested.hostname === "localhost") requested.hostname = "127.0.0.1";
  if (requested.origin === target.origin) return;
  denied++;
  console.error(JSON.stringify({ kind: "native-offline-route-denial", success: false, reason: "unintended relay destination", head: nativeTestHead() }));
  throw new Error("Native relay refused an unintended destination");
}

export function assertNativeRelaySocket(host: string, port: unknown): void {
  if (!relayForwarding.getStore()) return;
  assertNativeRelayDestination(new URL(`http://${host === "::1" ? "[::1]" : host}:${port}`));
}

export function assertNativeRelayUnix(path: string): void {
  const route = relayForwarding.getStore();
  if (!route) return;
  let origin: string | undefined;
  try { origin = ownedSocketOrigin(path); } catch { /* Unknown socket. */ }
  if (origin && normalizedOrigin(origin) === normalizedOrigin(route.origin)) return;
  assertNativeRelayDestination(new URL("http://unowned-native-ipc.invalid"));
}

function relayCredentialPlaceholders(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].map(key =>
    [key, env[key] === "brain-inference-relay-placeholder" ? env[key]! : ""]));
}

function ownedSocketOrigin(path: string): string | undefined {
  let real: string;
  try { real = realpathSync(path); } catch { return; }
  const stat = lstatSync(real, { bigint: true });
  const authority = ownedRelaySockets.get(socketIdentity(stat));
  if (!authority?.isLive()) return;
  return stat.isSocket() && stat.dev === authority.dev && stat.ino === authority.ino ? authority.origin : undefined;
}

function socketMatchesOrigin(path:string,origin:string):boolean {
  const peer=ownedSocketOrigin(path);return Boolean(peer&&normalizedOrigin(peer)===normalizedOrigin(origin));
}

function admittedRelay(argv: string[], socket: string): { origin: string; path: string } | undefined {
  for (let i = 0; i < argv.length - 2; i++) {
    if (!["--ro-bind", "--bind"].includes(argv[i]!) || !within(argv[i + 2]!, socket)) continue;
    const path = join(argv[i + 1]!, socket.slice(argv[i + 2]!.length));
    let real: string;
    try { real = realpathSync(path); } catch { continue; }
    const stat = lstatSync(real, { bigint: true });
    const authority = ownedRelaySockets.get(socketIdentity(stat));
    if (!authority?.isLive()) continue;
    if (!stat.isSocket() || stat.dev !== authority.dev || stat.ino !== authority.ino) continue;
    // A directory bind exposes its whole subtree, including symlink aliases.
    // No socket in that view may escape the same live scripted authority.
    const directory = statSync(argv[i + 1]!).isDirectory() ? argv[i + 1]! : undefined;
    if (directory && !relaySubtreeOwned(directory, authority.origin)) return;
    return { origin: authority.origin, path: real };
  }
}

function mountInputEvidence(input: string, destination: string, index: number, error: unknown, fixtureRoots: readonly string[] = []): Record<string,unknown> {
  const fixture=fixtureRoots.find(root=>within(root,resolve(input)));
  const known=SYSTEM.includes(input)||SYSTEM_FILES.includes(input);
  const targetFixture=fixtureRoots.find(root=>within(root,resolve(destination)));
  const workspaceTarget=within(ROOT,resolve(destination));
  return { mount:index,
    ...(targetFixture?{targetFixtureRoot:fixtureRoots.indexOf(targetFixture),targetRelativePath:resolve(destination).slice(targetFixture.length).replace(/^\//,"")||"."}:workspaceTarget?{targetWorkspacePath:resolve(destination).slice(ROOT.length).replace(/^\//,"")}:{}), sourceKind:known?"fixed-system":input.startsWith("/proc/")?"descriptor":fixture?"registered-fixture":"unregistered-source",
    ...(known?{systemRoot:input}:fixture?{fixtureRoot:fixtureRoots.indexOf(fixture),relativePath:resolve(input).slice(fixture.length).replace(/^\//,"")}:{}),
    targetKind:destination.startsWith("/etc/")?"isolated-config":destination.startsWith("/tmp/")?"fixture-temporary":"runtime-or-fixture",
    metadataError:(error as NodeJS.ErrnoException)?.code??"UNKNOWN" };
}

/** Validate the same bind-source inventory used to construct the native view. */
function assertNativeMountSockets(mounts: readonly string[], origin: string, keeper?: KeeperInspection): void {
  const roots: string[] = [];
  for (let i = 0; i < mounts.length; i++) {
    const flag = mounts[i]!;
    if (flag.startsWith("--overlay") || flag.includes("bind-fd")) refuse("unsupported native mount source");
    if (["--bind", "--ro-bind", "--dev-bind", "--bind-try", "--ro-bind-try", "--dev-bind-try"].includes(flag)) {
      const input = mounts[i + 1]!, destination = resolve(mounts[i + 2]!);
      if (FORBIDDEN_BIND_ROOTS.has(resolve(input)) || FORBIDDEN_BIND_ROOTS.has(destination)) refuse("native bind exposes a forbidden host service root");
      let source: string;
      try { source = inspectedWorkerSource(input, keeper); } catch(error) { refuse("native mount source is unavailable",mountInputEvidence(input,destination,i,error,scriptedRoute.getStore()?.fixtureRoots)); }
      if (FORBIDDEN_BIND_ROOTS.has(source)) refuse("native bind exposes a forbidden host service root");
      const system = [...SYSTEM, ...SYSTEM_FILES].some(path => {
        try { return destination === path && source === realpathSync(path); } catch { return false; }
      });
      if (flag !== "--ro-bind" && (system || SYSTEM.some(root => { try { return within(realpathSync(root), source); } catch { return false; } }))) refuse("native system mounts must be read-only");
      // No recursive walk of the fixed distribution view. All other binds,
      // including fixture tools, homes, caches and relay storage, fail closed.
      if (!system) roots.push(source);
      i += 2;
    }
  }
  const fixturePath = (path: string) => {
    const root = roots.filter(root => within(root, path)).sort((a,b) => b.length-a.length)[0];
    if (!root) return { storage: "outside-mount-inventory" };
    const mount = roots.indexOf(root);
    // Only constant OS roots may be identified outside synthetic fixture storage.
    const systemRoot = SYSTEM.find(path => { try { return realpathSync(path) === root; } catch { return false; } });
    const fixture = within(ROOT, root) || within(tmpdir(), root);
    return fixture
      ? { mount, storage: within(ROOT, root) ? "workspace-fixture" : "temporary-fixture", relativePath: path.slice(root.length).replace(/^\//, "") || "." }
      : { mount, storage: "outside-fixture", source: systemRoot ? "system-runtime" : "other-bound-source", ...(systemRoot ? { systemRoot } : {}) };
  };
  let refusedSocket: Record<string, unknown> | undefined;
  let inspected = "", metadataError: string | undefined;
  const visited = new Set<string>();
  const visit = (path: string): boolean => {
    inspected = path;
    let real: string;
    try { real = realpathSync(path); } catch (error) {
      // Every missing or unreadable non-system entry refuses.
      metadataError = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      return false;
    }
    // Aliases into fixed distribution roots follow the same read-only policy;
    // aliases into unmounted storage are inaccessible in the child.
    if (real !== path && SYSTEM.some(root => { try { return within(realpathSync(root), real); } catch { return false; } }) || !roots.some(root => within(root, real))) return true;
    const info = lstatSync(real, { bigint: true });
    if (info.isSocket()) {
      const peer = ownedSocketOrigin(real);
      const allowed = Boolean(peer && normalizedOrigin(peer) === normalizedOrigin(origin));
      if (!allowed) refusedSocket = { ...fixturePath(real), device: String(info.dev), inode: String(info.ino) };
      return allowed;
    }
    if (!info.isDirectory()) return true;
    const key = socketIdentity(info);
    if (visited.has(key)) return true;
    visited.add(key);
    return readdirSync(real).every(name => visit(join(real, name)));
  };
  try { if (roots.every(visit)) return; } catch (error) { metadataError = (error as NodeJS.ErrnoException).code ?? "UNKNOWN"; }
  refuse("fixture storage contains an unowned Unix socket or directory alias", {
    refusedSocket: refusedSocket ?? { ...fixturePath(inspected), metadataError: metadataError ?? "UNKNOWN" },
    ownedSockets: [...ownedRelaySockets.values()].map(socket => ({ ...fixturePath(socket.path), device: String(socket.dev), inode: String(socket.ino), live: socket.isLive() })),
  });
}

function relaySubtreeOwned(directory: string, origin: string): boolean {
  const root = realpathSync(directory), visited = new Set<string>();
  const visit = (path: string): boolean => {
    const real = realpathSync(path);
    if (!within(root, real)) return false;
    const info = lstatSync(real, { bigint: true });
    if (info.isSocket()) {
      const peer = ownedSocketOrigin(real);
      return Boolean(peer && normalizedOrigin(peer) === normalizedOrigin(origin));
    }
    if (!info.isDirectory()) return true;
    const key = socketIdentity(info);
    if (visited.has(key)) return true;
    visited.add(key);
    return readdirSync(real).every(name => visit(join(real, name)));
  };
  try { return visit(root); } catch { return false; }
}

const createdFixtureRoots = new Map<string, {dev:bigint;ino:bigint}>();
/** This creates a fresh owned tree; it cannot mark an existing host directory. */
export function nativeFixtureDirectory(prefix: string): string {
  if(prefix!==basename(prefix)||!/^[A-Za-z0-9_-]+$/.test(prefix))refuse("invalid fixture directory prefix");
  const root=mkdtempSync(join("/tmp",prefix));
  const info=lstatSync(root,{bigint:true});createdFixtureRoots.set(root,{dev:info.dev,ino:info.ino});return root;
}

interface FixtureKeeper { mount: string; namespacePid: number; namespaceStart: string; root: string }
interface KeeperInspection { mount: string; snapshot: string; refresh(): void }
const guardedChildren = new Map<number, string>();
const fixtureKeepers = new Map<number, KeeperInspection & { live(): boolean; dispose(): void }>();
function processStart(pid: number): string { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19]!; }
/** Called only by the installed test spawn interceptor, never by product code. */
export function recordNativeGuardChild(child: { pid: number; exited: Promise<number> }): void {
  let start: string; try { start = processStart(child.pid); } catch { return; }
  guardedChildren.set(child.pid, start);
  void child.exited.finally(() => { if (guardedChildren.get(child.pid) === start) guardedChildren.delete(child.pid); }).catch(() => {});
}
/** Fixture-owned output descriptor plus a live, guard-observed namespace; no path exemption. */
export function registerNativeFixtureKeeper(storage: FixtureKeeper): () => void {
  try { return registerFixtureKeeper(storage); }
  catch(error) { if(String(error).includes("Offline native Claude refused before launch:"))throw error;return refuse("fixture keeper provenance is unavailable"); }
}
function registerFixtureKeeper(storage: FixtureKeeper): () => void {
  const start = processStart(storage.namespacePid);
  let pid = storage.namespacePid, observed = false;
  for (let depth = 0; pid > 1 && depth < 64; depth++) {
    if (guardedChildren.get(pid) === processStart(pid)) { observed = true; break; }
    const parent = /^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (!parent) break; pid = Number(parent[1]);
  }
  const ns = `/proc/${storage.namespacePid}/ns/mnt`, namespace = statSync(ns, { bigint: true });
  if (!observed || storage.namespaceStart !== start || namespace.ino === statSync("/proc/self/ns/mnt", { bigint: true }).ino ||
      !new RegExp(`^/proc/${process.pid}/fd/[0-9]+$`).test(storage.root) || FORBIDDEN_BIND_ROOTS.has(resolve(storage.mount))) refuse("fixture keeper provenance is unavailable");
  if(Number(statfsSync(storage.root).type)!==0x01021994)refuse("fixture keeper output is not private tmpfs");
  // Only the publication tree is needed; overlay work/upper metadata never enters inspection.
  const mount=join(resolve(storage.mount),"merged");
  const fd = openSync(join(storage.root,"merged"), 0x200000 | 0x10000 | 0x20000); // O_PATH | O_DIRECTORY | O_NOFOLLOW.
  const info = fstatSync(fd, {bigint:true});
  const namespaceRoot = `/proc/${storage.namespacePid}/root${mount}`;
  const mounted = statSync(namespaceRoot, {bigint:true});
  if (mounted.dev !== info.dev || mounted.ino !== info.ino || !info.isDirectory() || info.uid !== BigInt(process.getuid?.() ?? -1)) { closeSync(fd); refuse("fixture keeper output is not private tmpfs"); }
  const snapshot = nativeFixtureDirectory("odysseus-keeper-inspection-");
  const anchor = `/proc/${process.pid}/fd/${fd}`;
  let disposed=false;
  const live = () => { try { const now=statSync(ns,{bigint:true}); return !disposed && processStart(storage.namespacePid)===start && now.dev===namespace.dev && now.ino===namespace.ino && statSync(namespaceRoot,{bigint:true}).dev===info.dev && statSync(namespaceRoot,{bigint:true}).ino===info.ino && observed; } catch { return false; } };
  const entry = { mount, snapshot, live, refresh() {
    if (!live()) refuse("fixture keeper namespace is no longer live");
    for (const name of readdirSync(snapshot)) rmSync(join(snapshot,name),{recursive:true,force:true});
    for (const name of readdirSync(anchor)) cpSync(join(anchor,name),join(snapshot,name),{recursive:true,dereference:false});
  }, dispose() { if(disposed)return;disposed=true;if(fixtureKeepers.get(storage.namespacePid)===entry)fixtureKeepers.delete(storage.namespacePid);closeSync(fd);rmSync(snapshot,{recursive:true,force:true}); } };
  if(fixtureKeepers.has(storage.namespacePid)){closeSync(fd);rmSync(snapshot,{recursive:true,force:true});refuse("fixture keeper was already registered");}
  try { entry.refresh(); } catch { entry.dispose(); refuse("fixture keeper snapshot is unavailable"); }
  fixtureKeepers.set(storage.namespacePid,entry); return entry.dispose;
}
function workerKeeper(argv: readonly string[], bwrap: number): KeeperInspection | undefined {
  const at = argv.findIndex((value,index) => index < bwrap && basename(value)==="nsenter");
  if(at<0)return;
  const separator=argv.indexOf("--",at);
  if(separator<0||separator>bwrap||!argv.slice(at+1,separator).includes("--mount"))return;
  const target=argv.indexOf("--target",at);if(target<0||target>separator)return;
  const entry=fixtureKeepers.get(Number(argv[target+1]));if(!entry)return;
  if(!entry.live())refuse("fixture keeper namespace is no longer live");entry.refresh();return entry;
}
function inspectedWorkerSource(input: string, keeper?: KeeperInspection): string {
  const path=resolve(input);
  return keeper && within(keeper.mount,path) ? realpathSync(join(keeper.snapshot,path.slice(keeper.mount.length))) : realpathSync(input);
}

/** Only fixture-declared data, fixed runtime bytes and guard-created IPC enter a worker. */
function workerSourceAllowed(source: string, route: ScriptedAuthority, guardRoot: string): boolean {
  const created=[...createdFixtureRoots].filter(([path,stamp])=>{try{const now=lstatSync(path,{bigint:true});return now.dev===stamp.dev&&now.ino===stamp.ino;}catch{return false;}}).map(([path])=>path);
  const registered=route.fixtureRoots.filter(path=>{try{const stamp=route.fixtureRootStamps.get(path),now=lstatSync(path,{bigint:true});return Boolean(stamp&&stamp.dev===now.dev&&stamp.ino===now.ino);}catch{return false;}});
  const roots = [...registered, ...created, guardRoot,
    ...["packages", "node_modules"].map(name => join(ROOT, name)), ...SYSTEM];
  if (roots.some(root => { try { return within(realpathSync(root), source); } catch { return false; } })) return true;
  return [...SYSTEM_FILES, process.execPath, compileSocketPolicy(), ...["package.json", "tsconfig.json", "bunfig.toml"].map(name => join(ROOT, name))]
    .some(path => { try { return realpathSync(path) === source; } catch { return false; } });
}

function stageWorkerFixtureBinds(argv: string[], bwrap: number, route: ScriptedAuthority, guardRoot: string, keeper?: KeeperInspection): void {
  let staged = 0;
  const staging = join(guardRoot, "files");
  for (let i = bwrap + 1; i < argv.indexOf("--", bwrap); i++) {
    if (!["--bind", "--ro-bind", "--dev-bind", "--bind-try", "--ro-bind-try", "--dev-bind-try"].includes(argv[i]!)) continue;
    if (FORBIDDEN_BIND_ROOTS.has(resolve(argv[i+1]!)) || FORBIDDEN_BIND_ROOTS.has(resolve(argv[i+2]!))) refuse("native bind exposes a forbidden host service root");
    let source: string;
    try { source = inspectedWorkerSource(argv[i + 1]!, keeper); } catch(error) { refuse("worker bind source is unavailable",mountInputEvidence(argv[i+1]!,argv[i+2]!,i,error,route.fixtureRoots)); }
    if (FORBIDDEN_BIND_ROOTS.has(source)) refuse("native bind exposes a forbidden host service root");
    const explicit = route.fixtureFiles.get(source);
    if (explicit) {
      mkdirSync(staging, {recursive:true,mode:0o755});chmodSync(staging,0o755);
      const copy=join(staging,String(staged++));writeFileSync(copy,explicit,{mode:0o444});chmodSync(copy,0o444);
      argv[i]="--ro-bind";argv[i+1]=copy;
    } else if (!workerSourceAllowed(source, route, guardRoot)) {
      const info=lstatSync(source);
      // Replace a socket-only relay directory with exact socket binds. A later
      // file in the original directory never enters the native view.
      if(info.isDirectory() && [...ownedRelaySockets.values()].some(socket=>normalizedOrigin(socket.origin)===normalizedOrigin(route.origin) && dirname(socket.path)===source && socket.isLive()) && readdirSync(source).length && readdirSync(source).every(name=>{
        try{return socketMatchesOrigin(join(source,name),route.origin);}catch{return false;}
      })) {
        const destination=argv[i+2]!;
        const exact=readdirSync(source).flatMap(name=>["--ro-bind",join(source,name),join(destination,name)]);
        argv.splice(i,3,...exact);i+=exact.length-1;continue;
      } else if (!(info.isSocket() && socketMatchesOrigin(source,route.origin)) && !(source === "/dev/null" && info.isCharacterDevice())) {
        refuse("worker bind was not created or staged by the fixture",mountInputEvidence(source,argv[i+2]!,i,{code:"UNREGISTERED"},route.fixtureRoots));
      }
    }
    i+=2;
  }
}

function assertWorkerFixtureBinds(mounts: readonly string[], route: ScriptedAuthority, guardRoot: string, keeper?: KeeperInspection): void {
  for(let i=0;i<mounts.length;i++) {
    if(!["--bind","--ro-bind","--dev-bind","--bind-try","--ro-bind-try","--dev-bind-try"].includes(mounts[i]!))continue;
    let source:string;try{source=inspectedWorkerSource(mounts[i+1]!,keeper);}catch{refuse("worker bind source is unavailable");}
    if(!workerSourceAllowed(source,route,guardRoot)) {
      const info=lstatSync(source);
      if(!(info.isSocket() && socketMatchesOrigin(source,route.origin)) && !(source === "/dev/null" && info.isCharacterDevice()))refuse("worker bind was not created or staged by the fixture",mountInputEvidence(source,mounts[i+2]!,i,{code:"UNREGISTERED"},route.fixtureRoots));
    }
    // A fixture symlink cannot turn a declared directory into outside data.
    const visited=new Set<string>();let inspected=source;
    const visit=(path:string):void=>{
      inspected=path;
      const real=realpathSync(path),info=lstatSync(real);
      if(info.isFile() && !workerSourceAllowed(real,route,guardRoot))refuse("worker file was not created or staged by the fixture");
      if(!info.isDirectory() || SYSTEM.some(root=>{try{return within(realpathSync(root),real);}catch{return false;}}) || visited.has(real))return;
      visited.add(real);for(const name of readdirSync(real))visit(join(real,name));
    };
    try { visit(source); } catch(error) {
      if(String(error).includes("Offline native Claude refused before launch:"))throw error;
      refuse("worker fixture provenance is unavailable",mountInputEvidence(inspected,mounts[i+2]!,i,error,route.fixtureRoots));
    }
    i+=2;
  }
}

/** Exact first-party status/namespace prefixes; a payload argument named bwrap is not a launcher. */
function nativeBwrapIndex(argv: readonly string[]): number {
  let at=0;
  const same=(command:string|undefined,path:string)=>{try{return Boolean(command)&&realpathSync(command!)===realpathSync(path);}catch{return false;}};
  for(let depth=0;depth<4;depth++) {
    if(same(argv[at],"/bin/sh")) {
      if(argv[at+1]!=="-c"||argv[at+2]!=='exec 3>"$1"; exec 4<"$2"; shift 2; exec "$@"'||argv[at+3]!=="brain-worker-status")return -1;
      if(!argv.slice(at+4,at+6).every(path=>{try{return new RegExp(`^/proc/${process.pid}/fd/[0-9]+$`).test(path)&&statSync(path).isFIFO();}catch{return false;}}))return -1;
      at+=6;continue;
    }
    if(same(argv[at],"/usr/bin/python3")&&argv[at+1]==="-I"&&argv[at+2]==="-S"&&argv[at+3]==="-c") {
      const {WORKER_FILESYSTEM_FILTER_PROGRAM}=createRequire(import.meta.url)("../packages/ui-sdk/src/server/worker-filesystem-filter.ts") as typeof import("../packages/ui-sdk/src/server/worker-filesystem-filter");
      if(argv[at+4]!==WORKER_FILESYSTEM_FILTER_PROGRAM)return -1;
      at+=5;continue;
    }
    if(same(argv[at],"/usr/bin/nsenter")) {
      const end=argv.indexOf("--",at);if(end<0)return -1;
      for(let i=at+1;i<end;i++){
        if(["--user","--mount","--preserve-credentials"].includes(argv[i]!))continue;
        if(argv[i]==="--target"&&/^\d+$/.test(argv[++i]??""))continue;
        return -1;
      }
      at=end+1;continue;
    }
    return basename(argv[at]??"")==="bwrap"?at:-1;
  }
  return -1;
}

/** Inspect the concrete existing worker bootstrap, including its exec payload. */
export function nativeWorkerBoundary(env: Record<string, string | undefined>): { env: Record<string, string | undefined>; dispose(): void; beforeLaunch(): void } {
  const unchanged = { env, dispose() {}, beforeLaunch() {} };
  if (!env.BRAIN_WORKER_LAUNCH) return unchanged;
  let launch: { command?: string[]; argv?: string[]; env?: Record<string, string>; brainPath?: string; hostHome?: string } | null;
  try { launch = JSON.parse(env.BRAIN_WORKER_LAUNCH); } catch { refuse("invalid worker launch metadata"); }
  if (!launch || !Array.isArray(launch.argv) || !launch.argv.length || !launch.argv.every(value => typeof value === "string") ||
      !Array.isArray(launch.command) || !launch.command.length || !launch.command.every(value => typeof value === "string")) refuse("worker command and argv are required");
  const argv = launch.argv;
  const context = { cwd: launch.brainPath, env: launch.env };
  let workerArgv = argv;
  let supervisor: { argv: string[] } | undefined;
  if (argv.length === 6 && argv[1] === "-I" && argv[2] === "-S" && argv[3] === "-c") {
    // This concrete launcher hands off to another UID; tracing its Python
    // coordinator cannot observe the broker's independently launched payload.
    try {
      const { WORKER_IDENTITY_SUPERVISOR } = createRequire(import.meta.url)("../packages/ui-sdk/src/server/worker-identity-program.ts") as { WORKER_IDENTITY_SUPERVISOR: string };
      if (argv[4] !== WORKER_IDENTITY_SUPERVISOR || realpathSync(argv[0]!) !== realpathSync("/usr/bin/python3")) refuse("unrecognized native identity launcher");
      supervisor = JSON.parse(argv[5]!);
    } catch { refuse("invalid native identity launcher"); }
    if (!supervisor || !Array.isArray(supervisor.argv) || !supervisor.argv.every(value => typeof value === "string")) refuse("invalid native identity launcher");
    workerArgv = supervisor.argv;
  }
  try { argv[0] = resolveExecutable(argv[0]!, context); workerArgv[0] = resolveExecutable(workerArgv[0]!, context); }
  catch { refuse("worker executable could not be resolved"); }
  const command = launch.command!;
  const tail = workerArgv.slice(-command.length);
  let agrees = false;
  try { agrees = tail.length === command.length && resolveExecutable(tail[0]!, context) === resolveExecutable(command[0]!, context)
    && tail.slice(1).every((value, index) => value === command[index + 1]); } catch { /* Unknown executable refuses. */ }
  if (!agrees) refuse("worker command and executable argv disagree");
  const actualNative = isNativeClaude(command[0]!, command.slice(1), context) || isNativeClaude(argv[0]!, [], context) || isNativeClaude(workerArgv[0]!, [], context);
  if (!actualNative) {
    if (supervisor) argv[5] = JSON.stringify(supervisor);
    launch.argv = argv;
    return { ...unchanged, env: { ...env, BRAIN_WORKER_LAUNCH: JSON.stringify(launch) } };
  }
  const bwrap = nativeBwrapIndex(workerArgv);
  if (bwrap < 0) refuse("native worker lacks the OS launcher");
  // Even ordinary test workers use a private network and a single bridge.
  // Do not rely on SDK options or the production profile to establish this.
  const socket = launch.env?.ANTHROPIC_UNIX_SOCKET;
  const route = scriptedRoute.getStore();
  if (!route) refuse("scripted service authority was not registered");
  const admitted = socket ? admittedRelay(workerArgv, socket) : undefined;
  const ownedOrigin = admitted?.origin;
  if (socket && !ownedOrigin) refuse("pre-existing native relay is not guard-owned");
  if (ownedOrigin && (!route || normalizedOrigin(ownedOrigin) !== normalizedOrigin(route.origin))) refuse("native relay did not match scripted authority");
  qualify();
  workerArgv[bwrap] = bwrapExecutable;
  const bridge = startNativeTestRelay(route.origin);
  try {
    const tools = fixtureToolView(launch.env ?? {}, launch.brainPath ?? ROOT, launch.hostHome ?? launch.env?.HOME);
    assertNativeMountSockets(tools.mounts, route.origin);
    for (let i = bwrap + 1; i < workerArgv.indexOf("--", bwrap); i++) {
      if (workerArgv[i] === "--ro-bind" && workerArgv[i + 1] === "/" && workerArgv[i + 2] === "/") workerArgv.splice(i--, 3);
      else if (workerArgv[i] === "--ro-bind" && ["/etc/alternatives", "/etc/resolv.conf", "/etc/ssl/certs"].includes(workerArgv[i + 2]!)) workerArgv.splice(i--, 3);
      else if (workerArgv[i] === "--setenv" && !WORKER_RUNTIME_ENV.has(workerArgv[i + 1]!)) workerArgv.splice(i--, 3);
    }
    workerArgv.splice(bwrap + 1, 0, "--clearenv", "--unshare-net", "--unshare-pid");
    const pinned = { ANTHROPIC_BASE_URL: "http://localhost", ANTHROPIC_UNIX_SOCKET: socket && ownedOrigin ? socket : "/tmp/native-relay/relay.sock",
      PATH: tools.path, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
      ...(["0", "1"].includes(launch.env?.USE_BUILTIN_RIPGREP ?? "") ? { USE_BUILTIN_RIPGREP: launch.env!.USE_BUILTIN_RIPGREP! } : {}),
      ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "",
      ...(ownedOrigin ? relayCredentialPlaceholders(launch.env ?? {}) : syntheticCredentials(launch.env ?? {})) };
    const separator = workerArgv.indexOf("--", bwrap);
    // bwrap applies mounts in order. Install every guard-owned input after
    // the launcher's tmpfs/masks, so no later covering mount hides it.
    workerArgv.splice(separator, 0, ...systemMounts(), ...testRuntimeMounts(), ...tools.mounts,
      "--ro-bind", process.execPath, process.execPath, "--ro-bind", compileSocketPolicy(), compileSocketPolicy(),
      "--ro-bind", bridge.directory, "/tmp/native-relay",
      "--ro-bind", join(bridge.directory, "passwd"), "/etc/passwd", "--ro-bind", join(bridge.directory, "group"), "/etc/group",
      ...Object.entries(pinned).flatMap(([key, value]) => ["--setenv", key, value]));
    const keeper=workerKeeper(workerArgv,bwrap);
    try { stageWorkerFixtureBinds(workerArgv,bwrap,route,bridge.directory,keeper); }
    catch(error) { if (String(error).includes("Offline native Claude refused before launch:")) throw error; refuse("worker fixture provenance is unavailable"); }
    const payloadIndex = workerArgv.indexOf("--", bwrap) + 1;
    const nativePayload = workerArgv.splice(payloadIndex);
    workerArgv.push(...nativeSocketCommand(nativePayload, admitted?.path ?? join(bridge.directory, "relay.sock"), pinned.ANTHROPIC_UNIX_SOCKET));
    const nativeMounts = workerArgv.slice(bwrap + 1, workerArgv.indexOf("--", bwrap));
    const beforeLaunch = () => {
      try { keeper?.refresh(); assertWorkerFixtureBinds(nativeMounts, route, bridge.directory,keeper); assertNativeMountSockets(nativeMounts, route.origin,keeper); }
      catch(error) { if (String(error).includes("Offline native Claude refused before launch:")) throw error; refuse("worker fixture provenance is unavailable"); }
    };
    beforeLaunch();
    const expected = expectedNativeExec(command[0]!, command.slice(1), context);
    let audited: ReturnType<typeof auditNativeLaunch>;
    if (supervisor) {
      const payload = workerArgv.splice(workerArgv.indexOf("--", bwrap) + 1);
      // The tracer runs after the UID handoff, outside the native PID and mount
      // view. The inner boundary preserves fixture writable mounts but hides
      // the audit storage and drops namespace capabilities from descendants.
      const { verifiedWorkerIdentity } = createRequire(import.meta.url)("../packages/ui-sdk/src/server/worker-launcher.ts") as typeof import("../packages/ui-sdk/src/server/worker-launcher");
      const identity = launch.brainPath && verifiedWorkerIdentity(launch.brainPath);
      if (!identity || identity.workerUid === process.getuid?.()) refuse("native worker audit lacks a verified separate UID");
      audited = auditNativeLaunch([bwrapExecutable, "--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-net", "--cap-drop", "ALL",
        "--bind", "/", "/", "--proc", "/proc", "--tmpfs", "AUDIT_STORAGE", "--", ...payload], expected, bridge.dispose, identity.workerUid);
      const log = audited.argv[audited.argv.indexOf("-o") + 1]!, directory = dirname(log);
      audited.argv[audited.argv.indexOf("AUDIT_STORAGE")] = directory;
      // Only the outer tracer sees this mount; the native process sees tmpfs.
      chmodSync(bridge.directory, 0o755); chmodSync(join(bridge.directory, "relay.sock"), 0o666);
      workerArgv.splice(workerArgv.indexOf("--", bwrap), 0, "--bind", directory, directory);
      workerArgv.push(...audited.argv);
      argv[5] = JSON.stringify(supervisor);
      launch.argv = argv;
    } else {
      audited = auditNativeLaunch(workerArgv, expected, bridge.dispose);
      launch.argv = audited.argv;
    }
    const encoded=JSON.stringify(launch);
    console.error(JSON.stringify({kind:"native-offline-worker-plan",head:nativeTestHead(),
      bootstrapArgc:launch.argv!.length,bootstrapArgvBytes:Buffer.byteLength(JSON.stringify(launch.argv)),
      sandboxArgc:workerArgv.length,sandboxArgvBytes:Buffer.byteLength(JSON.stringify(workerArgv)),metadataBytes:Buffer.byteLength(encoded)}));
    return { env: { ...env, BRAIN_WORKER_LAUNCH: encoded }, dispose: audited.dispose, beforeLaunch };
  } catch (error) { bridge.dispose(); throw error; }
}
