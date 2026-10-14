/** Legacy raw-history semantics exercised through native capture, not a second walker. */
import { expect, spyOn, test } from "bun:test";
import * as asyncFs from "node:fs/promises";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { readNativeJournalFile } from "../src/brain/native-journal-read.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "native-history-odysseus-")), root = join(directory, "brain"), dbPath = join(directory, "ui.db");
  mkdirSync(join(root, "notes"), { recursive: true });
  const db = createUiDb(dbPath), native = createNativeJournalFixture(root, directory);
  const journal = createTurnJournal(db, { brainPath: root, dbPath, objectsRoot: join(directory, "objects"), nativeManager: native.manager });
  return { root, directory, db, journal,
    begin: () => journal.begin("odysseus", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, () => {}),
    async observe() { await journal.observe(); return journal.details("ithaca", "odysseus")!; },
    bytes(path: string, side: "before" | "after") {
      const change = journal.details("ithaca", "odysseus")!.changes.findLast(item => item.path === path)!;
      return journal.version("ithaca", "odysseus", change.sequence, side)!.bytes(1024 * 1024);
    },
    async close() { try { await journal.close(); } finally { db.close(); await native.close(); rmSync(directory, { recursive: true, force: true }); } },
  };
}

test("native changed capture keeps exact CRLF create/delete versions without Git object storage", async () => {
  const f = fixture(), note = join(f.root, "notes/odysseus.md");
  try {
    writeFileSync(note, "# Ithaca\r\nReturn by sea.\r\n"); mkdirSync(join(f.root, ".git/objects"), { recursive: true });
    await f.begin();
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_objects").get(), "NATIVE_HISTORY_UNCHANGED_BASELINE_HAS_NO_OBJECTS").toEqual({ n: 0 });
    writeFileSync(join(f.root, "notes/athena.md"), "# Athena\nPlan the return.\n"); rmSync(note); rmSync(join(f.root, ".git/objects"), { recursive: true });
    const details = await f.observe();
    expect(details.changes.find(item => item.path === "notes/odysseus.md")).toMatchObject({ before: { kind: "file" }, after: null });
    expect(details.changes.find(item => item.path === "notes/athena.md")).toMatchObject({ before: null, after: { kind: "file" } });
    expect(f.bytes("notes/odysseus.md", "before"), "NATIVE_HISTORY_DELETED_RAW_CRLF_PRESERVED").toEqual(Buffer.from("# Ithaca\r\nReturn by sea.\r\n"));
    expect(f.bytes("notes/athena.md", "after")).toEqual(readFileSync(join(f.root, "notes/athena.md")));
  } finally { await f.close(); }
});

test("native changed capture freezes admitted ignore rules while ignored changes retain metadata only", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, ".gitignore"), "ignored.txt\n"); writeFileSync(join(f.root, "ignored.txt"), "one"); writeFileSync(join(f.root, "notes/odysseus.md"), "Ithaca");
    await f.begin();
    writeFileSync(join(f.root, ".gitignore"), "notes/\n"); writeFileSync(join(f.root, "notes/odysseus.md"), "Return to Ithaca"); writeFileSync(join(f.root, "ignored.txt"), "a longer ignored observation");
    const details = await f.observe();
    expect(f.bytes("notes/odysseus.md", "after"), "NATIVE_HISTORY_FROZEN_CONTENT_COVERAGE").toEqual(Buffer.from("Return to Ithaca"));
    const ignored = details.changes.find(item => item.path === "ignored.txt")!;
    expect(ignored.after).toMatchObject({ ignored: true, bytes: Buffer.byteLength("a longer ignored observation") });
    expect(ignored.after?.hash).toBeUndefined();
  } finally { await f.close(); }
});

