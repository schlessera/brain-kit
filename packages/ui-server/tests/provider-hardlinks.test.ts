/** Hardlinks out of masked provider folders (#2700): real inodes, metadata only. */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { providerHardlinks } from "../src/brain/provider-hardlinks";
import { ProviderPolicyRefusedError, providerMaskedFolders } from "../src/brain/governance-policy";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });

function brain() {
  const root = fs.mkdtempSync(join(tmpdir(), "odysseus-hardlinks-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = (rel: string) => fs.mkdirSync(join(root, rel, ".."), { recursive: true });
  const write = (rel: string) => { parent(rel); fs.writeFileSync(join(root, rel), "Odysseus keeps his oath.\n"); };
  const link = (source: string, rel: string) => { parent(rel); fs.linkSync(join(root, source), join(root, rel)); };
  write("me/oath.md");
  return { root, write, link };
}

test.each(["notes/x.txt", "notes/x", ".hidden/oath", "node_modules/pkg/oath.js", "mean/oath", "notes/.git/oath", "notes/.brain-index/oath"])(
  "a name outside the masks for a masked file is found whatever it is called (%s)", path => {
    const b = brain(); b.link("me/oath.md", path);
    expect(providerHardlinks(b.root, ["me"]), "HARDLINK_NAMED").toEqual([{ path, masked: "me/oath.md" }]);
  });

test("names inside the masks, the root .git and .brain-index, copies and symbolic links are not hardlinks out", () => {
  const b = brain();
  b.link("me/oath.md", "me/nested/alias.txt");
  b.link("me/oath.md", "crew/oath.txt");
  b.link("me/oath.md", ".git/objects/oath");
  b.link("me/oath.md", ".brain-index/oath");
  b.write("notes/copy.md"); b.link("notes/copy.md", "notes/other.md");
  fs.symlinkSync("../me/oath.md", join(b.root, "notes/oath-link.txt"));
  fs.symlinkSync("../me", join(b.root, "notes/folder-link"));
  fs.symlinkSync("missing", join(b.root, "notes/dangling"));
  fs.symlinkSync("..", join(b.root, "me/cycle"));
  expect(providerHardlinks(b.root, ["me", "me/nested", "crew", "absent"]), "ONLY_NAMES_THE_TURN_CAN_READ").toEqual([]);
});

test("a nested folder dropped from the masked set still counts as masked", () => {
  const b = brain(); b.write("me/sub/vow.md");
  b.link("me/sub/vow.md", "notes/vow.txt"); b.link("me/sub/vow.md", "me/vow-alias.txt");
  const masked = providerMaskedFolders({ providers: [{ paths: ["me/**", "me/sub/**"], allow: ["anthropic"] }] } as Parameters<typeof providerMaskedFolders>[0]);
  expect(masked, "NESTED_FOLDER_COVERED_BY_ITS_ANCESTOR").toEqual(["me"]);
  expect(providerHardlinks(b.root, masked), "NESTED_FILE_HARDLINK_STILL_FOUND").toEqual([{ path: "notes/vow.txt", masked: "me/sub/vow.md" }]);
});

test("every outside name is reported, against the masked name that was found first", () => {
  const b = brain(); b.write("me/vow.md");
  b.link("me/oath.md", "notes/a"); b.link("me/oath.md", "logs/b"); b.link("me/vow.md", "notes/c");
  expect(providerHardlinks(b.root, ["me"]).map(link => link.path), "ALL_ALIASES_NAMED").toEqual(["logs/b", "notes/a", "notes/c"]);
});

test("names that are not valid UTF-8 are inspected under their raw bytes", () => {
  const b = brain();
  // 0xFF never decodes; the worker still addresses these names.
  const raw = (rel: string, byte: string) => Buffer.concat([Buffer.from(join(b.root, rel)), Buffer.from(byte, "latin1")]);
  fs.mkdirSync(raw("notes/", "\xff"), { recursive: true });
  fs.linkSync(join(b.root, "me/oath.md"), raw("notes/", "\xff/oath"));
  fs.linkSync(join(b.root, "me/oath.md"), raw("notes/x", "\xfe"));
  expect(providerHardlinks(b.root, ["me"]), "RAW_BYTE_NAMES_FOUND").toHaveLength(2);
});

test("a masked folder reached twice through a symlinked parent counts each name once", () => {
  const b = brain(); b.link("me/oath.md", "notes/x");
  fs.symlinkSync(".", join(b.root, "alias"));
  expect(providerHardlinks(b.root, ["me", "alias/me"]), "ALIASED_MASK_NOT_DOUBLE_COUNTED").toEqual([{ path: "notes/x", masked: "alias/me/oath.md" }]);
});

test("a masked folder that is a symbolic link is not followed; the launcher refuses it", () => {
  const b = brain(); b.link("me/oath.md", "notes/x");
  fs.symlinkSync("me", join(b.root, "alias"));
  expect(providerHardlinks(b.root, ["alias"])).toEqual([]);
});

test("without a masked file named elsewhere, nothing outside the masks is inspected", () => {
  const b = brain(); b.write("notes/plain.md"); b.write("notes/deep/plain.md");
  b.link("me/oath.md", "me/alias");
  const stat = fs.lstatSync;
  const seen: string[] = [];
  const spy = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof stat>) => { seen.push(String(args[0])); return stat(...args); }) as typeof stat);
  cleanup.push(() => spy.mockRestore());
  expect(providerHardlinks(b.root, ["me"])).toEqual([]);
  expect(seen.length, "THE_SPY_SEES_THE_SCAN").toBeGreaterThan(0);
  expect(seen.filter(path => !path.startsWith(join(b.root, "me"))), "OUTSIDE_WALK_SKIPPED").toEqual([]);
});

test("a masked file linked only from outside the brain is looked for, and not found", () => {
  const b = brain();
  const elsewhere = fs.mkdtempSync(join(tmpdir(), "odysseus-elsewhere-"));
  cleanup.push(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  try { fs.linkSync(join(b.root, "me/oath.md"), join(elsewhere, "oath")); } catch (error) {
    // Only a temporary directory on another device cannot hold the link.
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    return;
  }
  b.write("notes/plain.md");
  expect(providerHardlinks(b.root, ["me"])).toEqual([]);
});

test("the refusal names the hardlinks and how to fix them, not the selectors", () => {
  const links = ["a", "b", "c", "d", "e"].map(name => ({ path: `notes/${name}`, masked: "me/oath.md" }));
  const refusal = ProviderPolicyRefusedError.hardlinks(links);
  expect(refusal.name).toBe("ProviderPolicyRefusedError");
  expect(refusal.selectors).toHaveLength(5);
  expect(refusal.message).toContain("notes/a is a hardlink to me/oath.md; notes/b is a hardlink to me/oath.md; notes/c is a hardlink to me/oath.md; and 2 more");
  expect(refusal.message).toContain("Remove those hardlinks");
  expect(refusal.message).not.toContain("whole folders");
});
