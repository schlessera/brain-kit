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
 * `brain.config.*`. An existing home must be a directory owned by this user
 * that no one else can read or enter. A home that fails refuses Google for
 * the command with its reason and nothing else; `brain doctor` reports the
 * standalone home's placement.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { resolveEnv, type CoreEnv } from "../../config/env.js";
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
  "home_invalid", "home_inside_brain", "home_holds_brain", "home_not_directory", "home_owner", "home_permissions", "home_unreadable",
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

/**
 * Whether `home` may hold Google's credential for the brain at `brainRoot`:
 * its placement always, its owner and mode when it exists. Never throws.
 */
export function checkGoogleHome(home: string, brainRoot: string, uid: number = process.getuid?.() ?? -1): GoogleHomeCheck {
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
  if (rootIsBrain && within(path, root)) return refuse("home_inside_brain", "The Google home is inside this brain repository, where its credential would be part of the brain.");
  if (rootIsBrain && within(root, path)) return refuse("home_holds_brain", "The Google home holds this brain repository; use a directory of its own outside every brain.");
  if (repository !== null) return refuse("home_inside_brain", "The Google home is inside a brain repository, where its credential would be part of that brain.");
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
