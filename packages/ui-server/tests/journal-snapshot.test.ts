import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournalWalker } from "../src/brain/journal-snapshot.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "journal-odysseus-")); roots.push(root);
  mkdirSync(join(root, "notes"));
  const objects = new Map<string, Buffer>();
  const store = { putFile(fd: number) { const bytes = readFileSync(fd); const hash = createHash("sha256").update(bytes).digest("hex"); objects.set(hash, Buffer.from(bytes)); return hash; }, has(hash: string) { return objects.has(hash); } };
  return { root, objects, walker: createJournalWalker(root, store) };
}

test("raw CRLF note bytes and changed create/delete versions are independent of Git objects", () => {
  const { root, objects, walker } = fixture();
  const note = join(root, "notes", "odysseus.md");
  writeFileSync(note, "# Ithaca\r\nReturn by sea.\r\n");
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  const before = walker.begin();
  const entry = before.entries.find(item => item.path === "notes/odysseus.md");
  expect(entry?.hash, "JOURNAL_RAW_NOTE_CAPTURED").toBeDefined();
  expect(objects.get(entry!.hash!)).toEqual(readFileSync(note));
  writeFileSync(join(root, "notes", "athena.md"), "# Athena\nPlan the return.\n");
  rmSync(note); rmSync(join(root, ".git", "objects"), { recursive: true });
  const after = walker.observe();
  expect(after.entries.some(item => item.path === "notes/athena.md")).toBe(true);
  expect(after.entries.some(item => item.path === "notes/odysseus.md")).toBe(false);
  expect(objects.get(entry!.hash!)).toEqual(Buffer.from("# Ithaca\r\nReturn by sea.\r\n"));
});

test("turn-start ignore rules remain frozen and initial covered notes remain content", () => {
  const { root, walker } = fixture();
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(root, "ignored.txt"), "one");
  writeFileSync(join(root, "notes", "odysseus.md"), "Ithaca");
  walker.begin();
  writeFileSync(join(root, ".gitignore"), "notes/\n");
  writeFileSync(join(root, "notes", "odysseus.md"), "Return to Ithaca");
  writeFileSync(join(root, "ignored.txt"), "a longer ignored observation");
  const after = walker.observe();
  expect(after.entries.find(item => item.path === "notes/odysseus.md")?.hash, "JOURNAL_INITIAL_COVERAGE_PINNED").toBeDefined();
  expect(after.entries.find(item => item.path === "ignored.txt")).toMatchObject({ ignored: true, bytes: Buffer.byteLength("a longer ignored observation") });
});

test("ctime invalidates the host stat cache when a same-size edit restores mtime", () => {
  const { root, objects, walker } = fixture();
  const note = join(root, "notes", "odysseus.md"); writeFileSync(note, "Ithaca");
  const date = new Date("2026-07-12T09:00:00.000Z"); utimesSync(note, date, date);
  const info = statSync(note);
  const before = walker.begin().entries.find(item => item.path === "notes/odysseus.md");
  writeFileSync(note, "Athena"); utimesSync(note, info.atime, info.mtime);
  const after = walker.observe().entries.find(item => item.path === "notes/odysseus.md");
  expect(objects.get(after?.hash ?? ""), "JOURNAL_CTIME_CHANGED_BYTES").toEqual(Buffer.from("Athena"));
  expect(after?.hash).not.toBe(before?.hash);
});

test("workspace coverage and raw refs never read config hooks or Git object bytes", () => {
  const { root, objects, walker } = fixture();
  const workspace = join(root, "workspaces", "ithaca");
  for (const path of [join(root, ".git", "refs", "heads"), join(workspace, ".git", "refs", "heads"), join(workspace, "notes")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/return\r\n");
  writeFileSync(join(workspace, ".git", "refs", "heads", "return"), "fixture-ref\n");
  writeFileSync(join(workspace, "notes", "athena.md"), "# Athena\r\n");
  writeFileSync(join(workspace, ".git", "config"), "[core]\nfsmonitor = false\n");
  const snapshot = walker.begin();
  expect(snapshot.missing).toEqual([]);
  expect(snapshot.entries.some(entry => entry.path.endsWith(".git/config"))).toBe(false);
  const head = snapshot.entries.find(entry => entry.path === "workspaces/ithaca/.git/HEAD")!;
  expect(objects.get(head.hash!)).toEqual(Buffer.from("ref: refs/heads/return\r\n"));
  expect(snapshot.entries.find(entry => entry.path === "workspaces/ithaca/notes/athena.md")?.scope).toBe("workspaces/ithaca");
});

test("a nested ignore cannot reinclude a file below an excluded parent directory", () => {
  const { root, walker } = fixture();
  mkdirSync(join(root, "notes", "ignored"));
  writeFileSync(join(root, ".gitignore"), "notes/ignored/\n");
  writeFileSync(join(root, "notes", "ignored", ".gitignore"), "!odysseus.md\n");
  writeFileSync(join(root, "notes", "ignored", "odysseus.md"), "Ithaca");
  expect(walker.begin().entries.find(entry => entry.path === "notes/ignored/odysseus.md")).toMatchObject({ ignored: true });
});

test("newly created workspace ignore rules cannot remove content from the existing turn's observation", () => {
  const { root, walker } = fixture(); walker.begin();
  const workspace = join(root, "workspaces", "ithaca"); mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, ".gitignore"), "odysseus.md\n");
  writeFileSync(join(workspace, "odysseus.md"), "Ithaca");
  expect(walker.observe().entries.find(entry => entry.path === "workspaces/ithaca/odysseus.md")?.hash).toBeDefined();
});

