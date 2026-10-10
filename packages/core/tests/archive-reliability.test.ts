import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
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

describe("archive demotes a primary or unset relevance to historical", () => {
  // Archives notes/x.md (a non-project path, so it stays put) and returns the
  // relevance the archived file carries.
  async function archivedRelevance(relevance?: string): Promise<unknown> {
    const root = corpus();
    const line = relevance === undefined ? "" : `relevance: ${relevance}\n`;
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes/x.md"), `---\ntitle: X\ntype: note\nstatus: active\n${line}---\nBody.\n`);
    await archiveDocument(root, "notes/x.md");
    const data = parseFrontmatter(readFileSync(join(root, "notes/x.md"), "utf8")).data;
    expect(data.status).toBe("archived");
    return data.relevance;
  }

  test("primary becomes historical", async () => {
    expect(await archivedRelevance("primary")).toBe("historical");
  });

  test("a missing relevance becomes historical", async () => {
    expect(await archivedRelevance()).toBe("historical");
  });

  test("an explicit secondary stays secondary", async () => {
    expect(await archivedRelevance("secondary")).toBe("secondary");
  });

  test("the moved project path carries the demotion too", async () => {
    const root = corpus();
    writeFileSync(join(root, "projects/active/demo.md"), source.replace("status: active\n", "status: active\nrelevance: primary\n"));
    const result = await archiveDocument(root, "projects/active/demo.md");
    expect(parseFrontmatter(readFileSync(join(root, result.path), "utf8")).data.relevance).toBe("historical");
  });
});