test("native changed capture detects a same-size edit with restored mtime", async () => {
  const f = fixture(), note = join(f.root, "notes/odysseus.md");
  try {
    writeFileSync(note, "Ithaca"); const date = new Date("2026-07-12T09:00:00.000Z"); utimesSync(note, date, date); const before = statSync(note);
    await f.begin(); writeFileSync(note, "Athena"); utimesSync(note, before.atime, before.mtime);
    expect(statSync(note).mtimeMs).toBe(before.mtimeMs);
    const details = await f.observe(), change = details.changes.find(item => item.path === "notes/odysseus.md")!;
    expect(f.bytes(change.path, "before")).toEqual(Buffer.from("Ithaca"));
    expect(f.bytes(change.path, "after"), "NATIVE_HISTORY_RESTORED_MTIME_CHANGED_BYTES").toEqual(Buffer.from("Athena"));
    expect(change.after?.hash).not.toBe(change.before?.hash);
  } finally { await f.close(); }
});

test("native workspace history retains raw HEAD and refs but excludes Git config and object bytes", async () => {
  const f = fixture(), workspace = join(f.root, "workspaces/ithaca");
  try {
    for (const path of [join(f.root, ".git/refs/heads"), join(workspace, ".git/refs/heads"), join(workspace, "notes")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(f.root, ".git/HEAD"), "ref: refs/heads/main\n"); writeFileSync(join(workspace, ".git/HEAD"), "ref: refs/heads/return\r\n");
    writeFileSync(join(workspace, ".git/refs/heads/return"), "fixture-ref\n"); writeFileSync(join(workspace, "notes/athena.md"), "# Athena\r\n");
    writeFileSync(join(workspace, ".git/config"), "[core]\nfsmonitor = false\n"); mkdirSync(join(workspace, ".git/objects")); writeFileSync(join(workspace, ".git/objects/fixture"), "excluded raw Git object");
    await f.begin();
    writeFileSync(join(workspace, ".git/HEAD"), "ref: refs/heads/harbor\r\n"); writeFileSync(join(workspace, ".git/refs/heads/return"), "updated-ref\n");
    writeFileSync(join(workspace, "notes/athena.md"), "# Athena\r\nHarbor plan.\r\n"); writeFileSync(join(workspace, ".git/config"), "[core]\nfsmonitor = malicious\n"); writeFileSync(join(workspace, ".git/objects/fixture"), "excluded changed raw Git object");
    const details = await f.observe();
    expect(details.changes.some(item => item.path.endsWith(".git/config") || item.path.includes(".git/objects/")), "NATIVE_HISTORY_GIT_EXECUTION_INPUTS_NOT_RETAINED").toBe(false);
    expect(f.bytes("workspaces/ithaca/.git/HEAD", "before")).toEqual(Buffer.from("ref: refs/heads/return\r\n"));
    expect(f.bytes("workspaces/ithaca/.git/HEAD", "after")).toEqual(Buffer.from("ref: refs/heads/harbor\r\n"));
    expect(f.bytes("workspaces/ithaca/.git/refs/heads/return", "after")).toEqual(Buffer.from("updated-ref\n"));
    expect(details.changes.find(item => item.path === "workspaces/ithaca/notes/athena.md")?.scope).toBe("workspaces/ithaca");
    expect(details.missing).toEqual([]);
  } finally { await f.close(); }
});

test("native history cannot reinclude a changed file beneath an ignored parent", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "notes/ignored")); writeFileSync(join(f.root, ".gitignore"), "notes/ignored/\n");
    writeFileSync(join(f.root, "notes/ignored/.gitignore"), "!odysseus.md\n"); writeFileSync(join(f.root, "notes/ignored/odysseus.md"), "Ithaca");
    await f.begin(); writeFileSync(join(f.root, "notes/ignored/odysseus.md"), "Return to Ithaca");
    const details = await f.observe(), change = details.changes.find(item => item.path === "notes/ignored/odysseus.md")!;
    expect(change.after).toMatchObject({ ignored: true }); expect(change.after?.hash).toBeUndefined();
  } finally { await f.close(); }
});

