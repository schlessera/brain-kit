/**
 * Launch qualification (#4301): what a launched worker's real mount table
 * makes reachable of host private state, read by the host while the
 * sandbox's start gate is still closed. This file holds the pure part: the
 * mountinfo parser, table completeness, the kernel's walk through mount
 * points (`resolveMount`) and the verdict over declared state roots
 * (`evaluateNamespace`). Nothing here reads the filesystem.
 * Design and rules: docs/decisions/worker-writable-areas.md.
 */
import { dirname } from "node:path";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";

/**
 * A read-only tmpfs `workerCommand` mounts as a launch's last mount option,
 * on the private `/tmp` tmpfs every envelope has.
 * Its presence in a table, with exactly one row at `/`, means bubblewrap has
 * finished building the sandbox and detached its old root.
 */
export const WORKER_NAMESPACE_SEAL = "/tmp/.brain-worker-seal";

/** One row of `/proc/<pid>/mountinfo`, with escaped fields decoded. */
export interface MountRow {
  readonly id: number;
  readonly parent: number;
  /** `major:minor` of the superblock. */
  readonly sb: string;
  /** The path inside the filesystem that is mounted here. */
  readonly root: string;
  /** Mount point, relative to the reading process's root. */
  readonly point: string;
  readonly options: readonly string[];
  readonly fstype: string;
  readonly source: string;
  /** Raw (still escaped) superblock options. */
  readonly superOptions: string;
}

const decode = (field: string) => field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/** Parse a mount table; `undefined` for an empty read (one taken during `pivot_root`). A malformed row throws. */
export function parseMountinfo(text: string): MountRow[] | undefined {
  if (!text.trim()) return undefined;
  return text.trim().split("\n").map((line, index) => {
    const fields = line.split(" ");
    const separator = fields.indexOf("-", 6);
    const [id, parent, sb, root, point, options] = fields;
    // The filesystem type, source and super-options all follow the separator (F41).
    if (separator < 0 || fields.length < separator + 4 || !/^\d+$/.test(id ?? "") || !/^\d+$/.test(parent ?? "")
      || !/^\d+:\d+$/.test(sb ?? "") || !root?.startsWith("/") || !point?.startsWith("/") || !options)
      throw new Error(`invalid worker mount record ${index + 1}`);
    return { id: Number(id), parent: Number(parent), sb: sb!, root: decode(root), point: decode(point), options: options.split(","),
      fstype: fields[separator + 1]!, source: decode(fields[separator + 2] ?? ""), superOptions: fields.slice(separator + 3).join(" ") };
  });
}

/** Whether `ancestor` names `path` or a directory above it, by whole components. */
export function holdsPath(ancestor: string, path: string): boolean {
  // `/` holds every absolute path; candidate names are symlink-free strings.
  return isWithin(ancestor, path, { trailingSeparator: "boundary" });
}
/** `path` below `ancestor`, as `""` or `/rest`. */
const below = (ancestor: string, path: string) => ancestor === "/" ? (path === "/" ? "" : path) : path.slice(ancestor.length);
const under = (point: string, rest: string) => point === "/" ? (rest || "/") : `${point}${rest}`;

/**
 * A complete table: bubblewrap's seal is mounted read-only **and exactly one
 * row is at `/`**. Between bubblewrap's final `pivot_root(".", ".")` and its
 * detach of the old root, the seal is already at its path while the old root
 * is still stacked over `/` (`pivot_root(2)`); that table is not judged.
 */
export function namespaceComplete(rows: readonly MountRow[]): boolean {
  return rows.filter(row => row.point === "/").length === 1
    && rows.some(row => row.point === WORKER_NAMESPACE_SEAL && row.fstype === "tmpfs" && row.options.includes("ro"));
}

export type Resolution = { row: MountRow } | { ambiguous: string };

