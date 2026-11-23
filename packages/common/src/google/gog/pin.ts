/**
 * The pin check (plan §8, "An exact pin"): before the transport runs a gog
 * binary for the first time it checks, in this order and without executing
 * anything until the hash matches,
 *
 * 1. that the platform has a pinned release binary;
 * 2. the binary and its directory: absolute, a regular executable file,
 *    owned by root or the host user and writable by no one else;
 * 3. the sha256 of the bytes read from one open descriptor, against the pin
 *    list, with that descriptor's file the one step 2 checked and its
 *    identity unchanged while it was read;
 * 4. `gog version`: exactly the pinned version and commit;
 * 5. `gog schema --json`: schema version, build, exit codes, and every
 *    command path, flag and positional of the snapshot, with its type.
 *
 * The identity the checks and the hash were taken over is what the
 * transport re-checks before each call: the file the path resolves to
 * through every symlink, that file's device, inode, size, mtime, ctime,
 * mode, owner and group, and its directory's device, inode, mode, owner and
 * group. Every step, and every re-check, resolves the path the transport
 * was given, so the file, the directory and the identity they are compared
 * with are always one file's; a symlink retargeted after verification
 * resolves to another file, which is a changed identity. The ctime is the
 * part no user can set: any write, rename, chmod or chown moves it, even
 * one that puts the mtime back. A changed identity refuses that call and
 * verifies the file again from step 2, so a mode or owner repaired after a
 * refusal is seen by the next call.
 *
 * What it cannot close: the descriptor is closed after hashing, and every
 * run (`version`, `schema` and each operation) executes the path. Between
 * the last identity check and the exec, a process that can write the
 * directory could swap the file and swap it back. Step 2 allows that only to
 * root and the host user, who could equally replace the binary between two
 * calls or change the host's own code; the swap also moves the ctime, so the
 * next call sees it. Executing the hashed descriptor itself is not done:
 * `Bun.spawn` takes a path, and a `/proc/self/fd` path exists on Linux only,
 * not on the macOS platforms the pins cover.
 *
 * Every failure is `transport_incompatible` with one of
 * {@link GOG_PIN_REFUSALS} as its reason, and the result says whether it is
 * transient ({@link GOG_PIN_TRANSIENT_REFUSALS}): a probe that timed out, was
 * killed or could not be spawned, a file that changed while it was being
 * verified, or a check that threw (a read of the binary that failed, say),
 * which the transport tries again after a backoff. Any other refusal stands
 * until the file's identity changes. The check never rejects, and no
 * exception's text, which may hold a path, reaches its result.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { GOG_EXIT_CODES } from "./errors.js";
import type { GogProcessEnd } from "./errors.js";
import { GOG_PINS, gogPlatform, type GogPin, type GogPlatform } from "./pins.js";
import { GOG_SCHEMA_STDOUT_CAP, runGogProcess } from "./runner.js";
import type { GogSchemaSnapshot } from "./commands.js";
import { GOG_SCHEMA_SNAPSHOT } from "./snapshot.js";

export const GOG_PIN_REFUSALS = [
  "platform_not_pinned", "not_absolute", "binary_missing", "not_regular_file", "not_executable", "binary_owner",
  "binary_writable", "directory_owner", "directory_writable", "binary_changed", "hash_not_pinned", "version_failed",
  "version_not_pinned", "version_mismatch", "schema_unreadable", "schema_version", "schema_build", "exit_codes",
  "missing_command", "missing_flag", "flag_type", "missing_positional", "probe_timeout", "probe_signal", "probe_spawn_failed",
  "verification_failed",
] as const;
export type GogPinRefusal = typeof GOG_PIN_REFUSALS[number];

/** Refusals that say nothing lasting about the file: the transport verifies it again after a backoff. */
export const GOG_PIN_TRANSIENT_REFUSALS: readonly GogPinRefusal[] = Object.freeze([
  "binary_changed", "probe_timeout", "probe_signal", "probe_spawn_failed", "verification_failed",
]);

/** One file's identity, as `stat` reports it; nanosecond times and 64-bit numbers as decimal strings. */
export interface GogFileIdentity {
  dev: string;
  ino: string;
  mode: number;
  uid: number;
  gid: number;
}