test("a new workspace ignore file cannot hide its new content from an existing native turn", async () => {
  const f = fixture();
  try {
    await f.begin(); const workspace = join(f.root, "workspaces/ithaca"); mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, ".gitignore"), "odysseus.md\n"); writeFileSync(join(workspace, "odysseus.md"), "Ithaca");
    await f.observe(); expect(f.bytes("workspaces/ithaca/odysseus.md", "after"), "NATIVE_HISTORY_LATE_WORKSPACE_RULES_NOT_ADOPTED").toEqual(Buffer.from("Ithaca"));
  } finally { await f.close(); }
});

test("native descriptor reads refuse a directory replaced by an outside link during open", async () => {
  const f = fixture(), outside = join(f.directory, "outside"); mkdirSync(outside); writeFileSync(join(outside, "odysseus.md"), "Athena's private advice");
  writeFileSync(join(f.root, "notes/odysseus.md"), "Ithaca");
  const open = asyncFs.open; let swapped = false;
  const probe = spyOn(asyncFs, "open").mockImplementation((...args: Parameters<typeof asyncFs.open>) => {
    if (!swapped && String(args[0]).endsWith("/notes")) { swapped = true; renameSync(join(f.root, "notes"), join(f.root, "notes-before-swap")); symlinkSync(outside, join(f.root, "notes")); }
    return open(...args);
  });
  try {
    await expect(readNativeJournalFile(f.root, "notes/odysseus.md", 1024), "NATIVE_HISTORY_DIRECTORY_SWAP_NOT_FOLLOWED").rejects.toThrow();
    expect(swapped).toBe(true); expect(readFileSync(join(outside, "odysseus.md"), "utf8")).toBe("Athena's private advice");
  } finally { probe.mockRestore(); await f.close(); }
});

test("real skip-worktree and malicious Git filters/config remain raw changed bytes and never commands", async () => {
  const f = fixture(), note = join(f.root, "notes/odysseus.md");
  try {
    writeFileSync(note, "# Ithaca\r\n");
    const env = { PATH: "/usr/bin:/bin", HOME: f.root, GIT_CONFIG_NOSYSTEM: "1" };
    const git = (args: string[]) => { const child = Bun.spawnSync(["git", ...args], { cwd: f.root, env, stdout: "pipe", stderr: "pipe" }); expect(child.exitCode, child.stderr.toString()).toBe(0); return child.stdout.toString(); };
    git(["init", "-b", "main"]); git(["add", "notes/odysseus.md"]); git(["update-index", "--skip-worktree", "notes/odysseus.md"]);
    expect(git(["ls-files", "-v"]).trim()).toBe("S notes/odysseus.md");
    const sentinel = join(f.root, "git-must-not-run"), helper = join(f.root, "git-fixture-hook.sh");
    writeFileSync(helper, `#!/bin/sh\nprintf unexpected > '${sentinel}'\n`, { mode: 0o755 });
    writeFileSync(join(f.root, "included.config"), `[filter "odysseus"]\nclean = ${helper}\nsmudge = ${helper}\n`);
    writeFileSync(join(f.root, ".git/config"), `[core]\nfsmonitor = ${helper}\n[include]\npath = ${join(f.root, "included.config")}\n`);
    writeFileSync(join(f.root, ".gitattributes"), "*.md filter=odysseus text eol=lf\n");
    await f.begin(); writeFileSync(note, "# Ithaca\r\nReturn by sea.\r\n"); await f.observe();
    expect(f.bytes("notes/odysseus.md", "after"), "NATIVE_HISTORY_SKIP_WORKTREE_RAW_EDIT").toEqual(readFileSync(note));
    expect(f.bytes("notes/odysseus.md", "before")).toEqual(Buffer.from("# Ithaca\r\n"));
    expect(existsSync(sentinel), "NATIVE_HISTORY_GIT_CONFIGURATION_NEVER_EXECUTED").toBe(false);
  } finally { await f.close(); }
});
