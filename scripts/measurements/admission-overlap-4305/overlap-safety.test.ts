import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overlap } from "./overlap-prototype.ts";

test("read-only preparation finishes while the admitted effect waits for admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-overlap-"));
  const gate = Promise.withResolvers<void>();
  const path = join(root, "ithaca.md"); writeFileSync(path, "Odysseus on 2026-07-12.\n");
  let preparations = 0, effects = 0;
  const pending = overlap(() => gate.promise, () => { preparations++; return readFileSync(path, "utf8"); }, data => { effects++; writeFileSync(path, `Admitted: ${data}`); });
  try {
    expect(preparations).toBe(1);
    expect(effects, "NO_EFFECT_BEFORE_ADMISSION").toBe(0);
    expect(readFileSync(path, "utf8")).toBe("Odysseus on 2026-07-12.\n");
    gate.resolve(); await pending;
    expect(effects).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("Admitted: Odysseus on 2026-07-12.\n");
  } finally { gate.resolve(); await pending; rmSync(root, { recursive: true, force: true }); }
});

test("refused admission leaves only the unchanged source fixture", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-refusal-")), path = join(root, "ithaca.md");
  writeFileSync(path, "Odysseus on 2026-07-12.\n");
  let preparations = 0;
  try {
    await expect(overlap(() => Promise.reject(new Error("admission refused")), () => { preparations++; return readFileSync(path, "utf8"); }, data => writeFileSync(join(root, "effect.md"), data))).rejects.toThrow("admission refused");
    expect(preparations).toBe(1);
    expect(readdirSync(root), "REFUSED_ADMISSION_LEAVES_NOTHING_BEHIND").toEqual(["ithaca.md"]);
    expect(readFileSync(path, "utf8")).toBe("Odysseus on 2026-07-12.\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
