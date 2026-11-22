/**
 * The host's gog home (#4206; plan
 * [`docs/plans/google-workspace.md`](../../../../docs/plans/google-workspace.md)
 * §10, "Hosted: an enforced boundary"): the checks a configured
 * `BRAIN_UI_GOOGLE_HOME` must pass before the host runs gog in it, and the
 * exact worker masks that keep it, and gog's own default directories under
 * the server's HOME, out of every worker's view.
 *
 * Free of the transport, so the cron runner can lay the same masks without
 * loading gog's code.
 */
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { workerIdentityHelper, workerSystemPaths } from "@schlessera/brain-ui-sdk/internal";
import { canonical } from "../brain/operational-state.js";

/** Why a configured home is refused. Each names the setting, never the path. */
export const GOOGLE_HOME_REASONS = [
  "home_unset", "home_relative", "home_unresolvable", "home_missing", "home_not_directory", "home_mode", "home_owner",
  "home_overlaps_brain", "home_overlaps_database", "home_overlaps_worker_mount", "home_overlaps_temp", "home_moved", "home_created_after_boot",
] as const;
export type GoogleHomeReason = typeof GOOGLE_HOME_REASONS[number];

/** A place the home may neither be inside nor hold. */
export interface GoogleHomeArea {
  kind: "brain" | "database" | "worker_mount" | "temp";
  /** Canonical: symbolic links resolved. */
  path: string;
}

/**
 * Where the host keeps what a worker must not reach, and what workers see
 * from the host. Every path is resolved before it is compared.
 */
export interface GoogleHomeLayout {
  brainPath: string;
  /** The UI database; its directory holds the journal and other host state. Absent or `:memory:` for none. */
  dbPath?: string;
  /** Host paths workers see whatever their masks: {@link googleWorkerMounts}. */
  workerMounts?: readonly string[];
  /** Temp areas. Default {@link googleTempAreas}. */
  tempAreas?: readonly string[];
  /**
   * The server's HOME, which a credentialed maintenance worker binds back
   * read-only. gog's own default directories under it are masked where they
   * are at boot ({@link googleWorkerMasks}).
   */
  serverHome?: string;
}

/**
 * The temp areas a home may not overlap: the process's temp directory
 * (`os.tmpdir()`, which follows `TMPDIR`), the worker temp root `/tmp` every
 * worker's private temp is mounted at, and the other shared temp areas.
 */
export function googleTempAreas(): string[] {
  return [...new Set([tmpdir(), "/tmp", "/var/tmp", "/dev/shm"])];
}

/**
 * The host paths a worker sees whatever its masks: `home` (credentialed
 * maintenance binds it back), the Bun runtime's directory, and the system
 * paths every restricted or transport worker binds, with `/proc` and `/dev`
 * (`workerSystemPaths`). A transport worker lays no host mask at all, so
 * these are the places no mask can cover.
 */
export function googleWorkerMounts(home: string | undefined): string[] {
  const mounts: string[] = [];
  // A home at `/` is never bound (the launcher refuses it), and would hold everything.
  if (home && isAbsolute(home) && home !== "/") mounts.push(home);
  try { mounts.push(dirname(realpathSync(process.execPath))); } catch { /* no runtime directory to name */ }
  mounts.push(...workerSystemPaths());
  return mounts;
}

