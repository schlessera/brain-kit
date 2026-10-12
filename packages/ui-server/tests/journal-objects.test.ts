import { expect, test } from "bun:test";
import { closeSync, constants, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJournalObjects, JournalCapacityError } from "../src/brain/journal-objects.js";

test("streamed private objects charge duplicate temporary bytes, deduplicate retained bytes and reject capacity before writing", () => {
  const root = mkdtempSync(join(tmpdir(), "journal-objects-odysseus-"));
  let charged = 0, peak = 0;
  const objects = createJournalObjects(join(root, "objects"), { reserve(bytes) {
    if (charged + bytes > 12) throw new JournalCapacityError();
    charged += bytes; peak = Math.max(peak, charged);
    return { finish(_hash, _bytes, duplicate) { if (duplicate) charged -= bytes; }, cancel() { charged -= bytes; } };
  } });
  const source = join(root, "odysseus.md"); writeFileSync(source, "Ithaca");
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const first = objects.putFile(fd, 6), again = objects.putFile(fd, 6);
    expect(first).toBe(again); expect(charged).toBe(6); expect(peak).toBe(12);
    expect(objects.read(first, 6)).toEqual(Buffer.from("Ithaca"));
    expect(readdirSync(join(root, "objects"))).toEqual([first]);
    writeFileSync(source, "Return to Ithaca");
    expect(() => objects.putFile(fd, 16)).toThrow(JournalCapacityError);
    expect(charged).toBe(6); expect(readdirSync(join(root, "objects"))).toEqual([first]);
  } finally { closeSync(fd); objects.close(); rmSync(root, { recursive: true, force: true }); }
});
