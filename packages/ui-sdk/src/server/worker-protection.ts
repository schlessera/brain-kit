/** The governed layout: one resolved list for mounts, note and manifest. */
import { closeSync, fstatSync, lstatSync, mkdirSync, readdirSync, realpathSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { INDEX_DIR } from "@schlessera/brain-common/internal/index-location";
import { hasNativeBrainBoundary } from "./worker-startup-view.js";
import { runWorkerStepsSync, workerStepSleep, type WorkerSteps } from "./worker-steps.js";
import { isEnvName, protectedPaths, PROTECTED_TIER_A, PROTECTED_TIER_B } from "./protected-paths.js";
import { at, openDirectory, mountPointsUnder, scanForOutsideLinks, WORKER_MOUNT_SCAN_LIMIT,
  type WorkerProtection, type ProtectedWorkerPath, type WorkerProviderMasks } from "./worker-sandbox.js";

const DIRECTORIES = new Set(["context/policies", ".git/hooks", ".git/info", ".git/modules", "node_modules"]);
const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? String(error);

/** Only this concrete resolver can mint folder mounts; public layout facts are not authority. */
const qualifiedFolders = new WeakMap<WorkerProtection, {
  readonly brain: string; readonly device: string; readonly inode: string;
  readonly roots: readonly string[];
  readonly pins: readonly { readonly rel: string; readonly device: string; readonly inode: string }[];
}>();

/** Inspect subtrees without following links, including aliases below directories. */
function checkTree(fd: number, rel: string, count: { value: number }, brain: string, depth = 0, allowPackageBins = true): void {
  if (depth > 256) throw new Error(`${rel} is nested too deeply to verify`);
  for (const name of readdirSync(at(fd, "."))) {
    if (++count.value > WORKER_MOUNT_SCAN_LIMIT) throw new Error(`${rel} has too many entries to verify`);
    const path = at(fd, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      // Package bins link to other files inside the same read-only mount.
      // Such a link cannot provide a writable alias. Cross-boundary links
      // still select strict, and a linked protected root is always refused.
      if (allowPackageBins && rel.startsWith("node_modules") && realpathSync(path).startsWith(`${brain}/node_modules/`)) continue;
      throw new Error(`${rel}/${name} is a symlink`);
    }
    if (info.isFile() && info.nlink > 1) throw new Error(`${rel}/${name} is hardlinked`);
    if (!info.isFile() && !info.isDirectory()) throw new Error(`${rel}/${name} is not a regular file or directory`);
    if (info.isDirectory()) {
      const child = openDirectory(path);
      try {
        const opened = fstatSync(child);
        if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`${rel}/${name} changed during inspection`);
        checkTree(child, `${rel}/${name}`, count, brain, depth + 1, allowPackageBins);
      } finally { closeSync(child); }
    }
  }
}

