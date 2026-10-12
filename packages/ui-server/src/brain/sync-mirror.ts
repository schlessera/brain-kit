/**
 * Hosted Git sync (#1674). The brain's executable inputs see no credential.
 * Only objects and refs cross the local file transport; the mirror's root,
 * configuration and hooks remain host-owned. The transport never mounts the
 * brain. The caller holds the exclusive writer gate for the entire workflow.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runMaintenanceWorker, type MaintenanceCommand } from "@schlessera/brain-ui-sdk/internal";
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
const within = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
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
function prepareMirror(mirror: string, brain: string): void {
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
  const result = await runMaintenanceWorker({ ...command, command: [git, "config", "--local", "--no-includes", "--get", "remote.origin.url"],
    credentials: false, timeoutMs: 10_000 });
  if (result.killed) throw new Error("reading the host sync remote timed out");
  // No configured remote means there is no credentialed transport. Run the
  // CLI uncredentialed so it retains its own no-repository/no-remote result.
  if (result.exitCode !== 0) return null;
  const remote = result.stdout.trim();
  if (!remote || /[\r\n\0]/.test(remote) || remote.startsWith("-")) throw new Error("invalid sync remote");
  return remote;
}

/** Host-owned transport input; no complete home, brain PATH, arbitrary extra env or repository helper reaches it. */
export function syncTransportCommand(input: { brain: string; mirror: string; remote: string; env: MaintenanceCommand["env"]; args: readonly string[]; tempLimits?: MaintenanceCommand["tempLimits"]; tempDomain?: MaintenanceCommand["tempDomain"] }): MaintenanceCommand {
  const git = Bun.which("git", { PATH: "/usr/bin:/bin" });
  if (!git) throw new Error("host sync needs system git");
  const readPaths: string[] = [];
  const writePaths: string[] = [];
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: "/tmp/brain-maintenance-home", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
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
    if (url.protocol === "https:" && url.hostname === "github.com" && !url.port) {
      const token = input.env.BRAIN_UI_SYNC_GITHUB_TOKEN ?? input.env.GITHUB_TOKEN;
      if (token) env.BRAIN_SYNC_TOKEN = token;
    }
  }
  return { brainPath: input.brain, credentials: true, env,
    ...(input.tempLimits ? { tempLimits: input.tempLimits } : {}),
    ...(input.tempDomain ? { tempDomain: input.tempDomain } : {}),
    command: [git, "--git-dir", input.mirror, "-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`,
      "-c", "http.followRedirects=false", "-c", "core.hooksPath=/dev/null", ...input.args.map(arg => arg === "$REMOTE" ? remote : arg)],
    transport: { mirror: input.mirror, readPaths, writePaths } };
}

/** Execute repository code from immutable inputs and publish validated outputs before transport. */
async function runLocalSync(command: MaintenanceCommand & { signal?: AbortSignal; timeoutMs?: number }): Promise<ExecutionResult> {
  const outputs = prepareMaintenanceOutput(command.brainPath);
  try {
    const git = await prepareMaintenanceGit(command, outputs, command.signal);
    const result = await runMaintenanceWorker({ ...command, startupView: outputs.view, output: outputs.output, ...(git ? { git } : {}) });
    if (!result.killed) outputs.publish();
    return result;
  } finally { outputs.cleanup(); }
}

/** Full deterministic sync with the same local merge behavior; remote races repeat its existing re-pull flow. */
export async function runMirrorSync(input: { command: MaintenanceCommand; mirror: string; transportEnv?: MaintenanceCommand["env"]; signal?: AbortSignal; timeoutMs?: number }): Promise<ExecutionResult> {
  // Standalone embedders have no attached database gate. Their private
  // mirror still serializes every local/transport phase in this process.
  return mirrorLocks.withLock(input.mirror, () => executeMirrorSync(input), { signal: input.signal });
}

async function executeMirrorSync(input: Parameters<typeof runMirrorSync>[0]): Promise<ExecutionResult> {
  const { command, mirror } = input;
  const brain = realpathSync(command.brainPath);
  const remote = await origin(command);
  if (remote === null) return runLocalSync({ ...command, credentials: false,
    ...(input.signal ? { signal: input.signal } : {}), ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) });
  prepareMirror(mirror, brain);
  const transport = async (args: readonly string[]) => {
    assertMirrorStorage(mirror);
    return runMaintenanceWorker({ ...syncTransportCommand({ brain, mirror, remote, env: input.transportEnv ?? command.env, args, tempLimits: command.tempLimits, tempDomain: command.tempDomain }),
      ...(input.signal ? { signal: input.signal } : {}), timeoutMs: input.timeoutMs ?? 120_000 });
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
    last = await runLocalSync({ ...command, credentials: false,
      readPaths: [...(command.readPaths ?? []), mirror],
      writeDirectories: [join(mirror, "objects"), join(mirror, "refs")],
      gitConfig: [["safe.directory", brain], ["safe.directory", mirror], [`url.file://${mirror}.insteadOf`, remote], ["remote.origin.pushurl", `file://${mirror}`]],
      ...(input.signal ? { signal: input.signal } : {}), ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) });
    if (last.exitCode !== 0) return last;
    // runMaintenanceWorker settles only after the namespace's init exits:
    // every child is gone before scanning the storage and admitting a key.
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