/** What the transport re-checks before each call: the file the path resolves to, and the directory that holds it. */
export interface GogBinaryIdentity {
  /** The path resolved through every symlink: the file checked, hashed and run. */
  target: string;
  file: GogFileIdentity & { size: string; mtimeNs: string; ctimeNs: string };
  directory: GogFileIdentity;
}

/** `path` is the file the given path resolved to (the one run), or the given path when it resolved to none. */
export type GogPinResult =
  | { ok: true; path: string; version: string; commit: string; platform: GogPlatform; sha256: string; identity: GogBinaryIdentity }
  /** `identity` is what the refusal was about, or null when it came before the file was read. */
  | { ok: false; reason: GogPinRefusal; path: string; transient: boolean; identity: GogBinaryIdentity | null };

export interface GogPinOptions {
  /** The environment gog runs `version` and `schema --json` with: the same allow-list as every call. */
  env: Readonly<Record<string, string>>;
}

/** Internal: what tests vary. Production always uses the committed pins, snapshot and running platform. */
export interface GogPinParameters {
  pins: readonly GogPin[];
  snapshot: GogSchemaSnapshot;
  platform: GogPlatform | null;
  uid: number;
  /** Process limits for `version` and `schema --json`. */
  timeoutMs: number;
}

const productionParameters = (): GogPinParameters => ({
  pins: GOG_PINS,
  snapshot: GOG_SCHEMA_SNAPSHOT,
  platform: gogPlatform(process.platform, process.arch),
  uid: process.getuid?.() ?? -1,
  timeoutMs: 30_000,
});

const ownerOf = (stats: BigIntStats): GogFileIdentity => ({
  dev: String(stats.dev), ino: String(stats.ino), mode: Number(stats.mode), uid: Number(stats.uid), gid: Number(stats.gid),
});
const fileOf = (stats: BigIntStats): GogBinaryIdentity["file"] => ({
  ...ownerOf(stats), size: String(stats.size), mtimeNs: String(stats.mtimeNs), ctimeNs: String(stats.ctimeNs),
});

const sameOwner = (a: GogFileIdentity, b: GogFileIdentity) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
const sameFile = (a: GogBinaryIdentity["file"], b: GogBinaryIdentity["file"]) =>
  sameOwner(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Whether two identities are the same file, at the same resolved path, in the same directory state; two nulls (no file) are the same. */
export const sameGogIdentity = (a: GogBinaryIdentity | null, b: GogBinaryIdentity | null): boolean =>
  a === null || b === null ? a === b : a.target === b.target && sameFile(a.file, b.file) && sameOwner(a.directory, b.directory);

/**
 * The current identity of what `path` names: the file it resolves to through
 * every symlink, and that file's directory. Null when it resolves to nothing
 * or either cannot be read.
 */
export function gogBinaryIdentity(path: string): GogBinaryIdentity | null {
  try {
    const target = realpathSync(path);
    return { target, file: fileOf(statSync(target, { bigint: true })), directory: ownerOf(statSync(dirname(target), { bigint: true })) };
  } catch {
    return null;
  }
}

const WRITABLE_BY_OTHERS = 0o022;

/** Step 2 on one identity: what the file and its directory must be. */
function checkPlace(identity: GogBinaryIdentity, uid: number): GogPinRefusal | null {
  const { file, directory } = identity;
  if ((file.mode & 0o170000) !== 0o100000) return "not_regular_file";
  if ((file.mode & 0o111) === 0) return "not_executable";
  if (file.uid !== 0 && file.uid !== uid) return "binary_owner";
  if (file.mode & WRITABLE_BY_OTHERS) return "binary_writable";
  if (directory.uid !== 0 && directory.uid !== uid) return "directory_owner";
  if (directory.mode & WRITABLE_BY_OTHERS) return "directory_writable";
  return null;
}

/**
 * The sha256 of the file `identity` describes, read through one descriptor;
 * `binary_changed` if the descriptor is not that file or it moved while read.
 * A descriptor that cannot be read throws; the pin check answers that as
 * `verification_failed`. Internal: exported for tests.
 */
export function hashOpen(path: string, identity: GogBinaryIdentity): { sha256: string } | "binary_missing" | "binary_changed" {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "binary_missing";
  }
  try {
    const before = fileOf(fstatSync(fd, { bigint: true }));
    if (!sameFile(before, identity.file)) return "binary_changed";
    const hasher = new Bun.CryptoHasher("sha256");
    const buffer = new Uint8Array(1024 * 1024);
    let read = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hasher.update(buffer.subarray(0, count));
      read += count;
    }
    const after = fileOf(fstatSync(fd, { bigint: true }));
    if (String(read) !== before.size || !sameFile(before, after)) return "binary_changed";
    return { sha256: hasher.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

/** A probe that did not run to an exit says nothing lasting about the binary. */
function interrupted(end: GogProcessEnd): GogPinRefusal | null {
  switch (end.kind) {
    case "timeout": return "probe_timeout";
    case "signal": return "probe_signal";
    case "spawn_failed": return "probe_spawn_failed";
    default: return null;
  }
}

const VERSION_LINE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) \(([0-9a-f]{7,40})(?: [^)\n]*)?\)\n?$/;

