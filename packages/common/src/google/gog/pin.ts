/**
 * The pin check (plan §8, "An exact pin"): before the transport runs a gog
 * binary for the first time it checks, in this order and without executing
 * anything until the hash matches,
 *
 * 1. that the platform has a pinned release binary;
 * 2. the binary and its directory: absolute, a regular executable file,
 *    owned by root or the host user and writable by no one else;
 * 3. the sha256 of the bytes read from one open descriptor, against the pin
 *    list, with the file's identity unchanged while it was read;
 * 4. `gog version`: exactly the pinned version and commit;
 * 5. `gog schema --json`: schema version, build, exit codes, and every
 *    command path, flag and positional of the snapshot, with its type.
 *
 * The identity (device, inode, size, mtime) the hash was taken over is what
 * the transport re-checks before each call. Every failure is
 * `transport_incompatible` with one of {@link GOG_PIN_REFUSALS} as its reason.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { GOG_EXIT_CODES } from "./errors.js";
import { GOG_PINS, gogPlatform, type GogPin, type GogPlatform } from "./pins.js";
import { runGogProcess } from "./runner.js";
import type { GogSchemaSnapshot } from "./commands.js";
import { GOG_SCHEMA_SNAPSHOT } from "./snapshot.js";

export const GOG_PIN_REFUSALS = [
  "platform_not_pinned", "not_absolute", "binary_missing", "not_regular_file", "not_executable", "binary_owner",
  "binary_writable", "directory_owner", "directory_writable", "binary_changed", "hash_not_pinned", "version_failed",
  "version_not_pinned", "version_mismatch", "schema_unreadable", "schema_version", "schema_build", "exit_codes",
  "missing_command", "missing_flag", "flag_type", "missing_positional",
] as const;
export type GogPinRefusal = typeof GOG_PIN_REFUSALS[number];

/** What the transport re-checks before each call. */
export interface GogBinaryIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export type GogPinResult =
  | { ok: true; path: string; version: string; commit: string; platform: GogPlatform; sha256: string; identity: GogBinaryIdentity }
  | { ok: false; reason: GogPinRefusal; path: string };

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

const identityOf = (stats: Stats): GogBinaryIdentity => ({ dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs });

export const sameGogIdentity = (a: GogBinaryIdentity, b: GogBinaryIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** The current identity of a file, or null when it cannot be read. */
export function gogBinaryIdentity(path: string): GogBinaryIdentity | null {
  try {
    return identityOf(statSync(path));
  } catch {
    return null;
  }
}

const WRITABLE_BY_OTHERS = 0o022;

function hashOpen(path: string): { sha256: string; identity: GogBinaryIdentity } | "binary_missing" | "binary_changed" {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "binary_missing";
  }
  try {
    const before = identityOf(fstatSync(fd));
    const hasher = new Bun.CryptoHasher("sha256");
    const buffer = new Uint8Array(1024 * 1024);
    let read = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hasher.update(buffer.subarray(0, count));
      read += count;
    }
    const after = identityOf(fstatSync(fd));
    if (read !== before.size || !sameGogIdentity(before, after)) return "binary_changed";
    return { sha256: hasher.digest("hex"), identity: before };
  } finally {
    closeSync(fd);
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

function checkPlace(path: string, uid: number): GogPinRefusal | null {
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch {
    return "binary_missing";
  }
  if (!stats.isFile()) return "not_regular_file";
  if ((stats.mode & 0o111) === 0) return "not_executable";
  if (stats.uid !== 0 && stats.uid !== uid) return "binary_owner";
  if (stats.mode & WRITABLE_BY_OTHERS) return "binary_writable";
  let directory: Stats;
  try {
    directory = statSync(dirname(path));
  } catch {
    return "binary_missing";
  }
  if (directory.uid !== 0 && directory.uid !== uid) return "directory_owner";
  if (directory.mode & WRITABLE_BY_OTHERS) return "directory_writable";
  return null;
}

/** The pin check with its parameters given. Internal: tests reach it through this module directly. */
export async function verifyGogBinaryWith(path: string, options: GogPinOptions, parameters: GogPinParameters): Promise<GogPinResult> {
  const refuse = (reason: GogPinRefusal): GogPinResult => ({ ok: false, reason, path });
  const platform = parameters.platform;
  if (!platform || !parameters.pins.some(pin => pin.sha256[platform])) return refuse("platform_not_pinned");
  if (!path.startsWith("/")) return refuse("not_absolute");
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return refuse("binary_missing");
  }
  const place = checkPlace(real, parameters.uid);
  if (place) return refuse(place);

  const hashed = hashOpen(real);
  if (typeof hashed === "string") return refuse(hashed);
  const pin = parameters.pins.find(candidate => candidate.sha256[platform] === hashed.sha256);
  if (!pin) return refuse("hash_not_pinned");

  // Only now, with the bytes known, does anything run.
  const limits = { env: options.env, stdin: null, timeoutMs: parameters.timeoutMs };
  const version = await runGogProcess(real, ["version"], { ...limits, stdoutCap: 64 * 1024 });
  if (version.end.kind !== "exit" || version.end.exitCode !== GOG_EXIT_CODES.ok || !version.stdout) return refuse("version_failed");
  const match = VERSION_LINE.exec(new TextDecoder().decode(version.stdout));
  if (!match) return refuse("version_failed");
  const [, reported, commit] = match as unknown as [string, string, string];
  if (reported !== pin.version) {
    return refuse(parameters.pins.some(candidate => candidate.version === reported) ? "version_mismatch" : "version_not_pinned");
  }
  if (!pin.commit.startsWith(commit) && !commit.startsWith(pin.commit)) return refuse("version_mismatch");

  const schemaRun = await runGogProcess(real, ["schema", "--json"], { ...limits, stdoutCap: 32 * 1024 * 1024 });
  if (schemaRun.end.kind !== "exit" || schemaRun.end.exitCode !== GOG_EXIT_CODES.ok || !schemaRun.stdout) return refuse("schema_unreadable");
  let schema: unknown;
  try {
    schema = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(schemaRun.stdout));
  } catch {
    return refuse("schema_unreadable");
  }
  const schemaRefusal = checkGogSchema(schema, parameters.snapshot, pin.version);
  if (schemaRefusal) return refuse(schemaRefusal);

  const now = gogBinaryIdentity(real);
  if (!now || !sameGogIdentity(now, hashed.identity)) return refuse("binary_changed");
  return { ok: true, path: real, version: pin.version, commit: pin.commit, platform, sha256: hashed.sha256, identity: hashed.identity };
}

/**
 * Checks a gog binary against the committed pins and schema snapshot on the
 * running platform, as owned by root or this process's user. `path` is
 * resolved once; the result's `path` is the file that was hashed and is the
 * one the transport executes.
 */
export function verifyGogBinary(path: string, options: GogPinOptions): Promise<GogPinResult> {
  return verifyGogBinaryWith(path, options, productionParameters());
}
