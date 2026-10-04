import { randomBytes } from "crypto";
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "fs";
import type { Stats } from "fs";
import { basename, extname, join, relative, resolve, sep } from "path";
import { safeResolve } from "@schlessera/brain";
import sharp from "sharp";
import * as exifr from "exifr";
import { validateOutputNaming } from "./output-naming.js";
import type { DateSource, OutputNamingOptions } from "./output-naming.js";

export interface PhotoResult {
  source: string; output: string; width: number; height: number; bytes: number;
  captured_at: string | null; location: { lat: number; lon: number } | null;
  date_source: DateSource;
}
export interface PhotoReport { files: PhotoResult[]; errors: { source: string; message: string }[] }

/** The private writer receives a canonical contained directory from photoDirectory. */
export function writePhotoCopy(directory: string, name: string, bytes: Uint8Array): string {
  const identity = lstatSync(directory);
  assertDirectory(directory, identity);
  const temporary = join(directory, ".travel-photo-" + randomBytes(12).toString("hex") + ".tmp");
  let created = false;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    created = true;
    try { writeFileSync(fd, bytes); }
    finally { closeSync(fd); }
    // link, unlike rename, atomically refuses every existing destination entry.
    // The completed sibling supplies the bytes; no reader sees a partial JPEG.
    for (let suffix = 1; ; suffix++) {
      assertDirectory(directory, identity);
      const output = join(directory, name + (suffix === 1 ? "" : "-" + suffix) + ".jpg");
      const entry = lstatSync(output, { throwIfNoEntry: false });
      if (entry?.isSymbolicLink()) throw new Error("Photo output is a symlink; refusing to write " + output);
      if (entry) continue;
      try { linkSync(temporary, output); return output; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (lstatSync(output, { throwIfNoEntry: false })?.isSymbolicLink()) {
          throw new Error("Photo output became a symlink; refusing to write " + output);
        }
      }
    }
  } finally {
    if (created && sameDirectory(directory, identity)) {
      try { unlinkSync(temporary); }
      catch {
        // Preserve the completed publication or the original processing error.
        // An I/O error during cleanup may leave a hidden temporary sibling.
      }
    }
  }
}

function sameDirectory(directory: string, original: Stats): boolean {
  try {
    const now = lstatSync(directory);
    return now.isDirectory() && !now.isSymbolicLink() && realpathSync(directory) === directory
      && now.dev === original.dev && now.ino === original.ino;
  } catch { return false; }
}
function assertDirectory(directory: string, original: Stats): void {
  if (!sameDirectory(directory, original)) throw new Error("Photo output directory changed or is a symlink; refusing to write");
}

export function photoDirectory(root: string, to: string): string {
  const directory = safeResolve(root, to);
  if (!directory) throw new Error("Photo output must stay inside the brain root");
  if (directory !== resolve(realpathSync(root), to)) throw new Error("Photo output directory uses a symlink; refusing to write");
  mkdirSync(directory, { recursive: true });
  assertDirectory(directory, lstatSync(directory));
  return directory;
}

const CAPTURE_OPTIONS = {
  reviveValues: false, translateValues: false,
  pick: ["DateTimeOriginal", "SubSecTimeOriginal", "OffsetTimeOriginal", "GPSLatitude", "GPSLatitudeRef", "GPSLongitude", "GPSLongitudeRef"],
};
const PHOTO_FORMATS = new Set(["jpeg", "png", "webp", "tiff", "gif", "heif", "jp2", "jxl"]);

function captureTime(tags: Record<string, unknown>): string | null {
  const raw = tags.DateTimeOriginal;
  if (typeof raw !== "string" || !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return null;
  const local = raw.replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3T");
  const calendar = new Date(local + "Z");
  if (!Number.isFinite(calendar.getTime()) || calendar.getUTCFullYear() < 1 || calendar.toISOString().slice(0, 19) !== local) return null;
  // EXIF records local camera time. Retain only a written offset; never use
  // the CLI process timezone to invent or shift the capture instant.
  const fraction = typeof tags.SubSecTimeOriginal === "string" && /^\d+$/.test(tags.SubSecTimeOriginal)
    ? "." + tags.SubSecTimeOriginal : "";
  const offset = typeof tags.OffsetTimeOriginal === "string" && /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(tags.OffsetTimeOriginal)
    ? tags.OffsetTimeOriginal : "";
  return local + fraction + offset;
}

async function capture(exif: Buffer | undefined): Promise<Pick<PhotoResult, "captured_at" | "location">> {
  if (!exif) return { captured_at: null, location: null };
  // Sharp exposes the original EXIF block for every supported container.
  // Parse TIFF bytes rather than asking exifr to support each image container.
  const tiff = exif.subarray(0, 6).equals(Buffer.from("Exif\0\0")) ? exif.subarray(6) : exif;
  const tags: Record<string, unknown> | undefined = await exifr.parse(tiff, CAPTURE_OPTIONS);
  if (!tags) return { captured_at: null, location: null };
  const lat = tags.latitude, lon = tags.longitude;
  const location = typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90
    && typeof lon === "number" && Number.isFinite(lon) && Math.abs(lon) <= 180 ? { lat, lon } : null;
  return { captured_at: captureTime(tags), location };
}

export async function preparePhotos(root: string, sources: string[], to: string, options: OutputNamingOptions & { forceDate?: boolean } = {}): Promise<PhotoReport> {
  const naming = validateOutputNaming(options, options.forceDate);
  const files: PhotoResult[] = [], errors: PhotoReport["errors"] = [];
  const directory = photoDirectory(root, to);
  for (const source of sources) {
    try {
      const input = resolve(root, source);
      if (!statSync(input).isFile()) throw new Error("Photo source is not a file");
      const bytes = readFileSync(input), image = sharp(bytes, { failOn: "error" });
      const metadata = await image.metadata();
      if (!PHOTO_FORMATS.has(metadata.format)) throw new Error("Photo requires a supported raster image");
      if ((metadata.pages ?? 1) > 1) throw new Error("Animated or multi-page images are not photos; no copy written");
      const provenance = await capture(metadata.exif);
      // Auto-orient actual pixels, flatten transparency on white, and encode
      // a fresh sRGB JPEG. Sharp's default output drops input metadata.
      const encoded = await image.autoOrient()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" }).toColourspace("srgb")
        .jpeg({ quality: 80, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      // captureTime already validates camera text. Its calendar day is not
      // an instant to convert through UTC or the CLI process timezone.
      const exifDate = provenance.captured_at?.slice(0, 10);
      const date = !options.forceDate && exifDate ? exifDate : naming.date;
      const dateSource: DateSource = naming.slug === undefined ? "none" :
        !options.forceDate && exifDate ? "exif" : naming.date ? "flag" : "none";
      const name = naming.slug === undefined ? basename(input, extname(input)) : `${date ?? "undated"}-${naming.slug}`;
      if (/[\u0000-\u001f\u007f\\]/.test(name)) throw new Error("Source name cannot create a portable photo filename");
      const output = writePhotoCopy(directory, name, encoded.data);
      files.push({
        source, output: relative(realpathSync(root), output).split(sep).join("/"),
        width: encoded.info.width, height: encoded.info.height, bytes: encoded.data.length, ...provenance,
        date_source: dateSource,
      });
    } catch (error) { errors.push({ source, message: (error as Error).message }); }
  }
  return { files, errors };
}
