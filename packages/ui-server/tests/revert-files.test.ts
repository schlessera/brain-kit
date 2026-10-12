import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync, symlinkSync, readlinkSync, renameSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { restoreJournalPath } from "../src/brain/revert-files.js";
const version = (bytes: Buffer, mode = 0o644) => ({ kind: "file" as const, bytes: bytes.length, mode, hash: createHash("sha256").update(bytes).digest("hex"), ignored: false });

test("raw restore preserves binary bytes and mode; a later actor's byte or mode change conflicts", () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-revert-"));
  const before = Buffer.from([0, 255, 10, 13]), after = Buffer.from([0, 254, 13, 10]);
  try {
    writeFileSync(join(brain, "fleet.bin"), after); chmodSync(join(brain, "fleet.bin"), 0o640);
    const copy = (fd: number) => { writeSync(fd, before); };
    expect(restoreJournalPath(brain, "fleet.bin", version(after, 0o640), version(before, 0o600), copy)).toBe("restored");
    expect(readFileSync(join(brain, "fleet.bin")), "REVERT_RAW_BYTES").toEqual(before);
    expect(statSync(join(brain, "fleet.bin")).mode & 0o7777).toBe(0o600);
    writeFileSync(join(brain, "fleet.bin"), after); chmodSync(join(brain, "fleet.bin"), 0o640);
    writeFileSync(join(brain, "fleet.bin"), Buffer.from([0, 253, 13, 10]));
    expect(restoreJournalPath(brain, "fleet.bin", version(after, 0o640), version(before), copy), "REVERT_STALE_RAW_BYTES_CONFLICT").toBe("conflict");
    expect(readFileSync(join(brain, "fleet.bin"))).toEqual(Buffer.from([0, 253, 13, 10]));
    writeFileSync(join(brain, "fleet.bin"), after); chmodSync(join(brain, "fleet.bin"), 0o600);
    expect(restoreJournalPath(brain, "fleet.bin", version(after, 0o640), version(before), copy)).toBe("conflict");
  } finally { rmSync(brain, { recursive: true, force: true }); }
});

test("a symlink is restored as a literal link and a swapped parent never reaches its target", () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-revert-")), outside = mkdtempSync(join(tmpdir(), "odysseus-outside-"));
  try {
    mkdirSync(join(brain, "plans")); writeFileSync(join(brain, "plans", "fleet"), "after"); writeFileSync(join(outside, "fleet"), "untouched");
    expect(restoreJournalPath(brain, "plans/fleet", version(Buffer.from("after")), version(Buffer.from("before")), () => {}, () => {
      renameSync(join(brain, "plans"), join(brain, "archived")); symlinkSync(outside, join(brain, "plans"));
    }), "REVERT_PARENT_IDENTITY_CONFLICT").toBe("conflict");
    expect(readFileSync(join(outside, "fleet"), "utf8")).toBe("untouched");
    expect(readFileSync(join(brain, "archived", "fleet"), "utf8")).toBe("after");
    symlinkSync("../outside", join(brain, "link"));
    const link = (target: string) => ({ kind: "symlink" as const, mode: 0o777, bytes: Buffer.byteLength(target), target, ignored: false });
    expect(restoreJournalPath(brain, "link", link("../outside"), link("../fleet"), () => {})).toBe("restored");
    expect(readlinkSync(join(brain, "link"))).toBe("../fleet");
  } finally { rmSync(brain, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
