import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { ATTACHMENT_DIR, ATTACHMENT_MAX_FILE_BYTES } from "@schlessera/brain-ui-sdk/protocol";
import { safeResolve } from "../files/walker.js";
import { detectKind } from "./detect.js";
import { FILE_ID, type AttachmentRow, type NewAttachment } from "./store.js";

/**
 * The filesystem half of composer originals (#3153). The originals live at
 * `.brain-ui/attachments/<fileId>/<name>` inside the brain, so both backends'
 * file tools can open the stable reference with no new mount. Every host read
 * re-checks the recorded size and SHA-256 and never follows a link.
 */

/** Absolute attachment root, created when absent. Refuses a root that is a link. */
export async function attachmentRoot(brainRoot: string): Promise<string> {
  const root = await safeResolve(ATTACHMENT_DIR, brainRoot);
  await mkdir(root, { recursive: true, mode: 0o755 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The attachment root is not a plain directory.");
  if (await realpath(root) !== root) throw new Error("The attachment root must not traverse a symlink.");
  return root;
}

type VerifiedRead = { ok: true; bytes: Uint8Array } | { ok: false; reason: "missing" | "changed" };

/**
 * Read one recorded original, verified against its record: a regular file
 * under the root reached through no link, of the recorded size and digest.
 * An altered original is `changed`; nothing of it is returned.
 */
export async function readVerified(brainRoot: string, row: Pick<AttachmentRow, "file_id" | "stored_name" | "bytes" | "sha256">): Promise<VerifiedRead> {
  if (!FILE_ID.test(row.file_id) || row.stored_name.includes("/") || row.stored_name.startsWith(".")) return { ok: false, reason: "changed" };
  let root: string;
  try { root = await attachmentRoot(brainRoot); } catch { return { ok: false, reason: "missing" }; }
  const dir = join(root, row.file_id);
  const abs = join(dir, row.stored_name);
  let file;
  try {
    const dirInfo = await lstat(dir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) return { ok: false, reason: "changed" };
    if (await realpath(abs) !== abs) return { ok: false, reason: "changed" };
    file = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "missing" : "changed" };
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== row.bytes || stat.size > ATTACHMENT_MAX_FILE_BYTES) return { ok: false, reason: "changed" };
    // One byte more than recorded proves growth after stat.
    const buffer = Buffer.alloc(row.bytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== row.bytes) return { ok: false, reason: "changed" };
    const bytes = buffer.subarray(0, size);
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) return { ok: false, reason: "changed" };
    return { ok: true, bytes: new Uint8Array(bytes) };
  } finally { await file.close(); }
}

/**
 * Sweep step 2's filesystem half: unlink one marked file's directory, after
 * checking it is a plain directory directly under the root. `rm` removes the
 * directory's entries without following links.
 */
export async function unlinkAttachment(brainRoot: string, fileId: string): Promise<void> {
  if (!FILE_ID.test(fileId)) throw new Error("Invalid attachment id");
  const root = await attachmentRoot(brainRoot);
  const dir = join(root, fileId);
  let info;
  try { info = await lstat(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("An attachment directory is not a plain directory.");
  if (await realpath(dir) !== dir || !dir.startsWith(root + "/")) throw new Error("An attachment directory left the root.");
  await rm(dir, { recursive: true, force: true });
}

/** The published directories under the root, and the partials a crash left. */
export async function listAttachmentDirs(brainRoot: string): Promise<{ published: string[]; partials: string[] }> {
  const root = await attachmentRoot(brainRoot);
  const published: string[] = [];
  const partials: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const partial = /^\.([a-f0-9-]{36})\.partial$/.exec(entry.name);
    if (partial && FILE_ID.test(partial[1]!)) partials.push(entry.name);
    else if (FILE_ID.test(entry.name)) published.push(entry.name);
  }
  return { published, partials };
}

/** Describe a published directory with no record so it can be adopted and charged. */
export async function describeOrphan(brainRoot: string, fileId: string): Promise<NewAttachment | null> {
  const root = await attachmentRoot(brainRoot);
  const dir = join(root, fileId);
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile());
  if (entries.length !== 1) return null;
  const name = entries[0]!.name;
  const stat = await lstat(join(dir, name));
  if (!stat.isFile() || stat.size === 0 || stat.size > ATTACHMENT_MAX_FILE_BYTES) return null;
  const file = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try { bytes = await file.readFile(); } finally { await file.close(); }
  const path = `${ATTACHMENT_DIR}/${fileId}/${name}`;
  const detected = detectKind(bytes, { name, mediaType: "application/octet-stream", path });
  return {
    fileId, storedName: name, incomingName: null, bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mediaType: detected.mediaType ?? "application/octet-stream", kind: detected.kind, reader: detected.reader,
    trackRejected: false, track: null,
  };
}

export async function removePartial(brainRoot: string, name: string): Promise<void> {
  if (!/^\.[a-f0-9-]{36}\.partial$/.test(name)) return;
  const root = await attachmentRoot(brainRoot);
  await rm(join(root, name), { recursive: true, force: true });
}
