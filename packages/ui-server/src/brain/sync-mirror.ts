/**
 * Hosted Git sync (#1674). The brain's executable inputs see no credential.
 * Only objects and refs cross the local file transport; the mirror's root,
 * configuration and hooks remain host-owned. The transport never mounts the
 * brain. The caller holds the exclusive writer gate for the entire workflow.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { runMaintenanceWorker, prepareNativeWorkerStartupView, ProtectedMaintenanceOutputError, type MaintenanceCommand } from "@schlessera/brain-ui-sdk/internal";
import { GOVERNANCE_POLICY_PATH } from "@schlessera/brain-common/internal/governance-policy";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { prepareMaintenanceOutput } from "./maintenance-output.js";
import { prepareMaintenanceGit } from "./maintenance-git.js";
import type { ExecutionResult } from "./host-boundary.js";

const MIRROR_CONFIG = `[core]
\trepositoryformatversion = 0
\tbare = true
\thooksPath = /dev/null
[receive]
\tfsckObjects = true
[fetch]
\tfsckObjects = true
[transfer]
\tfsckObjects = true
`;
const CREDENTIAL_HELPER = '!f() { printf "username=x-access-token\\npassword=%s\\n" "$BRAIN_SYNC_TOKEN"; }; f';
/** Deny direction (#3422): whether `path` is `root` or below it; a `root` of `/` holds every absolute path. */
export const within = (root: string, path: string) => isWithin(root, path, { trailingSeparator: "boundary" });
const mirrorLocks = createKeyedLock();

/** One host-private mirror per brain/database; standalone clients get private temporary state. */
export function syncMirrorPath(brain: string, dbPath?: string): string {
  if (!dbPath || dbPath === ":memory:") return join(mkdtempSync(join(tmpdir(), "brain-sync-")), "mirror.git");
  const id = createHash("sha256").update(`${realpathSync(brain)}\0${resolve(dbPath)}`).digest("hex").slice(0, 20);
  const directory = dirname(resolve(dbPath));
  return join(existsSync(directory) ? realpathSync(directory) : directory, `brain-sync-${id}.git`);
}

