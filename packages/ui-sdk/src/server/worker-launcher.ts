import { createWorkerStatusPipe } from "./worker-status.js";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync,
  realpathSync, rmSync, statSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { BackendRequestError } from "./backend.js";
import { createWorkerFreezer } from "./worker-freezer.js";
import { createWorkerFileObserver, type ObservedWorkerFile } from "./worker-file-observer.js";
import { createWorkerPipes } from "./worker-pipes.js";
import { hostOutputStagingLimits, DEFAULT_MAINTENANCE_TEMP_BYTES, type WorkerStateLimits, validWorkerStateBytes } from "./worker-state-limits.js";
import { WORKER_INFERENCE_DIR } from "./inference-relay.js";
import { FIRST_PARTY_FAILURE_CLASSES } from "../protocol.js";
import { resolveScratchMount, resolveWorkspacesMount, WORKER_AREAS, WORKER_AREA_ROOT, WORKER_XDG_DIRS,
  type WorkerArea, type WorkerAreaName, type WorkerHome, type WorkerSandbox } from "./worker-sandbox.js";
import { limitFailureMessage, PRLIMIT_REQUIREMENT, prlimitArgs, WORKER_LIMITS_ENV, workerLimitsPlan,
  type WorkerLimitHit, type WorkerLimitReport, type WorkerLimitsPlan } from "./worker-limits.js";
import { createWorkerCgroup, workerCgroupHostFailed, type WorkerCgroup } from "./worker-cgroup.js";
import { processStateLedger } from "./worker-state-budget.js";
import { TURN_TEMP_ROOT } from "./worker-turn-temp.js";
import { isEnvName } from "./protected-paths.js";
import { resolveWorkerProtection, protectedWorkerMounts } from "./worker-protection.js";
import { prepareWorkerOutput } from "./worker-output.js";
import { createWorkerStartupView, isNativeWorkerStartupRoot, type WorkerStartupView } from "./worker-startup-view.js";
import { bindPreparedWorkerOutputExit, type PreparedWorkerOutput, type WorkerOutputStorage } from "./worker-native-output.js";
import { workerFilesystemFilter, workerFilesystemFilterRefusal } from "./worker-filesystem-filter.js";

/** Concrete first-party worker boundary; not an optional exec wrapper. */
export const WORKER_SCRATCH = "/tmp/brain-worker-scratch";
/**
 * Where a worker's private runtime-state tmpfs is mounted inside its sandbox
 * (#1625). Only that worker's mount namespace holds it.
 */
export const WORKER_STATE = "/tmp/brain-worker-state";
const TMPFS_MAGIC = 0x01021994;
/**
 * Fallback start gate for direct argv consumers and synchronous host probes:
 * reads one server-owned stdin line before becoming the worker command.
 * Closed stdin or any other line ends the worker unstarted. Only the
 * absolute shell and its builtins run here, never a PATH lookup. Reads are
 * byte-sized, so nothing past the gate line is consumed. Live launches use
 * bubblewrap's --block-fd instead: workerBootstrap reopens its trusted gate
 * after Bun execve and the inherited-descriptor filter, preserving payload
 * stdin and leaving no gate descriptor in the sandbox command.
 */
const STATE_GATE = ["/bin/sh", "-c", 'IFS= read -r go && [ "$go" = go ] || exit 125; exec "$@"', "brain-worker-state-gate"];
/** What the server writes to open the gate. */
const STATE_GATE_OPEN = "go\n";
/** How long a launch waits for bubblewrap to report and mount, like the probe's bound. */
const STATE_SETUP_MS = 5_000;
export const WORKER_HOST_ROUTE = "Use a verified Linux or qualifying WSL2 host with bubblewrap and unprivileged user namespaces.";

export interface WorkerLaunch {
  brainPath: string;
  /** Host-owned immutable execution view for snapshot consumers. */
  startupView?: WorkerStartupView;
  /** Async-acquired stage and its owned startup reference, consumed by this launch. */
  preparedOutput?: PreparedWorkerOutput;
  /** Private validated persistent outputs for snapshot consumers. */
  areaOutput?: { source: string; storage?: WorkerOutputStorage };
  /** Server native-write locks held throughout strict output publication. */
  outputLock?: import("./keyed-lock.js").KeyedLock;
  /** Mount location only; always a fresh tmpfs, never host-backed writable storage. */
  scratchPath?: string;
  /**
   * The size of the worker's private runtime-state tmpfs at `WORKER_STATE`,
   * in bytes (#1625). A whole number of pages. Absent: no runtime state.
   */
  stateBytes?: number;
  /**
   * Fills the runtime state before the worker's command starts, given a
   * server-side path to the private tmpfs. Only `launchAgentWorker` calls it.
   */
  populateState?: (root: string) => void;
  /** Absolute executable and literal arguments. No shell is inserted. */
  command: readonly string[];
  /** The complete worker environment; nothing is inherited by default. */
  env: Readonly<Record<string, string>>;
  /**
   * The restricted envelope for untrusted (autonomous) execution (#676): a
   * private network namespace with only loopback, and an explicit read
   * envelope instead of the host root. Absent for interactive and voice turns.
   */
  restricted?: RestrictedEnvelope;
  /**
   * The writable areas resolved by `prepareWorkerSandbox` for this worker
   * (#1626). The same object renders the agent's sandbox note, so the mounts
   * and the note cannot disagree. Absent: only the per-turn scratch is writable.
   */
  sandbox?: WorkerSandbox;
  /**
   * The resource limits this worker runs under (#1660), resolved once by
   * `workerLimitsPlan` so the agent's note and the launch cannot disagree.
   * Absent: the launcher resolves the host's limits itself. No launch runs
   * without them.
   */
  limits?: WorkerLimitsPlan;
  /**
   * The size of the worker's private `/tmp`, its turn temp, in bytes (#1703):
   * a tmpfs of exactly this allowance, holding the scratch path and the XDG
   * directories. A whole number of pages. The server reaches it through a
   * held descriptor (`LaunchedWorker.turnTemp`), so it can promote what the
   * answer links once the worker has exited. Absent: an unsized `/tmp`.
   */
  turnTempBytes?: number;
  /**
   * A maintenance worker (#1648): the server's own work on a brain that
   * agents may write (indexing, application planning, the `brain` CLI, git).
   * The brain is bound read-write, the host stays read-only with its runtime
   * and home directories masked, and nothing but `env` is passed in. Exclusive
   * with `restricted` and `sandbox`.
   */
  maintenance?: MaintenanceEnvelope;
  /** Host Git transport: an empty root, explicit system/runtime mounts, and no brain mount. */
  transport?: { mirror: string; readPaths: readonly string[]; writePaths?: readonly string[]; tempBytes?: number };
  /** Trusted maintenance admission attached by the bootstrap before exec. */
  maintenanceReservation?: { id: string; directory: string; statePath?: string };
}

/**
 * Host directories a maintenance worker never sees: runtime state, Unix
 * sockets and every home. Each one becomes an empty private tmpfs; the paths
 * a worker needs from below one are bound back read-only (`readPaths`).
 * `/tmp` is already a fresh tmpfs in every worker, which covers
 * `/tmp/.X11-unix`.
 */
export const HOST_MASKS = ["/run", "/var/run", "/var/lib", "/home", "/root", "/mnt", "/media", "/srv"] as const;

/** The private, empty `$HOME` of a credential-free maintenance worker, on its own `/tmp`. */
export const MAINTENANCE_HOME = "/tmp/brain-maintenance-home";
export const MAINTENANCE_XDG_DIRS = { ...WORKER_XDG_DIRS, XDG_STATE_HOME: "/tmp/brain-maintenance-state" } as const;

export interface MaintenanceEnvelope {
  git?: { source: string; target: string; entry: string; binary: string };
  /** The server's named output workspace, separate from all configuration inputs. */
  output?: { source: string; target: string; storage?: WorkerOutputStorage };
  /** Agent profiles make the empty host masks read-only. */
  readOnlyMasks?: boolean;
  /** One sized /tmp for all maintenance temporary writes; never agent turn temp. */
  tempBytes?: number;
  /** The host network namespace. Otherwise a private one with only loopback. */
  network: boolean;
  /**
   * Whether the command receives credentials. A credential-free worker also
   * gets every `.env*` file at the brain root replaced by an empty read-only
   * file, so Bun cannot load the brain's keys into it.
   */
  credentials: boolean;
  /**
   * The server's home, made visible again below the home masks. Only a
   * credentialed worker gets it (the interim exposure the decision record
   * names): a read-only bind. Writable tool directories live in bounded /tmp.
   */
  home?: { path: string; overlay: boolean };
  /** Host files and directories bound back read-only after the masks: the runtime, the entry and its packages. */
  readPaths: readonly string[];
  /** Private host directories or regular files masked in addition to {@link HOST_MASKS}. */
  maskPaths?: readonly string[];
  /** Existing host files bound read-write at their own path, such as a cron job's span sink. */
  writeFiles?: readonly string[];
  /** Host-selected writable storage within an otherwise read-only mirror. */
  writeDirectories?: readonly string[];
}

