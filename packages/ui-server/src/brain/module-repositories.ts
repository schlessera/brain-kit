/**
 * Host-fetched repositories for module cron jobs (#3380;
 * docs/decisions/governed-writable-workers.md, "Repositories a module job may read").
 *
 * A module's config block asks for repositories; the operator's allow-list in
 * host configuration, outside the brain, decides. Only a repository on both is
 * fetched, by the sync mirror's credentialed transport into a host-private bare
 * mirror. The transport never mounts the brain. The job's own worker gets the
 * mirror read-only and a Git URL rewrite onto it, never the credential.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, mkdtempSync, openSync, realpathSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runMaintenanceWorker, type MaintenanceCommand, type MaintenanceResult } from "@schlessera/brain-ui-sdk/internal";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { assertMirrorStorage, prepareMirror, syncTransportCommand } from "./sync-mirror.js";

/** The operator's allow-list: host configuration, read only by the cron runner and never forwarded to a job. */
export const MODULE_REPOSITORIES_ENV = "BRAIN_UI_MODULE_REPOSITORIES";

/** One fetched repository a job's worker may read: the URL the module uses and the host mirror it reads instead. */
export interface ModuleRepositoryAccess {
  url: string;
  mirror: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
const mirrorLocks = createKeyedLock();

/**
 * The one comparable spelling of a repository URL, or null when the host would
 * not fetch it: HTTPS (loopback HTTP for fixtures), no credential, query,
 * fragment or dot segment. Host case and a trailing `/` or `.git` do not
 * distinguish repositories.
 */
export function canonicalRepository(input: string): string | null {
  if (typeof input !== "string" || /[\s\0]/.test(input) || input.startsWith("-")) return null;
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return null;
  if (url.username || url.password || url.search || url.hash || input.includes("?") || input.includes("#")) return null;
  // `new URL` silently resolves dot segments; the written spelling must not have any.
  const written = input.slice(input.indexOf("//") + 2).split("/").slice(1).filter(Boolean);
  if (written.length === 0 || !written.every(segment => SEGMENT.test(segment))) return null;
  const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  if (!path || path === "/") return null;
  return `${url.origin}${path}`;
}

/** The operator allow-list as written: comma or whitespace separated. Malformed entries never grant anything. */
export function parseRepositoryAllowList(raw: string | undefined): { allowed: string[]; invalid: string[] } {
  const allowed = new Set<string>(), invalid: string[] = [];
  for (const entry of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    const canonical = canonicalRepository(entry);
    if (canonical) allowed.add(canonical); else invalid.push(entry);
  }
  return { allowed: [...allowed], invalid };
}

/**
 * Intersect what a module asks for with what the operator allows. The module's
 * request alone grants nothing: an empty or missing allow-list refuses every
 * repository, whatever `brain.config.ts` says.
 */
export function grantModuleRepositories(requested: readonly string[], allowList: readonly string[]): { granted: string[]; refused: string[] } {
  const allowed = new Set(allowList.map(canonicalRepository).filter((url): url is string => url !== null));
  const granted: string[] = [], refused: string[] = [];
  for (const url of new Set(requested)) {
    const canonical = canonicalRepository(url);
    if (canonical && allowed.has(canonical)) granted.push(url); else refused.push(url);
  }
  return { granted, refused };
}

/** One host-private mirror per brain, UI database and repository, beside the sync mirror. */
export function moduleRepositoryMirrorPath(brain: string, dbPath: string | undefined, url: string): string {
  const canonical = canonicalRepository(url);
  if (!canonical) throw new Error(`not a fetchable repository: ${url}`);
  if (!dbPath || dbPath === ":memory:") return join(mkdtempSync(join(tmpdir(), "brain-module-repository-")), "mirror.git");
  const id = createHash("sha256").update(`${realpathSync(brain)}\0${resolve(dbPath)}\0${canonical}`).digest("hex").slice(0, 20);
  const directory = dirname(resolve(dbPath));
  return join(existsSync(directory) ? realpathSync(directory) : directory, `brain-module-repository-${id}.git`);
}

/**
 * What a job's worker gets for its fetched repositories: each mirror read-only,
 * and Git URL rewrites so the module's own `git clone <url>` reads the mirror.
 * Nothing here is or names a credential.
 */
export function moduleRepositoryWorkerAccess(repositories: readonly ModuleRepositoryAccess[]): { readPaths: string[]; gitConfig: [string, string][] } {
  const readPaths: string[] = [], gitConfig: [string, string][] = [];
  for (const { url, mirror } of repositories) {
    const canonical = canonicalRepository(url);
    if (!canonical) throw new Error(`not a fetchable repository: ${url}`);
    readPaths.push(mirror);
    gitConfig.push(["safe.directory", mirror]);
    // Git applies the longest matching prefix, so `<url>.git` and `<url>/`
    // land on the mirror itself rather than on a sibling path.
    for (const spelling of [canonical, `${canonical}/`, `${canonical}.git`, `${canonical}.git/`]) gitConfig.push([`url.file://${mirror}.insteadOf`, spelling]);
  }
  return { readPaths, gitConfig };
}

export type RepositoryTransportRun = (command: MaintenanceCommand & { signal?: AbortSignal; timeoutMs: number }) => Promise<MaintenanceResult>;

/** Write one host-owned file in the mirror without following a link. */
function writeHostFile(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, text); } finally { closeSync(fd); }
}

