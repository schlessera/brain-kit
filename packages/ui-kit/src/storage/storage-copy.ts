/**
 * The storage breakdown's fixed copy (#4544 design brief, Q2–Q5).
 *
 * Pure strings from plain inputs: a reason code, a count, a facet. None of
 * these is a ui-sdk wire type; a reason is the string the caller already has.
 * Sizes stay pre-formatted by the caller. Unit tested in
 * `tests/storage-copy.test.ts`.
 *
 * Two rules from the epic run through every function here: an unknown is a
 * mark ("?", "not measured"), never 0 and never "no links"; and the wording
 * is "available", never "free" (D5).
 */

/**
 * The short reason an unknown row prints, by `StorageRoot.reason` (and
 * `errors[].reason`). An unrecognised or missing reason reads "not measured".
 */
export function storageUnknownReason(reason: string | null | undefined): string {
  switch (reason) {
    case "metadata-unavailable":
      return "couldn't read file details";
    case "unsupported-platform":
      return "not measured on this system";
    case "cancelled":
      return "scan was cancelled · scan again";
    case "root-budget":
      return "too many stores to measure in one scan";
    case "partial":
      return STORAGE_PARTIAL_REASON;
    default:
      return "not measured";
  }
}

/** A partial-coverage row: its size is a lower bound, shown as `≥ 4.2 GB`. */
export const STORAGE_PARTIAL_REASON = "size so far · scan stopped early";

/** The legend's unknown chip, after its `?` mark. */
export function unknownStoresCopy(count: number): string {
  return `${count} ${count === 1 ? "store" : "stores"} · size unknown · not drawn`;
}

export type StorageGitFacet = "tracked" | "untracked" | "unknown";

export function gitFacetCopy(facet: StorageGitFacet): string {
  return facet === "tracked" ? "in Git" : facet === "untracked" ? "not in Git" : "? Git unknown";
}

/** Known link evidence by count; `null` is unknown, which never reads as "no links". */
export function linksCopy(count: number | null): string {
  if (count === null || !Number.isFinite(count) || count < 0) return "? links unknown";
  if (count === 0) return "no links";
  return count === 1 ? "1 link" : `${count} links`;
}

export type StorageEligibility = "can-remove" | "check" | "kept" | "cant-tell";

export const ELIGIBILITY_WORD: Record<StorageEligibility, string> = {
  "can-remove": "Can remove",
  check: "Check",
  kept: "Kept",
  "cant-tell": "Can't tell",
};

/** `✓ Can remove`, `⚠ Check · {why}`, `⊘ Kept · {why}`, `? Can't tell · {why}` — the word half. */
export function eligibilityCopy(eligibility: StorageEligibility, why?: string): string {
  const word = ELIGIBILITY_WORD[eligibility];
  return why ? `${word} · ${why}` : word;
}

/** `{n} selected · {size} {basis}`, plus `+ ? unknown` when any selected size is unknown. */
export function selectionCopy(count: number, size: string, basis: string, unknown = false): string {
  return `${count} selected · ${size} ${basis}${unknown ? " + ? unknown" : ""}`;
}

/** A row's size as it prints: the figure, `≥ figure` for a lower bound, or `? not measured`. */
export function rowSizeCopy(size: string | null, atLeast = false): string {
  if (size === null) return "? not measured";
  return atLeast ? `≥ ${size}` : size;
}

/** The same size as a screen reader says it. */
export function rowSizeSpoken(size: string | null, atLeast = false): string {
  if (size === null) return "size not measured";
  return atLeast ? `at least ${size}` : size;
}
