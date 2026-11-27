/**
 * The one no-follow parent walk both output publishers use (#4766): every
 * refused segment and every failed component leaves no handle open.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { at, noFollowParent } from "../src/server/no-follow-walk.js";

const root = mkdtempSync("/tmp/odysseus-no-follow-");
mkdirSync(join(root, "ithaca/palace"), { recursive: true });
writeFileSync(join(root, "ithaca/palace/hall.md"), "Penelope weaves");
writeFileSync(join(root, "ithaca/loom.md"), "a shroud");
mkdirSync(join(root, "outside"));
symlinkSync("../outside", join(root, "ithaca/harbour"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const INVALID = "invalid Odysseus test path";
/** The descriptors this process holds, so a leaked handle shows up as a new entry. */
const descriptors = () => readdirSync("/proc/self/fd").sort().join(",");

describe("noFollowParent", () => {
  test("accepts a nested regular path and returns its parent and last segment", () => {
    const before = descriptors();
    const handle = noFollowParent(root, "ithaca/palace/hall.md", INVALID);
    try {
      expect(handle.name, "LAST_SEGMENT").toBe("hall.md");
      expect(readlinkSync(`/proc/self/fd/${handle.fd}`), "PARENT_HANDLE").toBe(join(root, "ithaca/palace"));
      expect(readFileSync(at(handle.fd, handle.name), "utf8"), "LAST_SEGMENT_THROUGH_HANDLE").toBe("Penelope weaves");
    } finally { closeSync(handle.fd); }
    expect(descriptors(), "ONLY_THE_RETURNED_HANDLE_WAS_OPEN").toBe(before);
  });

  test.each([
    ["..", "ithaca/../ithaca/loom.md"],
    [".", "ithaca/./loom.md"],
    ["an empty segment", "ithaca//loom.md"],
    ["a NUL byte", "ithaca/lo\u0000om.md"],
    ["a NUL byte in a directory segment", "ith\u0000aca/loom.md"],
  ])("refuses %s before opening anything", (_label, rel) => {
    const before = descriptors();
    expect(() => noFollowParent(root, rel, INVALID), "INVALID_SEGMENT_REFUSED").toThrow(INVALID);
    expect(descriptors(), "NO_HANDLE_LEFT_OPEN").toBe(before);
  });

  test.each([
    ["a symlinked intermediate directory", "ithaca/harbour/ship.md", ["ELOOP", "ENOTDIR"]],
    ["a regular file where a directory is expected", "ithaca/loom.md/thread", ["ENOTDIR"]],
  ])("refuses %s and closes every handle it opened", (_label, rel, codes) => {
    const before = descriptors();
    let failure: unknown;
    try { closeSync(noFollowParent(root, rel, INVALID).fd); } catch (error) { failure = error; }
    expect(codes, "COMPONENT_REFUSED").toContain(String((failure as NodeJS.ErrnoException | undefined)?.code));
    expect(descriptors(), "NO_HANDLE_LEFT_OPEN").toBe(before);
  });
});