/** Prepare missing directories through descriptors; never create placeholder files. */
export function resolveWorkerProtection(brain: string, options: {
  paths?: readonly string[]; appeared?: readonly string[]; folderPaths?: readonly string[];
} = {}): { protection: WorkerProtection; reason?: string } {
  const paths: ProtectedWorkerPath[] = [];
  const ancestors = new Set<string>();
  const appeared = new Set(options.appeared ?? []);
  let root: number | undefined;
  try {
    root = openDirectory(brain);
    const names = [...new Set([...(options.paths ?? protectedPaths()), ...readdirSync(at(root, ".")).filter(isEnvName), ...appeared])];
    if (mountPointsUnder(brain).some(path => path !== brain)) throw new Error("the brain contains another mount");
    // A writable brain must not provide a writable alias to a host file.
    // The qualified native brain is an entire subvolume: Btrfs forbids links
    // crossing its root. Protected-subtree and scratch aliases still need checks.
    if (!hasNativeBrainBoundary(brain)) {
      const scan = scanForOutsideLinks(brain, brain);
      if (scan.overLimit || scan.unverified || scan.brainInside || scan.outside.length) {
        throw new Error(scan.unverified ?? (scan.outside.length ? `the brain has hardlinks outside it: ${scan.outside.slice(0, 3).join(", ")}` : "the brain's aliases could not be verified"));
      }
    }
    for (const rel of names) {
      if (!rel || rel.startsWith("/") || rel.split("/").some(part => !part || part === "." || part === "..")) throw new Error("invalid protected path");
      const segments = rel.split("/");
      let fd = openDirectory(at(root, "."));
      try {
        for (let i = 0; i < segments.length - 1; i++) {
          const path = at(fd, segments[i]!);
          if (!lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path, { mode: 0o755 });
          const next = openDirectory(path);
          closeSync(fd); fd = next;
          ancestors.add(segments.slice(0, i + 1).join("/"));
        }
        const path = at(fd, segments.at(-1)!);
        let info = lstatSync(path, { throwIfNoEntry: false });
        if (!info && DIRECTORIES.has(rel)) { mkdirSync(path, { mode: 0o755 }); info = lstatSync(path); }
        let mode: ProtectedWorkerPath["mode"] = "absent";
        if (info) {
          if (appeared.has(rel)) mode = info.isDirectory() ? "mask_directory" : "mask_file";
          else {
            if (info.isSymbolicLink()) throw new Error(`${rel} is a symlink`);
            if (info.isFile() && info.nlink > 1) throw new Error(`${rel} is hardlinked`);
            if (!info.isFile() && !info.isDirectory()) throw new Error(`${rel} is not a regular file or directory`);
            if (info.isDirectory()) {
              const dir = openDirectory(path);
              try { checkTree(dir, rel, { value: 0 }, brain); } finally { closeSync(dir); }
            }
            mode = "read_only";
          }
        }
        paths.push({ rel, mode, reason: appeared.has(rel) ? "appeared during an active turn; awaiting quarantine"
          : (PROTECTED_TIER_A as readonly string[]).includes(rel) || isEnvName(rel) ? "governance, secrets or startup code (tier A)"
          : (PROTECTED_TIER_B as readonly string[]).includes(rel) ? "runtime permissions or configuration (tier B)" : "added by governance policy" });
      } finally { closeSync(fd); }
    }
    const folderPins = new Map<string, { rel: string; device: string; inode: string }>();
    const folderPaths = [...new Set(options.folderPaths ?? [])], folderCount = { value: 0 };
    for (const rel of folderPaths) {
      if (!rel || rel.startsWith("/") || rel.startsWith("~") || /^[A-Za-z]:/.test(rel) || rel.includes("\\") || /[\u0000-\u001f\u007f*?[\]{}()!]/u.test(rel)
        || rel.split("/").some(part => !part || part === "." || part === "..")) throw new Error("invalid provider folder path");
      const segments = rel.split("/");
      let fd = openDirectory(at(root, "."));
      try {
        for (let i = 0; i < segments.length; i++) {
          const path = at(fd, segments[i]!), info = lstatSync(path, { bigint: true });
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${rel} is not an unaliased existing directory`);
          const next = openDirectory(path), opened = fstatSync(next, { bigint: true });
          if (opened.dev !== info.dev || opened.ino !== info.ino) { closeSync(next); throw new Error(`${rel} changed during inspection`); }
          closeSync(fd); fd = next;
          const part = segments.slice(0, i + 1).join("/");
          folderPins.set(part, { rel: part, device: String(opened.dev), inode: String(opened.ino) });
        }
        if (!folderPaths.some(other => rel.startsWith(`${other}/`))) checkTree(fd, rel, folderCount, brain, 0, false);
      } finally { closeSync(fd); }
    }
    const orderedAncestors = [...ancestors].sort((a, b) => a.split("/").length - b.split("/").length);
    if (!folderPaths.length) return { protection: { paths, ancestors: orderedAncestors } };
    const identity = fstatSync(root, { bigint: true }), visible = lstatSync(brain, { bigint: true });
    if (identity.dev !== visible.dev || identity.ino !== visible.ino) throw new Error("the brain changed during folder inspection");
    // Deep freeze the resolver-owned protection. A caller cannot reuse its
    // private qualification with substituted protected paths or ancestors.
    const protection: WorkerProtection = Object.freeze({ paths: Object.freeze(paths.map(path => Object.freeze({ ...path }))),
      ancestors: Object.freeze(orderedAncestors) });
    qualifiedFolders.set(protection, { brain: realpathSync(brain), device: String(identity.dev), inode: String(identity.ino),
      roots: Object.freeze(folderPaths), pins: Object.freeze([...folderPins.values()].map(pin => Object.freeze({ ...pin }))) });
    return { protection };
  } catch (error) {
    return { protection: { paths: [], ancestors: [] }, reason: `protected paths could not be verified: ${code(error)}` };
  } finally { if (root !== undefined) closeSync(root); }
}

/** Fixed order: ancestor mount points first, then the protected names. */
export function protectedWorkerMounts(brain: string, protection: WorkerProtection, retainedFolders: readonly string[] = []): string[] {
  const qualified = qualifiedFolders.get(protection);
  if (retainedFolders.some(root => !qualified?.roots.includes(root)))
    throw new Error("provider folder topology was not qualified by the resolver");
  if (qualified) {
    const identity = lstatSync(brain, { bigint: true });
    if (brain !== qualified.brain || !identity.isDirectory() || identity.isSymbolicLink()
      || String(identity.dev) !== qualified.device || String(identity.ino) !== qualified.inode)
      throw new Error("provider folder topology belongs to a different brain identity");
  }
  const folderPins = qualified?.pins ?? [];
  for (const pin of folderPins) {
    const info = lstatSync(join(brain, pin.rel), { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== pin.device || String(info.ino) !== pin.inode)
      throw new Error(`provider folder topology changed before launch: ${pin.rel}`);
  }
  const pins = [...new Set([...protection.ancestors, ...folderPins.map(pin => pin.rel)])]
    .sort((a,b) => a.split("/").length - b.split("/").length);
  const argv = pins.flatMap(rel => ["--bind", join(brain, rel), join(brain, rel)]);
  for (const { rel, mode } of protection.paths) {
    const path = join(brain, rel);
    if (mode === "read_only") argv.push("--ro-bind", path, path);
    else if (mode === "mask_directory") argv.push("--tmpfs", path, "--remount-ro", path);
    else if (mode === "mask_file") argv.push("--ro-bind", "/dev/null", path);
  }
  return argv;
}

const invalidFolder = (rel: string) => !rel || rel.startsWith("/") || rel.startsWith("~") || /^[A-Za-z]:/.test(rel) || rel.includes("\\")
  || /[\u0000-\u001f\u007f*?[\]{}()!]/u.test(rel) || rel.split("/").some(part => !part || part === "." || part === "..");

/**
 * The committed sidecar caches of generated text at the brain root (core's
 * `SIDECAR_CACHES`): chunk contexts and asset descriptions, keyed by content,
 * including masked documents' (#2692).
 */
export const PROVIDER_CACHE_FILES = [".context-cache.jsonl", ".asset-cache.jsonl"] as const;

/**
 * Provider data masks, applied after every pin and protected bind so nothing
 * restores what they cover (#1668). `view` is the tree the worker sees at the
 * brain path: the live brain, or the strict immutable checkpoint. A folder
 * absent from it has nothing to hide; a present one becomes an empty
 * read-only tmpfs. While any folder is masked, `.git` is hidden as in
 * restricted turns and the private filtered index is bound over
 * `.brain-index/`, which must exist in the view. A turn whose proven recipient
 * is allowed every provider folder has no folder to mask (#2695). Each present
 * committed cache of generated text reads as empty in every such turn (#2692).
 */
export function providerMaskMounts(brain: string, view: string, masks: WorkerProviderMasks): string[] {
  const argv: string[] = [];
  if (masks.folders.length && !masks.index) throw new Error("masked provider folders need the turn's private index");
  // A loose file mask detaches if another namespace renames or unlinks the
  // path. Only exclusive credentialed `--embeddings` runs write these caches,
  // and every concurrent turn under a provider rule hides them alike, allowed
  // recipients included (2026-10-23 rulings on #2692 and #2695), so a detached
  // mask exposes nothing such a turn could already see. A link is refused
  // rather than followed.
  for (const name of PROVIDER_CACHE_FILES) {
    const info = lstatSync(join(view, name), { throwIfNoEntry: false });
    if (!info) continue;
    if (!info.isFile() || info.nlink !== 1) throw new Error(`the generated-text cache ${name} must be a regular file with one link to be masked`);
    argv.push("--ro-bind", "/dev/null", join(brain, name));
  }
  for (const rel of [...new Set(masks.folders)].sort()) {
    if (invalidFolder(rel) || rel === INDEX_DIR || rel.startsWith(`${INDEX_DIR}/`) || rel === ".git" || rel.startsWith(".git/"))
      throw new Error("invalid provider mask folder");
    const info = lstatSync(join(view, rel), { throwIfNoEntry: false });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`provider mask folder ${rel} is not a directory`);
    argv.push("--tmpfs", join(brain, rel), "--remount-ro", join(brain, rel));
  }
  // A turn allowed every provider folder keeps `.git` and the real index (#2695).
  if (masks.index) {
    const git = lstatSync(join(view, ".git"), { throwIfNoEntry: false });
    if (git?.isDirectory() && !git.isSymbolicLink()) argv.push("--tmpfs", join(brain, ".git"), "--remount-ro", join(brain, ".git"));
    else if (git?.isFile()) argv.push("--ro-bind", "/dev/null", join(brain, ".git"));
    else if (git) throw new Error("the brain's .git must be a directory or a gitlink file to be masked");
    const index = lstatSync(masks.index, { throwIfNoEntry: false });
    if (!isAbsolute(masks.index) || normalize(masks.index) !== masks.index || !index?.isDirectory() || index.isSymbolicLink()
      || masks.index === brain || masks.index.startsWith(`${brain}/`) || brain.startsWith(`${masks.index}/`))
      throw new Error("the private index must be an unaliased directory outside the brain");
    const target = lstatSync(join(view, INDEX_DIR), { throwIfNoEntry: false });
    if (!target?.isDirectory() || target.isSymbolicLink()) throw new Error(`${INDEX_DIR} is missing from the worker's view`);
    argv.push("--bind", masks.index, join(brain, INDEX_DIR));
  }
  return argv;
}

/**
 * A one-shot directory handle on the gated worker's own view of the brain,
 * from the host identity broker (#2696). Across UIDs, `/proc/<pid>/root`
 * refuses the server; the handle replaces it. `close` returns it to the
 * broker, which refuses to release the start gate while it is held.
 */
export interface WorkerBrainView { open(): number; close(): void }

interface MountRecord { readonly id: string; readonly parent: string; readonly point: string }
function mountRecords(pid: number): MountRecord[] {
  return readFileSync(`/proc/${pid}/mountinfo`, "utf8").trim().split("\n").map(line => {
    const [id, parent, , , field] = line.split(" ");
    if (!id || !parent || !field) throw new Error("invalid worker mount record");
    return { id, parent, point: field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8))) };
  });
}

