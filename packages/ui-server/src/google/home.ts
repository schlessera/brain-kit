/**
 * The host's gog home (#4206; plan
 * [`docs/plans/google-workspace.md`](../../../../docs/plans/google-workspace.md)
 * §10, "Hosted: an enforced boundary"): the checks a configured
 * `BRAIN_UI_GOOGLE_HOME` must pass before the host runs gog in it, and the
 * exact worker masks that keep it, and the default homes gog and `brain
 * google` use under the server's HOME, out of every worker's view.
 *
 * Free of the transport, so the cron runner can lay the same masks without
 * loading gog's code.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { workerMaskCover, workerSystemPaths } from "@schlessera/brain-ui-sdk/internal";
import { serverInstallation } from "../brain/host-boundary.js";
import { canonical } from "../brain/operational-state.js";
import type { CronConfig } from "../config/env.js";

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
  /** The worker mount that is the server's HOME: the one area a mask may lie strictly inside of every launcher re-lays it there ({@link maskable}). */
  serverHome?: true;
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
   * read-only. The default homes under it are masked where they are at boot
   * ({@link googleWorkerMasks}), and a mask strictly inside it is safe.
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
 * maintenance binds it back), the Bun runtime's directory, the server's own
 * installation every maintenance worker binds back (`serverInstallation`:
 * the runtime, this package, its `node_modules` chain and the packages linked
 * into it), and the system paths every restricted or transport worker binds,
 * with `/proc` and `/dev` (`workerSystemPaths`). A transport worker lays no
 * host mask at all, and a bound-back runtime restores a directory mask laid
 * at its own path, so these are the places no mask can cover.
 */
export function googleWorkerMounts(home: string | undefined): string[] {
  const mounts: string[] = [];
  // A home at `/` is never bound (the launcher refuses it), and would hold everything.
  if (home && isAbsolute(home) && home !== "/") mounts.push(home);
  try { mounts.push(dirname(realpathSync(process.execPath))); } catch { /* no runtime directory to name */ }
  try { mounts.push(...serverInstallation()); } catch { /* no installation to name: the runtime and system paths stand */ }
  mounts.push(...workerSystemPaths());
  return [...new Set(mounts)];
}

/** A host process's layout: its brain, its database and its HOME, with the worker mounts that follow from them. */
export function googleHostLayout(input: { brainPath: string; dbPath?: string; serverHome?: string | undefined }): GoogleHomeLayout {
  return { brainPath: input.brainPath, ...(input.dbPath !== undefined ? { dbPath: input.dbPath } : {}),
    workerMounts: googleWorkerMounts(input.serverHome), ...(input.serverHome ? { serverHome: input.serverHome } : {}) };
}

export function googleHomeAreas(layout: GoogleHomeLayout): GoogleHomeArea[] {
  const areas: GoogleHomeArea[] = [{ kind: "brain", path: canonical(layout.brainPath) }];
  if (layout.dbPath && layout.dbPath !== ":memory:") areas.push({ kind: "database", path: dirname(canonical(layout.dbPath)) });
  const serverHome = layout.serverHome && isAbsolute(layout.serverHome) ? canonical(layout.serverHome) : undefined;
  for (const path of layout.workerMounts ?? []) {
    if (!isAbsolute(path)) continue;
    const resolved = canonical(path);
    areas.push({ kind: "worker_mount", path: resolved, ...(resolved === serverHome && resolved !== "/" ? { serverHome: true as const } : {}) });
  }
  for (const path of layout.tempAreas ?? googleTempAreas()) if (isAbsolute(path)) areas.push({ kind: "temp", path: canonical(path) });
  return areas;
}

const within = (root: string, path: string) => isWithin(root, path, { trailingSeparator: "boundary" });
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);

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
  /** The canonical home every worker view covers, or that no worker can reach ({@link unreachable}); null when boot laid no mask for it. */
  path: string | null;
  /**
   * Boot laid no mask at {@link path} because no worker can reach it: an
   * ancestor the separate worker identity cannot search. Each check confirms
   * that still holds.
   */
  unreachable?: true;
  /**
   * The directory at {@link path}, held open from boot (`O_RDONLY`,
   * `O_DIRECTORY`, `O_NOFOLLOW`, close-on-exec) when a check will run
   * against it. While the descriptor is open the kernel cannot free that
   * directory's inode and hand the number to another, so a directory put in
   * its place always has another device or inode, and a chmod or chown
   * changes neither. Null when boot could not open it, or once closed.
   */
  descriptor?: number | null;
  /** Boot laid none because no directory was there (missing, not a directory or unresolvable), not because the place was unsafe. */
  absentAtBoot?: boolean;
}

