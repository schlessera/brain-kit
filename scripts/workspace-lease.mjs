/** Coordinate development commands which share mutable workspace output. */
import { fstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKER = "BRAIN_WORKSPACE_LEASE";
const script = fileURLToPath(import.meta.url);
const lockPath = root => join(root, "tmp", "workspace-operation", "output.lock");

function inheritedLease() {
  try {
    const lease = JSON.parse(process.env[MARKER] ?? "null");
    if (!lease || !["read", "write"].includes(lease.mode) || !Number.isSafeInteger(lease.fd) || lease.fd < 3) return;
    let ownsFd = false;
    try {
      const held = fstatSync(lease.fd);
      ownsFd = held.isFile() && held.dev === lease.dev && held.ino === lease.ino;
    } catch { /* Bun's built-in run/shell path can close extra descriptors. */ }
    if (!ownsFd && !ancestorOwnsLease(lease)) return;
    Object.defineProperty(lease, "ownsFd", { value: ownsFd });
    return lease;
  } catch { /* A closed/reused descriptor is not inherited ownership. */ }
}

function ancestorOwnsLease(lease) {
  if (process.platform !== "linux" || !Number.isSafeInteger(lease.ownerPid) || lease.ownerPid < 1 ||
      !Number.isSafeInteger(lease.ownerFd) || lease.ownerFd < 3) return false;
  try {
    let pid = process.pid;
    for (let depth = 0; pid > 0 && depth < 128; depth++) {
      if (pid === lease.ownerPid) {
        const held = statSync(`/proc/${pid}/fd/${lease.ownerFd}`);
        return held.isFile() && held.dev === lease.dev && held.ino === lease.ino;
      }
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm may contain spaces or parentheses; ppid follows its last ')'.
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    }
  } catch { /* A dead/unrelated owner cannot authorize nested access. */ }
  return false;
}

function sameFile(fd, path) {
  try {
    const held = fstatSync(fd), wanted = statSync(path);
    return held.dev === wanted.dev && held.ino === wanted.ino;
  } catch { return false; }
}

export function workspaceTestAccess() {
  return process.env.BRAIN_WORKSPACE_ACCESS === "read" || inheritedLease()?.mode === "read" ? "read" : "write";
}

/** Preserve the lock's open file description, including replaced child environments. */
export function inheritWorkspaceLease(options = {}, defaultStderr = "inherit", pipeOnly = false) {
  const lease = inheritedLease();
  if (!lease) return options;
  if (!lease.ownsFd || pipeOnly) return { ...options, env: { ...(options.env ?? process.env), [MARKER]: JSON.stringify(lease) } };
  const { stdin, stdout, stderr, ...rest } = options;
  const defaults = ["ignore", "pipe", defaultStderr];
  const stdio = options.stdio ? [...options.stdio] : [stdin === undefined ? defaults[0] : stdin,
    stdout === undefined ? defaults[1] : stdout, stderr === undefined ? defaults[2] : stderr];
  while (stdio.length < 3) stdio.push(defaults[stdio.length]);
  const fd = stdio.length;
  stdio.push(lease.fd);
  return { ...rest, stdio, env: { ...(options.env ?? process.env), [MARKER]: JSON.stringify({ ...lease, fd }) } };
}

function exitCode(code, signal) {
  return signal ? 128 + (constants.signals[signal] ?? 0) : code ?? 1;
}

function originalCommand(entry) {
  // Bun test's process.argv names the current test file and execArgv omits
  // its test flags. Linux's original argv preserves selection, timeout and
  // preload exactly; an ordinary script has the portable Node fallback.
  if (process.platform === "linux") {
    const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0");
    if (argv.at(-1) === "") argv.pop();
    return [process.execPath, ...argv.slice(1)];
  }
  if (entry === "test") throw new Error("Direct Bun test coordination requires Linux; use bun run test to preserve its startup arguments");
  return [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
}

async function waitForChild(startChild, stop) {
  let child, pendingSignal;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const listeners = signals.map(signal => () => {
    if (child) stop(child, signal);
    else pendingSignal = signal;
  });
  // Install forwarding before creating descendants. A signal in the native
  // spawn/startup gap must not kill this monitor and orphan its new child.
  signals.forEach((signal, index) => process.on(signal, listeners[index]));
  try {
    child = startChild();
    const result = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit(exitCode(code, signal)));
    });
    if (pendingSignal) stop(child, pendingSignal);
    return await result;
  } finally {
    signals.forEach((signal, index) => process.off(signal, listeners[index]));
  }
}