test("20,000-file warm raw snapshot prints its timing and completes within the approved 500ms bound", () => {
  const { root, walker } = fixture();
  for (let i = 0; i < 20_000; i++) writeFileSync(join(root, "notes", `odysseus-${i}.md`), "# Ithaca\r\nReturn by sea.\r\n");
  walker.begin();
  const start = performance.now(), snapshot = walker.observe(), elapsed = performance.now() - start;
  console.log(`Journal 20,000-file warm raw snapshot: ${elapsed.toFixed(1)}ms`);
  expect(snapshot.entries).toHaveLength(20_000); expect(snapshot.missing).toEqual([]);
  expect(elapsed, "JOURNAL_WARM_20K_BELOW_500MS").toBeLessThan(500);
});

test("deterministic directory replacement between stat and open never captures the linked outside file", () => {
  const { root, objects, walker } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "journal-athena-outside-")); roots.push(outside);
  writeFileSync(join(outside, "athena-private.md"), "This owned fixture stays outside the snapshot.");
  writeFileSync(join(root, "notes", "odysseus.md"), "Ithaca");
  const open = fs.openSync;
  let swapped = false;
  const probe = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (!swapped && String(args[0]).endsWith("/notes")) {
      swapped = true;
      fs.renameSync(join(root, "notes"), join(root, "notes-before-swap"));
      fs.symlinkSync(outside, join(root, "notes"));
    }
    return open(...args);
  });
  try {
    const snapshot = walker.begin();
    expect(swapped).toBe(true);
    expect(snapshot.missing.map(entry => entry.path)).toContain("notes");
    expect(snapshot.entries.some(entry => entry.path.endsWith("athena-private.md")), "JOURNAL_DIRECTORY_SWAP_NOT_FOLLOWED").toBe(false);
    expect([...objects.values()].some(bytes => bytes.equals(Buffer.from("This owned fixture stays outside the snapshot.")))).toBe(false);
  } finally { probe.mockRestore(); }
});

test("a real skip-worktree note and malicious Git configuration remain raw data, never commands", () => {
  const { root, objects, walker } = fixture();
  const note = join(root, "notes", "odysseus.md"); writeFileSync(note, "# Ithaca\r\n");
  const env = { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args: string[]) => {
    const child = Bun.spawnSync(["git", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0); return child.stdout.toString();
  };
  git(["init", "-b", "main"]); git(["add", "notes/odysseus.md"]); git(["update-index", "--skip-worktree", "notes/odysseus.md"]);
  expect(git(["ls-files", "-v"]).trim()).toBe("S notes/odysseus.md");
  const sentinel = join(root, "git-must-not-run");
  const helper = join(root, "git-fixture-hook.sh");
  writeFileSync(helper, `#!/bin/sh\nprintf unexpected > '${sentinel}'\n`, { mode: 0o755 });
  writeFileSync(join(root, "included.config"), `[filter "odysseus"]\nclean = ${helper}\nsmudge = ${helper}\n`);
  writeFileSync(join(root, ".git", "config"), `[core]\nfsmonitor = ${helper}\n[include]\npath = ${join(root, "included.config")}\n`);
  writeFileSync(join(root, ".gitattributes"), "*.md filter=odysseus text eol=lf\n");
  const before = walker.begin().entries.find(entry => entry.path === "notes/odysseus.md")!;
  writeFileSync(note, "# Ithaca\r\nReturn by sea.\r\n");
  const after = walker.observe().entries.find(entry => entry.path === "notes/odysseus.md")!;
  expect(objects.get(after.hash!), "JOURNAL_SKIP_WORKTREE_RAW_EDIT").toEqual(readFileSync(note));
  expect(after.hash).not.toBe(before.hash);
  expect(existsSync(sentinel), "JOURNAL_GIT_CONFIGURATION_NEVER_EXECUTED").toBe(false);
});