/** The handle must be the top mount at the brain path in this worker's own namespace. */
function requireWorkerBrainMount(fd: number, pid: number, brain: string): void {
  const id = /^mnt_id:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1];
  // Mount IDs are unique system-wide, so a listed ID is a mount of this namespace.
  const records = mountRecords(pid);
  if (!id || !records.some(record => record.id === id && record.point === brain)
    || records.some(record => record.parent === id && record.point === brain))
    throw new Error("the brain view is not the worker's own brain mount");
}

/** Qualify this concrete launch's mounts while its trusted start gate is closed. */
export function verifyWorkerFolderMounts(brain: string, protection: WorkerProtection | undefined,
  retainedFolders: readonly string[] | undefined, pid: number, deadline: number, masks?: WorkerProviderMasks,
  view?: WorkerBrainView): void {
  runWorkerStepsSync(verifyWorkerFolderMountsSteps(brain, protection, retainedFolders, pid, deadline, masks, view));
}

/** `verifyWorkerFolderMounts`, waiting through steps for an asynchronous launch (#2416). */
export function* verifyWorkerFolderMountsSteps(brain: string, protection: WorkerProtection | undefined,
  retainedFolders: readonly string[] | undefined, pid: number, deadline: number, masks?: WorkerProviderMasks,
  view?: WorkerBrainView): WorkerSteps<void> {
  if (!retainedFolders?.length) return;
  const qualified = protection && qualifiedFolders.get(protection);
  if (!qualified || retainedFolders.some(root => !qualified.roots.includes(root)))
    throw new Error("provider folder topology was not qualified by the resolver");
  const identity = () => {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ");
    if (["Z", "X", "x"].includes(fields[0]!) || !/^\d+$/.test(fields[19] ?? ""))
      throw new Error("provider folder topology worker identity is unavailable");
    return fields[19]!;
  };
  try {
    const started = identity();
    for (;;) {
      const mounts = new Set(mountRecords(pid).map(record => record.point));
      // The authenticated PID can be reported before bubblewrap finishes its
      // mount sequence. No payload runs while this bounded observation waits.
      if (qualified.pins.every(pin => mounts.has(join(brain, pin.rel)))) break;
      if (Date.now() >= deadline) throw new Error("retained folder mount points are unavailable");
      if (identity() !== started) throw new Error("worker identity changed");
      yield* workerStepSleep(1);
    }
    // Check the still-live brain paths as well as the actual namespace view.
    protectedWorkerMounts(brain, protection!, retainedFolders);
    let handle: number | undefined;
    try {
      handle = view?.open();
      if (handle !== undefined) requireWorkerBrainMount(handle, pid, brain);
      verifyMountedFolders(handle === undefined ? `/proc/${pid}/root${brain}` : `/proc/self/fd/${handle}`, qualified, masks);
    } finally {
      try { if (handle !== undefined) closeSync(handle); } finally { view?.close(); }
    }
    if (identity() !== started) throw new Error("worker identity changed");
  } catch (error) {
    throw new Error(`provider folder topology could not be qualified before payload start: ${error instanceof Error ? error.message : code(error)}`);
  }
}