export interface RestrictedEnvelope {
  /** Host files and directories mounted read-only at their own paths. Nothing else from the host is. */
  readPaths: readonly string[];
  /** Private host directory holding the server-owned inference relay socket. */
  inferenceDir: string;
}

/**
 * The minimal system view of the restricted envelope: binaries, libraries and
 * the dynamic-linker and name-service files they need. No home, run, var,
 * mount or device directory of the host, and no other `/etc` file.
 */
const SYSTEM_DIRECTORIES = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
const SYSTEM_ETC = ["ld.so.cache", "ld.so.conf", "ld.so.conf.d", "alternatives", "passwd", "group",
  "nsswitch.conf", "hosts", "localtime", "os-release"];

/**
 * The restricted envelope hides the brain's `.git` (maintainer ruling 1A on
 * #676). A read-only mount does not stop `connect()` to a socket a host
 * process listens on inside the envelope, and git's own daemons (fsmonitor)
 * put one there. Masking it also hides hooks and config. A directory becomes
 * an empty read-only tmpfs; a gitlink file is covered by a node it cannot open.
 */
function maskedGit(brain: string): string[] {
  const git = join(brain, ".git");
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(git); } catch { return []; }
  if (info.isDirectory()) return ["--tmpfs", git, "--remount-ro", git];
  if (info.isFile()) return ["--ro-bind", "/dev/null", git];
  throw new WorkerHostError("the brain's .git must be a directory or a gitlink file to be masked");
}

function systemMounts(): string[] {
  const argv: string[] = [];
  for (const path of SYSTEM_DIRECTORIES) {
    if (!existsSync(path)) continue;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) argv.push("--symlink", readlinkSync(path), path);
    else if (info.isDirectory()) argv.push("--ro-bind", path, path);
  }
  for (const name of SYSTEM_ETC) {
    const path = `/etc/${name}`;
    if (existsSync(path)) argv.push("--ro-bind", realpathSync(path), path);
  }
  return argv;
}

function restrictedMounts(envelope: RestrictedEnvelope, brain: string): string[] {
  const argv = systemMounts();
  const seen = new Set<string>();
  for (const requested of envelope.readPaths) {
    if (!isAbsolute(requested)) throw new WorkerHostError("restricted read paths must be absolute");
    const path = realpathSync(requested);
    // The read envelope is explicit. The host root, a home or a whole system
    // tree would make it the old read-only host view under another name.
    if (path === "/" || path === "/tmp" || path === "/home" || path === "/etc" || path === "/run" || path === "/var" || path === "/proc"
      || brain === path || brain.startsWith(`${path}/`)) {
      throw new WorkerHostError(`restricted read path ${path} is broader than an explicit envelope`);
    }
    if (seen.has(path)) continue;
    seen.add(path);
    argv.push("--ro-bind", path, path);
  }
  const inference = realpathSync(envelope.inferenceDir);
  if (!lstatSync(inference).isDirectory() || (statSync(inference).mode & 0o077) !== 0) {
    throw new WorkerHostError("the inference relay directory must be a private directory");
  }
  argv.push("--ro-bind", inference, WORKER_INFERENCE_DIR);
  return argv;
}

/** No bind, including a system bind, may expose the brain or an ancestor of it. */
function transportMounts(envelope: NonNullable<WorkerLaunch["transport"]>, brain: string): string[] {
  const argv = systemMounts();
  for (const requested of ["/etc/resolv.conf", "/etc/ssl/certs", ...envelope.readPaths]) {
    if (existsSync(requested)) argv.push("--ro-bind", realpathSync(requested), requested);
  }
  for (const requested of [envelope.mirror, ...(envelope.writePaths ?? [])]) {
    const real = realpathSync(requested);
    if (!lstatSync(requested).isDirectory() || real !== normalize(requested)) throw new WorkerHostError("transport storage must be an unlinked directory");
    argv.push("--bind", real, requested);
  }
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--bind" && argv[index] !== "--ro-bind") continue;
    const source = realpathSync(argv[index + 1]!);
    if (within(source, brain) || within(brain, source)) throw new WorkerHostError("a transport mount must not expose the brain or its ancestors");
    index += 2;
  }
  argv.push("--dir", MAINTENANCE_HOME,
    ...Object.values(MAINTENANCE_XDG_DIRS).flatMap(path => ["--dir", path]),
    "--dir", "/dev/shm", "--remount-ro", "/dev", "--remount-ro", "/");
  return argv;
}

export class WorkerHostError extends BackendRequestError {
  readonly errorClass = FIRST_PARTY_FAILURE_CLASSES.worker_host_unsupported;
  /** The probe's named requirement alone, for status reporting (#1632). */
  constructor(readonly requirement: string) {
    super(`Agent worker boundary unavailable: ${requirement}. ${WORKER_HOST_ROUTE}`);
    this.name = "WorkerHostError";
  }
}

/** A host resource limit ended the worker (#1660); the message names the limit. */
export class WorkerResourceLimitError extends BackendRequestError {
  readonly errorClass = FIRST_PARTY_FAILURE_CLASSES.worker_resource_limit;
  constructor(readonly hits: WorkerLimitHit[]) {
    super(limitFailureMessage(hits));
    this.name = "WorkerResourceLimitError";
  }
}

/**
 * A worker runs as the server's kernel uid. For uid 0, the host-global files
 * of its fresh procfs (sysctls such as `kernel.core_pattern`, `/proc/acpi`,
 * `dynamic_debug`, the network namespace's entries under `/proc/<pid>/net`)
 * check only the file mode, so a worker without capabilities could still
 * write them (#1629). A root-run server's worker therefore gets the whole
 * procfs read-only. Other workers keep it writable: they reach no host-global
 * file through it, and nested user namespaces (Chromium's sandbox) need
 * `/proc/self/uid_map` (docs/decisions/container-fresh-proc.md).
 */
function rootProcCover(): string[] {
  return process.getuid?.() === 0 || process.geteuid?.() === 0 ? ["--remount-ro", "/proc"] : [];
}