export interface GoogleHomeCheckOptions {
  /** The user the server runs as. Default `process.getuid()`. */
  hostUid?: number;
  /**
   * What boot laid, held open (`hold`). A home that resolves anywhere else,
   * or anywhere at all when boot laid none, is `home_moved`, and so is an
   * unreachable one a worker can now reach; one that did not exist at boot,
   * or is not the directory boot held open, is `home_created_after_boot`.
   * Either way no worker view covers it until the server restarts. A mask
   * not held open is `home_unresolvable`: nothing tells a replacement from it.
   */
  mask?: GoogleHomeMask;
}

const refuse = (reason: GoogleHomeReason, detail: string): GoogleHomeCheck => ({ ok: false, reason, detail: `BRAIN_UI_GOOGLE_HOME ${detail}` });
const RESTART = "so no worker view covers it. Restart the server.";

/**
 * Checks a configured home: absolute; its symbolic links resolved; neither
 * inside nor holding any area; a directory; mode 0700; owned by the host
 * user; and still the directory boot held open and the worker masks cover
 * (or no worker can reach). The answer names the setting and the problem,
 * never the path. It never throws.
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
    if (mask.unreachable && reachable(path)) {
      return refuse("home_moved", "is no longer behind a directory workers cannot pass, and no worker view covers it: treat any token stored there as exposed. "
        + "Restart the server, and connect the account again.");
    }
    // Only a directory held open since boot can be told from one put in its place.
    if (typeof mask.descriptor !== "number") return refuse("home_unresolvable", `was not held open from the server's start, so a directory put in its place could not be told from it. Restart the server.`);
    let held: Stats;
    try { held = fstatSync(mask.descriptor); }
    catch { return refuse("home_unresolvable", "cannot be compared with the directory the server held open at its start. Restart the server."); }
    if (held.dev !== stats.dev || held.ino !== stats.ino) return refuse("home_created_after_boot", `was replaced after the server started, ${RESTART}`);
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
 * Whether a mask over `path` is safe for every launcher to lay:
 * - never over the brain or inside it: every launch refuses a mask there;
 * - never over a place that is or holds an area (the database directory, the
 *   server's HOME, the runtime, the server's installation, a system path, a
 *   temp area): it would hide what workers need to start;
 * - never inside a worker mount (a system directory such as the one holding
 *   the dynamic loader, the runtime, an installed package), where it hides
 *   part of what every worker runs, except strictly inside the server's HOME:
 *   a credentialed maintenance worker binds that HOME back and the launcher
 *   lays every mask inside it again;
 * - never below a worker-private root, which no worker sees anyway.
 *
 * Strictly inside the database directory or another temp area (`/var/tmp`)
 * is safe: a nested mask there is laid again over a HOME bound back inside it.
 */
function maskable(path: string, areas: readonly GoogleHomeArea[]): boolean {
  return !WORKER_PRIVATE_ROOTS.some(root => within(root, path)) && !areas.some(area => area.kind === "brain"
    ? overlaps(area.path, path)
    : within(path, area.path) || area.kind === "worker_mount" && !area.serverHome && within(area.path, path));
}

/**
 * Whether a worker can reach `path`, and so needs a mask there. Always,
 * without a separate worker identity. With one, the launcher widens a mask
 * whose ancestor that identity cannot search to the highest such ancestor
 * (`workerMaskCover`) and refuses every launch when that ancestor holds the
 * brain or the runtime; but no worker can pass that ancestor, so the place
 * needs no mask, and none is laid. A cover the launcher would refuse
 * (an ancestor linked, changed or owned by another user) counts as
 * unreachable too: laying it would refuse every launch.
 */
function reachable(path: string): boolean {
  try { return workerMaskCover(path) === path; } catch { return false; }
}

/** Linux's close-on-exec open flag: `node:fs` does not export it, and Bun's `openSync` does not add it. */
const O_CLOEXEC = 0o2000000;

/** The directory at `path`, opened for the server's lifetime; null when it cannot be. */
function holdOpen(path: string): number | null {
  try { return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC); } catch { return null; }
}

/** Whether boot should hold the configured home open, for a check that will run against it. */
interface GoogleMaskOptions {
  /** Hold the masked directory open ({@link GoogleHomeMask.descriptor}). Only where a check runs; whoever asks closes it. */
  hold?: boolean;
}

/**
 * The exact worker mask for a configured home, fixed at boot: its canonical
 * path, only where a mask is safe to lay ({@link maskable}) and only for an
 * existing directory, its links resolved: a file mask over something every
 * worker runs would stop them all. Mode, owner and the check's own verdict do
 * not matter here, so a misplaced home inside the server's HOME, or one with
 * the wrong mode, is still covered while its check refuses it. A home no
 * worker can reach ({@link reachable}) gets no mask, and is marked so.
 */
