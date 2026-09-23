import { Database } from "bun:sqlite";
import { createHash } from "crypto";

// Company suffixes to strip during normalization
const COMPANY_SUFFIXES =
  /\s*[,.]?\s*\b(inc\.?|llc|ltd\.?|gmbh|ag|corp\.?|co\.?|limited|s\.?a\.?|b\.?v\.?|plc|pty|se|oy|as|ab|srl|sarl|kft|sp\.?\s*z\.?\s*o\.?\s*o\.?|e\.?\s*v\.?)\s*$/i;

// Known company aliases (canonical -> variations) for cross-source dedup, where
// the same employer posts under slightly different names. Keep this list to
// widely-recognized examples; extend it for the employers you actually track.
const COMPANY_ALIASES: Record<string, string> = {
  meta: "meta",
  "meta platforms": "meta",
  facebook: "meta",
  alphabet: "google",
  google: "google",
  "google llc": "google",
  microsoft: "microsoft",
  "microsoft corporation": "microsoft",
  github: "github",
  "github inc": "github",
  gitlab: "gitlab",
  "gitlab inc": "gitlab",
};

export function normalizeCompany(raw: string): string {
  let s = raw.toLowerCase().trim();
  s = s.replace(COMPANY_SUFFIXES, "");
  s = s.replace(/[^a-z0-9\s]/g, "").trim();

  // Check alias table
  const alias = COMPANY_ALIASES[s];
  if (alias) return alias;

  // Remove all whitespace for final normalization
  return s.replace(/\s+/g, "");
}

export function normalizeTitle(raw: string): string {
  let s = raw.toLowerCase().trim();
  // NOTE: seniority tokens (senior/junior/staff/principal/...) and
  // parenthetical content ("(Frontend)" vs "(Backend)") are deliberately KEPT
  // in the fingerprint — stripping them collapsed distinct roles at the same
  // company into one dedup group, hiding real jobs from the review queue.
  // Strip gender markers
  s = s.replace(/\b(m\/f\/d|m\/w\/d|f\/m\/d|all\s+genders?|d\/f\/m|w\/m\/d)\b/gi, "");
  // Strip trailing location markers like "- Remote" or "| Berlin"
  s = s.replace(/\s*[-|]\s*(remote|worldwide|global|eu|europe|usa|us).*$/i, "");
  // Remove non-alphanumeric
  return s.replace(/[^a-z0-9]/g, "");
}

/**
 * Whether a company names an employer. The adapters' fallback `Unknown` and an
 * empty string do not: they mean "no company on this card".
 */
export function isIdentifiableCompany(raw: string): boolean {
  const companyNorm = normalizeCompany(raw);
  return companyNorm !== "" && companyNorm !== "unknown";
}

export function computeFingerprint(
  company: string,
  title: string,
  identity?: { source: string; sourceId: string }
): string {
  const companyNorm = normalizeCompany(company);
  // Jobs without a real company (adapter fallback "Unknown" or empty string)
  // must never share a cross-source fingerprint — every such posting would
  // collapse into one dedup group. Fall back to source+source_id identity.
  const input =
    !isIdentifiableCompany(company) && identity
      ? `${identity.source}|${identity.sourceId}`
      : companyNorm + "|" + normalizeTitle(title);
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export interface DedupStats {
  checked: number;
  duplicates_found: number;
}

/**
 * Run deduplication on all non-duplicate jobs.
 * For each unique fingerprint, the oldest record (by first_seen_at) becomes canonical;
 * newer records are marked as duplicates pointing to the canonical.
 */
export function runDedup(db: Database, verbose = false): DedupStats {
  const stats: DedupStats = { checked: 0, duplicates_found: 0 };

  // Find fingerprints that appear more than once (excluding already-marked dupes)
  const dupeFingerprints = db
    .query(
      `SELECT fingerprint, COUNT(*) as cnt
       FROM jobs
       WHERE is_duplicate = 0
       GROUP BY fingerprint
       HAVING cnt > 1`
    )
    .all() as Array<{ fingerprint: string; cnt: number }>;

  if (dupeFingerprints.length === 0) return stats;

  const markDupe = db.prepare(
    "UPDATE jobs SET is_duplicate = 1, duplicate_of = ? WHERE id = ?"
  );

  for (const { fingerprint } of dupeFingerprints) {
    // Get all jobs with this fingerprint, ordered by first_seen_at
    const jobs = db
      .query(
        `SELECT id, source, first_seen_at FROM jobs
         WHERE fingerprint = ? AND is_duplicate = 0
         ORDER BY first_seen_at ASC`
      )
      .all(fingerprint) as Array<{ id: number; source: string; first_seen_at: string }>;

    stats.checked += jobs.length;

    if (jobs.length < 2) continue;

    // First one is canonical
    const canonical = jobs[0];
    for (let i = 1; i < jobs.length; i++) {
      markDupe.run(canonical.id, jobs[i].id);
      stats.duplicates_found++;
      if (verbose) {
        console.log(`[dedup] Job #${jobs[i].id} (${jobs[i].source}) -> duplicate of #${canonical.id}`);
      }
    }
  }

  return stats;
}