/** The launch's limits, or the host's. A malformed configuration is a named host requirement. */
export function launchLimits(input: Pick<WorkerLaunch, "limits">): WorkerLimitsPlan {
  if (input.limits) return input.limits;
  try { return workerLimitsPlan(); } catch (error) {
    throw new WorkerHostError(`${WORKER_LIMITS_ENV} is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The trusted first program inside the worker's namespaces: `prlimit` sets
 * every rlimit, soft and hard, then execs the worker command. It runs inside
 * so that `RLIMIT_NPROC` counts only the worker's own tasks (worker-limits.ts).
 */
function rlimitPrefix(plan: WorkerLimitsPlan): string[] {
  if (!plan.rlimits.length) return [];
  if (!plan.prlimit) throw new WorkerHostError(PRLIMIT_REQUIREMENT);
  return [plan.prlimit, ...prlimitArgs(plan.rlimits), "--"];
}

/**
 * The mounts of a maintenance worker (#1648), after the read-only host root:
 * the host masks, the runtime bound back below them, the server's home for a
 * credentialed worker, then the brain read-write. A credential-free worker
 * gets the brain's `.env*` files covered, so Bun loads no key into it.
 */
function maintenanceMounts(envelope: MaintenanceEnvelope, brain: string): string[] {
  const masks: string[] = [];
  const fileMasks = new Set<string>();
  // Every mask as asked, before nested ones fold into an ancestor.
  const resolved: string[] = [];
  for (const requested of [...HOST_MASKS, ...(envelope.maskPaths ?? [])]) {
    if (!isAbsolute(requested)) throw new WorkerHostError("maintenance worker masks must be absolute paths");
    let path: string;
    try { path = realpathSync(requested); } catch { continue; }
    const info = statSync(path);
    if (!info.isDirectory() && !info.isFile()) continue;
    if (path === "/" || within(brain, path)) {
      throw new WorkerHostError(`a maintenance worker cannot mask ${path}: it is the brain, inside it or the root`);
    }
    // Host /tmp is already absent behind the worker's private tmpfs. A
    // second operational mask would replace its capacity and writable mode.
    if (within(TURN_TEMP_ROOT, path)) continue;
    if (info.isFile()) { fileMasks.add(path); continue; }
    resolved.push(path);
    if (masks.some(mask => within(mask, path))) continue;
    for (let i = masks.length - 1; i >= 0; i--) if (within(path, masks[i]!)) masks.splice(i, 1);
    masks.push(path);
  }
  const masked = (path: string) => within(TURN_TEMP_ROOT, path) || masks.some(mask => within(mask, path));
  const argv = masks.flatMap(mask => ["--tmpfs", mask]);
  const readOnlyMasks = new Set(masks);
  const bound = new Set<string>();
  const bindBack = (requested: string) => {
    if (!isAbsolute(requested)) throw new WorkerHostError("maintenance worker read paths must be absolute");
    let real: string;
    try { real = realpathSync(requested); } catch { return; }
    for (const path of new Set([real, normalize(requested)])) {
      if (!masked(path) || bound.has(path)) continue;
      bound.add(path);
      // A path reached through a link (a `latest` install alias) gets the
      // file it names bound at the linked path too.
      argv.push("--ro-bind", real, path);
    }
  };
  for (const path of envelope.readPaths) bindBack(path);
  // The resolver configuration, when it links into a masked directory (a
  // systemd-resolved `resolv.conf` under `/run`), stays readable for a
  // networked command. Only that one regular file: any other link from
  // `/etc` into a mask could re-expose a socket or a secret.
  if (envelope.network) {
    try {
      if (lstatSync("/etc/resolv.conf").isSymbolicLink() && statSync("/etc/resolv.conf").isFile()) bindBack("/etc/resolv.conf");
    } catch { /* No resolver configuration: nothing to bind. */ }
  }
  if (envelope.home) {
    if (!envelope.credentials) throw new WorkerHostError("only a credentialed maintenance worker sees the server's home");
    const home = realpathSync(envelope.home.path);
    if (home === "/" || within(brain, home)) throw new WorkerHostError("the server's home must be a directory outside the brain");
    if (envelope.home.overlay) throw new WorkerHostError("maintenance HOME overlays are not bounded; use read-only HOME and bounded XDG directories");
    argv.push("--ro-bind", home, home);
    // A mask inside the home (the UI database's directory below it) is laid
    // again over the home just bound back.
    for (const mask of resolved) if (mask !== home && within(home, mask)) { argv.push("--tmpfs", mask); readOnlyMasks.add(mask); }
  }
  argv.push("--bind", brain, brain);
  if (!envelope.credentials) {
    argv.push("--dir", MAINTENANCE_HOME);
    argv.push(...maintenanceEnvMasks(brain, brain));
  }
  for (const requested of envelope.writeFiles ?? []) {
    const real = realpathSync(requested);
    if (!lstatSync(real).isFile() || within(brain, real)) throw new WorkerHostError("a maintenance worker's writable file must be a regular file outside the brain");
    argv.push("--bind", real, real);
  }
  for (const requested of envelope.writeDirectories ?? []) {
    const info = lstatSync(requested);
    const real = realpathSync(requested);
    if (!info.isDirectory() || info.isSymbolicLink() || real === "/" || within(brain, real) || within(real, brain)) {
      throw new WorkerHostError("a maintenance worker's writable storage must be an unlinked directory outside the brain");
    }
    argv.push("--bind", real, real);
  }
  // Required private regular files (including native loop backing) need a
  // file mount, not tmpfs. Apply after every permitted bind-back so neither
  // HOME nor a runtime directory can restore their original bytes.
  for (const file of fileMasks) argv.push("--ro-bind", "/dev/null", file);
  if (envelope.readOnlyMasks || envelope.tempBytes !== undefined) {
    for (const mask of readOnlyMasks) argv.push("--remount-ro", mask);
  }
  if (envelope.tempBytes !== undefined) {
    argv.push(...Object.values(MAINTENANCE_XDG_DIRS).flatMap(path => ["--dir", path]),
      "--dir", "/dev/shm", "--remount-ro", "/dev");
  }
  return argv;
}

/** Applied after the complete startup view too, so a snapshot never lifts the secret mask. */
function maintenanceEnvMasks(source: string, brain: string, copies: readonly { from: string; to: string }[] = []): string[] {
  const argv: string[] = [];
  const covered = new Set<string>();
  // Resolve in worker-visible names, inspecting brain components through
  // the held snapshot spelling. realpath loses /proc/<server>/fd aliases
  // into the helper-private namespace; absolute brain links must also use
  // the snapshot, rather than resolve against later live bytes.
  const originalName = (path: string) => {
    const copy = copies.find(copy => within(copy.to, path));
    return copy ? copy.from + path.slice(copy.to.length) : path;
  };
  const inspectedName = (path: string) => {
    const original = originalName(path);
    return within(brain, original) ? source + original.slice(brain.length) : original;
  };
  function target(path: string, links = 0): { path: string; info: import("node:fs").Stats } | undefined {
    if (links > 40) return undefined;
    const parts = path.split("/");
    let current = "/";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (!part || part === ".") continue;
      if (part === "..") { current = dirname(current); continue; }
      const next = current === "/" ? `/${part}` : `${current}/${part}`;
      // Named copy mounts create their parents in the worker namespace.
      // Their metadata comes from the original held input tree.
      if (copies.some(copy => next !== copy.to && within(next, copy.to))) { current = next; continue; }
      const inspected = inspectedName(next);
      const info = lstatSync(inspected, { throwIfNoEntry: false });
      if (!info) return undefined;
      if (info.isSymbolicLink()) {
        const link = readlinkSync(inspected);
        return target(`${isAbsolute(link) ? link : `${current}/${link}`}/${parts.slice(i + 1).join("/")}`, links + 1);
      }
      current = next;
    }
    const inspected = inspectedName(current);
    const info = lstatSync(inspected, { throwIfNoEntry: false });
    return info ? { path: current, info } : undefined;
  }
  for (const name of readdirSync(source)) {
    if (!isEnvName(name)) continue;
    const resolved = target(`${brain}/${name}`);
    if (!resolved) continue;
    const original = originalName(resolved.path);
    const destinations = new Set([resolved.path, original]);
    for (const copy of copies) {
      if (within(copy.from, original)) destinations.add(copy.to + original.slice(copy.from.length));
    }
    for (const destination of destinations) {
      if (covered.has(destination)) continue;
      covered.add(destination);
      if (resolved.info.isDirectory()) argv.push("--tmpfs", destination, "--remount-ro", destination);
      // Native checkpoints retain special inodes too. Never leave a FIFO,
      // socket or device reachable through an environment-secret alias.
      else argv.push("--ro-bind", "/dev/null", destination);
    }
  }
  return argv;
}

/** The only argv builder used by both live workers and the actual host probe. */
export function workerCommand(input: WorkerLaunch): string[] {
  if (input.startupView && input.sandbox?.profile === "governed" && !input.restricted && !input.maintenance) {
    throw new WorkerHostError("governed workers require their shared live brain; an immutable startupView cannot be mounted over that writable root");
  }
  if (process.platform !== "linux") throw new WorkerHostError("Linux namespaces are required");
  const bwrap = Bun.which("bwrap");
  if (!bwrap) throw new WorkerHostError("bubblewrap is missing");
  if (!isAbsolute(input.brainPath) || !input.command[0] || !isAbsolute(input.command[0])) {
    throw new WorkerHostError("an absolute brain path and worker executable are required");
  }
  const brain = realpathSync(input.brainPath);
  const scratch = input.scratchPath ? realpathSync(normalize(input.scratchPath)) : WORKER_SCRATCH;
  if (!isAbsolute(scratch) || scratch === brain || scratch.startsWith(`${brain}/`)
    || brain.startsWith(`${scratch}/`) || scratch === "/" || brain === "/" || brain === "/tmp") {
    throw new WorkerHostError("scratch must be a separate location outside the authoritative brain and its ancestors");
  }
  if (input.turnTempBytes !== undefined) {
    validWorkerStateBytes(input.turnTempBytes, "the worker's turn-temp allowance");
    // Scratch lives in the sized /tmp; anywhere else would be a tmpfs of its own, unsized.
    if (!within(TURN_TEMP_ROOT, scratch) || scratch === TURN_TEMP_ROOT) {
      throw new WorkerHostError("scratch must be inside the worker's size-limited /tmp");
    }
  }
  if (input.stateBytes !== undefined) {
    validWorkerStateBytes(input.stateBytes, "the worker's runtime-state allowance");
    if (brain === WORKER_STATE || brain.startsWith(`${WORKER_STATE}/`) || scratch === WORKER_STATE
      || scratch.startsWith(`${WORKER_STATE}/`) || WORKER_STATE.startsWith(`${scratch}/`)) {
      throw new WorkerHostError("runtime state must be a separate location outside the brain and scratch");
    }
  }
  const maintenance = input.maintenance;
  const transport = input.transport;
  if (transport && (input.startupView || maintenance || input.restricted || input.sandbox || input.stateBytes !== undefined || input.turnTempBytes !== undefined)) {
    throw new WorkerHostError("a transport worker has no brain execution envelope or agent state");
  }
  if (maintenance && (input.restricted || input.sandbox || input.stateBytes !== undefined || input.turnTempBytes !== undefined)) {
    throw new WorkerHostError("a maintenance worker has no restricted envelope, writable areas, agent runtime state or turn temp");
  }
  const tempBytes = maintenance ? maintenance.tempBytes ?? DEFAULT_MAINTENANCE_TEMP_BYTES
    : transport ? transport.tempBytes ?? DEFAULT_MAINTENANCE_TEMP_BYTES : input.turnTempBytes;
  if (maintenance || transport) {
    validWorkerStateBytes(tempBytes, "maintenance temporary-write allowance", DEFAULT_MAINTENANCE_TEMP_BYTES);
    if (!within(TURN_TEMP_ROOT, scratch) || scratch === TURN_TEMP_ROOT) throw new WorkerHostError("maintenance scratch must be inside its size-limited /tmp");
  }
  const sized = tempBytes !== undefined;
  const writable = sandboxMounts(input, brain, scratch, input.stateBytes !== undefined ? WORKER_STATE : undefined);
  const argv = [bwrap, "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    // Explicit maintainer approval on #1708: maintenance commands cannot
    // create nested user namespaces; startup asserts that enforcement.
    ...(maintenance || transport ? ["--disable-userns", "--assert-userns-disabled"] : []),
    ...(input.restricted || (maintenance && !maintenance.network) ? ["--unshare-net"] : []),
    "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    // The restricted envelope starts from an empty root; others see the host read-only.
    ...(input.restricted || transport ? [] : ["--ro-bind", "/", "/"]),
    // Turn temp: a private tmpfs of exactly the allowance (#1703). Nothing on
    // the host backs it, and no other worker's namespace can see it.
    "--proc", "/proc", ...rootProcCover(), "--dev", "/dev",
    ...(sized ? ["--size", String(tempBytes), "--tmpfs", TURN_TEMP_ROOT] : ["--tmpfs", TURN_TEMP_ROOT]),
    ...(input.restricted ? restrictedMounts(input.restricted, brain) : []),
    ...(transport ? transportMounts(transport, brain) : maintenance ? maintenanceMounts(maintenance, brain) : input.sandbox?.profile ? maintenanceMounts({
      network: true, credentials: false, readOnlyMasks: true,
      readPaths: input.sandbox.readPaths ?? restrictedReadPaths(input.command.filter(path => isAbsolute(path) && existsSync(path))),
      maskPaths: input.sandbox.maskPaths,
    }, brain) : ["--ro-bind", brain, brain]),
    // Strict restores the old read-only brain after the common masks/runtime view.
    ...(input.startupView ? ["--ro-bind", input.startupView.root, brain]
      : !maintenance && input.sandbox?.profile === "strict" ? ["--ro-bind", brain, brain] : []),
    ...(input.restricted ? maskedGit(brain) : []),
    ...(maintenance?.output ? ["--bind", maintenance.output.source, maintenance.output.target] : []),
    ...(input.startupView && maintenance && !maintenance.credentials ? maintenanceEnvMasks(input.startupView.root, brain, maintenance.output ? [{ from: brain, to: maintenance.output.target }] : []) : []),
    ...(maintenance?.output && !maintenance.credentials ? maintenanceEnvMasks(maintenance.output.source, brain, [{ from: brain, to: maintenance.output.target }]) : []),
    ...(maintenance?.git ? ["--ro-bind", maintenance.git.source, maintenance.git.target, "--ro-bind", maintenance.git.entry, maintenance.git.entry,
      "--ro-bind", maintenance.git.binary, maintenance.git.binary,
      "--bind", join(maintenance.output!.source, ".git"), `${maintenance.output!.target}/.git`,
      "--ro-bind", join(maintenance.git.source, "empty-config"), `${maintenance.output!.target}/.git/config`,
      ...["hooks", "info", "modules"].flatMap(name => {
        const source = join(input.startupView!.root, ".git", name);
        const target = `${maintenance.output!.target}/.git/${name}`;
        return existsSync(source) ? ["--ro-bind", source, target] : ["--tmpfs", target, "--remount-ro", target];
      }),
    ] : []),
    ...(sized ? ["--dir", scratch] : ["--tmpfs", scratch]), ...writable.binds,
    ...(input.sandbox?.profile === "governed" && input.sandbox.protection ? protectedWorkerMounts(brain, input.sandbox.protection) : []), "--clearenv"];
  // Last: neither a complete view nor a protected-path bind may restore a
  // secret over an earlier mask. The masks are about reads, not writes.
  if (!maintenance) {
    const clear = argv.pop();
    const copies = input.areaOutput && input.sandbox?.profile === "strict"
      ? input.sandbox.areas.filter(area => area.mount.writable).map(area => ({ from: join(brain, area.rel), to: `${WORKER_AREA_ROOT}/${area.name}` })) : [];
    argv.push(...maintenanceEnvMasks(input.startupView?.root ?? brain, brain, copies), clear!);
  }

  // A private tmpfs of exactly the allowance. Nothing on the host backs it,
  // and no other worker's namespace can see it (#1625). It lands on top of
  // the turn-temp /tmp and is not part of it.
  if (input.stateBytes !== undefined) argv.push("--size", String(input.stateBytes), "--tmpfs", WORKER_STATE);
  for (const [key, value] of Object.entries(input.env)) argv.push("--setenv", key, value);
  argv.push(...writable.env, "--setenv", "BRAIN_WORKER_SCRATCH", scratch,
    "--chdir", transport ? transport.mirror : brain, "--", ...rlimitPrefix(launchLimits(input)), ...(gated(input) ? [...STATE_GATE] : []), ...input.command);
  const outputStorage = input.areaOutput?.storage ?? maintenance?.output?.storage;
  if (outputStorage) {
    const storage = outputStorage;
    const nsenter = Bun.which("nsenter");
    if (!nsenter) throw new WorkerHostError("util-linux nsenter is required for bounded output staging");
    // Resolve these sources inside the trusted keeper's mount namespace. The
    // worker receives no server descriptor and still gets its own fresh namespaces.
    for (let i = 0; i < argv.length - 2; i++) {
      if (["--bind", "--ro-bind"].includes(argv[i]!) && (argv[i + 1] === storage.root || argv[i + 1]!.startsWith(`${storage.root}/`))) {
        argv[i + 1] = argv[i + 1] === storage.root ? storage.mount : `${storage.mount}/${argv[i + 1]!.slice(storage.root.length + 1)}`;
      }
    }
    return filtered([nsenter, "--user", "--mount", "--preserve-credentials", "--target", String(storage.namespacePid), "--", ...argv]);
  }
  return filtered(argv);

  function filtered(command: string[]): string[] {
    if (input.transport) return command;
    try { return workerFilesystemFilter(brain, command); }
    catch (error) { throw new WorkerHostError(error instanceof Error ? error.message : String(error)); }
  }
}

/** Whether `path` is `dir` or lies below it. */
const within = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);

/**
 * Whether the worker's command waits behind the start gate: it does whenever
 * the server must reach a private tmpfs before any worker code runs.
 */
const gated = (input: Pick<WorkerLaunch, "stateBytes" | "turnTempBytes">) => input.stateBytes !== undefined || input.turnTempBytes !== undefined;

/**
 * The bubblewrap arguments for a resolved sandbox, re-checked against this
 * launch: the sandbox must be for this brain and envelope, each writable area
 * must still be a real directory at its own path in the brain, and the home it
 * was resolved for must still be the worker's `$HOME`. A mismatch refuses the
 * launch rather than binding something the agent's note does not describe.
 */
function sandboxMounts(input: WorkerLaunch, brain: string, scratch: string, state: string | undefined) {
  const out = { binds: [] as string[], env: [] as string[] };
  const sandbox = input.sandbox;
  if (!sandbox) return out;
  if (sandbox.brain !== brain || sandbox.restricted !== Boolean(input.restricted)) {
    throw new WorkerHostError("the worker sandbox was resolved for another brain or envelope");
  }
  if (sandbox.restricted && (sandbox.areas.length || sandbox.home)) {
    throw new WorkerHostError("a restricted worker has no writable areas or home");
  }
  for (const { name, rel, mount } of sandbox.areas) {
    // The note names each area by `rel`; it must be the area's own path.
    if (rel !== WORKER_AREAS[name]) throw new WorkerHostError(`the ${name} area is not at ${WORKER_AREAS[name]}/`);
    if (!mount.writable) continue;
    const path = mount.path;
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (path !== join(brain, rel) || !info?.isDirectory() || realpathSync(path) !== path
      || within(path, scratch) || within(scratch, path) || (state !== undefined && (within(path, state) || within(state, path)))) {
      throw new WorkerHostError(`the writable ${name} area must be a real directory at its own path inside the brain`);
    }
    out.binds.push("--bind", input.areaOutput ? join(input.areaOutput.source, rel) : path,
      input.sandbox?.profile === "governed" ? path : `${WORKER_AREA_ROOT}/${name}`);
  }
  // `$HOME` stays the host's, read-only; what tools write there goes to the
  // per-turn XDG directories in turn temp instead (#1703).
  if (sandbox.home?.mode === "xdg") {
    out.binds.push(...Object.values(WORKER_XDG_DIRS).flatMap(dir => ["--dir", dir]));
    out.env.push(...Object.entries(WORKER_XDG_DIRS).flatMap(([key, dir]) => ["--setenv", key, dir]));
  }
  return out;
}

export interface PrepareWorkerSandboxOptions {
  profile?: "governed" | "strict";
  protectedPaths?: readonly string[];
  appearedPaths?: readonly string[];
  readPaths?: readonly string[];
  maskPaths?: readonly string[];
  maintenance?: import("./maintenance-worker.js").MaintenanceHost;
  restricted?: boolean;
  /** The `HOME` the worker will be given; scratch is checked with it. */
  home?: string;
  /** Which writable areas this worker gets. Default: all of them. */
  areas?: readonly WorkerAreaName[];
}

/**
 * Resolves this worker's writable areas and home once. The backends pass the
 * result to the launcher and render the agent's note from the same object. A
 * restricted (autonomous) turn gets none of them: its envelope is unchanged.
 */
export function prepareWorkerSandbox(brainPath: string, options: PrepareWorkerSandboxOptions = {}): WorkerSandbox {
  let brain: string;
  try { brain = realpathSync(brainPath); } catch {
    // Nothing to bind; the launch itself refuses a missing brain.
    const reason = "the brain directory does not exist";
    return { brain: brainPath, restricted: Boolean(options.restricted), scratchAliasesRemoved: [],
      areas: options.restricted ? [] : (options.areas ?? (Object.keys(WORKER_AREAS) as WorkerAreaName[])).map(name => ({ name, rel: WORKER_AREAS[name], mount: { writable: false, reason, missing: true } })),
      ...(options.restricted ? {} : { home: { mode: "xdg" } }) };
  }
  if (options.restricted) return { brain, restricted: true, areas: [], scratchAliasesRemoved: [] };
  const resolved = options.profile === "governed" ? resolveWorkerProtection(brain, {
    paths: options.protectedPaths, appeared: options.appearedPaths,
  }) : undefined;
  const areas: WorkerArea[] = [];
  let removed: string[] = [];
  for (const name of options.areas ?? (Object.keys(WORKER_AREAS) as WorkerAreaName[])) {
    // A check that fails unexpectedly (EACCES on the way, an unreadable mount
    // table) leaves the area read-only for the turn rather than failing it.
    try {
      if (name === "scratch") {
        const scratch = resolveScratchMount(brain, options.maintenance);
        removed = scratch.removed;
        areas.push({ name, rel: WORKER_AREAS[name], mount: scratch.mount });
      } else areas.push({ name, rel: WORKER_AREAS[name], mount: resolveWorkspacesMount(brain) });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
      areas.push({ name, rel: WORKER_AREAS[name], mount: { writable: false, reason: `${WORKER_AREAS[name]}/ could not be checked (${code})` } });
    }
  }
  // No per-turn home overlay: bubblewrap resolves an overlay's upper
  // directory on the host, where no size-limited mount can hold it (#1703).
  const home: WorkerHome = { mode: "xdg" };
  return { brain, restricted: false, areas, scratchAliasesRemoved: removed,
    ...(options.profile ? { profile: resolved?.reason ? "strict" as const : options.profile,
      ...(resolved ? { protection: resolved.protection } : {}),
      ...(resolved?.reason ? { fallbackReason: resolved.reason } : {}),
      readPaths: options.readPaths, maskPaths: options.maskPaths } : {}),
    // Profile workers never restore the host home over its mask.
    home };

}

/**
 * Private trusted bootstrap. It validates/clears descriptors, joins the
 * worker's cgroup when it has one, then resets signal dispositions and execs the launcher.
 */
export function workerBootstrap(input: WorkerLaunch, cgroup?: string, status?: { source: string; gateSource: string }): { command: string[]; env: Record<string, string> } {
  // Resolve using this package's source/build output, never the brain's module resolver.
  const entry = Bun.resolveSync("./worker-entry", import.meta.dir);
  const { limits: _limits, populateState: _populate, ...launch } = input;
  let argv = workerCommand(input);
  if (status !== undefined) {
    if (![status.source, status.gateSource].every(source => new RegExp(`^/proc/${process.pid}/fd/[0-9]+$`).test(source))) throw new WorkerHostError("invalid trusted worker status source");
    const bwrap = argv.indexOf(Bun.which("bwrap")!);
    if (bwrap < 0) throw new WorkerHostError("worker status requires the trusted bubblewrap launch");
    argv.splice(bwrap + 1, 0, "--json-status-fd", "3", "--block-fd", "4");
    // Every status-qualified launch waits, including commands without state.
    // The PID cannot exit/recycle before verification and freezer setup.
    if (gated(input)) argv.splice(argv.length - input.command.length - STATE_GATE.length, STATE_GATE.length);
    // Bun execve closes descriptors above stdio. Reopen only these host-owned
    // FIFOs after the unchanged bootstrap filter. bubblewrap closes both
    // descriptors in its sandbox child before any payload can run.
    argv = ["/bin/sh", "-c", 'exec 3>"$1"; exec 4<"$2"; shift 2; exec "$@"', "brain-worker-status", status.source, status.gateSource, ...argv];
  }
  return { command: [process.execPath, entry], env: {
    BRAIN_WORKER_LAUNCH: JSON.stringify({ ...launch, argv, ...(cgroup ? { cgroup } : {}) }),
  } };
}

/**
 * Maintenance-only HOME overlay probe (#1648). Agent workers always use XDG
 * under their bounded /tmp (#1703); credentialed maintenance commands retain
 * their existing optional namespace-private home overlay.
 */
export function probeHomeOverlay(brain: string, home: string): true | string {
  const marker = `.brain-home-overlay-probe-${process.pid}-${Date.now()}`;
  const target = join(home, marker);
  try {
    const argv = workerCommand({ brainPath: brain, env: { HOME: home },
      command: ["/bin/sh", "-c", 'echo odysseus > "$HOME/$1" && test -s "$HOME/$1"', "sh", marker],
      maintenance: { network: false, credentials: true, home: { path: home, overlay: true }, readPaths: [] } });
    const result = Bun.spawnSync(argv, { env: {}, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 5_000 });
    if (existsSync(target)) {
      rmSync(target, { force: true });
      return "an overlay write reached the host home";
    }
    if (result.exitCode !== 0) return `bubblewrap could not overlay the home (${result.stderr.toString().trim().slice(0, 200)})`;
    return true;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** How close to a worker's death its own memory limit and an OOM kill must be to have caused it. */
const FATAL_OOM_WINDOW_MS = 1_000;

/** A worker's private runtime state, reachable from the server through one held descriptor (#1625). */
export interface WorkerStateHandle {
  /**
   * A server-side path to the tmpfs root. It stays valid after the worker and
   * its namespace are gone, until `close()`.
   */
  readonly root: string;
  /** The tmpfs's size and the bytes still free in it, read now. */
  space(): { total: number; free: number };
  /** Idempotent. The tmpfs is freed once the worker is gone and this is closed. */
  close(): void;
}

export type LaunchedWorker = ReturnType<ReturnType<typeof createWorkerPipes>["streams"]> & {
  /** Host-held configuration view used by this worker; valid until it exits. */
  readonly configurationRoot?: string;
  /** Host-held actual file views, valid only while this worker runs. */
  observeFile?: (path: string) => ObservedWorkerFile | undefined;
  pid: number;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
  /** Confirm the worker and all descendants are frozen before returning. */
  freeze(): void;
  resume(): void;
  /** The resource limits this launch was given (#1660). */
  limits: WorkerLimitsPlan;
  /** Which limits it has hit so far and, once it has exited, whether one ended it. */
  limitReport(): WorkerLimitReport;
  /** Present when the launch asked for runtime state. */
  state?: WorkerStateHandle;
  /**
   * The worker's private `/tmp`, present when the launch asked for a
   * turn-temp allowance (#1703). Same shape as `state`: its root stays valid
   * after the worker is gone, until `close()`.
   */
  turnTemp?: WorkerStateHandle;
};

/** Whether a process has exited: gone, or a zombie its parent has not reaped yet. */
function exited(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").startsWith("Z"); }
  catch { return true; }
}

/**
 * The sandbox's first process: the only child bubblewrap forks. Read from
 * the kernel's own record of bubblewrap's children, so nothing inside the
 * sandbox can name it.
 */
function sandboxPid(bwrap: number, deadline: number): number {
  for (;;) {
    let children: string[] = [];
    try { children = readFileSync(`/proc/${bwrap}/task/${bwrap}/children`, "utf8").trim().split(/\s+/).filter(Boolean); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Without CONFIG_PROC_CHILDREN, find it by parent process id.
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try { if (readFileSync(`/proc/${name}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[1] === String(bwrap)) children.push(name); }
        catch { /* gone meanwhile */ }
      }
    }
    if (children.length === 1) return Number(children[0]);
    if (children.length > 1) throw new WorkerHostError("bubblewrap started more than one sandbox process");
    if (exited(bwrap)) throw new WorkerHostError("bubblewrap exited before it started its sandbox");
    if (Date.now() > deadline) throw new WorkerHostError("bubblewrap did not start its sandbox in time");
    Bun.sleepSync(1);
  }
}

