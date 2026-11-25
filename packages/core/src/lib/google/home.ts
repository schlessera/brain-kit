/**
 * Which gog home `brain google` uses, and whether it may (#4208, plan
 * [`docs/plans/google-workspace.md`](../../../../../docs/plans/google-workspace.md)
 * §10, "Connecting an account" and "Standalone: an advisory boundary").
 *
 * - On a host, an operator's shell that holds `BRAIN_UI_GOOGLE_HOME` connects
 *   and reads the server's account: that home, with
 *   `BRAIN_UI_GOOGLE_KEYRING_PASSWORD` and `BRAIN_UI_GOG_PATH`. The server
 *   checks its home again itself (ui-server `google/home.ts`); nothing here
 *   relaxes that.
 * - Otherwise the standalone home: `BRAIN_GOOGLE_HOME`, else
 *   `$XDG_DATA_HOME/brain/google` (an absolute `XDG_DATA_HOME` only, as the
 *   XDG spec says), else `~/.local/share/brain/google`, with
 *   `BRAIN_GOOGLE_KEYRING_PASSWORD` and `BRAIN_GOOGLE_GOG_PATH`.
 *
 * Either home must be absolute, and must neither lie inside nor hold a brain
 * repository: the current brain root or any directory holding a
 * `brain.config.*`. Every directory above it that exists must be owned by
 * root or this user and writable by no one else unless sticky (as `/tmp`
 * is), so no other user can put another directory in its place between this
 * check and gog's use of the path. Inside a user namespace that does not map
 * root, root's directories show the kernel's overflow uid, which this process
 * cannot tell apart from any other unmapped user's, so they refuse; whoever
 * knows the namespace names the uid root shows as in `BRAIN_GOOGLE_ROOT_UID`,
 * and the refusal says so. An existing home must be a directory owned
 * by this user that no one else can read or enter. A home that fails refuses Google for
 * the command with its reason and nothing else; `brain doctor` reports the
 * standalone home's placement.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseUid, resolveEnv, type CoreEnv } from "../../config/env.js";
import { CONFIG_FILENAMES } from "../config.js";

export type GoogleHomeKind = "host" | "standalone";
export type GoogleHomeSource = "BRAIN_UI_GOOGLE_HOME" | "BRAIN_GOOGLE_HOME" | "XDG_DATA_HOME" | "HOME";

/** The home `brain google` would use, and the credential that goes with it. */
export interface GoogleHomeSelection {
  kind: GoogleHomeKind;
  source: GoogleHomeSource;
  /** As configured, made absolute only by the default's own join. */
  path: string;
  keyringPassword: string | undefined;
  gogPath: string | undefined;
  /** The variable names an operator sets, for messages. */
  names: { home: string; keyringPassword: string; gogPath: string };
}

/** Why a home cannot be used. */
export const GOOGLE_HOME_REASONS = [
  "home_invalid", "home_inside_brain", "home_holds_brain", "home_ancestor_unsafe", "home_not_directory", "home_owner", "home_permissions", "home_unreadable",
] as const;
export type GoogleHomeReason = typeof GOOGLE_HOME_REASONS[number];

export type GoogleHomeCheck =
  | { ok: true; exists: boolean; path: string }
  | { ok: false; reason: GoogleHomeReason; detail: string };

/** The standalone default under a data home. */
export const GOOGLE_STANDALONE_DIR = join("brain", "google");

/** C0 and C1 controls, NUL and the line separators: never in a usable path. */
const NOT_A_PATH = /[\p{Cc}\u2028\u2029]/u;

/** The standalone home alone, whatever the host variables say: what `brain doctor` checks. */
export function standaloneGoogleHome(env: CoreEnv["google"] = resolveEnv().google): GoogleHomeSelection {
  const names = { home: "BRAIN_GOOGLE_HOME", keyringPassword: "BRAIN_GOOGLE_KEYRING_PASSWORD", gogPath: "BRAIN_GOOGLE_GOG_PATH" };
  const credential = { keyringPassword: env.keyringPassword, gogPath: env.gogPath, names };
  if (env.home) return { kind: "standalone", source: "BRAIN_GOOGLE_HOME", path: env.home, ...credential };
  if (env.dataHome && isAbsolute(env.dataHome)) {
    return { kind: "standalone", source: "XDG_DATA_HOME", path: join(env.dataHome, GOOGLE_STANDALONE_DIR), ...credential };
  }
  return { kind: "standalone", source: "HOME", path: join(env.userHome, ".local", "share", GOOGLE_STANDALONE_DIR), ...credential };
}

/** The home this process uses: the host's while `BRAIN_UI_GOOGLE_HOME` is set, else the standalone one. */
export function selectGoogleHome(env: CoreEnv["google"] = resolveEnv().google): GoogleHomeSelection {
  if (env.hostHome) {
    return {
      kind: "host", source: "BRAIN_UI_GOOGLE_HOME", path: env.hostHome, keyringPassword: env.hostKeyringPassword, gogPath: env.hostGogPath,
      names: { home: "BRAIN_UI_GOOGLE_HOME", keyringPassword: "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", gogPath: "BRAIN_UI_GOG_PATH" },
    };
  }
  return standaloneGoogleHome(env);
}

