/**
 * Reference-source Git transport (#2429). Only the fixed network transport
 * ever receives a repository credential: it lists and fetches objects into a
 * host-owned Git directory whose configuration the host writes. Checkout of
 * repository-controlled content runs in a separate worker with no credential
 * and no network. Neither worker mounts the brain.
 */
import { constants, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMaintenanceWorker, type MaintenanceCommand } from "@schlessera/brain-ui-sdk/internal";
import type { ReferenceRepository } from "../db/reference-grants.js";

/** Fixed configuration of every acquired reference repository; nothing repository-controlled is ever configuration. */
export const REFERENCE_GIT_CONFIG = `[core]
\trepositoryformatversion = 0
\tbare = false
\thooksPath = /dev/null
\tsymlinks = true
\tfsmonitor = false
[fetch]
\tfsckObjects = true
[transfer]
\tfsckObjects = true
[gc]
\tauto = 0
`;
const CREDENTIAL_HELPER = '!f() { printf "username=x-access-token\\npassword=%s\\n" "$BRAIN_REFERENCE_TOKEN"; }; f';
const UMASK = ["/bin/sh", "-c", 'umask 022 && exec "$@"', "reference-git"];

export type ReferenceCheck =
  | { ok: true; commit: string; ref: string }
  | { ok: false; reason: "missing" | "denied" | "unavailable"; detail: string };

export class ReferenceTransportError extends Error {
  constructor(readonly reason: "denied" | "unavailable" | "capacity" | "invalid", message: string) { super(message); this.name = "ReferenceTransportError"; }
}

/** The concrete operations acquisition needs; tests substitute this one host-only owner. */
export interface ReferenceTransport {
  /** Resolve a branch or tag through the transport, with the grant's credential value or anonymously. */
  resolve(input: { repository: ReferenceRepository; revision: string; token: string | null; signal?: AbortSignal }): Promise<ReferenceCheck>;
  /** Fetch exactly one resolved ref into `<root>/.git` and report the fetched commit. */
  fetch(input: { repository: ReferenceRepository; ref: string; token: string | null; root: string; signal?: AbortSignal }): Promise<{ commit: string }>;
  /** Check out `commit` into `root` without any credential or network. */
  checkout(input: { root: string; commit: string; signal?: AbortSignal }): Promise<void>;
}

/** A branch or tag name: Git's ref-format rules, minus anything a shell or URL could reinterpret. */
export function referenceRevision(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/+-]{0,199}$/.test(input) || input.includes("..") || input.includes("//")
    || input.endsWith("/") || input.endsWith(".") || input.endsWith(".lock") || input.split("/").some(part => part.startsWith(".") || part.endsWith(".lock")))
    throw new ReferenceTransportError("invalid", "revision must be one branch or tag name");
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(input))
    throw new ReferenceTransportError("invalid", "request a branch or tag; a managed worktree pins an exact reported commit");
  return input;
}

