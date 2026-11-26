import { expect, test } from "bun:test";
import { freezeNativeJournalPolicy, journalPathScope } from "../src/brain/native-journal-policy.js";

const file = (path: string) => ({ path, kind: "file" as const, bytes: 20 });
test("native admission reads only bounded ignore inputs and freezes them across later edits", async () => {
  const reads: string[] = [];
  const entries = [file(".gitignore"), file("notes/odysseus.md"), file("secret.txt"), file("workspaces/voyage/.gitignore"), file("workspaces/voyage/draft.tmp")];
  const original = await freezeNativeJournalPolicy(entries, async path => {
    reads.push(path); return Buffer.from(path === ".gitignore" ? "secret.txt\n" : "*.tmp\n");
  });
  expect(reads, "NATIVE_ADMISSION_NO_CONTENT_BASELINE").toEqual([".gitignore", "workspaces/voyage/.gitignore"]);
  expect(original.ignored("secret.txt")).toBe(true);
  expect(original.ignored("workspaces/voyage/draft.tmp")).toBe(true);
  expect(original.ignored("workspaces/voyage/secret.txt")).toBe(false);
  const subsequent = await freezeNativeJournalPolicy(entries, async () => Buffer.from("notes/\n"));
  expect(subsequent.ignored("secret.txt")).toBe(false);
  expect(subsequent.ignored("notes/odysseus.md")).toBe(true);
  expect(original.ignored("notes/odysseus.md"), "NATIVE_RULES_FROZEN_PER_TURN").toBe(false);
  original.cover(["secret.txt"]);
  expect(original.ignored("secret.txt")).toBe(false);
});

test("ignored parent directories remain excluded, while raw Git reference coverage is retained", async () => {
  const policy = await freezeNativeJournalPolicy([file(".gitignore"), file("hidden/.gitignore")], async path => Buffer.from(path === ".gitignore" ? "hidden/\n.git/\n" : "!odysseus.md\n"));
  expect(policy.ignored("hidden/odysseus.md"), "NATIVE_IGNORE_PARENT_NOT_RESURRECTED").toBe(true);
  expect(policy.ignored(".git/HEAD")).toBe(false);
  expect(policy.ignored("workspaces/voyage/.git/refs/heads/main")).toBe(false);
  expect(journalPathScope(".git/objects/aa/bb")).toBeNull();
  expect(journalPathScope("notes/.git/HEAD")).toBeNull();
});

test("native ignore inputs reject symlinks and excessive sizes before reading", async () => {
  let reads = 0;
  const read = async () => { reads++; return Buffer.alloc(0); };
  await expect(freezeNativeJournalPolicy([{ path: ".gitignore", kind: "symlink", bytes: 12 }], read)).rejects.toThrow("bounded regular file");
  await expect(freezeNativeJournalPolicy([{ path: ".gitignore", kind: "file", bytes: 1024 * 1024 + 1 }], read)).rejects.toThrow("bounded regular file");
  expect(reads).toBe(0);
});

test("inspect workspace policy reads no checkout ignore files and cannot be covered back in", async () => {
  const reads: string[] = [];
  const policy = await freezeNativeJournalPolicy([
    file(".gitignore"), file("workspaces/ithaca/.gitignore"),
    { path: "workspaces/ithaca/nested/.gitignore", kind: "symlink", bytes: 0 },
  ], async path => { reads.push(path); return Buffer.from(""); }, [], { workspaces: false });
  expect(reads, "INSPECT_NEVER_READS_CHECKOUT_POLICY").toEqual([".gitignore"]);
  expect(policy.excluded("workspaces/ithaca/note.md"), "INSPECT_WORKSPACE_EXCLUDED").toBe(true);
  policy.cover(["workspaces/ithaca/note.md"]);
  expect(policy.excluded("workspaces/ithaca/note.md")).toBe(true);
  expect(policy.excluded("workspaces-old/note.md")).toBe(false);
});

test("absent-area workspace names use ordinary root scope before Git exclusions",async()=>{
 const policy=await freezeNativeJournalPolicy([],async()=>Buffer.alloc(0),[],{ordinaryWorkspaces:true});
 for(const path of ["workspaces/ithaca/.git/HEAD","notes/ithaca/.git/HEAD"])expect(policy.location(path),"ORDINARY_NESTED_GIT_HAS_NO_CHECKOUT_EXEMPTION").toBeNull();
 expect(policy.location("workspaces/ithaca/source.md"),"ORDINARY_WORKSPACE_ROWS_USE_ROOT_SCOPE").toEqual({scope:"",local:"workspaces/ithaca/source.md",refs:false});
});
