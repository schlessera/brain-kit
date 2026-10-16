/** The governed layout: one resolved list for mounts, note and manifest. */
import { closeSync, fstatSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { hasNativeBrainBoundary } from "./worker-startup-view.js";
import { isEnvName, protectedPaths, PROTECTED_TIER_A, PROTECTED_TIER_B } from "./protected-paths.js";
import { at, openDirectory, mountPointsUnder, scanForOutsideLinks, WORKER_MOUNT_SCAN_LIMIT,
  type WorkerProtection, type ProtectedWorkerPath } from "./worker-sandbox.js";

const DIRECTORIES = new Set(["context/policies", ".git/hooks", ".git/info", ".git/modules", "node_modules"]);
const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? String(error);

/** Inspect subtrees without following links, including aliases below directories. */
function checkTree(fd: number, rel: string, count: { value: number }, brain: string, depth = 0): void {
  if (depth > 256) throw new Error(`${rel} is nested too deeply to verify`);
  for (const name of readdirSync(at(fd, "."))) {
    if (++count.value > WORKER_MOUNT_SCAN_LIMIT) throw new Error(`${rel} has too many entries to verify`);
    const path = at(fd, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      // Package bins link to other files inside the same read-only mount.
      // Such a link cannot provide a writable alias. Cross-boundary links
      // still select strict, and a linked protected root is always refused.
      if (rel.startsWith("node_modules") && realpathSync(path).startsWith(`${brain}/node_modules/`)) continue;
      throw new Error(`${rel}/${name} is a symlink`);
    }
    if (info.isFile() && info.nlink > 1) throw new Error(`${rel}/${name} is hardlinked`);
    if (!info.isFile() && !info.isDirectory()) throw new Error(`${rel}/${name} is not a regular file or directory`);
    if (info.isDirectory()) {
      const child = openDirectory(path);
      try {
        const opened = fstatSync(child);
        if (opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`${rel}/${name} changed during inspection`);
        checkTree(child, `${rel}/${name}`, count, brain, depth + 1);
      } finally { closeSync(child); }
    }
  }
}

/** Prepare missing directories through descriptors; never create placeholder files. */
export function resolveWorkerProtection(brain: string, options: {
  paths?: readonly string[]; appeared?: readonly string[];
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
    return { protection: { paths, ancestors: [...ancestors].sort((a, b) => a.split("/").length - b.split("/").length) } };
  } catch (error) {
    return { protection: { paths: [], ancestors: [] }, reason: `protected paths could not be verified: ${code(error)}` };
  } finally { if (root !== undefined) closeSync(root); }
}

/** Fixed order: ancestor mount points first, then the protected names. */
export function protectedWorkerMounts(brain: string, protection: WorkerProtection): string[] {
  const argv = protection.ancestors.flatMap(rel => ["--bind", join(brain, rel), join(brain, rel)]);
  for (const { rel, mode } of protection.paths) {
    const path = join(brain, rel);
    if (mode === "read_only") argv.push("--ro-bind", path, path);
    else if (mode === "mask_directory") argv.push("--tmpfs", path, "--remount-ro", path);
    else if (mode === "mask_file") argv.push("--ro-bind", "/dev/null", path);
  }
  return argv;
}
