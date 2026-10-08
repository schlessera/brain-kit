import { expect, test } from "bun:test";
import { chmodSync, symlinkSync, linkSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { observeTree } from "../scripts/evals/import-enrichment/freeze";

test("runtime freeze observes executable-mode changes even when file bytes are unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "brain-import-enrichment-mode-")), file = join(directory, "odysseus.ts");
  try {
    writeFileSync(file, "export const port = 'Ithaca';\n"); chmodSync(file, 0o644);
    const before = observeTree(directory);
    chmodSync(file, 0o755); const after = observeTree(directory);
    expect(Object.keys(before.hashes)).toEqual(["odysseus.ts"]);
    expect(after.hashes).toEqual(before.hashes);
    expect(before.modes["odysseus.ts"]).toBe(0o644);
    expect(after.modes["odysseus.ts"]).toBe(0o755);
    expect(after.modes).not.toEqual(before.modes);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("installed dependency freeze refuses real external hardlinks while admitting solely internal occurrences", () => {
  const directory = mkdtempSync(join(tmpdir(), "brain-import-enrichment-hardlink-")), dependencies = join(directory, "node_modules");
  mkdirSync(dependencies); const file = join(dependencies, "odysseus.ts");
  try {
    writeFileSync(file, "export const port = 'Ithaca';\n"); linkSync(file, join(dependencies, "internal.ts"));
    expect(Object.keys(observeTree(dependencies, true).hashes).sort()).toEqual(["internal.ts", "odysseus.ts"]);
    linkSync(file, join(directory, "external.ts"));
    expect(() => observeTree(dependencies, true)).toThrow("Installed dependency inode has external hardlinks");
    expect(Object.keys(observeTree(dependencies, false).hashes)).toHaveLength(2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("source closure refuses a real source symlink instead of silently omitting its runtime bytes", () => {
  const directory = mkdtempSync(join(tmpdir(), "source-link-"));
  try { writeFileSync(join(directory, "record.ts"), "export const record = 1;\n"); symlinkSync("record.ts", join(directory, "alias.ts"));
    expect(() => observeTree(directory)).toThrow("Source symlink has no explicit runtime closure");
    expect(observeTree(directory, false, true).modes["alias.ts"]).toBeDefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