/** A host process's layout: its brain, its database and its HOME, with the worker mounts that follow from them. */
export function googleHostLayout(input: { brainPath: string; dbPath?: string; serverHome?: string | undefined }): GoogleHomeLayout {
  return { brainPath: input.brainPath, ...(input.dbPath !== undefined ? { dbPath: input.dbPath } : {}),
    workerMounts: googleWorkerMounts(input.serverHome), ...(input.serverHome ? { serverHome: input.serverHome } : {}) };
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
/**
 * A directory's identity: device, inode and birth time. ext4 hands a new
 * directory the inode just freed, so the inode alone does not tell a
 * recreated home from the one boot masked; a chmod or chown changes none of these.
 */
const identity = (stats: Stats) => `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;

const AREA_REASON: Readonly<Record<GoogleHomeArea["kind"], GoogleHomeReason>> = {
  brain: "home_overlaps_brain", database: "home_overlaps_database", worker_mount: "home_overlaps_worker_mount", temp: "home_overlaps_temp",
};
const AREA_NAME: Readonly<Record<GoogleHomeArea["kind"], string>> = {
  brain: "the brain", database: "the UI database's directory", worker_mount: "a directory workers see from the host", temp: "a temp area",
};

export type GoogleHomeCheck =
  | { ok: true; path: string }
  | { ok: false; reason: GoogleHomeReason; detail: string };

/**
 * What boot laid for the configured home, fixed for the server's lifetime
 * ({@link googleHomeMask}).
 */
export interface GoogleHomeMask {
  /** The canonical home every worker view covers, or null when boot laid no mask for it. */
  path: string | null;
  /** The masked directory as boot found it (device, inode, birth time): a directory put in its place later is not the one the views cover. */
  identity?: string;
  /** Boot laid none because no directory was there (missing, not a directory or unresolvable), not because the place was unsafe. */
  absentAtBoot?: boolean;
}

export interface GoogleHomeCheckOptions {
  /** The user the server runs as. Default `process.getuid()`. */
  hostUid?: number;
  /**
   * What boot laid. A home that resolves anywhere else, or anywhere at all
   * when boot laid none, is `home_moved`; one that did not exist at boot, or
   * was replaced since, is `home_created_after_boot`. Either way no worker
   * view covers it until the server restarts.
   */
  mask?: GoogleHomeMask;
}

const refuse = (reason: GoogleHomeReason, detail: string): GoogleHomeCheck => ({ ok: false, reason, detail: `BRAIN_UI_GOOGLE_HOME ${detail}` });
const RESTART = "so no worker view covers it. Restart the server.";

/**
 * Checks a configured home: absolute; its symbolic links resolved; neither
 * inside nor holding any area; a directory; mode 0700; owned by the host
 * user; and still the directory the worker masks cover. The answer names the
 * setting and the problem, never the path. It never throws.
 */
export function checkGoogleHome(home: string | undefined, areas: readonly GoogleHomeArea[], options: GoogleHomeCheckOptions = {}): GoogleHomeCheck {
  if (!home) return refuse("home_unset", "is not set.");
  if (!isAbsolute(home)) return refuse("home_relative", "is not an absolute path.");
  let path: string;
  try { path = canonical(home); } catch { return refuse("home_unresolvable", "cannot be resolved: a component is unreadable or links too deeply."); }
  for (const area of areas) {
    if (!overlaps(area.path, path)) continue;
    const where = within(area.path, path) ? `is inside ${AREA_NAME[area.kind]}` : `holds ${AREA_NAME[area.kind]}`;
    return refuse(AREA_REASON[area.kind], `${where}, where a worker may already have read it: treat any token stored there as exposed. `
      + "Move the home to a directory of its own outside the brain, the database directory, every worker mount and every temp area, restart the server, and connect the account again.");
  }
  let stats: Stats | undefined;
  try { stats = lstatSync(path, { throwIfNoEntry: false }); }
  catch { return refuse("home_unresolvable", "cannot be inspected: the server may not look at it, or it changed while it was checked."); }
  if (!stats) {
    return refuse("home_missing", "does not exist. Worker views cover only a home that exists when the server starts: "
      + "create it with mode 0700, owned by the user the server runs as, restart the server, then connect an account from the host's shell.");
  }
  if (!stats.isDirectory()) return refuse("home_not_directory", "is not a directory.");
  if ((stats.mode & 0o7777) !== 0o700) return refuse("home_mode", `has mode ${(stats.mode & 0o7777).toString(8).padStart(4, "0")}; it must be 0700.`);
  const uid = options.hostUid ?? process.getuid?.();
  if (stats.uid !== uid) return refuse("home_owner", "is not owned by the user the server runs as.");
  const mask = options.mask;
  if (mask) {
    if (mask.path === null && mask.absentAtBoot) return refuse("home_created_after_boot", `did not exist when the server started, ${RESTART}`);
    if (mask.path !== path) return refuse("home_moved", `is not where the worker views were laid at boot, ${RESTART}`);
    if (mask.identity !== undefined && mask.identity !== identity(stats)) return refuse("home_created_after_boot", `was replaced after the server started, ${RESTART}`);
  }
  return { ok: true, path };
}

/**
 * Roots every worker replaces with its own: a private `/tmp` (the launcher
 * skips a mask there) and a fresh `/proc` and `/dev`. A host path below them
 * is in no worker's view, and a mask there can only break launches: bwrap
 * cannot create a host process's directory in the worker's own `/proc`.
 */
const WORKER_PRIVATE_ROOTS: readonly string[] = ["/tmp", "/proc", "/dev"];

/**
 * Whether a mask over `path` is safe to lay. Never over the brain or inside
 * it: every launch refuses a mask there. Never over a place that is or holds
 * another area (the database directory, the server's HOME, the Bun runtime,
 * a system path, a temp area): it would hide what workers need to start.
 * Never below a worker-private root, which no worker sees anyway. Strictly
 * inside another area is safe and needed: a credentialed maintenance worker
 * binds the server's HOME back and the launcher lays every mask inside it
 * again; a nested mask in the masked database directory is laid again the
 * same way when that HOME lies inside it.
 */
function maskable(path: string, areas: readonly GoogleHomeArea[]): boolean {
  return !areas.some(area => area.kind === "brain" ? overlaps(area.path, path) : within(path, area.path))
    && !WORKER_PRIVATE_ROOTS.some(root => within(root, path));
}

/**
 * The exact worker mask for a configured home, fixed at boot: its canonical
 * path, only where a mask is safe to lay ({@link maskable}) and only for an
 * existing directory, its links resolved: a file mask over something every
 * worker runs would stop them all. Mode, owner and the check's own verdict do
 * not matter here, so a misplaced home inside the server's HOME, or one with
 * the wrong mode, is still covered while its check refuses it.
 */
export function googleHomeMask(home: string | undefined, areas: readonly GoogleHomeArea[]): GoogleHomeMask {
  if (!home || !isAbsolute(home)) return { path: null };
  let path: string;
  try { path = canonical(home); } catch { return { path: null, absentAtBoot: true }; }
  if (!maskable(path, areas)) return { path: null };
  let stats: Stats | undefined;
  try { stats = lstatSync(path, { throwIfNoEntry: false }); } catch { return { path: null, absentAtBoot: true }; }
  if (!stats?.isDirectory()) return { path: null, absentAtBoot: true };
  return { path, identity: identity(stats) };
}

/**
 * gog's own default directories under a HOME, where a gog run without
 * `GOG_HOME` or the XDG variables keeps its configuration, its keyring and
 * OAuth client (data, or the legacy config keyring), state and cache: gog
 * v0.48.1 `internal/config/layout.go` (`resolveKind`, `defaultBase`) and
 * `internal/config/layout_paths.go` (`KeyringDir`).
 */
export const GOG_DEFAULT_DIRS: readonly string[] = Object.freeze([".config/gogcli", ".local/share/gogcli", ".local/state/gogcli", ".cache/gogcli"]);

/**
 * gog's default directories under the server's HOME, as masks: a
 * credentialed maintenance worker binds that HOME back read-only, so a token
 * an operator created there with a bare `gog` is otherwise in its view. Each
 * is laid only for an existing directory strictly inside that HOME where a
 * mask is safe ({@link maskable}). None with a separate worker identity, where the
 * launcher may widen a mask to an unsearchable ancestor (which a worker of
 * another user cannot pass anyway) and refuse the launch if that ancestor
 * holds the brain or runtime.
 */
function gogDefaultMasks(serverHome: string | undefined, areas: readonly GoogleHomeArea[]): string[] {
  if (!serverHome || !isAbsolute(serverHome) || workerIdentityHelper()) return [];
  const home = canonical(serverHome);
  if (home === "/") return [];
  return GOG_DEFAULT_DIRS.flatMap(relative => {
    try {
      const path = canonical(join(serverHome, relative));
      if (path === home || !within(home, path) || !maskable(path, areas)) return [];
      return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ? [path] : [];
    } catch { return []; }
  });
}

/** Every Google mask boot lays, and what it laid for the configured home. */
export interface GoogleWorkerMasks {
  home: GoogleHomeMask;
  /** Exact worker masks: the configured home and gog's default directories under the server's HOME, each where it is safe. */
  paths: readonly string[];
}

/**
 * The Google masks for every worker view, fixed at boot. Never throws: a
 * layout it cannot resolve lays no mask, and the home's check then refuses.
 */
export function googleWorkerMasks(home: string | undefined, layout: GoogleHomeLayout): GoogleWorkerMasks {
  let areas: GoogleHomeArea[];
  try { areas = googleHomeAreas(layout); } catch { return { home: { path: null }, paths: [] }; }
  const mask = googleHomeMask(home, areas);
  let defaults: string[];
  try { defaults = gogDefaultMasks(layout.serverHome, areas); } catch { defaults = []; }
  return { home: mask, paths: [...new Set([...(mask.path ? [mask.path] : []), ...defaults])] };
}
