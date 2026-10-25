/**
 * Staging under a turn's protection guard (#2876) judges each change where it
 * lands at the moment it is made. A link that moves the staging directory
 * into a protected folder mid-staging stops the next write, the publication
 * and the removal of the partial, and nothing new appears in that folder.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { protectedPaths } from "@schlessera/brain-common/internal/protected-paths";
import { stageShareAt } from "../src/share/staging.js";
import { createProtectedTargetCheck, ProtectedTargetRefusedError } from "../src/brain/protected-target.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** Every entry below a folder, directories included, links not followed. */
const entries = (dir: string) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-staging-protection-")), brain = join(root, "brain");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(brain, "lore"), { recursive: true });
  mkdirSync(join(brain, SHARE_STAGING_DIR), { recursive: true });
  writeFileSync(join(brain, "lore/taxonomy.md"), "The suitors gather in the hall.\n");
  const isProtected = createProtectedTargetCheck(brain, protectedPaths({ protect: ["lore"] }));
  const guard = (path: string) => { if (isProtected(path)) throw new ProtectedTargetRefusedError(); };
  return { brain, guard };
}

/** The staging directory becomes a link into `lore/`, taking what it holds with it. */
function linkIntoLore(brain: string): void {
  renameSync(join(brain, SHARE_STAGING_DIR), join(brain, "lore/inbox"));
  symlinkSync("../lore/inbox", join(brain, SHARE_STAGING_DIR));
}

const id = () => crypto.randomUUID();

test("staging that already lands in a protected folder creates nothing there", async () => {
  const { brain, guard } = fixture();
  linkIntoLore(brain);
  const before = entries(join(brain, "lore"));
  await expect(stageShareAt(brain, { text: "Odysseus strings the bow.", files: [] }, id(), undefined, "cli", undefined, guard))
    .rejects.toBeInstanceOf(ProtectedTargetRefusedError);
  expect(entries(join(brain, "lore")), "NO_PARTIAL_CREATED_IN_PROTECTION").toEqual(before);
});

test("a link made while a file is read stops its write, and the partial it moved is left in place", async () => {
  const { brain, guard } = fixture();
  const staging = id();
  const letter = new File(["Penelope weaves by day."], "letter.txt", { type: "text/plain" });
  // The bytes are read after the partial exists and before they are written.
  Object.defineProperty(letter, "arrayBuffer", { value: async () => { linkIntoLore(brain); return new TextEncoder().encode("Penelope weaves by day.").buffer; } });
  await expect(stageShareAt(brain, { text: "A letter for Odysseus.", files: [letter] }, staging, undefined, "cli", undefined, guard))
    .rejects.toBeInstanceOf(ProtectedTargetRefusedError);
  expect(entries(join(brain, "lore/inbox")), "NO_WRITE_OR_REMOVAL_IN_PROTECTION").toEqual([`.${staging}.partial`]);
});

test("a link made before publication stops the publication", async () => {
  const { brain, guard } = fixture();
  const staging = id();
  let published = false;
  await expect(stageShareAt(brain, { text: "Odysseus strings the bow.", files: [] }, staging, undefined, "cli",
    () => { published = true; linkIntoLore(brain); }, guard)).rejects.toBeInstanceOf(ProtectedTargetRefusedError);
  expect(published).toBe(true);
  expect(entries(join(brain, "lore/inbox")), "NOT_PUBLISHED_INTO_PROTECTION").toEqual([`.${staging}.partial`, `.${staging}.partial/meta.json`]);
});

test("without a protected target, guarded staging publishes as before", async () => {
  const { brain, guard } = fixture();
  const staging = id();
  const result = await stageShareAt(brain, { text: "Odysseus strings the bow.", files: [] }, staging, undefined, "cli", undefined, guard);
  expect(result.id).toBe(staging);
  expect(entries(join(brain, SHARE_STAGING_DIR))).toEqual([staging, `${staging}/meta.json`]);
});

test("the guard judges every change staging makes, as it lands, in order", async () => {
  const { brain, guard } = fixture();
  const staging = id(), judged: string[] = [];
  const letter = new File(["Penelope weaves by day."], "letter.txt", { type: "text/plain" });
  await stageShareAt(brain, { text: "A letter for Odysseus.", files: [letter] }, staging, undefined, "cli", undefined, path => { judged.push(path); guard(path); });
  // An abort after publication removes what was published: judged again first.
  const aborted = id(), controller = new AbortController(), undone: string[] = [];
  await expect(stageShareAt(brain, { text: "Odysseus strings the bow.", files: [], signal: controller.signal }, aborted, undefined, "cli", undefined, path => {
    undone.push(path);
    if (path.endsWith(`/${aborted}`)) controller.abort();
  })).rejects.toThrow();
  const partial = `${SHARE_STAGING_DIR}/.${staging}.partial`;
  expect(judged, "EVERY_STAGING_CHANGE_JUDGED").toEqual([partial, `${partial}/letter.txt`, `${partial}/meta.json`, partial, `${SHARE_STAGING_DIR}/${staging}`]);
  const undonePartial = `${SHARE_STAGING_DIR}/.${aborted}.partial`, published = `${SHARE_STAGING_DIR}/${aborted}`;
  expect(undone, "ABORT_REMOVAL_JUDGED").toEqual([undonePartial, `${undonePartial}/meta.json`, undonePartial, published, published, undonePartial]);
});
