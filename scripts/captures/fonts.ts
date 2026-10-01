import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sha256 } from "./provenance.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const localFile = z.string().regex(/^(?:fonts\/[0-9]+\.ttf|licenses\/[a-z]+\.txt)$/);
const asset = z.object({
  url: z.string().url(), file: localFile, sha256: digest,
  bytes: z.number().int().positive(), content_type: z.enum(["font/ttf", "text/plain"]),
}).strict();
const schema = z.object({
  preview_stylesheet_url: z.string().url(),
  stylesheet: z.object({ file: z.literal("scripts/captures/fonts.css"), sha256: digest }).strict(),
  assets: z.array(asset).min(1), licenses: z.array(asset).min(1),
}).strict();

export type FontLock = z.infer<typeof schema>;

export async function readFontLock(root: string): Promise<{ lock: FontLock; hash: string; css: Uint8Array }> {
  const bytes = await readFile(resolve(root, "scripts/captures/font-lock.json"));
  const lock = schema.parse(JSON.parse(bytes.toString("utf8")));
  const css = await readFile(resolve(root, lock.stylesheet.file));
  if (sha256(css) !== lock.stylesheet.sha256) throw new Error("Pinned font CSS checksum mismatch");
  const head = await readFile(resolve(root, "packages/ui-kit/.storybook/preview-head.html"), "utf8");
  const previewUrls = [...head.matchAll(/href="(https:\/\/fonts\.googleapis\.com\/css2[^\"]*)"/g)].map((match) => match[1]);
  if (previewUrls.length !== 1 || previewUrls[0] !== lock.preview_stylesheet_url) {
    throw new Error("Preview font source changed; resolve and review the font lock before capture");
  }
  const cssUrls = new Set([...css.toString().matchAll(/url\((https:[^)]+)\)/g)].map((match) => match[1]));
  if (cssUrls.size !== lock.assets.length || lock.assets.some((entry) => !cssUrls.has(entry.url))) {
    throw new Error("Pinned font CSS and asset list differ");
  }
  for (const entry of lock.assets) {
    if (!/^https:\/\/fonts\.gstatic\.com\/s\/[a-z]+\/v[0-9]+\/[^/]+\.ttf$/.test(entry.url) || entry.content_type !== "font/ttf") {
      throw new Error(`Unexpected font asset source: ${entry.file}`);
    }
  }
  for (const entry of lock.licenses) {
    if (!/^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/[a-f0-9]{40}\/ofl\/[a-z]+\/OFL\.txt$/.test(entry.url) || entry.content_type !== "text/plain") {
      throw new Error(`Unpinned upstream font notice: ${entry.file}`);
    }
  }
  return { lock, hash: sha256(bytes), css };
}

export async function verifyFontCache(root: string, cache: string): Promise<{
  lock: FontLock; hash: string; css: Uint8Array; files: Map<string, Uint8Array>;
}> {
  const result = await readFontLock(root);
  const files = new Map<string, Uint8Array>();
  for (const entry of [...result.lock.assets, ...result.lock.licenses]) {
    let bytes: Uint8Array;
    try { bytes = await readFile(resolve(cache, entry.file)); }
    catch { throw new Error(`Pinned font input missing: ${entry.file}; run capture:fonts with this cache`); }
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`Pinned font input checksum mismatch: ${entry.file}`);
    }
    files.set(entry.url, bytes);
  }
  return { ...result, files };
}

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