/** Reject linked or special object/ref storage before a credential is admitted. No link is followed. */
export function assertMirrorStorage(mirror: string): void {
  const walk = (path: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("sync mirror contains linked or special storage");
    if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(mirror);
  for (const name of ["alternates", "http-alternates"]) {
    if (existsSync(join(mirror, "objects/info", name))) throw new Error("sync mirror object alternates are forbidden");
  }
}

/** Prepare only host-owned Git metadata, never evaluating the brain or its Git configuration. */
export function prepareMirror(mirror: string, brain: string): void {
  const parent = dirname(mirror);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (within(brain, realpathSync(parent))) throw new Error("the host sync mirror must be outside the brain");
  if (!existsSync(mirror)) {
    mkdirSync(mirror, { mode: 0o700 });
    for (const path of ["objects/info", "objects/pack", "refs/heads", "refs/tags"]) mkdirSync(join(mirror, path), { recursive: true, mode: 0o700 });
    // Keep HEAD off the exchanged branch: receive-pack otherwise tries to
    // take a HEAD.lock beside the deliberately read-only host metadata.
    writeFileSync(join(mirror, "HEAD"), "ref: refs/heads/host-transport\n", { mode: 0o600 });
  }
  assertMirrorStorage(mirror);
  if (realpathSync(mirror) !== mirror) throw new Error("the host sync mirror must have an unlinked path");
  chmodSync(mirror, 0o700);
  // The worker only has objects/refs writable. Still regenerate this fixed
  // metadata on every use, so no obsolete host configuration is inherited.
  writeFileSync(join(mirror, "config"), MIRROR_CONFIG, { mode: 0o600 });
}

/** Literal protected origin only: writable includes cannot select a credential's destination. */
async function origin(command: MaintenanceCommand): Promise<string | null> {
  const git = Bun.which("git", { PATH: "/usr/bin:/bin" });
  if (!git) throw new Error("host sync needs system git");
  const result = await runMaintenanceWorker({ ...command, tempKind: "sync", command: [git, "config", "--local", "--no-includes", "--get", "remote.origin.url"],
    credentials: false, timeoutMs: 10_000 });
  if (result.killed) throw new Error("reading the host sync remote timed out");
  // No configured remote means there is no credentialed transport. Run the
  // CLI uncredentialed so it retains its own no-repository/no-remote result.
  if (result.exitCode !== 0) return null;
  const remote = result.stdout.trim();
  if (!remote || /[\r\n\0]/.test(remote) || remote.startsWith("-")) throw new Error("invalid sync remote");
  return remote;
}

/**
 * Host-owned transport input; no complete home, brain PATH, arbitrary extra env or repository helper reaches it.
 * The host credential goes to `https://github.com` only, or to `credentialOrigin` when a host-side caller names one.
 */
export function syncTransportCommand(input: { brain: string; mirror: string; remote: string; env: MaintenanceCommand["env"]; args: readonly string[]; tempLimits?: MaintenanceCommand["tempLimits"]; tempDomain?: MaintenanceCommand["tempDomain"];
  /** @internal A fixture origin that receives the credential instead; never derived from repository input. */
  credentialOrigin?: string }): MaintenanceCommand {
  const git = Bun.which("git", { PATH: "/usr/bin:/bin" });
  if (!git) throw new Error("host sync needs system git");
  const readPaths: string[] = [];
  const writePaths: string[] = [];
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: "/tmp/brain-maintenance-home", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    // A worker can write the mirror's refs: a replace ref must never change what an object reads as (#4256).
    GIT_NO_REPLACE_OBJECTS: "1" };
  let remote = input.remote;
  if (remote.startsWith("/") || remote.startsWith("file://")) {
    const path = realpathSync(remote.startsWith("file://") ? new URL(remote).pathname : remote);
    if (within(input.brain, path) || within(path, input.brain)) throw new Error("the sync transport must not mount the brain or its ancestors");
    writePaths.push(path);
    remote = `file://${path}`;
    // Local fixture/file transport needs no credential, even if one exists.
  } else {
    const ssh = /^([a-zA-Z0-9._-]+@)?[a-zA-Z0-9.-]+:[^/].*/.test(remote) && !remote.includes("://");
    const url = ssh ? new URL(`ssh://${remote.replace(":", "/")}`) : new URL(remote);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && url.protocol !== "ssh:" && !(loopback && ["http:", "git:"].includes(url.protocol)))
      || url.password || url.search || url.hash || (url.protocol === "https:" && url.username)) throw new Error("host sync needs HTTPS without embedded credentials, SSH, or a local fixture remote");
    if (url.protocol === "ssh:") {
      const home = input.env.HOME;
      if (home && existsSync(join(home, ".ssh"))) { readPaths.push(join(home, ".ssh")); env.HOME = home; }
      const socket = input.env.SSH_AUTH_SOCK;
      if (socket && existsSync(socket)) { readPaths.push(socket); env.SSH_AUTH_SOCK = socket; }
    }
    if (input.credentialOrigin ? url.origin === input.credentialOrigin : url.protocol === "https:" && url.hostname === "github.com" && !url.port) {
      const token = input.env.BRAIN_UI_SYNC_GITHUB_TOKEN ?? input.env.GITHUB_TOKEN;
      if (token) env.BRAIN_SYNC_TOKEN = token;
    }
  }
  return { brainPath: input.brain, credentials: true, tempKind: "sync", env,
    ...(input.tempLimits ? { tempLimits: input.tempLimits } : {}),
    ...(input.tempDomain ? { tempDomain: input.tempDomain } : {}),
    command: [git, "--git-dir", input.mirror, "-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`,
      "-c", "http.followRedirects=false", "-c", "core.hooksPath=/dev/null", ...input.args.map(arg => arg === "$REMOTE" ? remote : arg)],
    transport: { mirror: input.mirror, readPaths, writePaths } };
}

/** Execute repository code from immutable inputs and publish validated outputs before transport. */
/**
 * A pull that changes the governance policy (#4256): the incoming bytes and
 * the upstream commit they arrived with. Nothing was published; the owner
 * reviews the change, and only an approval writes it, through the policy writer.
 */