/**
 * Opens the worker's private tmpfs from outside, through the sandbox's root.
 * bubblewrap reports the sandbox before it mounts anything, so this waits
 * until the path is a mount of its own (a device other than its parent's), a
 * tmpfs of exactly the allowance, and empty. Until then it would still name
 * the host's directory, or nothing.
 */
function openPrivateState(bwrap: number, pid: number, bytes: number, deadline: number, mount = WORKER_STATE, stagingDirectories = false): number {
  const path = `/proc/${pid}/root${mount}`;
  let last = "it never appeared";
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const root = `/proc/self/fd/${fd}`;
      const fs = statfsSync(root);
      if (fs.type === TMPFS_MAGIC && fs.blocks * fs.bsize === bytes && fstatSync(fd).dev !== statSync(`${root}/..`).dev
        && (stagingDirectories ? readdirSync(root).every(name => ["upper", "work", "merged"].includes(name)) : readdirSync(root).length === 0)) return fd;
      last = "it was not yet the private tmpfs";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM") {
        if (fd !== undefined) closeSync(fd);
        throw new WorkerHostError("the server cannot reach its worker's private runtime state through /proc (is bubblewrap installed setuid, or /proc mounted with hidepid?)");
      }
      last = (error as Error).message;
    }
    if (fd !== undefined) closeSync(fd);
    if (exited(pid) || exited(bwrap)) throw new WorkerHostError(`bubblewrap exited before it mounted the worker's private runtime-state tmpfs (${last})`);
    if (Date.now() > deadline) throw new WorkerHostError(`the worker's private runtime-state tmpfs was not mounted in time (${last})`);
    Bun.sleepSync(1);
  }
}

