/** Test-only OS boundary for installed native Claude processes (#4313). */
import { existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SYSTEM = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
const within = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
let qualified = false;

export function isNativeClaude(command: string, args: readonly unknown[] = []): boolean {
  return /^(claude|claude-code)(\.exe)?$/.test(basename(command)) ||
    args.some(value => typeof value === "string" && /claude-agent-sdk[^\n]*\/cli\.(js|mjs)$/.test(value));
}

function refuse(reason: string): never {
  // Fixed classifications only: arguments, settings, credentials and addresses
  // never enter a denial receipt.
  console.error(JSON.stringify({ kind: "native-offline-boundary", success: false, nativeLaunched: false, reason }));
  throw new Error(`Offline native Claude refused before launch: ${reason}`);
}

export function refuseNativeClaude(command: string, args: readonly unknown[] = []): void {
  if (isNativeClaude(command, args)) refuse("OS isolation has not been qualified");
}

function qualify(): void {
  // Positive native proof is reserved for disposable hosted runners. Namespace
  // availability on a developer machine never authorizes a native test launch.
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    refuse("positive native proof requires a hosted runner");
  }
  if (qualified) return;
  const result = Bun.spawnSync(["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "/usr/bin/true"],
  { env: {}, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  if (result.exitCode !== 0) refuse("OS namespace setup failed");
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

interface Boundary { argv: string[]; env: Record<string, string>; dispose(): void }

/** One Unix socket forwards only to the explicitly selected scripted service. */
function relay(upstream: string | undefined) {
  let target: URL;
  try { target = new URL(upstream!); } catch { return refuse("missing scripted loopback service"); }
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port || target.username || target.password ||
      target.pathname !== "/" || target.search || target.hash) refuse("invalid scripted loopback service");
  const directory = mkdtempSync(join(tmpdir(), "odysseus-native-relay-"));
  const socket = join(directory, "relay.sock");
  const server = Bun.serve({ unix: socket, async fetch(request) {
    const url = new URL(request.url);
    if (url.origin !== "http://localhost") {
      console.error(JSON.stringify({ kind: "native-offline-boundary", success: false, reason: "unintended native destination" }));
      return new Response("Offline native destination refused", { status: 403 });
    }
    // A redirect is returned to the isolated native process; it cannot make a
    // TCP connection or obtain another host socket through this bridge.
    return fetch(new URL(url.pathname + url.search, target), { method: request.method, headers: request.headers,
      body: request.body, redirect: "manual", signal: request.signal });
  } });
  return { directory, dispose() { server.stop(true); rmSync(directory, { recursive: true, force: true }); } };
}

/** Direct SDK launch: empty filesystem, fresh PID/network namespaces, one IPC. */
export function nativeClaudeBoundary(command: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; managedSettings?: string }): Boundary {
  qualify();
  const env = options.env ?? process.env;
  const cwd = realpathSync(options.cwd ?? process.cwd());
  const home = env.HOME && realpathSync(env.HOME);
  if (!home || !within(tmpdir(), home) || home === tmpdir() || !within(tmpdir(), cwd) && !within(ROOT, cwd)) {
    refuse("native launch requires fixture-owned storage");
  }
  const bridge = relay(env.ANTHROPIC_BASE_URL);
  try {
    const executable = realpathSync(command);
    const argv = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", ...systemMounts(),
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", ROOT, ROOT,
      "--ro-bind", executable, command, "--bind", home, home,
      ...(within(ROOT, cwd) || within(home, cwd) ? [] : ["--bind", cwd, cwd]),
      "--ro-bind", bridge.directory, "/tmp/native-relay",
      ...(options.managedSettings ? ["--ro-bind", options.managedSettings, "/etc/claude-code"] : []), "--clearenv"];
    const childEnv: Record<string, string> = { HOME: home, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? home,
      PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ANTHROPIC_API_KEY: "offline-odysseus",
      ANTHROPIC_BASE_URL: "http://localhost", ANTHROPIC_UNIX_SOCKET: "/tmp/native-relay/relay.sock",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
    for (const [key, value] of Object.entries(childEnv)) argv.push("--setenv", key, value);
    argv.push("--chdir", cwd, "--", command, ...args);
    return { argv, env: {}, dispose: bridge.dispose };
  } catch (error) { bridge.dispose(); throw error; }
}

/** Inspect the concrete existing worker bootstrap, including its exec payload. */
export function nativeWorkerBoundary(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (!env.BRAIN_WORKER_LAUNCH) return env;
  const launch = JSON.parse(env.BRAIN_WORKER_LAUNCH) as { command?: string[]; argv?: string[] };
  if (!launch.command?.[0] || !isNativeClaude(launch.command[0], launch.command.slice(1))) return env;
  qualify();
  // Existing worker egress uses a host-owned Unix relay and a private network.
  // Refuse the old shared-network path; no settings option substitutes for it.
  const argv = launch.argv;
  if (!argv || !argv.includes("--unshare-net")) refuse("native worker lacks a private network namespace");
  const bwrap = argv.findIndex(value => basename(value) === "bwrap");
  if (bwrap < 0) refuse("native worker lacks the OS launcher");
  // Remove the broad host view. All concrete fixture/runtime mounts planned
  // by the existing worker follow the system view and remain intact.
  for (let i = bwrap + 1; i < argv.indexOf("--", bwrap); i++) {
    if (argv[i] === "--ro-bind" && argv[i + 1] === "/" && argv[i + 2] === "/") argv.splice(i--, 3);
  }
  argv.splice(bwrap + 1, 0, ...systemMounts(), "--ro-bind", ROOT, ROOT, "--ro-bind", process.execPath, process.execPath);
  return { ...env, BRAIN_WORKER_LAUNCH: JSON.stringify(launch) };
}
