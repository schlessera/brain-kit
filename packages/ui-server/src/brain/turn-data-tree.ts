/**
 * A turn's data tree (#2848) and its provenance-pinned index updates (#2846).
 *
 * A strict worker runs configuration from the immutable startup view at the
 * brain path (#1649), so the host's applications in its own turn never reach
 * that view. Its brain tools read a separate data tree instead: a host copy of
 * the view's documents, with this turn's committed Markdown and image masks
 * written into it as each application commits, and the turn's own search index over its
 * `.brain-index/`. Both are read-only to the worker. At the next index read a
 * credential-free worker, configured from the same frozen view, brings the
 * index up to date with the tree; nothing a peer applied mid-turn enters it.
 *
 * The copy is the approved fallback for the manager stage (2026-10-25 ruling
 * on #2848): across UIDs the stage's merged directory belongs to the worker,
 * so the server cannot write through it. Only the view's own bytes and this
 * turn's effects ever enter the tree.
 *
 * A turn under provider rules keeps the masked folders, the generated-text
 * caches (#2725) and the operational-state folders out of the tree, and its index is
 * the turn's private one. An effect enters the tree only if its path is
 * visible, neither its result nor its base declares a type the turn's
 * recipient may not see, and its base is the tree's own bytes: the view's, or
 * this turn's earlier ones. Anything else is removed from the tree instead, so
 * the next update drops it from the index too. A governed masked turn reads
 * the live brain, so its tree feeds only its index updates.
 */