/** Re-enter this command under flock; nested commands reuse the inherited descriptor. */
export async function ensureWorkspaceLease(root, mode, entry = "script") {
  if (!["read", "write"].includes(mode)) throw new Error("Unknown workspace access mode");
  const lease = inheritedLease();
  if (lease?.mode === "read" && mode === "write") {
    throw new Error("Read-only verification cannot rebuild or remove workspace output");
  }
  const path = lockPath(root);
  const scope = statSync(path, { throwIfNoEntry: false });
  if (lease && scope && lease.dev === scope.dev && lease.ino === scope.ino) {
    // A nested read-only batch may narrow the enclosing test's write access.
    process.env[MARKER] = JSON.stringify({ ...lease, mode });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  console.error(`Acquiring ${mode === "write" ? "exclusive" : "shared"} workspace output access; overlapping commands wait.`);
  // Import subprocess APIs only when a command needs a new coordinator.
  const { spawn } = await import("node:child_process");
  return await waitForChild(() => spawn(process.execPath,
    [script, "--wait", root, mode, "3", ...originalCommand(entry)],
    { stdio: ["inherit", "inherit", "inherit", "pipe"] }),
  (child, signal) => child.kill(signal));
}

async function waitForLease(root, mode, lifetimeFd, executable, args) {
  const { spawn } = await import("node:child_process");
  const { Socket } = await import("node:net");
  let child, force, stopRequested;
  const stop = signal => {
    stopRequested = signal;
    if (!child) return;
    child.kill(signal);
    // An acquired owner has its own one-second process-group cleanup.
    if (!force) force = setTimeout(() => child.kill("SIGKILL"), 2_000);
  };
  // Watch the outer lifetime before flock acquires access. A killed waiter
  // must disappear even while another command continues holding the lock.
  const lifetime = new Socket({ fd: lifetimeFd, readable: true, writable: false });
  lifetime.on("end", () => stop("SIGTERM"));
  lifetime.on("error", () => stop("SIGTERM"));
  lifetime.resume();
  try {
    return await waitForChild(() => {
      child = spawn("flock", [mode === "write" ? "--exclusive" : "--shared", "--no-fork", lockPath(root),
        process.execPath, script, "--enter", root, mode, "3", executable, ...args],
      { stdio: [0, 1, 2, "pipe"] });
      if (stopRequested) stop(stopRequested);
      return child;
    }, (_, signal) => stop(signal));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Workspace coordination requires the flock executable (util-linux).");
    throw error;
  } finally {
    lifetime.destroy();
    clearTimeout(force);
  }
}

async function enter(root, mode, lifetimeFd, executable, args) {
  // flock opens the first free descriptor. A test preload may have forwarded
  // another worktree's lock, so do not assume its descriptor is always 3.
  let fd;
  for (let candidate = 3; candidate < 256; candidate++) {
    if (sameFile(candidate, lockPath(root))) { fd = candidate; break; }
  }
  if (fd === undefined) throw new Error("Workspace lock descriptor was not inherited from flock");
  const held = fstatSync(fd);
  const owner = { ownerPid: process.pid, ownerFd: fd };
  process.env[MARKER] = JSON.stringify({ mode, fd, dev: held.dev, ino: held.ino, ...owner });
  const { spawn } = await import("node:child_process");
  const { Socket } = await import("node:net");
  let child, force, stopRequested;
  const stop = signal => {
    stopRequested = signal;
    if (!child?.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
    if (!force) force = setTimeout(() => stop("SIGKILL"), 1000);
  };
  // The command inherits the lock, not this pipe. If its outer wrapper is
  // killed, EOF stops the owned group before the coordinator releases access.
  const lifetime = new Socket({ fd: lifetimeFd, readable: true, writable: false });
  lifetime.on("end", () => stop("SIGTERM"));
  lifetime.on("error", () => stop("SIGTERM"));
  lifetime.resume();
  let result, cleanupFailed = false;
  try {
    result = await waitForChild(() => {
      child = spawn(executable, args, {
        stdio: [0, 1, 2, fd], detached: process.platform !== "win32",
        env: { ...process.env, [MARKER]: JSON.stringify({ mode, fd: 3, dev: held.dev, ino: held.ino, ...owner }) },
      });
      if (stopRequested) stop(stopRequested);
      return child;
    }, (_, signal) => stop(signal));
  }
  finally {
    lifetime.destroy();
    clearTimeout(force);
    // Include compilers/CLI grandchildren when the main command failed or
    // was killed. The open descriptor keeps ownership until they stop.
    if (child?.pid && process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) {
        if (error.code !== "ESRCH") { cleanupFailed = true; console.error("Workspace child cleanup failed", error); }
      }
    }
  }
  return cleanupFailed ? result || 1 : result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [flag, root, mode, lifetime, executable, ...args] = process.argv.slice(2);
    if (!["--wait", "--enter"].includes(flag) || !root || !["read", "write"].includes(mode) || lifetime !== "3" || !executable) throw new Error("Invalid workspace lock entry");
    process.exit(await (flag === "--wait" ? waitForLease : enter)(root, mode, Number(lifetime), executable, args));
  } catch (error) { console.error(error); process.exit(1); }
}
