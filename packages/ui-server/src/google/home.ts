/**
 * The host's gog home (#4206; plan
 * [`docs/plans/google-workspace.md`](../../../../docs/plans/google-workspace.md)
 * §10, "Hosted: an enforced boundary"): the checks a configured
 * `BRAIN_UI_GOOGLE_HOME` must pass before the host runs gog in it, and the
 * exact worker mask that keeps it out of every worker's view.
 *
 * Free of the transport, so the cron runner can lay the same mask without
 * loading gog's code.
 */
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { canonical } from "../brain/operational-state.js";

/** Why a configured home is refused. Each names the setting, never the path. */
export const GOOGLE_HOME_REASONS = [
  "home_unset", "home_relative", "home_unresolvable", "home_missing", "home_not_directory", "home_mode", "home_owner",
  "home_overlaps_brain", "home_overlaps_database", "home_overlaps_worker_mount", "home_overlaps_temp", "home_moved",
] as const;
export type GoogleHomeReason = typeof GOOGLE_HOME_REASONS[number];

/** A place the home may neither be inside nor hold. */
export interface GoogleHomeArea {
  kind: "brain" | "database" | "worker_mount" | "temp";
  /** Canonical: symbolic links resolved. */
  path: string;
}

/**
 * Where the host keeps what a worker must not reach, and what it binds into
 * workers. Every path is resolved before it is compared.
 */
export interface GoogleHomeLayout {
  brainPath: string;
  /** The UI database; its directory holds the journal and other host state. Absent or `:memory:` for none. */
  dbPath?: string;
  /** Host directories the server binds into workers: its HOME for credentialed maintenance, the Bun runtime. */
  workerMounts?: readonly string[];
  /** Temp areas. Default {@link googleTempAreas}. */
  tempAreas?: readonly string[];
}

/**
 * The temp areas a home may not overlap: the process's temp directory
 * (`os.tmpdir()`, which follows `TMPDIR`), the worker temp root `/tmp` every
 * worker's private temp is mounted at, and the other shared temp areas.
 */
export function googleTempAreas(): string[] {
  return [...new Set([tmpdir(), "/tmp", "/var/tmp", "/dev/shm"])];
}

/** The host directories a worker sees bound from the host: `home` (credentialed maintenance) and the Bun runtime. */
export function googleWorkerMounts(home: string | undefined): string[] {
  const mounts: string[] = [];
  // A home at `/` is never bound (the launcher refuses it), and would hold everything.
  if (home && isAbsolute(home) && home !== "/") mounts.push(home);
  try { mounts.push(dirname(realpathSync(process.execPath))); } catch { /* no runtime directory to name */ }
  return mounts;
}

export function googleHomeAreas(layout: GoogleHomeLayout): GoogleHomeArea[] {
  const areas: GoogleHomeArea[] = [{ kind: "brain", path: canonical(layout.brainPath) }];
  if (layout.dbPath && layout.dbPath !== ":memory:") areas.push({ kind: "database", path: dirname(canonical(layout.dbPath)) });
  for (const path of layout.workerMounts ?? []) if (isAbsolute(path)) areas.push({ kind: "worker_mount", path: canonical(path) });
  for (const path of layout.tempAreas ?? googleTempAreas()) if (isAbsolute(path)) areas.push({ kind: "temp", path: canonical(path) });
  return areas;
}

const within = (root: string, path: string) => isWithin(root, path, { trailingSeparator: "boundary" });
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);

const AREA_REASON: Readonly<Record<GoogleHomeArea["kind"], GoogleHomeReason>> = {
  brain: "home_overlaps_brain", database: "home_overlaps_database", worker_mount: "home_overlaps_worker_mount", temp: "home_overlaps_temp",
};
const AREA_NAME: Readonly<Record<GoogleHomeArea["kind"], string>> = {
  brain: "the brain", database: "the UI database's directory", worker_mount: "a directory the server binds into workers", temp: "a temp area",
};

export type GoogleHomeCheck =
  | { ok: true; path: string }
  | { ok: false; reason: GoogleHomeReason; detail: string };

export interface GoogleHomeCheckOptions {
  /** The user the server runs as. Default `process.getuid()`. */
  hostUid?: number;
  /**
   * The canonical home the worker views cover, fixed at boot, or `null` when
   * boot laid none. A home that resolves anywhere else, or anywhere at all
   * under `null`, is `home_moved`: no worker view covers it.
   */
  masked?: string | null;
}

const refuse = (reason: GoogleHomeReason, detail: string): GoogleHomeCheck => ({ ok: false, reason, detail: `BRAIN_UI_GOOGLE_HOME ${detail}` });

/**
 * Checks a configured home: absolute; its symbolic links resolved; neither
 * inside nor holding any area; a directory; mode 0700; owned by the host
 * user; and still where the worker masks are. The answer names the setting
 * and the problem, never the path.
 */
export function checkGoogleHome(home: string | undefined, areas: readonly GoogleHomeArea[], options: GoogleHomeCheckOptions = {}): GoogleHomeCheck {
  if (!home) return refuse("home_unset", "is not set.");
  if (!isAbsolute(home)) return refuse("home_relative", "is not an absolute path.");
  let path: string;
  try { path = canonical(home); } catch { return refuse("home_unresolvable", "cannot be resolved: a component is unreadable or links too deeply."); }
  for (const area of areas) {
    if (!overlaps(area.path, path)) continue;
    const where = within(area.path, path) ? `is inside ${AREA_NAME[area.kind]}` : `holds ${AREA_NAME[area.kind]}`;
    return refuse(AREA_REASON[area.kind], `${where}. Move it to a directory of its own outside the brain, the database directory, every worker mount and every temp area.`);
  }
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats) return refuse("home_missing", "does not exist. Create it with mode 0700, then connect an account from the host's shell.");
  if (!stats.isDirectory()) return refuse("home_not_directory", "is not a directory.");
  if ((stats.mode & 0o7777) !== 0o700) return refuse("home_mode", `has mode ${(stats.mode & 0o7777).toString(8).padStart(4, "0")}; it must be 0700.`);
  const uid = options.hostUid ?? process.getuid?.();
  if (stats.uid !== uid) return refuse("home_owner", "is not owned by the user the server runs as.");
  if (options.masked !== undefined && options.masked !== path) {
    return refuse("home_moved", "is not where the worker views were laid at boot, so no worker view covers it. Restart the server.");
  }
  return { ok: true, path };
}

/**
 * The exact worker mask for a configured home, fixed at boot: its canonical
 * path, or nothing when it is unset, relative, unresolvable, or inside or
 * holding the brain (which a worker view cannot cover; its check refuses it).
 */
export function googleHomeMask(home: string | undefined, brainPath: string): string | undefined {
  if (!home || !isAbsolute(home)) return undefined;
  try {
    const path = canonical(home), brain = canonical(brainPath);
    return overlaps(brain, path) ? undefined : path;
  } catch { return undefined; }
}
