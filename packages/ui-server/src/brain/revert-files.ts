/** Raw, descriptor-rooted history restoration. No text decoding or Git operation. */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import type { JournalVersion } from "@schlessera/brain-ui-sdk/protocol";
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
export function reversibleJournalPath(path: string): boolean {
  return !!path && !/[\\\u0000-\u001f\u007f]/u.test(path) && path.split("/").every(part => !!part && ![".", "..", ".git"].includes(part));
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** `copy` reads an already verified, leased CAS object; it writes only the supplied regular descriptor. */
export function restoreJournalPath(brain: string, path: string, expected: JournalVersion | null, desired: JournalVersion | null, copy: (fd: number) => void, beforeCommit?: () => void): "restored" | "conflict" {
  if (process.platform !== "linux" || !reversibleJournalPath(path) || [expected, desired].some(item => item && (item.ignored || item.kind === "other"))) return "conflict";
  const descriptors: number[] = [], parents: { parent: number; name: string; child: number }[] = [];
  let target: number | undefined;
  try {
    const root = openSync(brain, DIRECTORY); descriptors.push(root);
    const parts = path.split("/"), name = parts.pop()!;
    let parent = root;
    for (const part of parts) {
      const child = openSync(at(parent, part), DIRECTORY); descriptors.push(child); parents.push({ parent, name: part, child }); parent = child;
    }
    const anchored = at(parent, name);
    function current(retainWriteDescriptor = false): JournalVersion | null {
      const info = lstatSync(anchored, { throwIfNoEntry: false }); if (!info) return null;
      const mode = info.mode & 0o7777;
      if (info.isSymbolicLink()) return { kind: "symlink", mode, bytes: info.size, target: readlinkSync(anchored), ignored: false };
      if (!info.isFile() || info.nlink !== 1) return { kind: "other", mode, bytes: info.size, ignored: false };
      if (expected?.kind !== "file" || expected.bytes !== info.size || expected.mode !== mode) return { kind: "file", mode, bytes: info.size, hash: "", ignored: false };
      const fd = openSync(anchored, (retainWriteDescriptor ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const initial = fstatSync(fd, { bigint: true });
        if (!initial.isFile() || initial.nlink !== 1n || Number(initial.dev) !== info.dev || Number(initial.ino) !== info.ino) throw new Error("changed_entry");
        const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024); let position = 0;
        for (;;) { const count = readSync(fd, buffer, 0, buffer.length, position); if (!count) break; digest.update(buffer.subarray(0, count)); position += count; }
        const final = fstatSync(fd, { bigint: true });
        if (initial.size !== final.size || initial.mtimeNs !== final.mtimeNs || initial.ctimeNs !== final.ctimeNs) throw new Error("changed_entry");
        if (retainWriteDescriptor) target = fd;
        return { kind: "file", mode, bytes: position, hash: digest.digest("hex"), ignored: false };
      } finally { if (target !== fd) closeSync(fd); }
    }
    // Normalize version field ordering; comparison includes existence, type,
    // raw bytes, literal link target, and permissions.
    const canonical = (entry: JournalVersion | null) => entry ? { kind: entry.kind, mode: entry.mode, bytes: entry.bytes, hash: entry.hash ?? null, target: entry.target ?? null, ignored: entry.ignored } : null;
    if (!same(canonical(current()), canonical(expected))) return "conflict";
    beforeCommit?.();
    const liveRoot = lstatSync(brain), rootInfo = fstatSync(root);
    if (!liveRoot.isDirectory() || liveRoot.dev !== rootInfo.dev || liveRoot.ino !== rootInfo.ino) return "conflict";
    for (const chain of parents) {
      const live = lstatSync(at(chain.parent, chain.name)), opened = fstatSync(chain.child);
      if (!live.isDirectory() || live.dev !== opened.dev || live.ino !== opened.ino) return "conflict";
    }
    if (!same(canonical(current(desired?.kind === "file" && expected?.kind === "file")), canonical(expected))) return "conflict";
    if (!desired) { if (expected) unlinkSync(anchored); fsyncSync(parent); return "restored"; }
    if (desired.kind === "symlink") {
      if (desired.target === undefined) return "conflict";
      if (expected) unlinkSync(anchored);
      symlinkSync(desired.target, anchored); fsyncSync(parent); return "restored";
    }
    if (expected?.kind === "symlink") unlinkSync(anchored);
    target ??= openSync(anchored, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (expected?.kind === "file" ? 0 : constants.O_CREAT | constants.O_EXCL), desired.mode);
    const opened = fstatSync(target), live = lstatSync(anchored);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== live.dev || opened.ino !== live.ino) return "conflict";
    ftruncateSync(target, 0); copy(target); fchmodSync(target, desired.mode); fsyncSync(target); fsyncSync(parent);
    return "restored";
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return "conflict";
    throw error;
  } finally { if (target !== undefined) closeSync(target); for (const descriptor of descriptors.reverse()) closeSync(descriptor); }
}

/** Same sync naming, but raw bytes and exclusive descriptor-rooted creation. */
export function createJournalSibling(brain: string, source: string, desired: JournalVersion, copy: (fd: number) => void,
  prepare: (path: string) => void, occupied: (path: string) => void): string {
  if (process.platform !== "linux" || !reversibleJournalPath(source) || desired.kind !== "file" || desired.ignored || !desired.hash) throw new Error("sibling_version_unavailable");
  const descriptors: number[] = [], parents: {parent:number;name:string;child:number}[] = [];
  let file: number | undefined;
  try {
    const root = openSync(brain, DIRECTORY); descriptors.push(root);
    const parts = source.split("/"), name = parts.pop()!; let parent = root;
    for (const part of parts) { const child = openSync(at(parent,part),DIRECTORY); descriptors.push(child); parents.push({parent,name:part,child}); parent=child; }
    const verify = () => {
      const named = lstatSync(brain), opened = fstatSync(root);
      if (!named.isDirectory() || named.dev !== opened.dev || named.ino !== opened.ino) throw new Error("changed_parent");
      for (const chain of parents) { const named = lstatSync(at(chain.parent,chain.name)), opened = fstatSync(chain.child);
        if (!named.isDirectory() || named.dev !== opened.dev || named.ino !== opened.ino) throw new Error("changed_parent"); }
    };
    const dot = name.toLowerCase().endsWith(".md") ? name.length-3 : name.length, stem=name.slice(0,dot), extension=name.slice(dot);
    for (let number=1;;number++) {
      const candidate=`${stem}-remote${number===1?"":`-${number}`}${extension}`, path=[...parts,candidate].join("/");
      verify(); if (lstatSync(at(parent,candidate),{throwIfNoEntry:false})) continue;
      // Reserve durable operation metadata and journal coverage before effects.
      prepare(path); verify();
      try { file=openSync(at(parent,candidate),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_NONBLOCK,desired.mode); }
      catch(error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") { occupied(path); continue; } throw error; }
      verify(); const opened=fstatSync(file), named=lstatSync(at(parent,candidate));
      if(!opened.isFile()||opened.nlink!==1||opened.dev!==named.dev||opened.ino!==named.ino)throw new Error("changed_entry");
      copy(file); fchmodSync(file,desired.mode); fsyncSync(file); fsyncSync(parent); return path;
    }
  } finally { if(file!==undefined)closeSync(file); for(const descriptor of descriptors.reverse())closeSync(descriptor); }
}