export interface IncomingPolicyChange { content: Uint8Array; upstream: string | null }
/** Larger than the policy writer's 1 MiB bound, so an oversize policy is refused there, by name. */
const INCOMING_POLICY_READ_BOUND = 1024 * 1024 + 1;

/** A sync whose local workflow ran but whose output was refused: mark a JSON result failed too. */
function refusedSync(local: ExecutionResult, reason: string): ExecutionResult {
  let stdout = local.stdout;
  try {
    const result = JSON.parse(stdout);
    if (result && typeof result === "object" && result.run && typeof result.run === "object") {
      result.run.status = "failed";
      result.run.reason = reason;
      result.run.report = `${reason}\n${typeof result.run.report === "string" ? result.run.report : ""}`;
      stdout = JSON.stringify(result);
    }
    else stdout = "";
  } catch {
    // A human report would describe commits and a push that never published: the reason replaces it.
    stdout = "";
  }
  return { stdout, stderr: reason, exitCode: 1 };
}

/** What a refused tier A sync output says, and does, next (#4256). */
async function protectedRefusal(local: ExecutionResult, error: ProtectedMaintenanceOutputError, policy: {
  onPolicyChange?: (change: IncomingPolicyChange) => void; upstream?: string | null;
  /** Whether `content` is exactly the upstream commit's policy blob, read by the host transport, never the worker. */
  verify?: (content: Uint8Array) => Promise<boolean>;
}): Promise<ExecutionResult> {
  // Only the policy file, and the policy directory a first policy creates with it.
  const policyOnly = error.paths.includes(GOVERNANCE_POLICY_PATH)
    && error.paths.every(path => path === GOVERNANCE_POLICY_PATH || isWithin(path, GOVERNANCE_POLICY_PATH, { includeRoot: false }) && isWithin("context/policies", path));
  if (policyOnly && policy.upstream) {
    let content: Uint8Array | null;
    try { content = await error.read(GOVERNANCE_POLICY_PATH, INCOMING_POLICY_READ_BOUND); }
    catch { return refusedSync(local, `${error.message}. Nothing was published. The incoming ${GOVERNANCE_POLICY_PATH} exceeds the policy writer's 1 MiB bound, so it cannot be reviewed: shrink it upstream, or revert the upstream commit that makes it.`); }
    if (content) {
      // A review offers only what the upstream commit itself carries: worker output is never a policy source.
      // A scheduled sync decides the same way, so it never names a review a UI sync would refuse.
      if (!policy.verify || !await policy.verify(content))
        return refusedSync(local, `${error.message}. Nothing was published. The merged ${GOVERNANCE_POLICY_PATH} differs from the upstream commit's, so it cannot be reviewed: change the policy upstream so the brain's copy matches it, or revert the upstream commit.`);
      if (!policy.onPolicyChange)
        return refusedSync(local, `Sync stopped before publishing anything: the pull changes ${GOVERNANCE_POLICY_PATH}, and a policy change needs the owner's review. Run Sync in the app to review it.`);
      policy.onPolicyChange({ content, upstream: policy.upstream });
      return refusedSync(local, `Sync paused before publishing anything: the pull changes ${GOVERNANCE_POLICY_PATH}. Review the policy change; approving it adopts the policy, and the next sync completes.`);
    }
  }
  const policies = error.paths.some(path => isWithin("context/policies", path));
  // Only a sync that pulled has an upstream commit to name; otherwise the change came from the brain itself.
  const source = policy.upstream ? "revert the upstream commit that makes it, or remove the change from the brain's repository if the sync made it"
    : "remove the change from the brain's repository";
  return refusedSync(local, `${error.message}. Nothing was published. A sync never adopts this change: ${source}${policies ? `, then change the policy in chat (propose_policy_change)` : ""}.`);
}

