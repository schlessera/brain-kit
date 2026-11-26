import { describe, expect, test } from "bun:test";
import type { StorageRemovalFile } from "@schlessera/brain-ui-sdk/protocol";
import { knownLinks } from "../src/components/settings/storage/storage-model.js";

const file = (extra: Partial<StorageRemovalFile> = {}): StorageRemovalFile => ({
  path: "attachments/Ithaca-harbor.pdf",
  bytes: 48_200_000,
  hash: "a".repeat(64),
  eligible: true,
  reason: null,
  git: "tracked",
  references: [],
  recovery: "requires-retention",
  ...extra,
});

// #4549 review F2 (third round): a Find large files row reads its links from
// the removal inspection. An empty list is "no links" only when the
// inspection checked every reference it scans; otherwise the count is
// unknown, never 0 (storage.md: an unknown is a mark).
describe("known links", () => {
  test("a complete inspection's count is known, zero included", () => {
    expect(knownLinks({ facts: file(), complete: true })).toBe(0);
    const references = [{ source: "notes/voyage.md", certainty: "resolved" as const }];
    expect(knownLinks({ facts: file({ references }), complete: true })).toBe(1);
  });

  test("an incomplete inspection's empty list is unknown, not zero", () => {
    // The server marks the whole inspection incomplete when its reference
    // scan fails, hits a bound or truncates a file's references.
    expect(knownLinks({ facts: file(), complete: false }), "STORAGE_INCOMPLETE_LINKS_UNKNOWN").toBeNull();
    // A partial list is a lower bound the row cannot state: still unknown.
    const references = [{ source: "notes/voyage.md", certainty: "resolved" as const }];
    expect(knownLinks({ facts: file({ references }), complete: false })).toBeNull();
  });

  test("a file refused as consequences_incomplete has unknown links", () => {
    const facts = file({ eligible: false, reason: "consequences_incomplete", recovery: "unavailable" });
    expect(knownLinks({ facts, complete: true }), "STORAGE_REFUSED_LINKS_UNKNOWN").toBeNull();
  });

  test("an uninspected or failed inspection has unknown links", () => {
    expect(knownLinks(undefined)).toBeNull();
    expect(knownLinks({ facts: null, complete: false })).toBeNull();
  });
});