/**
 * Opens the worker's private turn-temp tmpfs from outside, through the
 * sandbox's root (#1703). Until bubblewrap has switched to the sandbox's root,
 * the path names the server's own `/tmp`, so it must be a tmpfs of exactly
 * the allowance on another device than that. Nothing in the worker has run
 * yet: its command waits behind the start gate.
 */
function openPrivateTurnTemp(bwrap: number, pid: number, bytes: number, deadline: number): number {
  const path = `/proc/${pid}/root${TURN_TEMP_ROOT}`;
  let hostTmp: number | undefined;
  try { hostTmp = statSync(TURN_TEMP_ROOT).dev; } catch { hostTmp = undefined; }
  let last = "it never appeared";
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const root = `/proc/self/fd/${fd}`;
      const fs = statfsSync(root);
      const dev = fstatSync(fd).dev;
      if (fs.type === TMPFS_MAGIC && fs.blocks * fs.bsize === bytes && dev !== hostTmp && dev !== statSync(`${root}/..`).dev) return fd;
      last = "it was not yet the private tmpfs";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM") {
        if (fd !== undefined) closeSync(fd);
        throw new WorkerHostError("the server cannot reach its worker's private turn temp through /proc (is bubblewrap installed setuid, or /proc mounted with hidepid?)");
      }
      last = (error as Error).message;
    }
    if (fd !== undefined) closeSync(fd);
    if (exited(pid) || exited(bwrap)) throw new WorkerHostError(`bubblewrap exited before it mounted the worker's private turn-temp tmpfs (${last})`);
    if (Date.now() > deadline) throw new WorkerHostError(`the worker's private turn-temp tmpfs was not mounted in time (${last})`);
    Bun.sleepSync(1);
  }
}

