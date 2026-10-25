/**
 * Provider mask arguments for a turn's recipient (#2695): a turn allowed every
 * provider folder keeps `.git` and the real index; any masked folder needs the
 * private index and hides history.
 */
import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("a worker shown only some paths starts from an empty brain and binds back exactly those, refusing aliases (#2699)", () => {
  const { brain, index } = view();
  writeFileSync(join(brain, "brain.config.ts"), "export default {};\n");
  mkdirSync(join(brain, "node_modules/@schlessera"), { recursive: true });
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  expect(providerMaskMounts(brain, brain, { folders: ["me"], index, visible: ["node_modules", "brain.config.ts", "context/policies", "scripts/brain-cli.ts", "package.json"] }),
    "ONLY_PRESENT_VISIBLE_PATHS_BOUND_OVER_AN_EMPTY_BRAIN").toEqual([
    "--tmpfs", brain,
    "--ro-bind", join(brain, "brain.config.ts"), join(brain, "brain.config.ts"),
    "--ro-bind", join(brain, "context/policies"), join(brain, "context/policies"),
    "--ro-bind", join(brain, "node_modules"), join(brain, "node_modules"),
    "--tmpfs", join(brain, "me"), "--remount-ro", join(brain, "me"),
    "--tmpfs", join(brain, ".git"), "--remount-ro", join(brain, ".git"),
    "--bind", index, join(brain, ".brain-index"),
  ]);
  // Bubblewrap would bind whatever a link points at, so no name on the way may be one.
  mkdirSync(join(brain, "lib"));
  symlinkSync("lib", join(brain, "modules"));
  expect(() => providerMaskMounts(brain, brain, { folders: [], visible: ["modules/oracle"] }), "LINKED_ANCESTOR_REFUSED").toThrow("modules is a symbolic link");
  symlinkSync("notes.ts", join(brain, "helper.ts"));
  expect(() => providerMaskMounts(brain, brain, { folders: [], visible: ["helper.ts"] }), "LINKED_PATH_REFUSED").toThrow("helper.ts is a symbolic link");
  linkSync(join(brain, "brain.config.ts"), join(brain, "me/config-alias.ts"));
  expect(() => providerMaskMounts(brain, brain, { folders: [], visible: ["brain.config.ts"] }), "HARDLINKED_PATH_REFUSED").toThrow("brain.config.ts is hardlinked");
  writeFileSync(join(brain, "context/file"), "");
  expect(providerMaskMounts(brain, brain, { folders: [], visible: ["context/file/below"] }), "PATH_BELOW_A_FILE_IS_ABSENT").toEqual(["--tmpfs", brain]);
  for (const rel of [".git/config", ".brain-index", "../outside", "a/./b"])
    expect(() => providerMaskMounts(brain, brain, { folders: [], visible: [rel] }), rel).toThrow("invalid visible brain path");
});
