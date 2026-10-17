import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./hash.ts";
import { readFontLock, verifyFontCache } from "./fonts.ts";

/** Preparation may download public pinned inputs; generation calls only verifyFontCache. */
export async function prepareFontCache(root: string, cache: string): Promise<void> {
  const { lock } = await readFontLock(root);
  for (const entry of [...lock.assets, ...lock.licenses]) {
    const target = resolve(cache, entry.file);
    let existing: Uint8Array | undefined;
    try { existing = await readFile(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing) {
      if (existing.length !== entry.bytes || sha256(existing) !== entry.sha256) throw new Error(`Pinned font input checksum mismatch: ${entry.file}`);
      continue;
    }
    const response = await fetch(entry.url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Could not prepare ${entry.file}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Downloaded font input checksum mismatch: ${entry.file}`);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.partial`;
    try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
  await verifyFontCache(root, cache);
}