/** A held private tmpfs, as `LaunchedWorker.state` and `.turnTemp` expose it. */
function heldTmpfs(fd: number): WorkerStateHandle {
  const root = `/proc/self/fd/${fd}`;
  let open = true;
  return {
    root,
    space() { const fs = statfsSync(root); return { total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize }; },
    close() { if (open) { open = false; closeSync(fd); } },
  };
}

/**
 * A server-owned, kernel-bounded tmpfs, held by a trusted mount helper
 * until publication finishes. No host directory backs the stored bytes.
 * Only writable upper-layer bytes occupy this allowance. Immutable startup
 * inputs live separately and cannot be modified through this merged view.
 */
export function createOutputStagingStorage(limits: WorkerStateLimits = hostOutputStagingLimits(), lowerRoot?: string) {
  const reservation = processStateLedger().reserve(undefined, undefined, limits);
  let mount: string;
  try { mount = mkdtempSync("/tmp/brain-output-staging-"); } catch (error) { reservation.release(); throw error; }
  let fd: number | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let pipes: ReturnType<typeof createWorkerPipes> | undefined;
  try {
    validWorkerStateBytes(limits.allowanceBytes, "output staging allowance");
    const bwrap = Bun.which("bwrap");
    if (!bwrap) throw new WorkerHostError("bubblewrap is missing");
    if (lowerRoot && !isNativeWorkerStartupRoot(lowerRoot) && !/^\/tmp\/brain-startup-input-[A-Za-z0-9]+\/startup-[A-Za-z0-9]+\/brain$/.test(lowerRoot)) {
      throw new WorkerHostError("output staging requires a server-owned immutable lower path");
    }
    if (lowerRoot && /[,:\\]/.test(lowerRoot)) throw new WorkerHostError("native output staging requires a managed store path without colon, comma or backslash mount-option delimiters");
    if (lowerRoot && isNativeWorkerStartupRoot(lowerRoot)) throw new WorkerHostError("native output staging requires asynchronously prepared trusted OverlayFS through the configured native manager; userxattr fallback is unavailable");
    const mountProgram = lowerRoot ? Bun.which("mount") : undefined;
    if (lowerRoot && !mountProgram) throw new WorkerHostError("util-linux mount is required for bounded copy-on-write output staging");
    pipes = createWorkerPipes();
    // This helper executes only the literal shell below, never repository
    // inputs. Preserve source mount writability so the final worker can
    // rebind an explicitly allowed maintenance span sink. The final worker
    // applies its own read-only root and complete boundary before agent code.
    const setupScript = '"$4" -i -n -t tmpfs -o "size=$3,mode=700" tmpfs "$2" && mkdir "$2/upper" "$2/work" "$2/merged" && "$4" -i -n -t overlay overlay -o "lowerdir=$1,upperdir=$2/upper,workdir=$2/work,userxattr" "$2/merged" || exit 126; printf "ready\\n"; IFS= read -r go; exit 0';
    const unshare = lowerRoot ? Bun.which("unshare") : undefined;
    if (lowerRoot && !unshare) throw new WorkerHostError("util-linux unshare is required for bounded copy-on-write output staging");
    const keeperCommand = lowerRoot
      ? [unshare!, "--user", "--map-root-user", "--mount", "--net", "--ipc", "--uts", "--fork", "--kill-child=SIGKILL",
        "/bin/sh", "-c", setupScript, "brain-output-keeper", lowerRoot, mount, String(limits.allowanceBytes), mountProgram!]
      : [bwrap, "--unshare-user", "--unshare-net", "--unshare-ipc", "--unshare-uts",
        "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--bind", "/", "/", "--proc", "/proc",
        ...["null", "zero", "full", "random", "urandom", "tty"].flatMap(name => ["--dev-bind", `/dev/${name}`, `/dev/${name}`]),
        "--size", String(limits.allowanceBytes), "--tmpfs", mount,
        "--clearenv", "--", "/bin/sh", "-c", 'printf "ready\\n"; IFS= read -r go; exit 0'];
    child = Bun.spawn(keeperCommand, { env: {}, stdin: pipes.child[0], stdout: pipes.child[1], stderr: pipes.child[2] });
    pipes.closeChild();
    const deadline = Date.now() + STATE_SETUP_MS;
    fd = openPrivateState(child.pid, sandboxPid(child.pid, deadline), limits.allowanceBytes, deadline, mount, Boolean(lowerRoot));
    const namespacePid = sandboxPid(child.pid, deadline);
    // Older bubblewrap switches user namespaces after mounting. Wait for
    // the trusted shell itself before asking nsenter to join the finished pair.
    const ready = openSync(`/proc/self/fd/${pipes.parent[1]}`, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      let received = "";
      const buffer = Buffer.alloc(16);
      while (received !== "ready\n") {
        try { received += buffer.subarray(0, readSync(ready, buffer)).toString(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error; }
        if (received === "ready\n") break;
        if (exited(child.pid) || Date.now() > deadline) throw new WorkerHostError("output-staging helper did not become ready");
        Bun.sleepSync(1);
      }
    } finally { closeSync(ready); }
    const owned = fd;
    let refs = 0, closed = false;
    // Only the server reads this descriptor alias. Worker mount sources are
    // resolved inside the keeper namespace, then masked by their own /tmp.
    const root = `/proc/${process.pid}/fd/${owned}`;
    void child.exited.finally(() => pipes!.cleanup());
    return { root, mount, namespacePid, allowanceBytes: reservation.outputStagingBytes,
      retain() { if (closed) throw new Error("output staging is closed"); refs++; },
      release() { if (closed || --refs > 0) return; closed = true; child!.kill("SIGKILL"); closeSync(owned); rmSync(mount, { recursive: true, force: true }); reservation.release(); },
    };
  } catch (error) {
    child?.kill("SIGKILL");
    if (fd !== undefined) closeSync(fd);
    const detail = pipes ? launchDiagnostics(pipes.parent[2]) : "";
    pipes?.cleanup(); rmSync(mount, { recursive: true, force: true }); reservation.release();
    if (detail) throw new WorkerHostError(detail);
    throw error;
  }
}

/** What bubblewrap wrote to the worker's stderr so far, read without waiting. */
function launchDiagnostics(stderr: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(`/proc/self/fd/${stderr}`, constants.O_RDONLY | constants.O_NONBLOCK);
    const chunk = Buffer.alloc(4096);
    return chunk.subarray(0, readSync(fd, chunk)).toString("utf8").trim().slice(0, 400);
  } catch { return ""; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * All three protocol channels are new pipes. No stdio/extra-fd override exists.
 * `limitReport()` says which limits the worker has hit so far and, once it
 * has exited, whether one of them ended it (#1660). A worker with runtime
 * state (#1625) starts its command only after its private tmpfs is mounted,
 * verified and populated.
 */
export function launchAgentWorker(input: WorkerLaunch): LaunchedWorker {
  let startupView = input.preparedOutput?.view ?? input.startupView;
  let areaOutput: ReturnType<typeof prepareWorkerOutput> | PreparedWorkerOutput | undefined = input.preparedOutput;
  let plan: WorkerLimitsPlan;
  try { plan = launchLimits(input); }
  catch (error) {
    void Promise.resolve(input.preparedOutput?.cleanup() ?? startupView?.cleanup()).catch(() => { /* Native broker keeps the recoverable checkpoint identity. */ });
    throw error;
  }
  let cgroup: WorkerCgroup | undefined;
  if (plan.cgroup.available) {
    try { cgroup = createWorkerCgroup(plan.cgroup, plan.limits); } catch (error) {
      // This launch was promised its cgroup limits, so it does not run without
      // them. Later plans, the status and the agent's note say they are absent.
      const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
      workerCgroupHostFailed(reason);
      void Promise.resolve(input.preparedOutput?.cleanup() ?? startupView?.cleanup()).catch(() => { /* Native broker keeps the recoverable checkpoint identity. */ });
      throw new WorkerHostError(`the worker's cgroup could not be created (${reason}); the next turn runs without cgroup limits and says so`);
    }
  }
  let pipes: ReturnType<typeof createWorkerPipes> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stateFd: number | undefined, tempFd: number | undefined;
  let status: ReturnType<typeof createWorkerStatusPipe> | undefined;
  try {
    startupView ??= input.sandbox?.profile === "governed" ? undefined : createWorkerStartupView(realpathSync(input.brainPath), { omitGit: Boolean(input.restricted) });
    const configurationRoot = startupView?.root ?? realpathSync(input.brainPath);
    const areas = input.sandbox?.areas.filter(area => area.mount.writable).map(area => area.rel) ?? [];
    if (startupView && areas.length && !areaOutput) areaOutput = prepareWorkerOutput(input.brainPath, { startupView, areas });
    input = { ...input, ...(startupView ? { startupView } : {}), ...(areaOutput ? { areaOutput: areaOutput.output } : {}) };
    const brain = realpathSync(input.brainPath);
    const observeFile = createWorkerFileObserver({ brain, configurationRoot: startupView?.root ?? brain,
      areas: (input.sandbox?.areas ?? []).flatMap(area => area.mount.writable ? [{ rel: area.rel,
        worker: input.sandbox?.profile === "governed" ? join(brain, area.rel) : join(WORKER_AREA_ROOT, area.name),
        host: input.areaOutput ? join(input.areaOutput.source, area.rel) : area.mount.path }] : []), maskPaths: input.sandbox?.maskPaths });
    pipes = createWorkerPipes();
    status = createWorkerStatusPipe();
    const boot = workerBootstrap({ ...input, limits: plan }, cgroup?.path, status);
    child = Bun.spawn(boot.command, { env: boot.env,
      stdin: pipes.child[0], stdout: pipes.child[1], stderr: pipes.child[2] });
    if (input.preparedOutput) bindPreparedWorkerOutputExit(input.preparedOutput, child.exited);
    pipes.closeChild();
    let state: WorkerStateHandle | undefined, turnTemp: WorkerStateHandle | undefined;
    const deadline = Date.now() + STATE_SETUP_MS;
    let pid: number;
    try { pid = status.childPid(child.pid, deadline); }
    catch (error) { throw new WorkerHostError(error instanceof Error ? error.message : String(error)); }
    status.closeWriter();
    const statusChannel = status;
    void child.exited.finally(() => statusChannel.close());
    const freezer = createWorkerFreezer(pid);
    if (input.stateBytes !== undefined) {
      // Runtime state is bubblewrap's last mount, so once it is there the sandbox is complete.
      stateFd = openPrivateState(child.pid, pid, input.stateBytes, deadline);
      state = heldTmpfs(stateFd);
      input.populateState?.(state.root);
    }
    if (input.turnTempBytes !== undefined) {
      tempFd = openPrivateTurnTemp(child.pid, pid, input.turnTempBytes, deadline);
      turnTemp = heldTmpfs(tempFd);
    }
    // Release the gate: the worker's command starts only now.
    status.release();
    stateFd = tempFd = undefined;
    const streams = pipes.streams();
    let killed = false;
    let final: WorkerLimitReport | undefined;
    // When the worker's own memory limit last fired and an OOM kill last
    // happened, from a fresh cgroup's zero counters. A worker's death (exit
    // 137) is the limit's doing only if both happened just before it: a
    // command the limit killed earlier, which the worker survived, is not.
    const memory = { counters: { oom: 0, oomKill: 0 }, limitAt: -Infinity, killAt: -Infinity };
    const watchMemory = () => {
      if (!cgroup) return;
      const now = cgroup.memoryCounters(), at = performance.now();
      if (now.oom > memory.counters.oom) memory.limitAt = at;
      if (now.oomKill > memory.counters.oomKill) memory.killAt = at;
      memory.counters = now;
    };
    const memoryWatch = cgroup ? setInterval(watchMemory, FATAL_OOM_WINDOW_MS / 4) : undefined;
    memoryWatch?.unref?.();
    // The rlimits make a step fail inside the worker (EAGAIN, ENOMEM, SIGXFSZ)
    // without a record the server can read; the cgroup counts its hits.
    const report = (exitCode?: number | null): WorkerLimitReport => {
      if (final) return final;
      const hits = cgroup?.hits() ?? [];
      let fatal = false;
      if (exitCode === 137 && !killed) {
        watchMemory();
        const recent = performance.now() - FATAL_OOM_WINDOW_MS;
        fatal = memory.limitAt >= recent && memory.killAt >= recent;
      }
      return { hits, fatal };
    };
    const spawned = child;
    const exited = spawned.exited.then(async code => {
      clearInterval(memoryWatch);
      final = report(code);
      if (cgroup) final.peak = cgroup.peak();
      cgroup?.remove();
      try {
        if (areaOutput && input.outputLock) await areaOutput.publishLocked(input.outputLock);
        else await areaOutput?.publish();
      }
      finally { try { await areaOutput?.cleanup(); } finally { if (!input.preparedOutput) await startupView?.cleanup(); } }
      return code;
    });
    return { ...streams, configurationRoot, observeFile, pid: spawned.pid, exited, limits: plan, limitReport: () => report(),
      freeze: () => cgroup ? cgroup.freeze() : freezer.freeze(),
      resume: () => cgroup ? cgroup.resume() : freezer.resume(),
      kill: (signal?: NodeJS.Signals) => { killed = true; return spawned.kill(signal); }, ...(state ? { state } : {}),
      ...(turnTemp ? { turnTemp } : {}) };
  } catch (error) {
    child?.kill("SIGKILL");
    status?.close();
    if (stateFd !== undefined) closeSync(stateFd);
    if (tempFd !== undefined) closeSync(tempFd);
    const detail = error instanceof WorkerHostError && pipes ? launchDiagnostics(pipes.parent[2]) : "";
    pipes?.cleanup(); cgroup?.remove();
    if (child) void child.exited.finally(async () => { try { await areaOutput?.cleanup(); } finally { if (!input.preparedOutput) await startupView?.cleanup(); } }).catch(() => { /* Native broker retains unresolved release intent for recovery. */ });
    else { void Promise.resolve(areaOutput?.cleanup()).finally(() => input.preparedOutput ? undefined : startupView?.cleanup()).catch(() => { /* No child ran; durable ownership retains unresolved release intent. */ }); }
    if (detail) {
      throw new WorkerHostError(NO_TMPFS_SIZE.test(detail)
        ? `bubblewrap 0.7 or later, for the worker's size-limited tmpfs mounts (${detail})`
        : `${(error as WorkerHostError).requirement} (${detail})`);
    }
    throw error;
  }
}

export type WorkerHostProbe = { ok: true } | { ok: false; requirement: string };

/**
 * bubblewrap's own refusal when the kernel will not mount a fresh procfs for
 * the worker's PID namespace. Inside a user namespace the kernel allows that
 * mount only while the parent /proc has no masked or covered paths, and
 * Docker masks several by default (docs/decisions/container-fresh-proc.md).
 */
const FRESH_PROC_REFUSED = /Can't mount proc on \S+: Operation not permitted/;
const FRESH_PROC_REQUIREMENT = "the kernel refused the worker a fresh /proc because the parent /proc has masked or covered paths;"
  + " in Docker, run the container with --security-opt systempaths=unconfined";

export interface WorkerHostProbeOptions {
  profile?: "governed" | "strict";
  /** Also establish the restricted envelope: a private network namespace and an explicit read envelope. */
  restricted?: boolean;
  /**
   * Also mount a private runtime-state tmpfs of this many bytes behind the
   * start gate, and check its size from inside (#1625). Needs bubblewrap 0.7
   * or later for `--size`.
   */
  stateBytes?: number;
  /**
   * Also mount the worker's `/tmp` as a private tmpfs of this many bytes
   * behind the start gate, and check its size from inside (#1703). Needs
   * bubblewrap 0.7 or later for `--size`.
   */
  turnTempBytes?: number;
}

/** bubblewrap before 0.7 does not know `--size`. */
const NO_TMPFS_SIZE = /--size/;
/** Brains whose ordinary worker boundary a real probe has proven in this process. */
const proven = new Set<string>();

/**
 * Whether a real probe has passed for this brain in this process. The host
 * execution boundary (#1648) holds from the first pass on: a host that can
 * run a governed turn never again evaluates the brain's code itself.
 */
export function workerHostProven(brainPath: string): boolean {
  try { return proven.has(realpathSync(brainPath)); } catch { return false; }
}

/** Runs the real launcher before each turn; a version/OS check is insufficient. */
export function probeWorkerHost(brainPath: string, options: WorkerHostProbeOptions = {}): WorkerHostProbe {
  let fixture: string | undefined;
  let relayDir: string | undefined;
  try {
    if (process.platform !== "linux") throw new Error("Linux namespaces are required");
    brainPath = realpathSync(brainPath);
    // The host owns this disposable sentinel on the configured brain filesystem.
    // Even a broken launcher can only change these newly minted fixture bytes.
    fixture = mkdtempSync(join(brainPath, ".worker-host-probe-"));
    const target = join(fixture, "sentinel");
    const golden = "Odysseus: authoritative bytes.\n";
    writeFileSync(target, golden);
    const writableTarget = join(fixture, "writable");
    const sandbox: WorkerSandbox | undefined = options.profile && !options.restricted ? {
      brain: brainPath, restricted: false, profile: options.profile, areas: [], scratchAliasesRemoved: [],
      protection: { ancestors: [normalize(fixture.slice(brainPath.length + 1))], paths: [
        { rel: target.slice(brainPath.length + 1), reason: "probe sentinel", mode: "read_only" },
      ] }, readPaths: [process.execPath],
    } : undefined;
    let restricted: RestrictedEnvelope | undefined;
    if (options.restricted) {
      relayDir = mkdtempSync(join(tmpdir(), "brain-inference-probe-"));
      chmodSync(relayDir, 0o700);
      restricted = { readPaths: [process.execPath], inferenceDir: relayDir };
    }
    // The worker must see each rlimit the plan sets, as its hard limit (#1660).
    const limits = launchLimits({});
    const rows = { processes: "Max processes", data: "Max data size", file_size: "Max file size", open_files: "Max open files" };
    const expected = limits.rlimits.map(({ limit, value }) => [rows[limit], value] as const);
    const program = `import {writeFileSync,readFileSync,existsSync} from "node:fs";
      const table=readFileSync("/proc/self/limits","utf8").split("\\n");
      for(const [row,value] of ${JSON.stringify(expected)}){
        const fields=(table.find(l=>l.startsWith(row))??"").slice(row.length).trim().split(/\\s+/);
        if(fields[0]!==String(value)||fields[1]!==String(value)) process.exit(5);
      }
      let denied=false; try {writeFileSync(${JSON.stringify(target)},"changed")} catch {denied=true}
      const scratch=process.env.BRAIN_WORKER_SCRATCH+"/positive";
      writeFileSync(scratch,"Odysseus: scratch works.");
      if(!denied || readFileSync(scratch,"utf8")!=="Odysseus: scratch works.") process.exit(1);
      ${options.profile === "governed" && !options.restricted ? `writeFileSync(${JSON.stringify(writableTarget)},"Odysseus: governed works.");` : ""}
      ${options.restricted ? `const links=readFileSync("/proc/net/dev","utf8").split("\\n").slice(2).map(l=>l.split(":")[0].trim()).filter(Boolean);
      if(links.join()!=="lo") process.exit(2);
      if(!existsSync(${JSON.stringify(WORKER_INFERENCE_DIR)})) process.exit(4);` : ""}
      ${options.stateBytes !== undefined ? `const state=require("node:fs").statfsSync(${JSON.stringify(WORKER_STATE)});
      if(state.type!==${TMPFS_MAGIC}||state.blocks*state.bsize!==${Number(options.stateBytes)}) process.exit(6);` : ""}
      ${options.turnTempBytes !== undefined ? `const temp=require("node:fs").statfsSync(${JSON.stringify(TURN_TEMP_ROOT)});
      if(temp.type!==${TMPFS_MAGIC}||temp.blocks*temp.bsize!==${Number(options.turnTempBytes)}) process.exit(7);` : ""}
      console.log("worker-boundary-pass");`;
    // The probe starts outside the brain and loads no `.env`: the brain's own
    // `bunfig.toml` or `.env` must never decide whether the boundary holds (#1648).
    const boot = workerBootstrap({ brainPath, command: ["/bin/sh", "-c", 'cd / && exec "$0" --no-env-file -e "$1"', process.execPath, program], env: {}, restricted, limits, sandbox,
      ...(options.stateBytes !== undefined ? { stateBytes: options.stateBytes } : {}),
      ...(options.turnTempBytes !== undefined ? { turnTempBytes: options.turnTempBytes } : {}) });

    const pipes = createWorkerPipes();
    try {
      // Opens the start gate up front; the probe has nothing to copy in.
      if (gated(options)) writeSync(pipes.parent[0], STATE_GATE_OPEN);
      const child = Bun.spawnSync(boot.command, { env: boot.env, stdin: pipes.child[0],
        stdout: pipes.child[1], stderr: pipes.child[2], timeout: 5_000 });
      pipes.closeChild(); pipes.closeInput();
      const output = readFileSync(pipes.parent[1], "utf8");
      const errors = readFileSync(pipes.parent[2], "utf8");
      if (child.exitCode !== 0 || output.trim() !== "worker-boundary-pass" || readFileSync(target, "utf8") !== golden
        || (options.profile === "governed" && !options.restricted && (!existsSync(writableTarget) || readFileSync(writableTarget, "utf8") !== "Odysseus: governed works."))) {
        const detail = errors.trim().slice(0, 400);
        const filesystemRefusal = workerFilesystemFilterRefusal(errors);
        if (filesystemRefusal) throw new WorkerHostError(filesystemRefusal);
        if (FRESH_PROC_REFUSED.test(errors)) throw new Error(`${FRESH_PROC_REQUIREMENT} (${detail})`);
        if (gated(options) && NO_TMPFS_SIZE.test(errors)) {
          throw new Error(`bubblewrap 0.7 or later, for the worker's size-limited tmpfs mounts (${detail})`);
        }
        const what = child.exitCode === 2 ? "a private network namespace with only loopback"
          : child.exitCode === 4 ? "the inference relay mount"
          : child.exitCode === 5 ? "the worker's resource limits (prlimit)"
          : child.exitCode === 6 ? "a private, size-limited runtime-state tmpfs"
          : child.exitCode === 7 ? "a private, size-limited turn-temp /tmp"
          : "bubblewrap namespaces, read-only brain, writable scratch or pipe/descriptor validation";
        throw new Error(`${what} failed (${detail})`);
      }
    } finally { pipes.cleanup(); }
    if (!options.restricted) proven.add(brainPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, requirement: error instanceof WorkerHostError ? error.requirement
      : error instanceof Error ? error.message : String(error) };
  } finally {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
    if (relayDir) rmSync(relayDir, { recursive: true, force: true });
  }
}

/** Concrete probe object permits test spies, with no production disable flag. */
export const workerHostBoundary = { probe: probeWorkerHost };
export function requireWorkerHost(brainPath: string, options: WorkerHostProbeOptions = {}): void {
  let result: WorkerHostProbe;
  try {
    result = workerHostBoundary.probe(brainPath, options);
  } catch (error) {
    if (error instanceof WorkerHostError) throw error;
    throw new WorkerHostError(error instanceof Error ? error.message : String(error));
  }
  if (!result.ok) throw new WorkerHostError(result.requirement);
}

/**
 * The read envelope a restricted worker needs to run code that lives in
 * installed packages: the Bun runtime, every `node_modules` directory on each
 * entry's ancestor chain, the targets of linked workspace packages in them,
 * and each entry's own package. No sibling file of an install root (for
 * example an `.env` beside `node_modules`) and no home directory is included.
 */
export function restrictedReadPaths(entries: readonly string[]): string[] {
  const paths = new Set<string>([realpathSync(process.execPath)]);
  for (const entry of entries) {
    const real = realpathSync(entry);
    let dir = dirname(real);
    let owner: string | undefined;
    for (;;) {
      if (!owner && existsSync(join(dir, "package.json"))) owner = dir;
      const modules = join(dir, "node_modules");
      if (existsSync(modules) && lstatSync(modules).isDirectory()) {
        paths.add(realpathSync(modules));
        for (const name of readdirSync(modules)) {
          const entries = name.startsWith("@") && lstatSync(join(modules, name)).isDirectory()
            ? readdirSync(join(modules, name)).map(child => join(modules, name, child)) : [join(modules, name)];
          for (const path of entries) if (lstatSync(path).isSymbolicLink() && existsSync(path)) paths.add(realpathSync(path));
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    paths.add(owner ?? real);
  }
  return [...paths];
}