/**
 * The kernel's walk through mount points for a symlink-free absolute name:
 * from the one row at `/`, repeatedly enter the child mount (by parent id)
 * with the shortest mount point that is the name or a directory above it.
 * Masked replicas stay rows of a table but are never entered, because their
 * mask is a sibling with a shorter mount point. Two children of one parent on
 * one point, a deleted mount point or a parent cycle make the table ambiguous.
 */
export function resolveMount(rows: readonly MountRow[], name: string): Resolution {
  const roots = rows.filter(row => row.point === "/");
  if (roots.length !== 1) return { ambiguous: "the table has no single root mount" };
  let current = roots[0]!;
  const visited = new Set<number>([current.id]);
  for (;;) {
    const children = rows.filter(row => row.parent === current.id && row.id !== current.id && holdsPath(row.point, name));
    if (!children.length) return { row: current };
    const shortest = Math.min(...children.map(row => row.point.length));
    const next = children.filter(row => row.point.length === shortest);
    if (next.length > 1) return { ambiguous: `two mounts share the mount point ${next[0]!.point}` };
    if (next[0]!.point.endsWith(" (deleted)")) return { ambiguous: `the mount point ${next[0]!.point} is deleted` };
    if (visited.has(next[0]!.id)) return { ambiguous: "the table's parent ids form a cycle" };
    current = next[0]!;
    visited.add(current.id);
  }
}

/** One existing state root, observed by the host at its canonical path. */
export interface StateRootObservation {
  readonly setting: string;
  /** Canonical host path. */
  readonly path: string;
  /** Backing coordinates: the superblock and the path inside its filesystem. */
  readonly sb: string;
  readonly fspath: string;
  /** The host reads it through an idmapped mount: its owner there is not the inode's (F34). */
  readonly hostIdmapped?: boolean;
}

/** What the host reads at its own paths, injected so the verdict stays pure. */
export interface NamespaceInspector {
  /** Owner and mode of the object at a host path; `undefined` when it cannot be read. */
  owner(path: string): { uid: number; mode: number } | undefined;
  /** Backing coordinates of an overlay layer path in the server's namespace; `undefined` when it does not resolve there. */
  layer(path: string): { sb: string; fspath: string } | undefined;
}

export interface NamespaceExposure { setting: string; path: string; name: string; row: string }
export type NamespaceVerdict =
  | { result: "hidden"; nonCoverage: string[] }
  | { result: "ownership_only"; entries: NamespaceExposure[]; nonCoverage: string[] }
  | ({ result: "exposed" } & NamespaceExposure)
  | { result: "unknown"; cause: string };

const describe = (row: MountRow) => `${row.id} ${row.parent} ${row.sb} ${row.root} ${row.point} ${row.fstype}`;

/**
 * Overlay layer paths. `lowerdir` lists layers separated by colons; Linux
 * shows it as given, with its backslashes octal-escaped, so it is decoded
 * first and split on the colons a `\\` does not escape (F33). `lowerdir+`,
 * `datadir+`, `upperdir` and `workdir` each name one layer.
 */
/**
 * The legacy lowerdir string split as the kernel splits it (#4973 r4 F44): a
 * backslash escapes the character after it, so backslashes pair up and a
 * colon after an even run still separates layers; each layer then drops its
 * escapes.
 */
function splitLowerdir(value: string): string[] {
  const layers: string[] = [];
  let layer = "";
  for (let at = 0; at < value.length; at++) {
    const char = value[at]!;
    if (char === "\\") { if (at + 1 < value.length) layer += value[++at]; }
    else if (char === ":") { if (layer) layers.push(layer); layer = ""; }
    else layer += char;
  }
  if (layer) layers.push(layer);
  return layers;
}

export function overlayLayers(superOptions: string): string[] {
  const layers: string[] = [];
  for (const option of superOptions.split(",")) {
    const eq = option.indexOf("=");
    if (eq < 0) continue;
    const key = option.slice(0, eq), value = decode(option.slice(eq + 1));
    // Linux keeps the legacy lowerdir string as given and octal-escapes its
    // backslashes: decode first, then split on the colons it left unescaped (F33).
    if (key === "lowerdir") layers.push(...splitLowerdir(value));
    else if (["lowerdir+", "datadir+", "upperdir", "workdir"].includes(key)) layers.push(value);
  }
  return layers;
}

