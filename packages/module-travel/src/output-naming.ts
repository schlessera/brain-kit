/** Concrete shared naming rules for travel photo and route jobs. */
export interface OutputNamingOptions {
  name?: string;
  date?: string;
}

export type DateSource = "exif" | "flag" | "none";

/** Validate job options before reading sources or creating an output directory. */
export function validateOutputNaming(options: OutputNamingOptions, forceDate = false): { slug?: string; date?: string } {
  if (options.date !== undefined) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(options.date) ? new Date(options.date + "T00:00:00Z") : null;
    if (!date || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.toISOString().slice(0, 10) !== options.date) {
      throw new Error("--date requires a valid calendar date in YYYY-MM-DD form.");
    }
  }
  if (forceDate && options.date === undefined) throw new Error("--force-date requires a valid --date calendar date.");
  if (options.name === undefined) return { date: options.date };
  const slug = options.name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("--name descriptor must contain an ASCII letter, digit, underscore or hyphen after accent folding.");
  return { slug, date: options.date };
}