import { chmodSync, chownSync, closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative } from "node:path";
import { Database, constants as sqlite } from "bun:sqlite";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { INDEX_DIR } from "@schlessera/brain-common/internal/index-location";
import { isEnvName } from "@schlessera/brain-common/internal/protected-paths";
import { envMaskedPaths, launchAgentWorker, prepareWorkerSandbox, PROVIDER_CACHE_DIR, PROVIDER_CACHE_FILES, retainWorkerStartupView, workerIdentityHelper, WORKER_DATA_ROOT,
  type WorkerDataTree, type WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
import { createIndexBatch, type IndexBatch } from "./index-batch.js";
import { isProviderMasked } from "./provider-mask-refusal.js";
import { createPrivateIndexDirectory, PRIVATE_INDEX_BUILD_MS, removePrivateIndexDirectory } from "./private-index.js";
import { MAINTENANCE_ENTRY } from "./host-boundary.js";

/**
 * One committed effect of an application: its bytes, or null for a removal,
 * and the live base it transformed: the path's own, or for an archive
 * destination the base of the source it was moved `from`. Markdown carries
 * text; an image mask (#2892) carries the PNG's bytes.
 */
export interface AppliedEffect {
  readonly path: string; readonly content: string | Uint8Array | null; readonly base: string | Uint8Array | null; readonly from?: string;
}

/** The provider rules a masked turn's tree admits effects under. */
export interface TurnTreeMasks {
  /** The folders the turn's recipient may not see. */
  readonly folders: readonly string[];
  /** Everything its index build sees as empty: `folders` and the operational-state folders. */
  readonly buildFolders: readonly string[];
  /** Document types the recipient may not see. */
  readonly types: readonly string[];
}

export interface TurnDataTree {
  /** The worker's mounts; absent for a governed turn, which reads the live brain. */
  readonly mount?: WorkerDataTree;
  /** The turn's search index directory. */
  readonly index: string;
  /** Write this turn's committed effects into the tree. Called inside the application's commit boundary. */
  commit(effects: readonly AppliedEffect[]): void;
  /** Whether this turn committed `path` (repo-relative). */
  applied(path: string): boolean;
  /**
   * Plan a capture against the tree and the turn's index, never the live
   * brain (#2846): what a masked turn's `brain_add` writes. Its plan is
   * untrusted data, and its bytes enter the tree under the same rule.
   */
  planAdd(input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  /** Resolve once the turn's index holds every effect committed before the call. */
  barrier(signal?: AbortSignal): Promise<void>;
  /** Whether committed effects wait for an index update. */
  pending(): boolean;
  /** Remove the tree and its index once every worker has exited. */
  close(): Promise<void>;
}

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
/** The view's entries a tree never holds: history, the real index, the brain's packages and `.env*`. */
const OMITTED = new Set([".git", INDEX_DIR, "node_modules"]);
const COPY_ENTRIES = 200_000, COPY_DEPTH = 256;
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/**
 * Copy the view's documents into `target`: links stay links, timestamps and
 * modes are kept, nothing else (sockets, devices) is copied. `skip` names
 * repo-relative paths left out. Across UIDs, a file or directory the server
 * cannot read (a worker's own `0600` file) is left out too: the worker that
 * could read it sees it at the brain path.
 */
function copyView(view: string, target: string, skip: (rel: string) => boolean): void {
  let entries = 0;
  const unreadable = (error: unknown) => errno(error) === "EACCES";
  const walk = (rel: string, depth: number) => {
    if (depth > COPY_DEPTH) throw new Error("The startup view exceeds the data tree's directory depth bound.");
    let listed: import("node:fs").Dirent[];
    try { listed = readdirSync(join(view, rel), { withFileTypes: true }); } catch (error) { if (rel && unreadable(error)) return; throw error; }
    for (const entry of listed) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip(path)) continue;
      if (++entries > COPY_ENTRIES) throw new Error(`The startup view exceeds the data tree's ${COPY_ENTRIES} entry bound.`);
      const from = join(view, path), to = join(target, path), info = lstatSync(from);
      if (info.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      else if (info.isDirectory()) {
        mkdirSync(to, { mode: 0o700 }); walk(path, depth + 1);
        chmodSync(to, info.mode & 0o7777); utimesSync(to, info.atime, info.mtime);
      } else if (info.isFile()) {
        try { copyFileSync(from, to, constants.COPYFILE_EXCL); } catch (error) { if (unreadable(error)) continue; throw error; }
        chmodSync(to, info.mode & 0o7777); utimesSync(to, info.atime, info.mtime);
      }
    }
  };
  walk("", 0);
}

/** Seed `index` with the view's index files. The updater runs as the worker identity, which shares the server's group. */
function seedIndex(view: string, index: string, separateIdentity: boolean): void {
  const source = join(view, INDEX_DIR);
  const names = (() => { try { return readdirSync(source, { withFileTypes: true }); } catch (error) { if (errno(error) === "ENOENT") return []; throw error; } })();
  for (const entry of names) {
    if (!entry.isFile()) continue;
    const to = join(index, entry.name);
    copyFileSync(join(source, entry.name), to, constants.COPYFILE_EXCL);
    chmodSync(to, separateIdentity ? 0o660 : 0o600);
  }
}

/**
 * Settle the turn index's write-ahead log here, before any worker opens it:
 * a reader on the read-only mount can neither recover a log the checkpoint
 * caught mid-write nor create the sidecars a copy left out.
 */
function settleIndex(index: string, separateIdentity: boolean): void {
  // A worker identity's own build closed cleanly, so its sidecars persist; the
  // server cannot, and need not, write it. A copy the server made it settles.
  const own = lstatSync(join(index, "brain.db"), { throwIfNoEntry: false });
  if (!own?.isFile() || own.uid !== process.getuid?.()) return;
  const db = new Database(join(index, "brain.db"));
  try {
    db.run("PRAGMA busy_timeout=5000");
    db.run("PRAGMA journal_mode=WAL");
    db.fileControl(sqlite.SQLITE_FCNTL_PERSIST_WAL, 1);
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
  for (const name of ["brain.db", "brain.db-wal", "brain.db-shm"]) {
    const info = lstatSync(join(index, name), { throwIfNoEntry: false });
    if (info?.isFile() && info.uid === process.getuid?.()) chmodSync(join(index, name), separateIdentity ? 0o660 : 0o600);
  }
}

/**
 * Remove a server-owned copy, including directories the view held read-only
 * (`0555`): the owner needs write permission on a directory to empty it.
 */
function removeCopy(root: string): void {
  const open = (dir: string) => {
    let info; try { info = lstatSync(dir); } catch (error) { if (errno(error) === "ENOENT") return; throw error; }
    if (!info.isDirectory()) return;
    if (info.uid === process.getuid?.()) chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) open(join(dir, name));
  };
  open(root);
  rmSync(root, { recursive: true, force: true });
}

/** The repo-relative path's parent, opened without following a link, creating missing directories. */
function openParent(root: string, path: string): { fd: number; name: string } {
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.includes("\u0000"))) throw new Error("invalid data tree path");
  let fd = openSync(root, DIRECTORY);
  try {
    for (const part of parts.slice(0, -1)) {
      let next: number;
      try { next = openSync(at(fd, part), DIRECTORY); }
      catch (error) {
        if (errno(error) !== "ENOENT") throw error;
        mkdirSync(at(fd, part), { mode: 0o755 }); next = openSync(at(fd, part), DIRECTORY);
      }
      closeSync(fd); fd = next;
    }
    return { fd, name: parts.at(-1)! };
  } catch (error) { closeSync(fd); throw error; }
}