/** `path` with its deepest existing ancestor's symbolic links resolved; the rest is joined on lexically. */
function resolveExisting(path: string): string {
  const missing: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(at), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(at);
      if (parent === at) return resolve(path);
      missing.push(basename(at));
      at = parent;
    }
  }
}

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** The nearest directory at or above `path` that holds a `brain.config.*`, or null. */
function brainRepositoryAbove(path: string): string | null {
  for (let dir = path; ; dir = dirname(dir)) {
    if (CONFIG_FILENAMES.some(name => existsSync(join(dir, name)))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** The kernel's overflow uid, which every uid a user namespace does not map shows as; undefined off Linux. */
function overflowUid(): number | undefined {
  try { return parseUid(readFileSync("/proc/sys/kernel/overflowuid", "utf8")); } catch { return undefined; }
}

/** Whom {@link checkGoogleHome} judges: this user, and the uid root's directories show as when it is not 0. */
export interface GoogleHomeOwners {
  /** Default `process.getuid()`. */
  uid?: number;
  /** `BRAIN_GOOGLE_ROOT_UID`: trusted as root is, on the directories above the home only. */
  rootUid?: number | undefined;
}

/**
 * Whether `home` may hold Google's credential for the brain at `brainRoot`:
 * its placement always, its owner and mode when it exists. Never throws.
 */
export function checkGoogleHome(home: string, brainRoot: string, owners: GoogleHomeOwners = {}): GoogleHomeCheck {
  const uid = owners.uid ?? process.getuid?.() ?? -1;
  const { rootUid } = owners;
  const refuse = (reason: GoogleHomeReason, detail: string): GoogleHomeCheck => ({ ok: false, reason, detail });
  if (typeof home !== "string" || !isAbsolute(home) || NOT_A_PATH.test(home)) {
    return refuse("home_invalid", "The Google home must be an absolute path without control characters.");
  }
  let path: string;
  let root: string;
  try {
    path = resolveExisting(home);
    root = resolveExisting(brainRoot);
  } catch {
    return refuse("home_unreadable", "A directory on the way to the Google home cannot be read.");
  }
  let repository: string | null;
  let rootIsBrain: boolean;
  try {
    repository = brainRepositoryAbove(path);
    // Root discovery falls back to a `.git` ancestor or the working directory, which need not be a brain.
    rootIsBrain = CONFIG_FILENAMES.some(name => existsSync(join(root, name)));
  } catch {
    return refuse("home_unreadable", "A directory on the way to the Google home cannot be read.");
  }
  // A home inside this brain is found by the walk up, since this brain's root holds its config.
  if (repository !== null) return refuse("home_inside_brain", "The Google home is inside a brain repository, where its credential would be part of that brain.");
  if (rootIsBrain && within(root, path)) return refuse("home_holds_brain", "The Google home holds this brain repository; use a directory of its own outside every brain.");
  // Another user who can rename an entry above the home could swap the path gog is given.
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    let above: ReturnType<typeof statSync> | undefined;
    try { above = statSync(dir, { throwIfNoEntry: false }); }
    catch { return refuse("home_unreadable", "A directory on the way to the Google home cannot be read."); }
    if (above) {
      const owned = above.uid === 0 || uid < 0 || above.uid === uid || (rootUid !== undefined && above.uid === rootUid);
      if (!owned) {
        // An unmapped owner is unknown, never clean: only someone who knows the namespace can say it is root.
        const unmapped = above.uid === overflowUid()
          ? ` Inside a user namespace that does not map root, root's directories show as uid ${above.uid}; set BRAIN_GOOGLE_ROOT_UID=${above.uid} if that is root here.`
          : "";
        return refuse("home_ancestor_unsafe", `A directory above the Google home is owned by uid ${above.uid}, another user who could replace the home.${unmapped}`);
      }
      if ((above.mode & 0o022) !== 0 && (above.mode & 0o1000) === 0) {
        return refuse("home_ancestor_unsafe", "A directory above the Google home is writable by another user, who could replace the home.");
      }
    }
    if (dirname(dir) === dir) break;
  }
  let stats: ReturnType<typeof statSync>;
  try {
    // `path` is resolved, so this is the directory itself, not a link to it.
    stats = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, exists: false, path };
    return refuse("home_unreadable", "The Google home cannot be read.");
  }
  if (!stats.isDirectory()) return refuse("home_not_directory", "The Google home is not a directory.");
  if (uid >= 0 && stats.uid !== uid) return refuse("home_owner", "The Google home is owned by another user.");
  if ((stats.mode & 0o077) !== 0) return refuse("home_permissions", "The Google home is readable or searchable by other users; make it mode 0700.");
  return { ok: true, exists: true, path };
}