/** Write the fixed host Git metadata into an owned root; existing entries are never followed. */
export function prepareReferenceGitDirectory(root: string): string {
  const gitDir = join(root, ".git");
  for (const path of [gitDir, join(gitDir, "objects"), join(gitDir, "objects/info"), join(gitDir, "objects/pack"), join(gitDir, "refs"), join(gitDir, "refs/heads"), join(gitDir, "refs/tags")]) {
    try { mkdirSync(path, { mode: 0o755 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ReferenceTransportError("invalid", "reference Git metadata is not an owned directory");
  }
  for (const [name, text] of [["config", REFERENCE_GIT_CONFIG], ["HEAD", "ref: refs/heads/reference\n"]] as const) {
    const fd = openSync(join(gitDir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try { writeSync(fd, text); } finally { closeSync(fd); }
  }
  return gitDir;
}

function git(): string {
  const binary = Bun.which("git", { PATH: "/usr/bin:/bin" });
  if (!binary) throw new ReferenceTransportError("unavailable", "reference acquisition needs system git");
  return binary;
}

/** Credentialed network argv: one allowed protocol, no redirects, no hooks, fsck on transfer. */
function networkArgs(repository: ReferenceRepository, token: string | null): string[] {
  return ["-c", "credential.helper=", ...(token ? ["-c", `credential.helper=${CREDENTIAL_HELPER}`] : []), "-c", "credential.interactive=false",
    "-c", "http.followRedirects=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", `protocol.${repository.scheme}.allow=always`,
    "-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true"];
}

function classify(stderr: string): "denied" | "unavailable" {
  return /authentication failed|could not read (username|password)|unable to get (username|password)|repository not found|not found|403|401|terminal prompts disabled|access denied|does not appear to be a git repository/i
    .test(stderr) ? "denied" : "unavailable";
}

export function createReferenceTransport(options: {
  brainPath: string; timeoutMs?: number; tempLimits?: MaintenanceCommand["tempLimits"]; tempDomain?: MaintenanceCommand["tempDomain"];
  /** Test seam for the exact launched commands; production uses the maintenance worker. */
  run?: typeof runMaintenanceWorker;
}): ReferenceTransport {
  const run = options.run ?? runMaintenanceWorker;
  const timeoutMs = options.timeoutMs ?? 120_000;
  function command(input: { argv: string[]; mirror: string; token: string | null; repository?: ReferenceRepository; network: boolean; signal?: AbortSignal })
    : MaintenanceCommand & { signal?: AbortSignal; timeoutMs: number } {
    const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: "/tmp/brain-maintenance-home", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false" };
    // The credential value exists only in this network transport's environment.
    if (input.token) env.BRAIN_REFERENCE_TOKEN = input.token;
    const readPaths = input.repository?.scheme === "file" ? [input.repository.url.slice("file://".length)] : [];
    return { brainPath: options.brainPath, credentials: input.network, env, command: [...UMASK, ...input.argv],
      ...(options.tempLimits ? { tempLimits: options.tempLimits } : {}), ...(options.tempDomain ? { tempDomain: options.tempDomain } : {}),
      transport: { mirror: input.mirror, readPaths, network: input.network }, ...(input.signal ? { signal: input.signal } : {}), timeoutMs };
  }
  return {
    async resolve({ repository, revision, token, signal }) {
      const scratch = mkdtempSync(join(tmpdir(), "brain-reference-resolve-"));
      try {
        const result = await run(command({ repository, token, network: true, mirror: scratch, signal,
          argv: [git(), ...networkArgs(repository, token), "ls-remote", "--exit-code", "--", repository.url,
            `refs/heads/${revision}`, `refs/tags/${revision}`, `refs/tags/${revision}^{}`] }));
        if (result.killed) return { ok: false, reason: "unavailable", detail: "reference resolution timed out or was cancelled" };
        if (result.exitCode === 2) return { ok: false, reason: "missing", detail: `no branch or tag named ${revision}` };
        if (result.exitCode !== 0) return { ok: false, reason: classify(result.stderr), detail: result.stderr.trim().slice(-500) || `exit ${result.exitCode}` };
        const rows = new Map(result.stdout.trim().split("\n").map(line => line.split("\t")).filter(row => row.length === 2 && /^[0-9a-f]{40,64}$/.test(row[0]!))
          .map(row => [row[1]!, row[0]!]));
        const head = rows.get(`refs/heads/${revision}`), peeled = rows.get(`refs/tags/${revision}^{}`), tag = rows.get(`refs/tags/${revision}`);
        if (head) return { ok: true, commit: head, ref: `refs/heads/${revision}` };
        if (peeled ?? tag) return { ok: true, commit: (peeled ?? tag)!, ref: `refs/tags/${revision}` };
        return { ok: false, reason: "missing", detail: `no branch or tag named ${revision}` };
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    },
    async fetch({ repository, ref, token, root, signal }) {
      const gitDir = prepareReferenceGitDirectory(root);
      const fetched = await run(command({ repository, token, network: true, mirror: gitDir, signal,
        argv: [git(), "--git-dir", gitDir, ...networkArgs(repository, token), "fetch", "--no-tags", "--no-write-fetch-head", "--", repository.url, `+${ref}:refs/reference/source`] }));
      if (fetched.killed) throw new ReferenceTransportError("unavailable", "reference fetch timed out or was cancelled");
      if (fetched.exitCode !== 0) {
        const detail = fetched.stderr.trim().slice(-500) || `exit ${fetched.exitCode}`;
        throw new ReferenceTransportError(/quota|no space/i.test(detail) ? "capacity" : classify(detail), `reference fetch failed: ${detail}`);
      }
      // Read the fetched ref offline: no credential or network reaches this step.
      const parsed = await run(command({ token: null, network: false, mirror: gitDir, signal,
        argv: [git(), "--git-dir", gitDir, "-c", "core.hooksPath=/dev/null", "rev-parse", "--verify", "refs/reference/source^{commit}"] }));
      const commit = parsed.stdout.trim();
      if (parsed.killed || parsed.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw new ReferenceTransportError("unavailable", "fetched reference commit is unreadable");
      return { commit };
    },
    async checkout({ root, commit, signal }) {
      if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new ReferenceTransportError("invalid", "checkout needs one commit id");
      const gitDir = prepareReferenceGitDirectory(root);
      const result = await run(command({ token: null, network: false, mirror: root, signal,
        argv: [git(), "--git-dir", gitDir, "--work-tree", root, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "checkout", "--force", "--detach", commit] }));
      if (result.killed) throw new ReferenceTransportError("unavailable", "reference checkout timed out or was cancelled");
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim().slice(-500) || `exit ${result.exitCode}`;
        throw new ReferenceTransportError(/quota|no space/i.test(detail) ? "capacity" : "unavailable", `reference checkout failed: ${detail}`);
      }
    },
  };
}
