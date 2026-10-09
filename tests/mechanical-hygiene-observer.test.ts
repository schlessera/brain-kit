import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeTree, treeChanges } from "../scripts/evals/mechanical-hygiene/observer";

test("whole-tree evidence sees unexpected binary writes, deleted files and complete hygiene logs", () => {
  const root = mkdtempSync(join(tmpdir(), "hygiene-observer-"));
  try {
    mkdirSync(join(root, "context/hygiene"), { recursive: true });
    writeFileSync(join(root, "context/hygiene/log.md"), "Before the council.\n");
    writeFileSync(join(root, "context/raft.md"), "The sail stays tied.\n");
    const before = observeTree(root);
    writeFileSync(join(root, "unexpected.bin"), Buffer.from([0, 255, 17]));
    rmSync(join(root, "context/raft.md"));
    writeFileSync(join(root, "context/hygiene/log.md"), "After the council.\n");
    const after = observeTree(root);
    expect(after["unexpected.bin"]?.bytesBase64).toBe("AP8R");
    expect(Buffer.from(after["context/hygiene/log.md"]!.bytesBase64!, "base64").toString()).toBe("After the council.\n");
    expect(treeChanges(before, after)).toMatchObject({
      created: ["unexpected.bin"], deleted: ["context/raft.md"], content: ["context/hygiene/log.md"],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("symlink evidence retains its target without reading outside the fixture", () => {
  const parent = mkdtempSync(join(tmpdir(), "hygiene-symlink-")), root = join(parent, "brain");
  try {
    mkdirSync(root);
    const outside = join(parent, "outside.bin");
    writeFileSync(outside, Buffer.from([128, 0, 127]));
    symlinkSync(outside, join(root, "link"));
    const observed = observeTree(root);
    expect(observed.link).toMatchObject({ kind: "symlink", target: outside });
    expect(observed.link?.bytesBase64).toBeUndefined();
    expect(Object.keys(observed)).toEqual(["link"]);
    expect(readFileSync(outside)).toEqual(Buffer.from([128, 0, 127]));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("unchanged content cannot hide timestamp churn or changed permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "hygiene-metadata-"));
  try {
    const path = join(root, "raft.md");
    writeFileSync(path, "Odysseus checks the mast.\n"); chmodSync(path, 0o600);
    utimesSync(path, new Date("2026-07-11T00:00:00Z"), new Date("2026-07-11T00:00:00Z"));
    const before = observeTree(root);
    chmodSync(path, 0o644);
    utimesSync(path, new Date("2026-07-12T00:00:00Z"), new Date("2026-07-12T00:00:00Z"));
    expect(treeChanges(before, observeTree(root))).toEqual({ created: [], deleted: [], content: [], metadata: ["raft.md"] });
    const once = observeTree(root);
    expect(treeChanges(once, observeTree(root))).toEqual({ created: [], deleted: [], content: [], metadata: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