export function googleHomeMask(home: string | undefined, areas: readonly GoogleHomeArea[], options: GoogleMaskOptions = {}): GoogleHomeMask {
  if (!home || !isAbsolute(home)) return { path: null };
  let path: string;
  try { path = canonical(home); } catch { return { path: null, absentAtBoot: true }; }
  if (!maskable(path, areas)) return { path: null };
  let stats: Stats | undefined;
  try { stats = lstatSync(path, { throwIfNoEntry: false }); } catch { return { path: null, absentAtBoot: true }; }
  if (!stats?.isDirectory()) return { path: null, absentAtBoot: true };
  return { path, ...(reachable(path) ? {} : { unreachable: true as const }), ...(options.hold ? { descriptor: holdOpen(path) } : {}) };
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
 * The standalone `brain google` default home under a HOME:
 * `$XDG_DATA_HOME/brain/google` with `XDG_DATA_HOME`'s default
 * (plan §10, "Standalone: an advisory boundary").
 */
export const BRAIN_GOOGLE_DEFAULT_DIR = ".local/share/brain/google";

/** Every default home masked under the server's HOME: gog's own, then the standalone CLI's. */
export const GOOGLE_DEFAULT_DIRS: readonly string[] = Object.freeze([...GOG_DEFAULT_DIRS, BRAIN_GOOGLE_DEFAULT_DIR]);

/**
 * The default homes under the server's HOME, as masks: a credentialed
 * maintenance worker binds that HOME back read-only, so a token an operator
 * created there with a bare `gog` or `brain google` is otherwise in its view.
 * Each is the directory the default resolves to, its links resolved, so a
 * default linked elsewhere (outside HOME too) masks the directory gog would
 * open. It is laid only for an existing directory where a mask is safe
 * ({@link maskable}: never into the brain) and a worker can reach
 * ({@link reachable}).
 */
function defaultMasks(serverHome: string | undefined, areas: readonly GoogleHomeArea[]): string[] {
  if (!serverHome || !isAbsolute(serverHome) || canonical(serverHome) === "/") return [];
  return GOOGLE_DEFAULT_DIRS.flatMap(relative => {
    try {
      const path = canonical(join(serverHome, relative));
      if (!maskable(path, areas) || !reachable(path)) return [];
      return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ? [path] : [];
    } catch { return []; }
  });
}

/** Every Google mask boot lays, and what it laid for the configured home. */
export interface GoogleWorkerMasks {
  home: GoogleHomeMask;
  /** Exact worker masks: the configured home and the default homes under the server's HOME, each where it is safe and reachable. */
  paths: readonly string[];
  /** Closes the descriptor a held home keeps open. Idempotent; a check after it refuses the home. */
  close(): void;
}

function closeMask(mask: GoogleHomeMask): void {
  const descriptor = mask.descriptor;
  if (typeof descriptor !== "number") return;
  mask.descriptor = null;
  try { closeSync(descriptor); } catch { /* Already closed: nothing is held. */ }
}

/**
 * The Google masks for every worker view, fixed at boot. Never throws: a
 * layout it cannot resolve lays no mask, and the home's check then refuses.
 */
export function googleWorkerMasks(home: string | undefined, layout: GoogleHomeLayout, options: GoogleMaskOptions = {}): GoogleWorkerMasks {
  let areas: GoogleHomeArea[];
  try { areas = googleHomeAreas(layout); } catch { return { home: { path: null }, paths: [], close() {} }; }
  const mask = googleHomeMask(home, areas, options);
  let defaults: string[];
  try { defaults = defaultMasks(layout.serverHome, areas); } catch { defaults = []; }
  return { home: mask, paths: [...new Set([...(mask.path && !mask.unreachable ? [mask.path] : []), ...defaults])], close: () => closeMask(mask) };
}

/**
 * The cron runner's worker masks: the native manager's private paths and the
 * Google masks for its brain, database and HOME, as the server lays them. It
 * runs no gog and checks no home, so it holds nothing open.
 */
export function cronWorkerMaskPaths(config: Pick<CronConfig, "googleHome" | "brainPath" | "dbPath" | "moduleDiscoveryEnv">, privatePaths: readonly string[]): string[] {
  const google = googleWorkerMasks(config.googleHome, googleHostLayout({ brainPath: config.brainPath, dbPath: config.dbPath, serverHome: config.moduleDiscoveryEnv.HOME }));
  return [...privatePaths, ...google.paths];
}
