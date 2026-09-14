import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { archiveDocument } from "../src/lib/archiver";

const roots: string[] = [];
const source = "---\ntitle: Demo\ntype: project\nstatus: active\n---\nNew project.\n";
function corpus() {
  const root = mkdtempSync(join(tmpdir(), "brain-archive-test-"));
  roots.push(root);
  mkdirSync(join(root, "projects/active"), { recursive: true });
  mkdirSync(join(root, "projects/archive"), { recursive: true });
  writeFileSync(join(root, "projects/active/demo.md"), source);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const dryRun of [false, true]) {
  test(`archive collision preserves both files (dryRun=${dryRun})`, async () => {
    const root = corpus();
    const destination = join(root, "projects/archive/demo.md");
    writeFileSync(destination, "Older project history.");
    let indexed = false;
    await expect(archiveDocument(root, "projects/active/demo.md", {
      dryRun, reindex: async () => { indexed = true; },
    })).rejects.toThrow("Archive destination already exists");
    expect(readFileSync(destination, "utf8")).toBe("Older project history.");
    expect(readFileSync(join(root, "projects/active/demo.md"), "utf8")).toBe(source);
    expect(indexed).toBe(false);
    expect(readdirSync(join(root, "projects/archive"))).toEqual(["demo.md"]);
  });
}

test("archive publishes the complete updated document then removes the source", async () => {
  const root = corpus();
  const result = await archiveDocument(root, "projects/active/demo.md");
  expect(result).toMatchObject({ path: "projects/archive/demo.md", moved: true, status: "archived" });
  expect(existsSync(join(root, "projects/active/demo.md"))).toBe(false);
  const archived = readFileSync(join(root, result.path), "utf8");
  expect(archived).toContain("status: archived");
  expect(archived).toContain("New project.");
  expect(readdirSync(join(root, "projects/archive"))).toEqual(["demo.md"]);
});

test("dry run creates no archive and leaves the source unchanged", async () => {
  const root = corpus();
  expect(await archiveDocument(root, "projects/active/demo.md", { dryRun: true })).toMatchObject({ moved: true, dryRun: true });
  expect(readFileSync(join(root, "projects/active/demo.md"), "utf8")).toBe(source);
  expect(readdirSync(join(root, "projects/archive"))).toEqual([]);
});

test("an in-root destination symlink cannot overwrite its target", async () => {
  const root = corpus();
  writeFileSync(join(root, "older.md"), "Keep this history.");
  symlinkSync("../../older.md", join(root, "projects/archive/demo.md"));
  await expect(archiveDocument(root, "projects/active/demo.md")).rejects.toThrow("already exists");
  expect(readFileSync(join(root, "older.md"), "utf8")).toBe("Keep this history.");
  expect(readFileSync(join(root, "projects/active/demo.md"), "utf8")).toBe(source);
});