async function runLocalSync(command: MaintenanceCommand & { signal?: AbortSignal; timeoutMs?: number; onPolicyChange?: (change: IncomingPolicyChange) => void; upstream?: string | null;
  verify?: (content: Uint8Array) => Promise<boolean> }, nativeManager: Parameters<typeof prepareNativeWorkerStartupView>[1] | undefined, folderPaths?: readonly string[], log?: import("@opentelemetry/api-logs").Logger): Promise<ExecutionResult> {
  if (!nativeManager) throw new Error("Local sync requires the configured native managed-storage manager; full-copy fallback is unavailable.");
  const view = await prepareNativeWorkerStartupView(command.brainPath, nativeManager, command.signal);
  let outputs: Awaited<ReturnType<typeof prepareMaintenanceOutput>> | undefined;
  try {
    command.signal?.throwIfAborted();
    outputs = await prepareMaintenanceOutput(command.brainPath, { startupView: view, folderPaths, signal: command.signal });
    const git = await prepareMaintenanceGit(command, outputs, command.signal, log);
    const { onPolicyChange, upstream, verify, ...worker } = command;
    const result = await runMaintenanceWorker({ ...worker, tempKind: "sync", startupView: outputs.view, output: outputs.output, ...(git ? { git } : {}) });
    if (!result.killed) {
      try { await outputs.publish(); }
      catch (error) {
        if (!(error instanceof ProtectedMaintenanceOutputError) || result.exitCode !== 0) throw error;
        return await protectedRefusal(result, error, { onPolicyChange, upstream, verify });
      }
    }
    return result;
  } finally { try { await outputs?.cleanup(); } finally { await view.cleanup(); } }
}

/** Full deterministic sync with the same local merge behavior; remote races repeat its existing re-pull flow. */
export async function runMirrorSync(input: { log?: import("@opentelemetry/api-logs").Logger; folderPaths?: readonly string[]; nativeManager?: Parameters<typeof prepareNativeWorkerStartupView>[1]; command: MaintenanceCommand; mirror: string; transportEnv?: MaintenanceCommand["env"]; signal?: AbortSignal; timeoutMs?: number;
  /** Called once the sync's first worker is about to start: after the mirror lock, the startup view and the origin probe (#4257). */
  onExecute?: () => void;
  /** Called, before the sync ends, when its pull changes only the governance policy (#4256). Absent: the sync refuses and names the waiting change. */
  onPolicyChange?: (change: IncomingPolicyChange) => void }): Promise<ExecutionResult> {
  // Standalone embedders have no attached database gate. Their private
  // mirror still serializes every local/transport phase in this process.
  return mirrorLocks.withLock(input.mirror, () => executeMirrorSync(input), { signal: input.signal });
}