/** Compare the worker's mounted view, rooted at its brain, with the resolver's qualification. */
function verifyMountedFolders(view: string, qualified: NonNullable<ReturnType<typeof qualifiedFolders.get>>, masks?: WorkerProviderMasks): void {
  const root = statSync(view, { bigint: true });
  if (!root.isDirectory() || String(root.dev) !== qualified.device || String(root.ino) !== qualified.inode)
    throw new Error("mounted brain identity changed");
  // A masked root shows its mask, not the retained directory beneath it:
  // the private index for `.brain-index`, an empty tmpfs for a folder.
  const privateIndex = masks?.index ? statSync(masks.index, { bigint: true }) : undefined;
  for (const pin of qualified.pins) {
    // A retained root inside a masked folder is hidden by that mask.
    if (masks?.folders.some(folder => pin.rel.startsWith(`${folder}/`))) continue;
    const mounted = statSync(join(view, pin.rel), { bigint: true });
    if (!mounted.isDirectory()) throw new Error(`mounted folder identity changed: ${pin.rel}`);
    if (privateIndex && pin.rel === INDEX_DIR) {
      if (mounted.dev !== privateIndex.dev || mounted.ino !== privateIndex.ino) throw new Error("the private index is not mounted over the index directory");
    } else if (masks?.folders.includes(pin.rel)) {
      if (String(mounted.dev) === pin.device || readdirSync(join(view, pin.rel)).length) throw new Error(`provider folder mask is not in place: ${pin.rel}`);
    } else if (String(mounted.dev) !== pin.device || String(mounted.ino) !== pin.inode)
      throw new Error(`mounted folder identity changed: ${pin.rel}`);
  }
  // A present generated-text cache shows its `/dev/null` mask.
  if (masks) for (const name of PROVIDER_CACHE_FILES) {
    const cache = lstatSync(join(view, name), { throwIfNoEntry: false });
    if (cache && !cache.isCharacterDevice()) throw new Error(`generated-text cache mask is not in place: ${name}`);
  }
}