function readTree(root: string, path: string): Buffer | null {
  let parent: { fd: number; name: string };
  try { parent = openParent(root, path); } catch (error) { if (["ENOENT", "ENOTDIR", "ELOOP"].includes(errno(error) ?? "")) return null; throw error; }
  try {
    let fd: number;
    try { fd = openSync(at(parent.fd, parent.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (["ENOENT", "ELOOP"].includes(errno(error) ?? "")) return null; throw error; }
    try { return fstatSync(fd).isFile() ? readFileSync(fd) : null; } finally { closeSync(fd); }
  } finally { closeSync(parent.fd); }
}

function writeTree(root: string, path: string, content: string | Uint8Array | null): void {
  const parent = openParent(root, path);
  try {
    const target = at(parent.fd, parent.name);
    try { if (lstatSync(target).isDirectory()) throw new Error(`data tree path ${path} is a directory`); }
    catch (error) { if (errno(error) !== "ENOENT") throw error; }
    if (content === null) { try { unlinkSync(target); } catch (error) { if (errno(error) !== "ENOENT") throw error; } return; }
    const temporary = at(parent.fd, `.brain-tree-${crypto.randomUUID()}.tmp`);
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
    try { renameSync(temporary, target); } catch (error) { rmSync(temporary, { force: true }); throw error; }
  } finally { closeSync(parent.fd); }
}

const declaredType = (text: string | Uint8Array | null): string | undefined => {
  // Only Markdown declares a type; an image's bytes never do.
  if (typeof text !== "string") return undefined;
  try { const type = parseFrontmatter(text, { dataOnly: true }).data?.type; return type === undefined || type === null ? undefined : String(type); }
  catch { return undefined; }
};

/**
 * Run the application route's maintenance program on the turn's tree, in a
 * credential-free strict worker: configuration from the frozen view at the
 * brain path, documents from the tree at the fixed data path, the index
 * writable only for an update. A masked turn's run sees the brain path through
 * the same masks as its admission build. The answer is untrusted data.
 */
async function runOnTree(options: {
  brainPath: string; view: WorkerStartupView; tree: WorkerDataTree; masks?: TurnTreeMasks; maskPaths: readonly string[];
  request: Record<string, unknown>; writeIndex: boolean; label: string; signal?: AbortSignal; timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted();
  const sandbox = { ...prepareWorkerSandbox(options.brainPath, { profile: "strict", areas: [], maskPaths: options.maskPaths }),
    dataTree: { ...options.tree, ...(options.writeIndex ? { indexWritable: true } : {}) },
    ...(options.masks ? { providerMasks: Object.freeze({ folders: Object.freeze([...options.masks.buildFolders]), index: options.tree.index }) } : {}) };
  const view = retainWorkerStartupView(options.view);
  let worker: ReturnType<typeof launchAgentWorker>;
  try {
    worker = launchAgentWorker({ brainPath: options.brainPath, startupView: view, sandbox,
      env: { PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"), HOME: "/tmp", NO_COLOR: "1" },
      command: [process.execPath, MAINTENANCE_ENTRY] });
  } catch (error) { await view.cleanup(); throw error; }
  const timeoutMs = options.timeoutMs ?? PRIVATE_INDEX_BUILD_MS;
  const stop = () => worker.kill("SIGKILL");
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  options.signal?.addEventListener("abort", stop, { once: true });
  try {
    worker.stdin.end(JSON.stringify({ ...options.request, root: WORKER_DATA_ROOT }));
    const read = async (stream: unknown) => {
      const kept: Uint8Array[] = []; let length = 0;
      for await (const chunk of stream as AsyncIterable<Uint8Array>) if ((length += chunk.length) <= 256 * 1024) kept.push(chunk);
      return new TextDecoder().decode(Buffer.concat(kept));
    };
    const [stdout, stderr, exit] = await Promise.all([read(worker.stdout), read(worker.stderr), worker.exited]);
    options.signal?.throwIfAborted();
    if (timedOut) throw new Error(`${options.label} did not finish within ${timeoutMs / 1000} s`);
    let answer: { ok?: unknown; error?: unknown } | undefined;
    try { answer = JSON.parse(stdout.trim().split("\n").at(-1) ?? ""); } catch { /* reported below */ }
    if (!answer || typeof answer !== "object") throw new Error(`${options.label} gave no answer (exit ${exit}): ${stderr.trim().slice(-400)}`);
    if (answer.ok !== true) throw new Error(typeof answer.error === "string" ? answer.error.slice(0, 2000) : `${options.label} failed`);
    return answer as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
    // Never leave the worker behind a failed read of its answer.
    try { stop(); } catch { /* already gone */ }
    await worker.exited.catch(() => {});
  }
}

/**
 * Copy the view into a new tree, before the worker launches. `index` is the
 * masked turn's private index, already built; an unmasked turn's is seeded
 * from the view. `pending` names paths the view's index may lag its documents
 * on (`IndexBatch.watermark`): the first index read updates them.
 */
export function createTurnDataTree(options: {
  brainPath: string; view: WorkerStartupView; maskPaths: readonly string[];
  /** Mount it for the worker: false for a governed turn, which reads the live brain. */
  mount: boolean;
  masks?: TurnTreeMasks; index?: string; pending?: readonly string[];
  /**
   * The turn is under provider rules (#2692, #2695): the legacy root-level
   * generated-text caches stay out of its tree even when its recipient is
   * allowed every folder. `.brain-cache/` stays out only with `masks` (#2725).
   */
  providerRules?: boolean;
  /** Default: the maintenance program's targeted index update, on the tree. */
  update?: (tree: WorkerDataTree, paths: readonly string[]) => Promise<void>;
  /** Default: the maintenance program's capture planning, on the tree. */
  plan?: (tree: WorkerDataTree, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
}): TurnDataTree {
  const separateIdentity = Boolean(workerIdentityHelper());
  const root = mkdtempSync(join(tmpdir(), "brain-turn-data-"));
  let index: string | undefined;
  try {
    if (separateIdentity) { chownSync(root, process.getuid!(), process.getgid!()); chmodSync(root, 0o750); }
    // The legacy root-level caches stay out under any provider rule;
    // `.brain-cache/` only while a folder is masked (#2725).
    const masks = options.masks, caches = Boolean(masks || options.providerRules);
    // The `.env*` masks cover link targets at the brain path only, so the tree
    // leaves those targets out as well.
    const hidden = [...(masks?.buildFolders ?? []), ...envMaskedPaths(options.view.root, options.brainPath)];
    copyView(options.view.root, root, rel => {
      const top = !rel.includes("/");
      if (top && (OMITTED.has(rel) || isEnvName(rel) || (caches && PROVIDER_CACHE_FILES.includes(rel)) || (masks && rel === PROVIDER_CACHE_DIR))) return true;
      return hidden.some(folder => rel === folder || rel.startsWith(`${folder}/`));
    });
    mkdirSync(join(root, INDEX_DIR), { mode: 0o755 });
    index = options.index ?? createPrivateIndexDirectory();
    if (!options.index) seedIndex(options.view.root, index, separateIdentity);
    settleIndex(index, separateIdentity);
  } catch (error) {
    try { removeCopy(root); } finally { if (index && !options.index) removePrivateIndexDirectory(index); }
    throw error;
  }
  const tree: WorkerDataTree = Object.freeze({ root, index, ...(options.masks || options.providerRules
    ? { masked: Object.freeze([...options.masks?.buildFolders ?? []]) } : {}) });
  const run = (target: WorkerDataTree, request: Record<string, unknown>, writeIndex: boolean, label: string, signal?: AbortSignal) => runOnTree({
    brainPath: options.brainPath, view: options.view, tree: target, ...(options.masks ? { masks: options.masks } : {}), maskPaths: options.maskPaths,
    request, writeIndex, label, ...(signal ? { signal } : {}) });
  const update = options.update ?? (async (target, paths) => { await run(target, { op: "index", paths: [...paths] }, true, "the turn's index update"); });
  const plan = options.plan ?? (async (target, input, signal) => (await run(target, { op: "plan-add", input, readonlyIndex: true,
    ...(options.masks ? { masked: [...options.masks.folders] } : {}) }, false, "capture planning on the turn's tree", signal)).plan);
  const batch: IndexBatch = createIndexBatch({ index: paths => update(tree, paths) });
  if (options.pending?.length) batch.queue([...options.pending]);
  const applied = new Set<string>();
  let failure: string | undefined;
  const types = new Set(options.masks?.types ?? []);
  const admitted = (effect: AppliedEffect): boolean => {
    if (!options.masks) return true;
    if (isProviderMasked(effect.path, options.masks.buildFolders)) return false;
    const resultType = declaredType(effect.content), baseType = declaredType(effect.base);
    if ((resultType !== undefined && types.has(resultType)) || (baseType !== undefined && types.has(baseType))) return false;
    // The base the application transformed must be what this turn could
    // already see: the view's bytes or its own earlier effect, never a peer's.
    const seen = readTree(root, effect.from ?? effect.path);
    if (seen === null || effect.base === null) return seen === effect.base;
    return typeof effect.base === "string" ? seen.toString("utf8") === effect.base : seen.equals(effect.base);
  };
  let closed: Promise<void> | undefined;
  return {
    ...(options.mount ? { mount: tree } : {}),
    index,
    commit(effects) {
      if (closed || !effects.length) return;
      try {
        for (const effect of effects) {
          applied.add(effect.path);
          writeTree(root, effect.path, admitted(effect) ? effect.content : null);
        }
      } catch (error) {
        // The Markdown is committed; the index cannot vouch for it any more.
        failure ??= error instanceof Error ? error.message : String(error);
      } finally { batch.queue(effects.map(effect => effect.path)); }
    },
    applied: path => applied.has(normalize(path)),
    planAdd: (input, signal) => plan(tree, input, signal),
    async barrier(signal) {
      if (failure) throw new Error(`This turn's data tree could not record an applied change (${failure}); its index reads refuse until the turn ends.`);
      await batch.barrier(signal);
    },
    pending: () => batch.pending(),
    close() {
      return closed ??= (async () => {
        await batch.idle();
        try { removeCopy(root); } finally { if (!options.index) removePrivateIndexDirectory(index!); }
      })();
    },
  };
}

/**
 * Where a path the worker names lands, resolved as the worker's kernel would:
 * `/proc/<pid>/root` aliases dropped, then component by component, each link
 * followed in the immutable view the worker sees at the brain path. A path
 * at or under the data tree is `data`; anything else outside the brain is
 * `other`. Bounded like the kernel's own link limit.
 */
export function workerPathTarget(brainPath: string, view: string, path: string): { kind: "brain"; rel: string } | { kind: "data" } | { kind: "other" } {
  const within = (dir: string, target: string) => target === dir || target.startsWith(`${dir}/`);
  let pending = (path.startsWith("/") ? path : `${brainPath}/${path}`).replace(/^\/proc\/(?:self|thread-self|[0-9]+)\/root(?=\/|$)/u, "").split("/");
  let current: string[] = [], links = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") { current.pop(); continue; }
    current.push(part);
    const absolute = `/${current.join("/")}`;
    if (within(WORKER_DATA_ROOT, absolute)) return { kind: "data" };
    if (!within(brainPath, absolute) || absolute === brainPath) continue;
    let info;
    try { info = lstatSync(join(view, relative(brainPath, absolute))); } catch { continue; }
    if (!info.isSymbolicLink()) continue;
    if (++links > 40) return { kind: "other" };
    const link = readlinkSync(join(view, relative(brainPath, absolute)));
    current.pop();
    pending = [...(link.startsWith("/") ? (current = [], link.split("/")) : link.split("/")), ...pending];
  }
  const target = `/${current.join("/")}`;
  if (within(WORKER_DATA_ROOT, target)) return { kind: "data" };
  return within(brainPath, target) && target !== brainPath ? { kind: "brain", rel: relative(brainPath, target) } : { kind: "other" };
}

/** Paths Claude's file tools name in their input. */
const FILE_TOOL_PATHS: Record<string, readonly string[]> = { Read: ["file_path"], Grep: ["path"], Glob: ["path", "pattern"] };

/**
 * Why a Claude file tool may not run in a turn with a data tree, or nothing.
 * Its `Read` of a brain path this turn changed would return the turn-start
 * bytes (2026-10-25 ruling), and no file tool reads the data tree itself: the
 * harness loads instructions near the files it reads, and the brain tools
 * read the tree as data.
 */
export function staleReadRefusal(tree: Pick<TurnDataTree, "applied">, brainPath: string, view: string | undefined,
  toolName: string, input: Readonly<Record<string, unknown>> | undefined): string | undefined {
  for (const key of FILE_TOOL_PATHS[toolName] ?? []) {
    const value = input?.[key];
    if (typeof value !== "string" || (key === "pattern" && !value.startsWith("/"))) continue;
    const target = view ? workerPathTarget(brainPath, view, value) : value.startsWith(WORKER_DATA_ROOT) ? { kind: "data" as const } : { kind: "other" as const };
    if (target.kind === "data") return `${toolName} does not read this turn's data tree (${WORKER_DATA_ROOT}). Use mcp__brain__brain_read, mcp__brain__brain_search or mcp__brain__brain_context, which read it, including this turn's changes.`;
    if (toolName === "Read" && target.kind === "brain" && tree.applied(target.rel))
      return `This turn changed ${target.rel}; the file at the brain path still shows it as the turn started. Read it with mcp__brain__brain_read, which reads this turn's current version.`;
  }
  return undefined;
}
