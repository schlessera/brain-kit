import { afterAll, describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../src/lib/frontmatter-parse";
import {
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  checkOkfBundle,
  exportOkfBundle,
  OkfExportError,
} from "../src/lib/okf-exporter";
import { getMarkdownFiles } from "../src/lib/indexer";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { makeTempBrain, runCli } from "./cli-harness";

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function document(
  title: string,
  body: string,
  extra: string[] = []
): string {
  return [
    "---",
    "type: note",
    `title: ${title}`,
    "created: 2026-01-02",
    "updated: 2026-02-03",
    "tags: [fixture, portable]",
    ...extra,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function makeBrain(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "brain-kit-okf-test-"));
  fixtures.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function taxonomy() {
  return buildTaxonomy({
    user: {
      taxonomy: {
        dirAnchors: ["status.md"],
      },
    },
  });
}

function fullFixture(): string {
  return makeBrain({
    "notes/source.md": document(
      "Source Note",
      [
        "Plain [[plain]] and aliased [[plain|friendly label]].",
        "Fragment [[plain#details]] and qualified [[library/reference]].",
        "Frontmatter alias [[field guide]] and index anchor [[talks]].",
        "Directory status anchor [[some-dir]].",
        "Ambiguous [[duplicate]] and unresolved [[missing-note]].",
        "Inline `[[plain]]` stays literal.",
        "",
        "```ts",
        "const matrix = [['a', 1]]; // [[plain]] stays literal",
        "```",
      ].join("\n"),
      [
        "summary: A portable source note.",
        "repo: example-org/field-notes",
        "aliases: [source, origin note]",
        "custom_key: retained",
        "deadline: 2026-09-10",
      ]
    ),
    "notes/plain.md": document("Plain Target", "## Details\n\nTarget body."),
    "library/reference.md": document(
      "Reference",
      "Reference body.",
      ["aliases: [field guide]", "resource: https://example.test/reference", "repo: example-org/reference"]
    ),
    "talks/_index.md": document("Talk Registry", "Registry body.", ["summary: A registry of sample talks."]),
    "some-dir/status.md": document("Directory Status", "Status body."),
    "alpha/duplicate.md": document("Duplicate Alpha", "Alpha body."),
    "beta/duplicate.md": document("Duplicate Beta", "Beta body."),
    "assets/map.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
}

function snapshotTree(root: string): Record<string, string> {
  const glob = new Bun.Glob("**/*");
  const snapshot: Record<string, string> = {};
  for (const path of [...glob.scanSync({ cwd: root, onlyFiles: true })].sort()) {
    snapshot[path] = readFileSync(join(root, path)).toString("base64");
  }
  return snapshot;
}

describe("OKF exporter", () => {
  test("an exact file rule cannot authorize a directory visible to indexing", async () => {
    const root = makeBrain({ "notes/source.md": document("Source", "Nonempty source") });
    const custom = buildTaxonomy({ user: { exclude: { files: ["published"] } } });
    await expect(exportOkfBundle({ root, taxonomy: custom, outDir: "published" })).rejects.toThrow("must be excluded from indexing");
    expect(snapshotTree(root)).toEqual({ "notes/source.md": Buffer.from(document("Source", "Nonempty source")).toString("base64") });
  });

  test("preserves protected directories even with an exporter marker", async () => {
    for (const outDir of [".git", ".agents", "scripts", "workspaces", ".brain-ui", "node_modules", ".git/nested"]) {
      const root = makeBrain({
        [`${outDir}/keep.txt`]: "valuable data",
        [`${outDir}/.brain-okf-export`]: "brain-kit OKF export\n",
      });
      await expect(exportOkfBundle({ root, taxonomy: taxonomy(), outDir })).rejects.toThrow("protected");
      expect(readFileSync(join(root, outDir, "keep.txt"), "utf8")).toBe("valuable data");
    }
  });

  test("preserves unowned output and refuses a symlinked ownership marker", async () => {
    const root = makeBrain({ "okf-dist/keep.txt": "valuable data", "marker.txt": "brain-kit OKF export\n" });
    await expect(exportOkfBundle({ root, taxonomy: taxonomy() })).rejects.toThrow("nonempty directory");
    symlinkSync(join(root, "marker.txt"), join(root, "okf-dist/.brain-okf-export"));
    await expect(exportOkfBundle({ root, taxonomy: taxonomy() })).rejects.toThrow("nonempty directory");
    expect(readFileSync(join(root, "okf-dist/keep.txt"), "utf8")).toBe("valuable data");
  });

  test("accepts an empty custom excluded destination and replaces owned output", async () => {
    const root = makeBrain({ "note.md": document("Note", "First body") });
    const custom = buildTaxonomy({ user: { exclude: { dirs: ["published"] } } });
    mkdirSync(join(root, "published"));
    await exportOkfBundle({ root, taxonomy: custom, outDir: "published" });
    writeFileSync(join(root, "note.md"), document("Note", "Updated body"));
    await exportOkfBundle({ root, taxonomy: custom, outDir: "published" });
    expect(readFileSync(join(root, "published/note.md"), "utf8")).toContain("Updated body");
  });

  for (const outDir of ["published", "nested/published"]) {
    test(`a directory segment authorizes ${outDir} and keeps its output out of indexing`, async () => {
      const root = makeBrain({ "notes/source.md": document("Source", "Nonempty source") });
      const custom = buildTaxonomy({ user: { exclude: { segments: ["published"] } } });
      await exportOkfBundle({ root, taxonomy: custom, outDir });
      expect(readFileSync(join(root, outDir, "notes/source.md"), "utf8")).toContain("Nonempty source");
      expect(getMarkdownFiles(root, custom)).toEqual(["notes/source.md"]);
    });
  }

  test("converts every wiki-link form and leaves fenced/inline code untouched", async () => {
    const root = fullFixture();
    const report = await exportOkfBundle({ root, taxonomy: taxonomy() });
    const output = readFileSync(join(root, "okf-dist/notes/source.md"), "utf-8");

    expect(output).toContain("[plain](/notes/plain.md)");
    expect(output).toContain("[friendly label](/notes/plain.md)");
    expect(output).toContain("[plain](/notes/plain.md#details)");
    expect(output).toContain("[library/reference](/library/reference.md)");
    expect(output).toContain("[field guide](/library/reference.md)");
    expect(output).toContain("[talks](/talks/_index.md)");
    expect(output).toContain("[some-dir](/some-dir/status.md)");
    expect(output).toContain("Ambiguous duplicate and unresolved missing-note.");
    expect(output).toContain("Inline `[[plain]]` stays literal.");
    expect(output).toContain("const matrix = [['a', 1]]; // [[plain]] stays literal");
    expect(report.linksConverted).toBe(7);
    expect(report.linksDegraded).toBe(2);
    expect(report.degradedLinks.map((item) => item.link)).toEqual(["duplicate", "missing-note"]);
  });

  test("real fixture export gives same-document heading links visible text", async () => {
    const root = makeTempBrain();
    fixtures.push(root);
    const sourcePath = "notes/anchor-test.md";
    const source = document("Anchor test", [
      "## Section one",
      "",
      "Plain: [[#Section one]]",
      "Labelled: [[#Section one|read this section]]",
      "Trailing slash: [[#Section one/]]",
      "Missing heading: [[#Missing heading]]",
    ].join("\n"));
    writeFileSync(join(root, sourcePath), source);
    const before = snapshotTree(root);
    expect(before[sourcePath]).toBe(Buffer.from(source).toString("base64"));
    expect(Object.keys(before).length).toBeGreaterThan(1);

    const exported = await runCli(root, ["okf", "export", "--json"]);
    expect(exported.code).toBe(0);
    const output = readFileSync(join(root, "okf-dist", sourcePath), "utf8");
    expect(output).toContain("Plain: [Section one](/notes/anchor-test.md#Section one)");
    expect(output).toContain("Labelled: [read this section](/notes/anchor-test.md#Section one)");
    expect(output).toContain("Trailing slash: [Section one/](/notes/anchor-test.md#Section one/)");
    expect(output).toContain("Missing heading: [Missing heading](/notes/anchor-test.md#Missing heading)");
    const after = Object.fromEntries(
      Object.entries(snapshotTree(root)).filter(([path]) => !path.startsWith("okf-dist/"))
    );
    expect(after).toEqual(before);
  });

  test("maps OKF fields, preserves extensions, and keeps timestamp/date/array scalar styles", async () => {
    const root = fullFixture();
    await exportOkfBundle({ root, taxonomy: taxonomy() });
    const sourceRaw = readFileSync(join(root, "okf-dist/notes/source.md"), "utf-8");
    const source = parseFrontmatter(sourceRaw);

    expect(source.data.description).toBe("A portable source note.");
    expect(source.data.summary).toBeUndefined();
    expect(source.data.resource).toBe("https://github.com/example-org/field-notes");
    expect(source.data.repo).toBe("example-org/field-notes");
    expect(source.data.timestamp).toBe("2026-02-03T00:00:00Z");
    expect(typeof source.data.timestamp).toBe("string");
    expect(source.data.custom_key).toBe("retained");
    expect(source.data.deadline).toBeInstanceOf(Date);
    expect(sourceRaw).toContain("tags: [fixture, portable]");
    expect(sourceRaw).toContain("aliases: [source, origin note]");
    expect(sourceRaw).toMatch(/^created: 2026-01-02$/m);
    expect(sourceRaw).toMatch(/^updated: 2026-02-03$/m);
    expect(sourceRaw).toMatch(/^deadline: 2026-09-10$/m);

    const nativeResource = parseFrontmatter(readFileSync(join(root, "okf-dist/library/reference.md"), "utf-8"));
    expect(nativeResource.data.resource).toBe("https://example.test/reference");
  });

  test("uses the git commit datetime in one history-derived timestamp map", async () => {
    const root = makeBrain({
      "notes/committed.md": document("Committed Note", "Versioned body."),
    });
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Fixture Author"],
      ["config", "user.email", "fixture@example.test"],
      ["add", "notes/committed.md"],
    ]) {
      expect(Bun.spawnSync(["git", "-C", root, ...args]).exitCode).toBe(0);
    }
    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-03-04 12:34:56 +0200",
      GIT_COMMITTER_DATE: "2026-03-04 12:34:56 +0200",
    };
    const commit = Bun.spawnSync([
      "git", "-C", root, "-c", "commit.gpgsign=false", "commit", "-qm", "Add fixture concept",
    ], { env });
    expect(new TextDecoder().decode(commit.stderr)).toBe("");
    expect(commit.exitCode).toBe(0);

    await exportOkfBundle({ root, taxonomy: taxonomy() });
    const exported = parseFrontmatter(readFileSync(join(root, "okf-dist/notes/committed.md"), "utf-8"));
    expect(exported.data.timestamp).toBe("2026-03-04T12:34:56+02:00");
    expect(typeof exported.data.timestamp).toBe("string");
  });

  test("generates root and per-directory indexes with descriptions and relative links", async () => {
    const root = fullFixture();
    const report = await exportOkfBundle({ root, taxonomy: taxonomy() });
    const rootIndex = readFileSync(join(root, "okf-dist/index.md"), "utf-8");
    const notesIndex = readFileSync(join(root, "okf-dist/notes/index.md"), "utf-8");

    expect(rootIndex).toStartWith('---\nokf_version: "0.1"\n---\n');
    expect(rootIndex).toContain("* [notes](notes/)");
    expect(rootIndex).toContain("* [talks](talks/) - A registry of sample talks.");
    expect(notesIndex).not.toStartWith("---");
    expect(notesIndex).toContain("# Notes");
    expect(notesIndex).toContain("* [Source Note](source.md) - A portable source note.");
    expect(notesIndex).toContain("* [Plain Target](plain.md)\n");
    expect(notesIndex).not.toContain("Plain Target](plain.md) -");
    expect(report.indexFilesGenerated).toBeGreaterThan(1);
    expect(report.topLevelDirectories).toEqual([
      "alpha", "assets", "beta", "library", "notes", "some-dir", "talks",
    ]);
    expect(readFileSync(join(root, "okf-dist/assets/map.png"))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  test("fails before wiping output when a source concept uses a reserved name", async () => {
    const root = makeBrain({
      "notes/index.md": document("Reserved Concept", "Must be renamed."),
      "okf-dist/keep.txt": "existing output",
    });
    await expect(exportOkfBundle({ root, taxonomy: taxonomy() })).rejects.toThrow(OkfExportError);
    expect(readFileSync(join(root, "okf-dist/keep.txt"), "utf-8")).toBe("existing output");
  });

  test("exports a conformant bundle and produces byte-identical consecutive runs", async () => {
    const root = fullFixture();
    const first = await exportOkfBundle({ root, taxonomy: taxonomy() });
    const checked = checkOkfBundle(join(root, "okf-dist"));
    expect(first.filesExported).toBe(7);
    expect(checked.ok).toBe(true);
    expect(checked.errors).toBe(0);
    expect(checked.warnings).toBe(0);
    expect(getMarkdownFiles(root, taxonomy())).toHaveLength(7);

    const before = snapshotTree(join(root, "okf-dist"));
    await exportOkfBundle({ root, taxonomy: taxonomy() });
    expect(snapshotTree(join(root, "okf-dist"))).toEqual(before);
  });

  test("applies include/exclude scope and refuses an output directory visible to indexing", async () => {
    const root = fullFixture();
    const report = await exportOkfBundle({
      root,
      taxonomy: taxonomy(),
      include: ["notes", "library"],
      exclude: ["library"],
      copyAssets: false,
    });
    expect(report.filesExported).toBe(2);
    expect(report.assetsCopied).toBe(0);
    expect(report.topLevelDirectories).toEqual(["notes"]);
    expect(readFileSync(join(root, "okf-dist/notes/source.md"), "utf-8")).not.toContain("/library/");

    await expect(
      exportOkfBundle({ root, taxonomy: taxonomy(), outDir: "published-bundle" })
    ).rejects.toThrow("must be excluded from indexing");
  });
});

describe("OKF checker", () => {
  test("treats broken internal links as warnings but reserved-file structure as conformance errors", () => {
    const warningRoot = makeBrain({
      "index.md": "# Bundle\n\n* [Missing](missing.md)\n",
      "concept.md": document("Concept", "See [missing](/missing.md)."),
    });
    const warningReport = checkOkfBundle(warningRoot);
    expect(warningReport.errors).toBe(0);
    expect(warningReport.warnings).toBe(2);

    const errorRoot = makeBrain({
      "index.md": "not a conformant listing\n",
      "log.md": "# Updates\n\n## yesterday\n* **Update**: Changed a concept.\n",
      "missing-frontmatter.md": "Body only.\n",
      "empty-type.md": "---\ntype: ''\n---\n\nBody.\n",
    });
    const errorReport = checkOkfBundle(errorRoot);
    expect(errorReport.ok).toBe(false);
    expect(errorReport.errors).toBeGreaterThanOrEqual(4);
  });
});
