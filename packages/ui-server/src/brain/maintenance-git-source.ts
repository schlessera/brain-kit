/**
 * Fixed Git startup-input collection. The collector runs only in the read-only
 * worker view; a directory the worker identity cannot search is withheld and
 * read by its exact owner, the server, through `collectOwnedGitAttributes`.
 */
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
export interface MaintenanceGitSources {
  rootIdentity: string;
  repository: boolean;
  config: [string, string][];
  hookNames: string[];
  attributes: { path: string; data: string }[];
  /** Directories the worker identity cannot search, with the exact metadata it observed. Never entered by the worker. */
  withheld: { path: string; stamp: string }[];
}
const phases = ["metadata", "config", "hooks", "attrs", "receipt", "owner"] as const;
const errorClasses = ["Error", "TypeError", "RangeError", "SyntaxError", "SystemError"] as const;
const errnos = ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP", "ESTALE", "EIO", "EMFILE", "ENFILE", "ENOMEM", "E2BIG"] as const;
const rootClasses = [".brain", "private", "private-hooks", "notes", "other"] as const;
const entryTypes = ["directory", "file", "symlink", "other"] as const;
type AttrContext = { rootClass: string; depth: number; uid: number; gid: number; mode: number; type: string };
const uint = (value: unknown, maximum: number) => Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= maximum;
const unknownFailure = () => ({ phase: "unknown", errorClass: "unknown", errno: "unknown" });
class CollectionFailure extends Error {
  readonly diagnostic;
  constructor(phase: string, error: unknown, attrs?: AttrContext) {
    super("Concrete Git source collection refused");
    const kind = error instanceof Error ? error.name : "unknown", code = (error as NodeJS.ErrnoException | null)?.code;
    this.diagnostic = { phase: phases.includes(phase as any) ? phase : "unknown",
      errorClass: errorClasses.includes(kind as any) ? kind : "unknown", errno: errnos.includes(code as any) ? code! : "unknown", ...((phase === "attrs" || phase === "owner") && attrs ? { attrs } : {}) };
  }
}
/** Decode only the fixed refusal receipt; never forward worker stderr. */
export function parseMaintenanceGitFailure(stderr: string): { phase: string; errorClass: string; errno: string; attrs?: AttrContext } {
  if (Buffer.byteLength(stderr) > 512) return unknownFailure();
  try {
    const lines = stderr.trim().split("\n");
    if (lines.length !== 2 || lines[1] !== "Concrete Git source collection refused") return unknownFailure();
    const value = JSON.parse(lines[0]!);
    if (!value || !["errno,errorClass,phase", "attrs,errno,errorClass,phase"].includes(Object.keys(value).sort().join(","))
      || ![...phases, "unknown"].includes(value.phase) || ![...errorClasses, "unknown"].includes(value.errorClass)
      || ![...errnos, "unknown"].includes(value.errno)) return unknownFailure();
    const attrs = value.attrs;
    if (attrs !== undefined && (value.phase !== "attrs" || !attrs || Object.keys(attrs).sort().join(",") !== "depth,gid,mode,rootClass,type,uid"
      || !rootClasses.includes(attrs.rootClass) || !entryTypes.includes(attrs.type) || !uint(attrs.depth, 257)
      || !uint(attrs.uid, 0xffffffff) || !uint(attrs.gid, 0xffffffff) || !uint(attrs.mode, 0o7777))) return unknownFailure();
    return { phase: value.phase as string, errorClass: value.errorClass as string, errno: value.errno as string,
      ...(attrs ? { attrs: { rootClass: attrs.rootClass as string, depth: attrs.depth as number, uid: attrs.uid as number,
        gid: attrs.gid as number, mode: attrs.mode as number, type: attrs.type as string } } : {}) };
  } catch { return unknownFailure(); }
}
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const identity = (s: ReturnType<typeof fstatSync>) => `${s.dev}:${s.ino}`;
const stamp = (s: ReturnType<typeof fstatSync>) => `${identity(s)}:${s.mode}:${s.nlink}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const STAMP = /^[0-9]+:[0-9]+:[0-9]+:[0-9]+:[0-9]+:[0-9]+(?:\.[0-9]+)?:[0-9]+(?:\.[0-9]+)?$/;
function name(value: string): boolean { return value !== "." && value !== ".." && !!value && !/[\\/\u0000-\u001f\u007f]/u.test(value); }
function utf8(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw Error("Git input is not exact UTF-8");
  return text;
}
/** The caller supplies only the already resolved Git runtime and a numeric bound. */
export async function collectMaintenanceGitSources(binary: string, maximum: number, expectedRoot: string): Promise<MaintenanceGitSources> {
  if (!Number.isSafeInteger(maximum) || maximum < 4096 || !/^[0-9]+:[0-9]+$/.test(expectedRoot)) throw Error("Invalid concrete Git source envelope");
  const root = process.cwd(), fd = openSync(".", DIRECTORY), rootInfo = fstatSync(fd);
  const at = (directory: number, child = "") => `/proc/self/fd/${directory}/${child || "."}`;
  const answer: MaintenanceGitSources = { rootIdentity: identity(rootInfo), repository: false, config: [], hookNames: [], attributes: [], withheld: [] };
  let entries = 0, bytes = 0, phase = "metadata";
  let attrs: AttrContext | undefined;
  const heldMetadata = new Map<number, Stats>([[fd, rootInfo]]);
  const attrContext = (path: string, depth: number, info: Stats) => {
    const first = path.split("/")[0]!;
    attrs = { rootClass: rootClasses.includes(first as any) ? first : "other", depth, uid: info.uid, gid: info.gid,
      mode: info.mode & 0o7777, type: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other" };
  };
  function charge(value: string) { bytes += Buffer.byteLength(value); if (bytes > maximum) throw Error("Concrete Git inputs exceed their bound"); }
  function members(directory: number): string[] {
    return readdirSync(at(directory), { encoding: "buffer" }).map(raw => {
      if (++entries > 200000) throw Error("Concrete Git inputs exceed their entry bound");
      const text = utf8(raw); if (!name(text)) throw Error("Unsupported concrete Git input name"); return text;
    }).sort();
  }
  /** Only permission denial withholds; every other failure still refuses. */
  function searchable(parent: number, child: string): boolean {
    try { accessSync(at(parent, child), constants.R_OK | constants.X_OK); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EACCES") return false; throw error; }
  }
  function directory(parent: number, child: string): number {
    const info = lstatSync(at(parent, child));
    if (!info.isDirectory()) throw Error("Concrete Git directory must not be an alias or special node");
    const opened = openSync(at(parent, child), DIRECTORY), held = fstatSync(opened);
    if (stamp(held) !== stamp(info) || held.dev !== rootInfo.dev) { closeSync(opened); throw Error("Changed concrete Git directory"); }
    heldMetadata.set(opened, held);
    return opened;
  }
  try {
    if (answer.rootIdentity !== expectedRoot) throw Error("Foreign concrete Git startup root");
    let metadata: ReturnType<typeof lstatSync>;
    try { metadata = lstatSync(at(fd, ".git")); } catch (error) { if (absent(error)) return answer; throw error; }
    if (!metadata.isDirectory()) { if (metadata.isSymbolicLink()) throw Error("Aliased Git metadata is unsupported"); return answer; }
    const git = directory(fd, ".git");
    try {
      const config = lstatSync(at(git, "config"), { throwIfNoEntry: false });
      if (!config) return answer;
      if (!config.isFile() || config.nlink !== 1) throw Error("Unsupported Git configuration input");
    } finally { closeSync(git); }
    phase = "config";
    if (!isAbsolute(binary)) throw Error("Maintenance needs its fixed Git binary");
    const child = Bun.spawn([binary, "-c", `safe.directory=${root}`, "config", "--null", "--list", "--includes"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const collect = async (stream: ReadableStream<Uint8Array>, bound: number) => {
      const parts: Uint8Array[] = []; let size = 0;
      for await (const part of stream) { size += part.byteLength; if (size > bound) { child.kill("SIGKILL"); throw Error("Git configuration output exceeds its bound"); } parts.push(part); }
      return Buffer.concat(parts);
    };
    timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const pending = [collect(child.stdout, maximum), collect(child.stderr, Math.min(maximum, 4096)), child.exited] as const;
    try {
      const [stdout, , code] = await Promise.all(pending);
      if (code !== 0) throw Error("Cannot collect retained Git configuration");
      const config = utf8(stdout); charge(config);
      let offset = 0;
      while (offset < config.length) {
        const delimiter = config.indexOf("\0", offset), stop = delimiter < 0 ? config.length : delimiter;
        const record = config.slice(offset, stop); offset = stop + 1;
        if (!record) continue;
        if (answer.config.length >= 200000) throw Error("Git configuration exceeds its entry bound");
        const end = record.indexOf("\n"); answer.config.push(end < 0 ? [record, "true"] : [record.slice(0, end), record.slice(end + 1)]);
      }
    } catch (error) { child.kill("SIGKILL"); await Promise.allSettled(pending); throw error; }
    finally { if (timer) clearTimeout(timer); }
    answer.repository = true;
    phase = "hooks";
    const declared = answer.config.filter(([key]) => key.toLowerCase() === "core.hookspath").at(-1)?.[1];
    const hooks = declared ? resolve(root, declared) : join(root, ".git/hooks");
    if (hooks === root || hooks.startsWith(`${root}/`)) {
      const parts = relative(root, hooks).split("/").filter(Boolean); let current = openSync(at(fd), DIRECTORY);
      try {
        for (const part of parts) { if (!name(part)) throw Error("Unsupported retained hook path"); const next = directory(current, part); closeSync(current); current = next; }
        answer.hookNames = members(current);
        for (const hook of answer.hookNames) {
          const info = lstatSync(at(current, hook));
          if (!info.isFile() || info.nlink !== 1) throw Error("Unsupported retained repository hook");
          // Validate readability under the actual worker identity, without
          // loading or executing a hook during source collection.
          const file = openSync(at(current, hook), FILE); closeSync(file); charge(hook);
        }
      } catch (error) { if (!absent(error)) throw error; }
      finally { closeSync(current); }
    }
    function walk(directoryFd: number, prefix: string, depth: number) {
      if (depth > 256) throw Error("Concrete Git inputs exceed their depth bound");
      attrContext(prefix, depth, heldMetadata.get(directoryFd)!);
      for (const child of members(directoryFd)) {
        if (child === ".git" || child === "node_modules") continue;
        const path = prefix ? `${prefix}/${child}` : child;
        attrContext(prefix, depth, heldMetadata.get(directoryFd)!);
        const info = lstatSync(at(directoryFd, child));
        attrContext(path, depth + 1, info);
        if (child === ".gitattributes") {
          if (!info.isFile() || info.nlink !== 1 || info.size > maximum - bytes) throw Error("Unsupported retained attributes input");
          const file = openSync(at(directoryFd, child), FILE);
          try {
            if (stamp(fstatSync(file)) !== stamp(info)) throw Error("Changed retained attributes input");
            const data = utf8(readFileSync(file));
            if (stamp(fstatSync(file)) !== stamp(info)) throw Error("Changed retained attributes input");
            charge(path); charge(data); answer.attributes.push({ path, data });
          } finally { closeSync(file); }
        } else if (info.isDirectory()) {
          if (info.dev !== rootInfo.dev) throw Error("Concrete Git directory crosses its root device");
          if (!searchable(directoryFd, child)) { charge(path); answer.withheld.push({ path, stamp: stamp(info) }); continue; }
          const nested = directory(directoryFd, child);
          try { walk(nested, path, depth + 1); } finally { closeSync(nested); }
        }
      }
    }
    phase = "attrs";
    walk(fd, "", 0);
    phase = "receipt";
    if (identity(fstatSync(fd)) !== expectedRoot || Buffer.byteLength(JSON.stringify(answer)) > maximum) throw Error("Changed or oversized concrete Git source receipt");
    return answer;
  } catch (error) { throw new CollectionFailure(phase, error, attrs); }
  finally { closeSync(fd); }
}
export function parseMaintenanceGitSources(text: string, maximum: number, expectedRoot: string): MaintenanceGitSources {
  if (Buffer.byteLength(text) > maximum) throw Error("Oversized concrete Git source receipt");
  const value = JSON.parse(text) as MaintenanceGitSources;
  if (!value || value.rootIdentity !== expectedRoot || typeof value.repository !== "boolean" || !Array.isArray(value.config)
    || !Array.isArray(value.hookNames) || !Array.isArray(value.attributes) || !Array.isArray(value.withheld)
    || value.config.length + value.hookNames.length + value.attributes.length + value.withheld.length > 200000
    || value.config.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(item => typeof item !== "string"))
    || value.hookNames.some(hook => typeof hook !== "string" || !name(hook)) || new Set(value.hookNames).size !== value.hookNames.length)
    throw Error("Malformed concrete Git source receipt");
  const paths = new Set<string>();
  for (const attribute of value.attributes) {
    if (!attribute || typeof attribute.path !== "string" || typeof attribute.data !== "string" || paths.has(attribute.path)
      || attribute.path.split("/").length > 257 || attribute.path.split("/").some(part => !name(part)) || !attribute.path.endsWith(".gitattributes")
      || attribute.path.split("/").at(-1) !== ".gitattributes") throw Error("Malformed retained attributes receipt");
    paths.add(attribute.path);
  }
  const withheld = new Set<string>();
  for (const item of value.withheld) {
    if (!item || typeof item !== "object" || Object.keys(item).sort().join(",") !== "path,stamp" || typeof item.path !== "string"
      || typeof item.stamp !== "string" || !STAMP.test(item.stamp) || item.path.split("/").length > 256
      || item.path.split("/").some(part => !name(part) || part === ".git" || part === "node_modules") || withheld.has(item.path))
      throw Error("Malformed withheld Git input receipt");
    withheld.add(item.path);
  }
  // The worker never enters a withheld directory, so nothing it reports can lie below one.
  const below = (path: string) => [...withheld].some(root => path.startsWith(`${root}/`));
  if ([...paths, ...withheld].some(below)) throw Error("Inconsistent withheld Git input receipt");
  if (!value.repository && (value.config.length || value.hookNames.length || value.attributes.length || value.withheld.length)) throw Error("Inconsistent concrete Git source receipt");
  return value;
}
/**
 * The bounded trusted read for withheld directories, run by the server under its
 * own identity. It reads nested `.gitattributes` bytes, and nothing else, below
 * each withheld directory of the retained checkpoint, and only while the server
 * owns every directory and attributes file it opens. The withheld path must still
 * name the exact node the worker observed, reached without aliases on the
 * checkpoint's device. Ownership, identity and the shared bounds are checked
 * here, so the worker receipt cannot select another root, identity or operation.
 */
export function collectOwnedGitAttributes(root: string, sources: MaintenanceGitSources, maximum: number, expectedRoot: string): MaintenanceGitSources {
  const owner = process.geteuid?.();
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY), rootInfo = fstatSync(fd);
  const at = (directory: number, child = "") => `/proc/self/fd/${directory}/${child || "."}`;
  const attributes = [...sources.attributes];
  let entries = 0, bytes = Buffer.byteLength(JSON.stringify(sources));
  let attrs: AttrContext | undefined;
  const attrContext = (path: string, depth: number, info: Stats) => {
    const first = path.split("/")[0]!;
    attrs = { rootClass: rootClasses.includes(first as any) ? first : "other", depth, uid: info.uid, gid: info.gid,
      mode: info.mode & 0o7777, type: info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other" };
  };
  function charge(value: string) { bytes += Buffer.byteLength(value); if (bytes > maximum) throw Error("Owned Git inputs exceed their bound"); }
  // The single identity guard: the server opens only nodes it owns.
  const ownedByServer = (info: Stats) => owner !== undefined && info.uid === owner;
  function directory(parent: number, child: string, owned: boolean): number {
    const info = lstatSync(at(parent, child));
    if (!info.isDirectory() || info.dev !== rootInfo.dev) throw Error("Owned Git directory must not be an alias, special node or another device");
    if (owned && !ownedByServer(info)) throw Error("Owned Git directory has a foreign owner");
    const opened = openSync(at(parent, child), DIRECTORY), held = fstatSync(opened);
    if (stamp(held) !== stamp(info)) { closeSync(opened); throw Error("Changed owned Git directory"); }
    return opened;
  }
  function walk(directoryFd: number, prefix: string, depth: number) {
    if (depth > 256) throw Error("Owned Git inputs exceed their depth bound");
    const names = readdirSync(at(directoryFd), { encoding: "buffer" }).map(raw => {
      if (++entries > 200000) throw Error("Owned Git inputs exceed their entry bound");
      const text = utf8(raw); if (!name(text)) throw Error("Unsupported owned Git input name"); return text;
    }).sort();
    for (const child of names) {
      if (child === ".git" || child === "node_modules") continue;
      const path = `${prefix}/${child}`, info = lstatSync(at(directoryFd, child));
      attrContext(path, depth + 1, info);
      if (child === ".gitattributes") {
        if (!info.isFile() || info.nlink !== 1 || !ownedByServer(info) || info.dev !== rootInfo.dev || info.size > maximum - bytes)
          throw Error("Unsupported owned attributes input");
        const file = openSync(at(directoryFd, child), FILE);
        try {
          if (stamp(fstatSync(file)) !== stamp(info)) throw Error("Changed owned attributes input");
          const data = utf8(readFileSync(file));
          if (stamp(fstatSync(file)) !== stamp(info)) throw Error("Changed owned attributes input");
          charge(path); charge(data); attributes.push({ path, data });
        } finally { closeSync(file); }
      } else if (info.isDirectory()) {
        const nested = directory(directoryFd, child, true);
        try { walk(nested, path, depth + 1); } finally { closeSync(nested); }
      }
    }
  }
  try {
    if (owner === undefined) throw Error("Owned Git inputs need a numeric server identity");
    if (identity(rootInfo) !== expectedRoot || sources.rootIdentity !== expectedRoot) throw Error("Foreign owned Git startup root");
    for (const withheld of sources.withheld) {
      const parts = withheld.path.split("/");
      if (parts.length > 256 || parts.some(part => !name(part))) throw Error("Unsupported withheld Git input path");
      let current = openSync(at(fd), DIRECTORY);
      try {
        // Ancestors are the directories the worker itself searched; only the
        // withheld directory and its descendants need the server as owner.
        for (const part of parts.slice(0, -1)) { const next = directory(current, part, false); closeSync(current); current = next; }
        const info = lstatSync(at(current, parts.at(-1)!));
        attrContext(withheld.path, parts.length, info);
        if (stamp(info) !== withheld.stamp) throw Error("Withheld Git directory changed identity");
        const opened = directory(current, parts.at(-1)!, true);
        closeSync(current); current = opened;
        walk(current, withheld.path, parts.length);
      } finally { closeSync(current); }
    }
    attrs = undefined;
    if (identity(fstatSync(fd)) !== expectedRoot) throw Error("Changed owned Git startup root");
    const answer: MaintenanceGitSources = { ...sources, attributes: attributes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), withheld: [] };
    if (Buffer.byteLength(JSON.stringify(answer)) > maximum) throw Error("Oversized owned Git source receipt");
    return answer;
  } catch (error) { throw new CollectionFailure("owner", error, attrs); }
  finally { closeSync(fd); }
}
/** Report only the fixed owner-read refusal through the caller's logger. */
export function reportOwnedGitFailure(log: import("@opentelemetry/api-logs").Logger | undefined, error: unknown): void {
  const failure: { phase: string; errorClass: string; errno: string; attrs?: AttrContext } = error instanceof CollectionFailure ? error.diagnostic : unknownFailure();
  log?.emit({ severityText: "WARN", body: "maintenance Git owner input refused", attributes: {
    "maintenance.git.phase": failure.phase, "maintenance.git.errorClass": failure.errorClass, "maintenance.git.errno": failure.errno,
    ...(failure.attrs ? { "maintenance.git.rootClass": failure.attrs.rootClass, "maintenance.git.depth": failure.attrs.depth,
      "maintenance.git.uid": failure.attrs.uid, "maintenance.git.gid": failure.attrs.gid, "maintenance.git.mode": failure.attrs.mode,
      "maintenance.git.type": failure.attrs.type } : {}),
  } });
}
/** Report only the bounded fixed collector receipt through the caller's logger. */
export function reportMaintenanceGitFailure(log: import("@opentelemetry/api-logs").Logger | undefined,
  result: { exitCode: number; killed?: boolean; stderr: string }): void {
  const failure = parseMaintenanceGitFailure(result.stderr);
  const exitCode = Number.isInteger(result.exitCode) && result.exitCode >= -255 && result.exitCode <= 255 ? result.exitCode : -256;
  log?.emit({ severityText: "WARN", body: "maintenance Git source collection refused", attributes: {
    "maintenance.git.exitCode": exitCode, "maintenance.git.killed": result.killed === true,
    "maintenance.git.phase": failure.phase, "maintenance.git.errorClass": failure.errorClass, "maintenance.git.errno": failure.errno,
    ...(failure.attrs ? { "maintenance.git.rootClass": failure.attrs.rootClass, "maintenance.git.depth": failure.attrs.depth,
      "maintenance.git.uid": failure.attrs.uid, "maintenance.git.gid": failure.attrs.gid, "maintenance.git.mode": failure.attrs.mode,
      "maintenance.git.type": failure.attrs.type } : {}),
  } });
}
if (import.meta.main) {
  try { process.stdout.write(JSON.stringify(await collectMaintenanceGitSources(process.argv[2]!, Number(process.argv[3]), process.argv[4]!)) + "\n"); }
  catch (error) { process.stderr.write(JSON.stringify(error instanceof CollectionFailure ? error.diagnostic : unknownFailure()) + "\nConcrete Git source collection refused\n"); process.exitCode = 1; }
}
