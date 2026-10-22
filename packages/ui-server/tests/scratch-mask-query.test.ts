import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createBrainClient } from "../src/brain/client.js";
import { createHostBoundary } from "../src/brain/host-boundary.js";
import { createScratchIgnoreQuery } from "../src/brain/scratch-mask-query.js";

// Ordinary real filesystem/lock proof only; no native acquisition or worker.
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "odysseus-scratch-query-"))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test("scratch query construction preserves clients for a nonexistent brain", () => {
  const brainPath = join(root, "missing");
  expect(() => createHostBoundary({ brainPath }), "SCRATCH_QUERY_CONSTRUCTION_HAS_NO_FILESYSTEM_PRECONDITION").not.toThrow();
  expect(() => createBrainClient({ brainPath }), "SCRATCH_QUERY_CLIENT_CONSTRUCTION_HAS_NO_FILESYSTEM_PRECONDITION").not.toThrow();
});

test.each(["missing", "file"] as const)("actual scratch query refuses a %s root and releases its output lock", async kind => {
  const brainPath = join(root, kind);
  if (kind === "file") writeFileSync(brainPath, "Odysseus has no brain directory here.\n");
  const lock = createKeyedLock();
  const query = createScratchIgnoreQuery({ brainPath, maintenance: {}, lock });
  await expect(query(), "SCRATCH_QUERY_INVALID_ROOT_REFUSES_AT_EXECUTION").rejects.toThrow(kind === "missing" ? "ENOENT" : "canonical brain directory");
  expect(lock.heldKeys, "SCRATCH_QUERY_INVALID_ROOT_RELEASES_LOCK").toEqual([]);
});

test("a legitimate brain alias retains the boundary's canonical key and still requires native storage", async () => {
  const brain = join(root, "brain"), alias = join(root, "alias");
  mkdirSync(brain); symlinkSync(brain, alias);
  const boundary = createHostBoundary({ brainPath: alias });
  expect(boundary.brainPath, "SCRATCH_QUERY_USES_BOUNDARY_CANONICAL_ROOT").toBe(brain);
  await expect(boundary.maintenance!.scratchIgnoreQuery!()).rejects.toThrow("configured native manager");
});

test("scratch query revalidates its canonical directory after waiting for the output lock", async () => {
  const brain = join(root, "brain"), other = join(root, "other");
  mkdirSync(brain); mkdirSync(other);
  const lock = createKeyedLock(), release = await lock.acquire(brain);
  const query = createScratchIgnoreQuery({ brainPath: brain, maintenance: {}, lock });
  const pending = query();
  try {
    renameSync(brain, join(root, "original-brain")); symlinkSync(other, brain);
  } finally { release(); }
  await expect(pending, "SCRATCH_QUERY_REVALIDATES_ROOT_AFTER_OUTPUT_LOCK").rejects.toThrow("canonical brain directory");
  expect(lock.heldKeys, "SCRATCH_QUERY_SWAPPED_ROOT_RELEASES_LOCK").toEqual([]);
});

test("a cancelled query waiting on a missing root does not activate filesystem prerequisites", async () => {
  const brainPath = join(root, "missing"), lock = createKeyedLock();
  const release = await lock.acquire(brainPath), controller = new AbortController();
  const query = createScratchIgnoreQuery({ brainPath, maintenance: {}, lock });
  const pending = query(controller.signal);
  try {
    controller.abort();
    await expect(pending, "SCRATCH_QUERY_CANCELLED_BEFORE_ROOT_VALIDATION").rejects.toThrow("cancelled");
  } finally { release(); }
  expect(lock.heldKeys).toEqual([]);
});
