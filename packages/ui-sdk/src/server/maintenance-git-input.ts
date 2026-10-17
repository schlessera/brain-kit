/** First-party, bounded installer for one concrete maintenance Git adapter. */
import { constants, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync,
  rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { maintenanceOutputRoot } from "../config/env.js";
export type MaintenanceGitFile = { path: string; data: string; executable: boolean };
export type MaintenanceGitManifest = { relative: string; maximum: number; previous?: { inode: string; digest: string }; files: MaintenanceGitFile[] };
const digest = (files: MaintenanceGitFile[]) => createHash("sha256").update(JSON.stringify(files)).digest("hex");
export const maintenanceGitDigest = digest;
const valid = (path: string) => /^(?:config\.json|empty-config|bin\/git|hooks\/[^/\\\u0000-\u001f\u007f]+)$/.test(path)
  && path.split("/").every(part => part !== "." && part !== "..");
export function captureMaintenanceGitFiles(root: string, maximum: number): MaintenanceGitFile[] {
  for (const directory of [root, join(root, "bin"), join(root, "hooks")]) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700) throw Error("Changed concrete maintenance Git input directory");
  }
  const files: MaintenanceGitFile[] = []; let bytes = 0;
  for (const path of ["config.json", "empty-config", "bin/git", ...readdirSync(join(root, "hooks")).sort().map(name => `hooks/${name}`)]) {
    if (!valid(path)) throw Error("Invalid concrete maintenance Git input");
    const info = lstatSync(join(root, path));
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) throw Error("Changed concrete maintenance Git input");
    bytes += info.size;
    if (bytes > maximum) throw Error("Maintenance Git input exceeds its existing stage allowance");
    const fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd), data = readFileSync(fd);
      const after = fstatSync(fd);
      if (before.dev !== info.dev || before.ino !== info.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
        throw Error("Changed concrete maintenance Git input file");
      files.push({ path, data: data.toString("base64"), executable: path.startsWith("bin/") || path.startsWith("hooks/") });
    } finally { closeSync(fd); }
  }
  return files;
}
if (import.meta.main) {
  try {
    const maximum = Number(process.argv[2]);
    if (!Number.isSafeInteger(maximum) || maximum < 4096) throw Error("Invalid maintenance Git input bound");
    const reader = Bun.stdin.stream().getReader(), chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > maximum) throw Error("Maintenance Git input exceeds its existing stage allowance"); chunks.push(part.value); }
    const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as MaintenanceGitManifest;
    if (manifest.maximum !== maximum || !/^\.brain-maintenance-git-[0-9a-f-]{36}$/.test(manifest.relative)
      || !Array.isArray(manifest.files) || manifest.files.length > 200000) throw Error("Invalid maintenance Git input envelope");
    const root = join(maintenanceOutputRoot()!, manifest.relative), names = new Set<string>(); let bytes = 0;
    for (const file of manifest.files) {
      if (!valid(file.path) || names.has(file.path) || typeof file.data !== "string" || typeof file.executable !== "boolean") throw Error("Invalid maintenance Git input member");
      names.add(file.path); bytes += Buffer.byteLength(file.data, "base64");
      if (bytes > maximum) throw Error("Maintenance Git input exceeds its existing stage allowance");
    }
    if (!["config.json", "empty-config", "bin/git"].every(path => names.has(path))) throw Error("Incomplete maintenance Git input");
    if (manifest.previous) {
      const node = lstatSync(root);
      if (!node.isDirectory() || String(node.ino) !== manifest.previous.inode || node.uid !== process.getuid?.() || (node.mode & 0o7777) !== 0o700
        || digest(captureMaintenanceGitFiles(root, maximum)) !== manifest.previous.digest) throw Error("Changed maintenance Git input owner");
      for (const name of readdirSync(root)) if (!["config.json", "empty-config", "bin", "hooks"].includes(name)) throw Error("Changed maintenance Git input members");
      // Existing directories are checked without following a replacement link.
      for (const name of ["bin", "hooks"]) {
        const info = lstatSync(join(root, name));
        if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700) throw Error("Changed maintenance Git input directory");
      }
      for (const file of captureMaintenanceGitFiles(root, maximum)) rmSync(join(root, file.path));
    } else {
      mkdirSync(root, { mode: 0o700 }); mkdirSync(join(root, "bin"), { mode: 0o700 }); mkdirSync(join(root, "hooks"), { mode: 0o700 });
    }
    for (const file of manifest.files) {
      const fd = openSync(join(root, file.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.executable ? 0o700 : 0o600);
      try { writeFileSync(fd, Buffer.from(file.data, "base64")); if (fstatSync(fd).nlink !== 1) throw Error("Changed maintenance Git input file"); }
      finally { closeSync(fd); }
    }
    const node = lstatSync(root);
    console.log(JSON.stringify({ inode: String(node.ino), digest: digest(manifest.files) }));
  } catch { console.error("Concrete maintenance Git input preparation refused"); process.exitCode = 1; }
}
