/**
 * The host side of the trusted web executor (#3686, epic #2765): what one
 * executor session is given before it starts.
 *
 * Each principal's session gets a fresh private directory, created `0700`
 * under a host-chosen root and removed when that executor ends. It holds a
 * sanitized copy of the host's `web-search.json` and nothing else: no host
 * HOME, config directory, auth, models, settings, brain or cache is mounted
 * or copied. `HOME`, `XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR`, the fetch
 * cache and `TMPDIR` all point inside it, so `gh`, `git` and the extension's
 * own lookups find no host login. Provider API keys arrive only as the
 * catalog's environment variables, under the existing trusted host policy.
 *
 * The sanitizer enforces the rulings of 2026-10-15 on #1863 in the
 * configuration itself, rather than trusting the worker-facing schema alone:
 *
 * - Workflow A, only the four core tools: `workflow` is `none`; curator,
 *   summary, commands, shortcuts, tool renames and activation are dropped;
 *   image, video and YouTube analysis and GitHub cloning are off.
 * - Credential exclusion A: browser cookies are off and their profile
 *   selection dropped, and every `!command` credential value is removed, so
 *   no credential command can run.
 *
 * What it removed is reported, never silently ignored.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The pinned extension's published entry (`pi.extensions: ["./dist"]` in its manifest). */
export function pinnedWebExtensionEntry(): string {
  return join(dirname(Bun.resolveSync("pi-web-access/package.json", import.meta.dir)), "dist", "index.js");
}

/** The pinned upstream identity, checked by `tests/web-executor-pin.test.ts`. */
export const PINNED_WEB_EXTENSION = Object.freeze({
  name: "pi-web-access",
  version: "0.41.0",
  /** Registry SHA-512 integrity of the published tarball. */
  integrity: "sha512-8+UoNENGHKlYBxrtwh7Hwoh2twVfs+tcdR1Ciq7sRUtTur0mOXP8N/o7/y72JbdYij3NuSyCNjShbWBPPJ8JPA==",
  /** SHA-256 of the same tarball, as `docs/plans/host-owned-web-search.md` records it. */
  tarballSha256: "68c4eb20216fe77fe69b0fcdb24e03c0cc6e0c7cc7bad8e88b47373da1c91aec",
});

/** Top-level keys that select a deferred workflow or an excluded mode; removed outright. */
const DROPPED_KEYS = [
  "curatorTimeoutSeconds", "autoOpenBrowser", "curatorRemote", "summaryModel", "summaryGenerationDeadlineMs",
  "summaryInstructions", "commands", "shortcuts", "toolNames", "toolActivation", "browserCookies", "chromeProfile",
] as const;

/** Forced values: the four tools under their default names, and every deferred or excluded path off. */
const FORCED: Readonly<Record<string, unknown>> = Object.freeze({
  workflow: "none",
  allowBrowserCookies: false,
  tools: { webSearch: { enabled: true }, fetchContent: { enabled: true }, getSearchContent: { enabled: true }, sourceCheck: { enabled: true } },
  commands: { websearch: { enabled: false }, curator: { enabled: false }, search: { enabled: false }, "google-account": { enabled: false } },
  image: { enabled: false },
  video: { enabled: false },
  youtube: { enabled: false },
  githubClone: { enabled: false },
});

export interface SanitizedWebConfig {
  config: Record<string, unknown>;
  /** Dotted paths of what was removed or overridden, for the receipt. */
  removed: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** An upstream credential command: `!cmd`. `$!…` is the escape for a literal `!`. */
const isCredentialCommand = (value: unknown) => typeof value === "string" && value.trim().startsWith("!");

function withoutCommands(value: unknown, path: string, removed: string[]): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => {
      if (isCredentialCommand(entry)) { removed.push(`${path}[${index}]`); return []; }
      return [withoutCommands(entry, `${path}[${index}]`, removed)];
    });
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (isCredentialCommand(entry)) { removed.push(at); continue; }
    out[key] = withoutCommands(entry, at, removed);
  }
  return out;
}

/** The executor's copy of a parsed host `web-search.json`. */
export function sanitizeWebExecutorConfig(host: unknown): SanitizedWebConfig {
  const removed: string[] = [];
  const source = isRecord(host) ? host : {};
  const config = withoutCommands(source, "", removed) as Record<string, unknown>;
  for (const key of DROPPED_KEYS) if (Object.hasOwn(config, key)) { delete config[key]; removed.push(key); }
  for (const [key, value] of Object.entries(FORCED)) {
    if (Object.hasOwn(source, key) && JSON.stringify(source[key]) !== JSON.stringify(value) && !removed.includes(key)) removed.push(key);
    config[key] = structuredClone(value);
  }
  return { config, removed };
}

export interface WebExecutorState {
  dir: string;
  env: Record<string, string>;
  removed: string[];
  cleanup(): void;
}

export interface PrepareWebExecutorStateOptions {
  /** Where private session directories are created; the host owns it. */
  root: string;
  /** The host's `web-search.json`; absent means an empty configuration. */
  hostConfigPath: string;
  /** Catalog provider API keys from the host environment; only nonempty values pass. */
  credentialEnv: Readonly<Record<string, string | undefined>>;
  /** PATH for the executor's own subprocesses. */
  path: string;
}

/** Create one executor session's private directory and environment. */
export function prepareWebExecutorState(options: PrepareWebExecutorStateOptions): WebExecutorState {
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(options.root, "session-"));
  chmodSync(dir, 0o700);
  try {
    for (const sub of ["agent", "work", "tmp", "cache", "xdg"]) mkdirSync(join(dir, sub), { mode: 0o700 });
    let host: unknown = {};
    if (existsSync(options.hostConfigPath)) {
      // A config the host cannot parse is not guessed at: the executor runs with none.
      try { host = JSON.parse(readFileSync(options.hostConfigPath, "utf8")); } catch { host = {}; }
    }
    const { config, removed } = sanitizeWebExecutorConfig(host);
    writeFileSync(join(dir, "agent", "web-search.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
    const env: Record<string, string> = {
      PATH: options.path, LANG: "C.UTF-8", HOME: dir, XDG_CONFIG_HOME: join(dir, "xdg"), PI_CODING_AGENT_DIR: join(dir, "agent"),
      PI_WEB_ACCESS_CACHE_ROOT: join(dir, "cache"), TMPDIR: join(dir, "tmp"), PI_OFFLINE: "1",
    };
    for (const [name, value] of Object.entries(options.credentialEnv)) if (value && value.trim()) env[name] = value;
    return { dir, env, removed, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** The program the host's child executor runs for one session. */
export function webExecutorCommand(runtime: string, stateDir: string): [string, ...string[]] {
  return [runtime, Bun.resolveSync("./web-executor-entry", import.meta.dir), stateDir];
}