async function executeMirrorSync(input: Parameters<typeof runMirrorSync>[0]): Promise<ExecutionResult> {
  const { command, mirror } = input;
  const brain = realpathSync(command.brainPath);
  if (!input.nativeManager) throw new Error("Hosted sync requires the configured native managed-storage manager; full-copy fallback is unavailable.");
  const originView = await prepareNativeWorkerStartupView(brain, input.nativeManager, input.signal);
  let remote: string | null;
  try { input.signal?.throwIfAborted(); remote = await origin({ ...command, startupView: originView }); }
  finally { await originView.cleanup(); }
  input.signal?.throwIfAborted();
  input.onExecute?.();
  // Without a remote nothing is pulled, so no policy change can arrive: none is reviewable.
  if (remote === null) return runLocalSync({ ...command, credentials: false,
    ...(input.signal ? { signal: input.signal } : {}), ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) }, input.nativeManager, input.folderPaths, input.log);
  prepareMirror(mirror, brain);
  const transport = async (args: readonly string[], outputBytes?: number) => {
    assertMirrorStorage(mirror);
    return runMaintenanceWorker({ ...syncTransportCommand({ brain, mirror, remote, env: input.transportEnv ?? command.env, args, tempLimits: command.tempLimits, tempDomain: command.tempDomain }),
      ...(input.signal ? { signal: input.signal } : {}), ...(outputBytes ? { outputBytes } : {}), timeoutMs: input.timeoutMs ?? 120_000 });
  };
  let last: ExecutionResult = { stdout: "", stderr: "", exitCode: 1 };
  for (let attempt = 0; attempt < 3; attempt++) {
    const integrity = await transport(["fsck", "--full", "--strict"]);
    if (integrity.exitCode !== 0) return { ...integrity, exitCode: 1 };
    const fetched = await transport(["fetch", "--no-tags", "$REMOTE", "+refs/heads/main:refs/heads/main"]);
    if (fetched.exitCode !== 0) return { ...fetched, exitCode: 1 };
    // Entire config/commit/pull/merge/judgment/index flow stays in a worker
    // with no credential. Only objects and refs are writable in the mirror;
    // config, HEAD, hooks and the directory itself remain read-only.
    // The upstream policy is read now, after the integrity check and the fetch
    // and before any worker of this sync runs, so worker writes to the mirror
    // cannot change what it is compared with.
    const upstream = mirrorHead(mirror);
    // Bounded like the stage read: a larger upstream policy is never held, and it cannot be reviewed.
    const upstreamPolicy = upstream ? await transport(["cat-file", "blob", `${upstream}:${GOVERNANCE_POLICY_PATH}`], INCOMING_POLICY_READ_BOUND) : null;
    const expected = upstreamPolicy?.exitCode === 0 && !upstreamPolicy.killed ? upstreamPolicy.stdout : null;
    last = await runLocalSync({ ...command, credentials: false, upstream,
      ...(input.onPolicyChange ? { onPolicyChange: input.onPolicyChange } : {}),
      verify: async content => {
        if (expected === null) return false;
        try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content) === expected; } catch { return false; }
      },
      readPaths: [...(command.readPaths ?? []), mirror],
      writeDirectories: [join(mirror, "objects"), join(mirror, "refs")],
      gitConfig: [["safe.directory", brain], ["safe.directory", mirror], [`url.file://${mirror}.insteadOf`, remote], ["remote.origin.pushurl", `file://${mirror}`]],
      ...(input.signal ? { signal: input.signal } : {}), ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) }, input.nativeManager, input.folderPaths, input.log);
    if (last.exitCode !== 0) return last;
    // Maintenance awaits both monitor exit and namespace-owned output EOF.
    // A child may leave files during teardown: validate them before a key.
    const checked = await transport(["fsck", "--full", "--strict"]);
    if (checked.exitCode !== 0) return transportFailure(last, checked);
    const pushed = await transport(["push", "$REMOTE", "refs/heads/main:refs/heads/main"]);
    if (pushed.exitCode === 0) return last;
    last = transportFailure(last, pushed);
    // Only a non-fast-forward race warrants another deterministic re-pull.
    if (!/\[rejected\].*(?:fetch first|non-fast-forward)/.test(pushed.stderr)) return last;
  }
  return last;
}

/** The fetched upstream `main` in the mirror, or null when it cannot be read. */
function mirrorHead(mirror: string): string | null {
  const sha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
  try { const loose = readFileSync(join(mirror, "refs/heads/main"), "utf8").trim(); if (sha.test(loose)) return loose; } catch { /* packed */ }
  try {
    for (const line of readFileSync(join(mirror, "packed-refs"), "utf8").split("\n")) {
      const [id, ref] = line.trim().split(" ");
      if (ref === "refs/heads/main" && id && sha.test(id)) return id;
    }
  } catch { /* none */ }
  return null;
}

/** A local mirror push is not a successful external push; keep hosted status and exit evidence consistent. */
function transportFailure(local: ExecutionResult, failed: ExecutionResult): ExecutionResult {
  const reason = `host Git transport failed: ${failed.stderr.trim() || failed.stdout.trim() || `exit ${failed.exitCode}`}`;
  let stdout = local.stdout;
  try {
    const result = JSON.parse(stdout);
    if (result && typeof result === "object" && result.run && typeof result.run === "object") {
      result.run.status = "failed";
      result.run.reason = reason;
      result.run.report = `${reason}\nLocal mirror workflow:\n${typeof result.run.report === "string" ? result.run.report : ""}`;
      stdout = JSON.stringify(result);
    }
  } catch { /* Human-mode output retains its local report; stderr records the failed outward transport. */ }
  return { stdout, stderr: reason, exitCode: 1 };
}
