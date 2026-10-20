import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectStorageAttachmentFacts } from "../src/lib/storage-attachment-facts";

test("attachment consequences include unindexed Markdown links and invalidate when references change", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-attachment-facts-"));
  try {
    mkdirSync(join(root, "attachments")); mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "attachments/chart.pdf"), "%PDF chart");
    writeFileSync(join(root, "notes/voyage.md"), "[Chart](../attachments/chart.pdf)\n![Map][map]\n[map]: /attachments/chart.pdf\n");
    const first = inspectStorageAttachmentFacts(root, ["attachments/chart.pdf"]);
    expect(first).toMatchObject({ complete: true, scannedFiles: 1, files: [{ path: "attachments/chart.pdf", git: "no-repository", references: [{ source: "notes/voyage.md", certainty: "resolved" }] }] });
    writeFileSync(join(root, "notes/arrival.md"), "[[chart.pdf]]\n");
    const second = inspectStorageAttachmentFacts(root, ["attachments/chart.pdf"]);
    expect(second.fingerprint, "STORAGE_CONSEQUENCES_BOUND_TO_REVIEW").not.toBe(first.fingerprint);
    expect(second.files[0]?.references.some(value => value.source === "notes/arrival.md" && value.certainty === "possible")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
