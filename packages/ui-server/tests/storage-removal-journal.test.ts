import { expect, test } from "bun:test";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture";
import { createTurnJournal } from "../src/brain/turn-journal";
import { createUiDb } from "../src/db/client";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("the charged journal retains and verifies selected original bytes before removal without widening ignore rules", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-journal-")), brain = join(root, "brain"), dbPath = join(root, "ui.sqlite");
  mkdirSync(brain); mkdirSync(join(brain, "attachments"));
  const original = Buffer.from([37, 80, 68, 70, 0, 255, 13]); writeFileSync(join(brain, "attachments/chart.pdf"), original);
  writeFileSync(join(brain, "attachments/ignored.pdf"), "ignored content"); writeFileSync(join(brain, ".gitignore"), "attachments/ignored.pdf\n");
  const db = createUiDb(dbPath), native = createNativeJournalFixture(brain, root), journal = createTurnJournal(db, { brainPath: brain, dbPath, objectsRoot: join(root, "objects"), nativeManager: native.manager });
  try {
    await journal.begin("storage-odysseus", { sessionId: "storage", actor: "user", model: null, profile: "strict", policyHash: null }, () => {});
    const before = await journal.retainBefore("storage-odysseus", "attachments/chart.pdf");
    expect(before?.hash, "STORAGE_RETAINED_BEFORE_UNLINK").toHaveLength(64);
    expect(readFileSync(join(brain, "attachments/chart.pdf"))).toEqual(original);
    expect(journal.hasRetainedVersion("storage-odysseus", before!)).toBe(true);
    const fd = openSync(join(root, "independent-copy"), "wx");
    try { journal.withRetainedVersion(before, copy => copy(fd)); } finally { closeSync(fd); }
    expect(readFileSync(join(root, "independent-copy")), "STORAGE_RETAINED_ORIGINAL_CONTROL").toEqual(original);
    expect(await journal.retainBefore("storage-odysseus", "attachments/ignored.pdf"), "STORAGE_NO_IGNORE_EXPANSION").toBeNull();
    rmSync(join(brain, "attachments/chart.pdf")); await journal.finish("storage-odysseus");
    expect(journal.hasRetainedVersion("storage-odysseus", before!)).toBe(true);
    expect(journal.details("storage", "storage-odysseus")?.changes[0]?.before?.hash).toBe(before?.hash);
  } finally { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
