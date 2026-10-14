import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeJournalFile } from "../src/brain/native-journal-read.js";

test("native journal reads exact bounded bytes without following leaf or parent links", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-read-odysseus-"));
  mkdirSync(join(root, "sealed")); mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "sealed/odysseus.md"), "Ithaca\r\n");
  writeFileSync(join(root, "outside/private.md"), "Athena's private advice");
  symlinkSync("../outside", join(root, "sealed/link"));
  symlinkSync("../outside/private.md", join(root, "sealed/leaf"));
  try {
    expect(await readNativeJournalFile(join(root, "sealed"), "odysseus.md", 8)).toEqual(Buffer.from("Ithaca\r\n"));
    await expect(readNativeJournalFile(join(root, "sealed"), "odysseus.md", 7)).rejects.toThrow("read bound");
    await expect(readNativeJournalFile(join(root, "sealed"), "link/private.md", 1024)).rejects.toThrow();
    await expect(readNativeJournalFile(join(root, "sealed"), "leaf", 1024)).rejects.toThrow();
    await expect(readNativeJournalFile(join(root, "sealed"), "../outside/private.md", 1024)).rejects.toThrow("Invalid native journal path");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
