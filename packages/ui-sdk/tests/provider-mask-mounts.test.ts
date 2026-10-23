/**
 * Provider mask arguments for a turn's recipient (#2695): a turn allowed every
 * provider folder keeps `.git` and the real index; any masked folder needs the
 * private index and hides history.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerMaskMounts } from "../src/server/worker-protection";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function view() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-mask-mounts-")); roots.push(root);
  const brain = join(root, "brain"), index = join(root, "private-index");
  for (const dir of ["me", ".git", ".brain-index"]) mkdirSync(join(brain, dir), { recursive: true });
  mkdirSync(index);
  return { brain, index };
}

test("a turn allowed every provider folder mounts no mask over them, its history or its index", () => {
  const { brain } = view();
  expect(providerMaskMounts(brain, brain, { folders: [] }), "ALLOWED_TURN_KEEPS_HISTORY_AND_REAL_INDEX").toEqual([]);
});

test("a masked folder hides history and binds the private index, which it cannot do without", () => {
  const { brain, index } = view();
  expect(() => providerMaskMounts(brain, brain, { folders: ["me"] }), "MASKED_FOLDER_NEEDS_PRIVATE_INDEX").toThrow("need the turn's private index");
  expect(providerMaskMounts(brain, brain, { folders: ["me"], index })).toEqual([
    "--tmpfs", join(brain, "me"), "--remount-ro", join(brain, "me"),
    "--tmpfs", join(brain, ".git"), "--remount-ro", join(brain, ".git"),
    "--bind", index, join(brain, ".brain-index"),
  ]);
});
