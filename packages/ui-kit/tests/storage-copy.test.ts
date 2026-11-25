import { describe, expect, test } from "bun:test";
import {
  STORAGE_PARTIAL_REASON,
  eligibilityCopy,
  gitFacetCopy,
  linksCopy,
  rowSizeCopy,
  rowSizeSpoken,
  selectionCopy,
  storageUnknownReason,
  unknownStoresCopy,
} from "../src/storage/storage-copy.js";

describe("storage breakdown copy (#4544 Q2–Q5)", () => {
  test("each StorageRoot reason has its short copy; anything else reads 'not measured'", () => {
    expect(storageUnknownReason("metadata-unavailable")).toBe("couldn't read file details");
    expect(storageUnknownReason("unsupported-platform")).toBe("not measured on this system");
    expect(storageUnknownReason("cancelled")).toBe("scan was cancelled · scan again");
    expect(storageUnknownReason("root-budget")).toBe("too many stores to measure in one scan");
    expect(storageUnknownReason("partial")).toBe(STORAGE_PARTIAL_REASON);
    expect(STORAGE_PARTIAL_REASON).toBe("size so far · scan stopped early");
    for (const other of [null, undefined, "", "EACCES", "something-new"]) expect(storageUnknownReason(other)).toBe("not measured");
  });

  test("the legend's unknown chip counts stores, singular and plural", () => {
    expect(unknownStoresCopy(1)).toBe("1 store · size unknown · not drawn");
    expect(unknownStoresCopy(2)).toBe("2 stores · size unknown · not drawn");
  });

  test("an unknown is a mark, never zero and never 'no links'", () => {
    expect(rowSizeCopy(null)).toBe("? not measured");
    expect(rowSizeCopy(null, true)).toBe("? not measured");
    expect(rowSizeCopy("4.2 GB", true)).toBe("≥ 4.2 GB");
    expect(rowSizeCopy("9.8 GB")).toBe("9.8 GB");
    expect(rowSizeSpoken(null)).toBe("size not measured");
    expect(rowSizeSpoken("4.2 GB", true)).toBe("at least 4.2 GB");
    expect(linksCopy(null)).toBe("? links unknown");
    expect(linksCopy(Number.NaN)).toBe("? links unknown");
    expect(linksCopy(0)).toBe("no links");
    expect(linksCopy(1)).toBe("1 link");
    expect(linksCopy(2)).toBe("2 links");
    expect(gitFacetCopy("tracked")).toBe("in Git");
    expect(gitFacetCopy("untracked")).toBe("not in Git");
    expect(gitFacetCopy("unknown")).toBe("? Git unknown");
  });

  test("eligibility words and the selection line", () => {
    expect(eligibilityCopy("can-remove")).toBe("Can remove");
    expect(eligibilityCopy("check", "other links exist")).toBe("Check · other links exist");
    expect(eligibilityCopy("kept", "tracked by Git")).toBe("Kept · tracked by Git");
    expect(eligibilityCopy("cant-tell", "not measured")).toBe("Can't tell · not measured");
    expect(selectionCopy(2, "5.0 GB", "on disk")).toBe("2 selected · 5.0 GB on disk");
    expect(selectionCopy(3, "5.0 GB", "on disk", true)).toBe("3 selected · 5.0 GB on disk + ? unknown");
    for (const copy of [selectionCopy(1, "1 GB", "file size"), unknownStoresCopy(3)]) expect(copy).not.toMatch(/\bfree\b|freed/i);
  });
});