interface SchemaNode {
  name?: unknown;
  flags?: unknown;
  positionals?: unknown;
  subcommands?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function typedEntries(list: unknown): Map<string, unknown> | null {
  if (!Array.isArray(list)) return null;
  const out = new Map<string, unknown>();
  for (const item of list) {
    if (!isObject(item) || typeof item.name !== "string") return null;
    out.set(item.name, item.type);
  }
  return out;
}

function child(node: SchemaNode, name: string): SchemaNode | null {
  if (!Array.isArray(node.subcommands)) return null;
  return (node.subcommands.find(item => isObject(item) && item.name === name) as SchemaNode | undefined) ?? null;
}

/** Checks a parsed `gog schema --json` against the snapshot. Null when everything the catalog uses is there with its type. */
export function checkGogSchema(schema: unknown, snapshot: GogSchemaSnapshot, version: string): GogPinRefusal | null {
  if (!isObject(schema) || !isObject(schema.command)) return "schema_unreadable";
  if (schema.schema_version !== snapshot.schema_version) return "schema_version";
  if (typeof schema.build !== "string" || !schema.build.startsWith(`v${version} `)) return "schema_build";
  const automation = isObject(schema.automation) ? schema.automation : {};
  const codes = isObject(automation.exit_codes) ? automation.exit_codes : null;
  const expected: Record<string, number> = snapshot.exit_codes;
  if (!codes || Object.keys(codes).length !== Object.keys(expected).length || Object.entries(expected).some(([name, code]) => codes[name] !== code)) {
    return "exit_codes";
  }
  const root = schema.command as SchemaNode;
  const rootFlags = typedEntries(root.flags);
  if (!rootFlags) return "schema_unreadable";
  for (const [name, type] of Object.entries(snapshot.root_flags)) {
    if (!rootFlags.has(name)) return "missing_flag";
    if (rootFlags.get(name) !== type) return "flag_type";
  }
  for (const spec of Object.values(snapshot.commands)) {
    let node: SchemaNode | null = root;
    for (const name of spec.path) node = node && child(node, name);
    if (!node) return "missing_command";
    const flags = typedEntries(node.flags);
    const positionals = typedEntries(node.positionals ?? []);
    if (!flags || !positionals) return "schema_unreadable";
    for (const [name, type] of Object.entries(spec.flags)) {
      if (!flags.has(name)) return "missing_flag";
      if (flags.get(name) !== type) return "flag_type";
    }
    for (const [name, type] of Object.entries(spec.positionals)) {
      if (positionals.get(name) !== type) return "missing_positional";
    }
  }
  return null;
}

/**
 * The pin check with its parameters given. Internal: tests reach it through this module directly.
 *
 * Never rejects. An exception in any step is `verification_failed`, transient,
 * about the file the check had reached, or the one the path names now when it
 * threw before reading one, so the transport's backoff stands while that file
 * is unchanged. The exception itself is dropped: its text may hold a path.
 */
export async function verifyGogBinaryWith(path: string, options: GogPinOptions, parameters: GogPinParameters): Promise<GogPinResult> {
  let identity: GogBinaryIdentity | null = null;
  const refuse = (reason: GogPinRefusal): GogPinResult =>
    ({ ok: false, reason, path: identity?.target ?? path, transient: GOG_PIN_TRANSIENT_REFUSALS.includes(reason), identity });
  try {
    return await pinSteps(path, options, parameters, refuse, seen => { identity = seen; });
  } catch {
    identity ??= path.startsWith("/") ? gogBinaryIdentity(path) : null;
    return refuse("verification_failed");
  }
}

/** Steps 1 to 5 in order, telling `reached` the identity they check. A step that throws is the caller's to answer. */
async function pinSteps(
  path: string, options: GogPinOptions, parameters: GogPinParameters,
  refuse: (reason: GogPinRefusal) => GogPinResult, reached: (identity: GogBinaryIdentity | null) => void,
): Promise<GogPinResult> {
  const platform = parameters.platform;
  if (!platform || !parameters.pins.some(pin => pin.sha256[platform])) return refuse("platform_not_pinned");
  if (!path.startsWith("/")) return refuse("not_absolute");
  const seen = gogBinaryIdentity(path);
  reached(seen);
  if (!seen) return refuse("binary_missing");
  const real = seen.target;
  const place = checkPlace(seen, parameters.uid);
  if (place) return refuse(place);

  const hashed = hashOpen(real, seen);
  if (typeof hashed === "string") return refuse(hashed);
  const pin = parameters.pins.find(candidate => candidate.sha256[platform] === hashed.sha256);
  if (!pin) return refuse("hash_not_pinned");

  // Only now, with the bytes known, does anything run.
  const limits = { env: options.env, stdin: null, timeoutMs: parameters.timeoutMs };
  const version = await runGogProcess(real, ["version"], { ...limits, stdoutCap: 64 * 1024 });
  const versionInterrupted = interrupted(version.end);
  if (versionInterrupted) return refuse(versionInterrupted);
  if (version.end.kind !== "exit" || version.end.exitCode !== GOG_EXIT_CODES.ok || !version.stdout) return refuse("version_failed");
  const match = VERSION_LINE.exec(new TextDecoder().decode(version.stdout));
  if (!match) return refuse("version_failed");
  const [, reported, commit] = match as unknown as [string, string, string];
  if (reported !== pin.version) {
    return refuse(parameters.pins.some(candidate => candidate.version === reported) ? "version_mismatch" : "version_not_pinned");
  }
  if (!pin.commit.startsWith(commit) && !commit.startsWith(pin.commit)) return refuse("version_mismatch");

  const schemaRun = await runGogProcess(real, ["schema", "--json"], { ...limits, stdoutCap: GOG_SCHEMA_STDOUT_CAP });
  const schemaInterrupted = interrupted(schemaRun.end);
  if (schemaInterrupted) return refuse(schemaInterrupted);
  if (schemaRun.end.kind !== "exit" || schemaRun.end.exitCode !== GOG_EXIT_CODES.ok || !schemaRun.stdout) return refuse("schema_unreadable");
  let schema: unknown;
  try {
    schema = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(schemaRun.stdout));
  } catch {
    return refuse("schema_unreadable");
  }
  const schemaRefusal = checkGogSchema(schema, parameters.snapshot, pin.version);
  if (schemaRefusal) return refuse(schemaRefusal);

  if (!sameGogIdentity(gogBinaryIdentity(path), seen)) return refuse("binary_changed");
  return { ok: true, path: real, version: pin.version, commit: pin.commit, platform, sha256: hashed.sha256, identity: seen };
}

/**
 * Checks a gog binary against the committed pins and schema snapshot on the
 * running platform, as owned by root or this process's user. `path` is
 * resolved through every symlink; the result's `path` is the file that was
 * hashed and is the one the transport executes, for as long as `path` still
 * resolves to it.
 */
export function verifyGogBinary(path: string, options: GogPinOptions): Promise<GogPinResult> {
  return verifyGogBinaryWith(path, options, productionParameters());
}
