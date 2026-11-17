/**
 * The descriptor-anchored staging operations (#2907) act on the directory
 * they opened. A link swapped in at the visible path after every check, just
 * before the system call, cannot redirect a write, a publication or a removal.
 */
import { afterEach, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import {
  makeDirectory, openEntry, openStagingRoot, publishDirectory, removeEntry, removeStagedArrival, StagingTopologyError, writeExclusive,
} from "../src/share/staging-fs.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const SENTINEL = "The bow of Eurytus hangs in the storeroom.\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-staging-fs-")), brain = join(root, "brain");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(brain, SHARE_STAGING_DIR), { recursive: true });
  mkdirSync(join(brain, "vault"));
  writeFileSync(join(brain, "vault/bow.md"), SENTINEL);
  return { brain, staging: join(brain, SHARE_STAGING_DIR), vault: join(brain, "vault") };
}

/** Move the real staging directory away and leave a link to the vault at its name. */
function swapRoot(f: ReturnType<typeof fixture>): string {
  const moved = join(f.brain, "moved-inbox");
  renameSync(f.staging, moved);
  symlinkSync("../vault", f.staging);
  return moved;
}

test("a write lands in the opened directory after its visible path becomes a link", async () => {
  const f = fixture();
  const root = openStagingRoot(f.brain, false)!;
  cleanup.push(() => root.close());
  const moved = swapRoot(f);
  await writeExclusive(root.dir, "letter.txt", "For Telemachus.\n");
  expect(existsSync(join(f.vault, "letter.txt")), "WRITE_NOT_REDIRECTED").toBe(false);
  expect(readFileSync(join(moved, "letter.txt"), "utf8")).toBe("For Telemachus.\n");
  expect(() => root.verify(), "SWAP_DETECTED").toThrow(StagingTopologyError);
});

test("an exclusive write never follows or truncates a planted link", async () => {
  const f = fixture();
  const root = openStagingRoot(f.brain, false)!;
  cleanup.push(() => root.close());
  symlinkSync("../../vault/bow.md", join(f.staging, "meta.json"));
  await expect(writeExclusive(root.dir, "meta.json", "{}\n"), "PLANTED_LINK_REFUSED").rejects.toThrow();
  expect(readFileSync(join(f.vault, "bow.md"), "utf8"), "LINK_TARGET_UNCHANGED").toBe(SENTINEL);
});

test("a publication renames inside the opened directory after its visible path becomes a link", () => {
  const f = fixture();
  const root = openStagingRoot(f.brain, false)!;
  cleanup.push(() => root.close());
  const partial = makeDirectory(root.dir, ".arrival.partial");
  mkdirSync(join(f.vault, ".arrival.partial"));
  const moved = swapRoot(f);
  publishDirectory(root.dir, ".arrival.partial", "arrival", partial);
  expect(readdirSync(f.vault).sort(), "PUBLICATION_NOT_REDIRECTED").toEqual([".arrival.partial", "bow.md"]);
  expect(readdirSync(moved)).toEqual(["arrival"]);
});

test("a publication refuses a partial that became a link", () => {
  const f = fixture();
  const root = openStagingRoot(f.brain, false)!;
  cleanup.push(() => root.close());
  const partial = makeDirectory(root.dir, ".arrival.partial");
  renameSync(join(f.staging, ".arrival.partial"), join(f.brain, "moved-partial"));
  symlinkSync("../../vault", join(f.staging, ".arrival.partial"));
  expect(() => publishDirectory(root.dir, ".arrival.partial", "arrival", partial), "LINKED_PARTIAL_NOT_PUBLISHED").toThrow(StagingTopologyError);
  expect(existsSync(join(f.staging, "arrival"))).toBe(false);
});

test("a removal lands in the opened directory after its visible path becomes a link", () => {
  const f = fixture();
  mkdirSync(join(f.staging, "arrival"));
  writeFileSync(join(f.staging, "arrival/meta.json"), "{}\n");
  const root = openStagingRoot(f.brain, false)!;
  cleanup.push(() => root.close());
  // The link's target holds an entry under the same name.
  mkdirSync(join(f.vault, "arrival"));
  writeFileSync(join(f.vault, "arrival/bow.md"), SENTINEL);
  const moved = swapRoot(f);
  removeEntry(root.dir, "arrival");
  expect(readFileSync(join(f.vault, "arrival/bow.md"), "utf8"), "REMOVAL_NOT_REDIRECTED").toBe(SENTINEL);
  expect(readdirSync(moved)).toEqual([]);
});

test("a removal unlinks links below an arrival and never follows them", () => {
  const f = fixture();
  mkdirSync(join(f.staging, "arrival/nested"), { recursive: true });
  symlinkSync("../../../vault", join(f.staging, "arrival/folder"));
  symlinkSync("../../../../vault/bow.md", join(f.staging, "arrival/nested/file"));
  const root = openStagingRoot(f.brain, false)!;
  cleanup.push(() => root.close());
  removeEntry(root.dir, "arrival");
  expect(existsSync(join(f.staging, "arrival"))).toBe(false);
  expect(readdirSync(f.vault), "LINKED_CONTENT_KEPT").toEqual(["bow.md"]);
  expect(readFileSync(join(f.vault, "bow.md"), "utf8")).toBe(SENTINEL);
});

test("removing a staged arrival refuses a linked staging directory or ancestor", () => {
  for (const arrange of [
    (f: ReturnType<typeof fixture>) => { rmSync(f.staging, { recursive: true }); symlinkSync("../vault", f.staging); },
    (f: ReturnType<typeof fixture>) => { renameSync(join(f.brain, ".brain-ui"), join(f.brain, "elsewhere")); symlinkSync("vault", join(f.brain, ".brain-ui")); mkdirSync(join(f.vault, "inbox")); },
  ]) {
    const f = fixture(), id = crypto.randomUUID();
    arrange(f);
    mkdirSync(join(f.vault, id), { recursive: true });
    mkdirSync(join(f.vault, "inbox", id), { recursive: true });
    expect(() => removeStagedArrival(f.brain, id), "LINKED_ROOT_REFUSED").toThrow(StagingTopologyError);
    expect(existsSync(join(f.vault, id)) && existsSync(join(f.vault, "inbox", id)), "LINK_TARGET_KEPT").toBe(true);
  }
});

test("removing a staged arrival from an absent staging directory is already done", () => {
  const f = fixture();
  rmSync(join(f.brain, ".brain-ui"), { recursive: true });
  expect(() => removeStagedArrival(f.brain, crypto.randomUUID())).not.toThrow();
  expect(existsSync(join(f.brain, ".brain-ui")), "NOTHING_CREATED").toBe(false);
});

test("an existing arrival opens only as a real directory", () => {
  const f = fixture();
  const root = openStagingRoot(f.brain, false)!;
  cleanup.push(() => root.close());
  mkdirSync(join(f.staging, "arrival"));
  symlinkSync("../../vault", join(f.staging, "linked"));
  const arrival = openEntry(root.dir, "arrival");
  cleanup.push(() => closeSync(arrival.fd));
  expect(arrival.path).toBe(join(root.dir.path, "arrival"));
  expect(() => openEntry(root.dir, "linked"), "LINKED_ARRIVAL_REFUSED").toThrow(StagingTopologyError);
});
