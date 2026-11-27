/**
 * The process boundary of the media review effects (#4845): the cases of
 * hygiene-media-effects.test.ts that keep the spawned core CLI, one per call
 * shape the host relies on. Every call starts the bin with the same
 * environment keys the in-process runner passes.
 *
 * - a plan (`hygiene list`, then `hygiene media <action> --dry-run`) and an
 *   apply (`hygiene media <action>`): the Delete case;
 * - a failing exit (`hygiene unkeep` exits 1 with a refusal): the refused kept
 *   entry case.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LOOM, mediaEffectsHost, put, read, SCRATCH, spawnedHygiene } from "./helpers/media-effects-host.js";

const setup = mediaEffectsHost(spawnedHygiene);

test("Delete captures the bytes first, removes the file, and Undo puts back the exact bytes", async () => {
  const f = await setup();
  const receipt = await f.apply(LOOM, "delete");
  expect(receipt, "MEDIA_DELETE_APPLIED").toMatchObject({ outcome: "applied", files: [{ path: LOOM, state: "removed" }], undo: { available: true } });
  expect(existsSync(join(f.root, LOOM))).toBe(false);
  const undone = await f.undo(receipt.journalId);
  expect(undone, "MEDIA_DELETE_UNDONE").toMatchObject({ outcome: "undone", files: [{ path: LOOM, state: "restored" }] });
  expect(read(f.root, LOOM), "MEDIA_DELETE_UNDO_BYTES").toBe("loom bytes");
  expect(f.effects.receipt(receipt.journalId, "odysseus")?.undo, "MEDIA_UNDO_ONCE").toEqual({ available: false, reason: "already-undone" });
});

test("a refused kept entry (step 6b) removes the copy and restores the config", async () => {
  const f = await setup({ wrap: (args, real) => args[0] === "keep-copy" ? { status: "refused", reason: "copy-changed" } : real(args) });
  put(f.root, SCRATCH, "dawn bytes");
  put(f.root, ".brain/scratch-pins/pins.json", JSON.stringify({ version: 1, ready: true, sessions: { '["claude","ithaca"]': [SCRATCH] } }));
  const receipt = await f.apply(SCRATCH, "keep-copy", "places/harbour-dawn.jpg");
  expect(receipt, "MEDIA_KEEP_6B_COMPENSATED").toMatchObject({ outcome: "compensated", reason: "copy-changed" });
  expect(existsSync(join(f.root, "places/harbour-dawn.jpg")), "MEDIA_KEEP_6B_NO_COPY").toBe(false);
  expect(read(f.root, "brain.config.json")).toBe("{}\n");
  expect(existsSync(join(f.root, "context/hygiene/kept.md"))).toBe(false);
});
