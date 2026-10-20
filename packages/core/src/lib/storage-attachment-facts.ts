/** Bounded consequence inspection. Git evaluation must run inside the caller's maintenance worker. */
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { extractWikiLinks } from "./indexer/links.js";
import { storageAttachmentPath } from "./storage-attachments.js";

export interface StorageAttachmentFacts {
  fingerprint: string;
  complete: boolean;
  scannedFiles: number;
  unchecked: string[];
  files: { path: string; git: "tracked" | "untracked" | "ignored" | "no-repository" | "unknown"; references: { source: string; hash: string; certainty: "resolved" | "possible" }[]; truncated: boolean }[];
}
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
const volume = (fd: number) => readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").match(/^mnt_id:\s*(\d+)$/m)?.[1];
type Node = { type: string; url?: string; identifier?: string; children?: Node[] };
export function inspectStorageAttachmentFacts(root: string, paths: readonly string[], signal?: AbortSignal): StorageAttachmentFacts {
  if (paths.length < 1 || paths.length > 32 || new Set(paths).size !== paths.length || paths.some(path => !storageAttachmentPath(path))) throw Error("Invalid attachment review selection.");
  const files: StorageAttachmentFacts["files"] = paths.map(path => ({ path, git: "unknown", references: [], truncated: false }));
  const proof: string[] = [], started = Date.now(); let scannedFiles = 0, bytes = 0, entries = 0, complete = true;
  const deadline = () => { signal?.throwIfAborted(); if (Date.now() - started > 10_000) throw Error("Review time bound exceeded."); };
  const git = (...args: string[]) => {
    deadline(); const child = Bun.spawnSync(["git", "-C", root, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 2000, maxBuffer: 1_048_576 });
    return { code: child.exitCode, text: child.stdout.toString(), error: child.stderr.toString() };
  };
  let repository = false;
  try {
    const status = git("rev-parse", "--is-inside-work-tree");
    repository = status.code === 0 && status.text.trim() === "true";
    if (!repository && !/not a git repository/i.test(status.error)) throw Error("Git observation unavailable.");
    for (const file of files) {
      if (!repository) { file.git = "no-repository"; continue; }
      const tracked = git("ls-files", "--error-unmatch", "--", file.path);
      if (tracked.code === 0) { file.git = "tracked"; continue; }
      if (tracked.code !== 1) continue;
      const ignored = git("check-ignore", "--quiet", "--", file.path);
      file.git = ignored.code === 0 ? "ignored" : ignored.code === 1 ? "untracked" : "unknown";
    }
  } catch { complete = false; }
  const tree = unified().use(remarkParse);
  function references(source: string, content: string, hash: string) {
    const ast = tree.parse(content) as Node, definitions = new Map<string, string>(), urls: string[] = [], pending = [ast], refs: string[] = [];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier.toLowerCase(), node.url);
      else if (["link", "image"].includes(node.type) && node.url) urls.push(node.url);
      else if (["linkReference", "imageReference"].includes(node.type) && node.identifier) refs.push(node.identifier.toLowerCase());
      if (node.children) pending.push(...node.children);
    }
    for (const ref of refs) { const url = definitions.get(ref); if (url) urls.push(url); }
    const resolved = new Set<string>();
    for (const url of urls) {
      if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//")) continue;
      try { const path = decodeURIComponent(url.split(/[?#]/)[0]!); resolved.add(path.startsWith("/") ? posix.normalize(path.slice(1)) : posix.normalize(posix.join(posix.dirname(source), path))); }
      catch { complete = false; }
    }
    const wiki = extractWikiLinks(content);
    for (const file of files) {
      const direct = resolved.has(file.path) || wiki.includes(file.path), possible = wiki.some(target => target === posix.basename(file.path));
      if (!direct && !possible) continue;
      if (file.references.length === 200) { file.truncated = true; complete = false; continue; }
      file.references.push({ source, hash, certainty: direct ? "resolved" : "possible" });
    }
  }
  const rootFd = openSync(root, DIRECTORY), rootVolume = volume(rootFd);
  if (!rootVolume) { closeSync(rootFd); throw Error("Review mount identity unavailable."); }
  function walk(directory: number, prefix: string, depth: number) {
    if (depth > 32 || entries > 10_000) { complete = false; return; }
    const names: string[] = [], stream = opendirSync(at(directory, "."));
    try {
      for (;;) {
        deadline(); const entry = stream.readSync(); if (!entry) break;
        if (++entries > 10_000) { complete = false; break; }
        names.push(entry.name);
      }
    } finally { stream.closeSync(); }
    for (const name of names.sort()) {
      deadline();
      if (name.startsWith(".") || ["node_modules", "workspaces"].includes(name)) continue;
      const path = prefix ? `${prefix}/${name}` : name, info = lstatSync(at(directory, name));
      if (info.isDirectory()) {
        let child: number | undefined;
        try { child = openSync(at(directory, name), DIRECTORY); if (volume(child) !== rootVolume) { complete = false; continue; } walk(child, path, depth + 1); }
        catch { complete = false; } finally { if (child !== undefined) closeSync(child); }
      } else if (name.endsWith(".md")) {
        if (!info.isFile() || info.nlink !== 1 || info.size > 512 * 1024 || scannedFiles === 2000 || bytes + info.size > 8 * 1024 * 1024) { complete = false; continue; }
        let fd: number | undefined;
        try {
          fd = openSync(at(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          if (volume(fd) !== rootVolume) { complete = false; continue; }
          const before = fstatSync(fd, { bigint: true }); if (!before.isFile() || before.size !== BigInt(info.size)) { complete = false; continue; }
          const buffer = Buffer.alloc(info.size + 1); let offset = 0;
          while (offset < buffer.length) { deadline(); const length = readSync(fd, buffer, offset, Math.min(64 * 1024, buffer.length - offset), offset); if (!length) break; offset += length; }
          const raw = buffer.subarray(0, offset), after = fstatSync(fd, { bigint: true });
          if (raw.length !== info.size || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) { complete = false; continue; }
          const hash = createHash("sha256").update(raw).digest("hex"); scannedFiles++; bytes += raw.length;
          proof.push(`${path}:${hash}`); references(path, new TextDecoder("utf-8", { fatal: true }).decode(raw), hash);
        } catch { complete = false; } finally { if (fd !== undefined) closeSync(fd); }
      }
    }
  }
  try { walk(rootFd, "", 0); } catch { complete = false; } finally { closeSync(rootFd); }
  signal?.throwIfAborted();
  const unchecked = ["retained conversations", "external consumers", "other workspaces", "hidden content", "symlinked content", "unsupported link syntax"];
  const fingerprint = createHash("sha256").update(JSON.stringify({ files, proof, complete, unchecked })).digest("hex");
  return { fingerprint, complete, scannedFiles, unchecked, files };
}