/**
 * The verdict for one complete table. A row covers a root when it is on the
 * root's superblock and its `root` is the root's backing path, a directory
 * above it, or inside it; the candidate name is where the row shows that
 * part. A live candidate (one `resolveMount` reaches) is an exposure, unless
 * the object it shows is owned by none of the sandbox's UIDs and has no group
 * or other permission bit (the 2026-11-27 ruling): then it is reported only.
 * The same holds for any host directory between the mount's root and the
 * object, which the sandbox must traverse to open it: state below an
 * owner-only directory of another UID is reported only (#5051).
 * A live overlay whose layer is prefix-related to a root is an exposure; a
 * layer path the server cannot resolve is not judged and is named in
 * `nonCoverage`. An ambiguous table, or a live object the host cannot stat,
 * is `unknown`.
 */
export function evaluateNamespace(rows: readonly MountRow[], roots: readonly StateRootObservation[], workerUids: readonly number[],
  inspect: NamespaceInspector): NamespaceVerdict {
  const ownershipOnly: NamespaceExposure[] = [], nonCoverage: string[] = [];
  for (const root of roots) {
    for (const row of rows) {
      if (row.sb !== root.sb) continue;
      let name: string, object: string, traversed = 0;
      if (holdsPath(row.root, root.fspath)) {
        const rest = below(row.root, root.fspath);
        name = under(row.point, rest); object = root.path;
        // The host directories from the mount's root down to the object's parent.
        traversed = rest.split("/").filter(Boolean).length;
      }
      else if (holdsPath(root.fspath, row.root)) { name = row.point; object = under(root.path, below(root.fspath, row.root)); }
      else continue;
      const reached = resolveMount(rows, name);
      if ("ambiguous" in reached) return { result: "unknown", cause: reached.ambiguous };
      if (reached.row.id !== row.id) continue;
      const exposure = { setting: root.setting, path: root.path, name, row: describe(row) };
      const ownerOnly = (path: string): boolean | undefined => {
        const owner = inspect.owner(path);
        return owner && !workerUids.includes(owner.uid) && (owner.mode & 0o077) === 0;
      };
      let closed = ownerOnly(object);
      if (closed === undefined) return { result: "unknown", cause: `the owner of ${root.setting} could not be read` };
      for (let at = 0, dir = object; !closed && at < traversed; at++) {
        dir = dirname(dir);
        closed = ownerOnly(dir);
        if (closed === undefined) return { result: "unknown", cause: `the owner of a directory above ${root.setting} could not be read` };
      }
      // An idmapped mount shows another owner at the worker's name than the host
      // reads at its own: the host's owner decides nothing there (F31).
      if (!row.options.includes("idmapped") && !root.hostIdmapped && closed) ownershipOnly.push(exposure);
      else return { result: "exposed", ...exposure };
    }
  }
  for (const row of rows) {
    if (row.fstype !== "overlay") continue;
    const reached = resolveMount(rows, row.point);
    if ("ambiguous" in reached) return { result: "unknown", cause: reached.ambiguous };
    if (reached.row.id !== row.id) continue;
    for (const layer of overlayLayers(row.superOptions)) {
      const coordinates = layer.startsWith("/") ? inspect.layer(layer) : undefined;
      if (!coordinates) { nonCoverage.push(`overlay layer ${layer} at ${row.point}`); continue; }
      const root = roots.find(candidate => candidate.sb === coordinates.sb
        && (holdsPath(candidate.fspath, coordinates.fspath) || holdsPath(coordinates.fspath, candidate.fspath)));
      if (root) return { result: "exposed", setting: root.setting, path: root.path, name: row.point, row: describe(row) };
    }
  }
  return ownershipOnly.length ? { result: "ownership_only", entries: ownershipOnly, nonCoverage } : { result: "hidden", nonCoverage };
}