/** A remote's default branch from `ls-remote --symref`, or null for anything Git would not call a plain branch. */
export function defaultBranch(lsRemote: string): string | null {
  const match = /^ref: (refs\/heads\/[A-Za-z0-9._\/-]+)\tHEAD$/m.exec(lsRemote);
  const ref = match?.[1];
  if (!ref || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".lock") || ref.split("/").some(part => part.startsWith("."))) return null;
  return ref;
}

/**
 * Refresh one host mirror through the sync transport with the host credential:
 * the same fixed Git configuration, no hooks, no redirects, fsck on transfer.
 * The transport mounts the mirror and never the brain.
 */
export async function fetchModuleRepository(input: {
  brain: string; mirror: string; url: string; env: MaintenanceCommand["env"];
  tempLimits?: MaintenanceCommand["tempLimits"]; tempDomain?: MaintenanceCommand["tempDomain"]; signal?: AbortSignal; timeoutMs?: number;
  /** @internal Test seam for the launched transport; production uses the maintenance worker. */
  run?: RepositoryTransportRun;
  /** @internal A fixture origin that receives the credential; never derived from repository or brain input. */
  credentialOrigin?: string;
}): Promise<ModuleRepositoryAccess> {
  if (!canonicalRepository(input.url)) throw new Error(`not a fetchable repository: ${input.url}`);
  const run = input.run ?? runMaintenanceWorker;
  return mirrorLocks.withLock(input.mirror, async () => {
    prepareMirror(input.mirror, input.brain);
    const transport = async (args: readonly string[]) => {
      assertMirrorStorage(input.mirror);
      const result = await run({ ...syncTransportCommand({ brain: input.brain, mirror: input.mirror, remote: input.url, env: input.env, args,
        tempLimits: input.tempLimits, tempDomain: input.tempDomain, ...(input.credentialOrigin ? { credentialOrigin: input.credentialOrigin } : {}) }),
      ...(input.signal ? { signal: input.signal } : {}), timeoutMs: input.timeoutMs ?? 120_000 });
      if (result.killed) throw new Error(`host repository transport for ${input.url} timed out or was cancelled`);
      if (result.exitCode !== 0) throw new Error(`host repository transport for ${input.url} failed: ${result.stderr.trim().slice(-500) || `exit ${result.exitCode}`}`);
      return result;
    };
    const head = defaultBranch((await transport(["ls-remote", "--symref", "$REMOTE", "HEAD"])).stdout);
    await transport(["fetch", "--prune", "--no-tags", "$REMOTE", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]);
    assertMirrorStorage(input.mirror);
    // A clone of the mirror checks out what the remote calls its default branch.
    if (head) writeHostFile(join(input.mirror, "HEAD"), `ref: ${head}\n`);
    return { url: input.url, mirror: input.mirror };
  }, { signal: input.signal });
}
