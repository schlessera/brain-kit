import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureAdmissionJoin } from "../scripts/native-proof/admission-join";

test("admission measurement retains both fences and every hold/delay cell with real FULL writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-admission-measure-"));
  try {
    const measured = await measureAdmissionJoin(root, 1);
    expect(measured.rows.map(row => [row.hold, row.delayMs, row.queuedCommits, row.fences])).toEqual([
      ["drained", 10, 20, 2], ["drained", 50, 20, 2], ["drained", 500, 20, 2],
      ["removed", 10, 20, 2], ["removed", 50, 20, 2], ["removed", 500, 20, 2],
    ]);
    for (const row of measured.rows) {
      expect(row.admitMs).toBeGreaterThanOrEqual(0);
      expect(row.credentialToDispatchMs).toBeGreaterThanOrEqual(0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
