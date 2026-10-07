import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import {
  listDirectory,
  readFileContent,
  resolveAncestors,
  resolveForRaw,
  buildWikilinkMap,
  classifyKind,
  safeResolve,
  PathEscapeError,
  NotFoundError,
  TooLargeError,
} from "../src/files/walker";
import { FILE_SIZE_CAP_BYTES } from "@schlessera/brain-ui-sdk/protocol";
import { createFilesRoutes } from "../src/routes/files";

let root: string;

beforeAll(async () => {
  root = await Bun.$`mktemp -d`.text().then((s) => s.trim());

  await writeFile(join(root, ".gitignore"), "secret/\n*.log\n");
  await writeFile(join(root, "README.md"), "# hello");
  await writeFile(join(root, "page.html"), "<h1>hi</h1><script>alert(1)</script>");
  await writeFile(join(root, "notes.txt"), "plain text");
  await writeFile(join(root, "data.json"), `{"a":1}`);
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 0, 3]));
  await writeFile(join(root, "ignored.log"), "should be ignored");

  await mkdir(join(root, "notes/projects"), { recursive: true });
  await writeFile(join(root, "notes/foo.md"), "foo");
  await writeFile(join(root, "notes/projects/bar.md"), "bar");

  await mkdir(join(root, "secret"));
  await writeFile(join(root, "secret/hidden.md"), "no");

  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git/HEAD"), "ref");
  await writeFile(join(root, ".git/git-internal.md"), "Internal repository metadata.");

  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules/pkg.txt"), "x");
  await writeFile(join(root, "node_modules/dependency-readme.md"), "Dependency metadata.");

  await writeFile(join(root, "brain.db"), "x");
  await writeFile(join(root, "brain.db-wal"), "x");

  // Symlink escaping the root
  const outside = join(tmpdir(), `brain-ui-outside-${process.pid}-${Date.now()}`);
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.md"), "outside");
  await symlink(outside, join(root, "escape-link"));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("safeResolve", () => {
  test("rejects '..'", async () => {
    await expect(safeResolve("../etc/passwd", root)).rejects.toBeInstanceOf(PathEscapeError);
  });
  test("rejects absolute path", async () => {
    await expect(safeResolve("/etc/passwd", root)).rejects.toBeInstanceOf(PathEscapeError);
  });
  test("rejects null byte", async () => {
    await expect(safeResolve("a\0b", root)).rejects.toBeInstanceOf(PathEscapeError);
  });
  test("rejects Windows path syntax before candidate paths can diverge", async () => {
    const windowsRoot = "C:\\brain";
    const driveRelative = "C:escape-link/secret.md";
    const resolved = win32.resolve(windowsRoot, driveRelative);
    const rawCandidates = driveRelative.split("/").reduce<string[]>((candidates, segment) => {
      candidates.push(win32.join(candidates.at(-1)!, segment));
      return candidates;
    }, [windowsRoot]);
    const derivedCandidates = win32
      .relative(windowsRoot, resolved)
      .split(win32.sep)
      .reduce<string[]>((candidates, segment) => {
        candidates.push(win32.join(candidates.at(-1)!, segment));
        return candidates;
      }, [windowsRoot]);

    expect(resolved).toBe("C:\\brain\\escape-link\\secret.md");
    expect(rawCandidates.at(-1)).toBe("C:\\brain\\C:escape-link\\secret.md");
    expect(rawCandidates.at(-1)).not.toBe(resolved);
    expect(derivedCandidates.at(-1)).toBe(resolved);
    await expect(safeResolve(driveRelative, root)).rejects.toBeInstanceOf(PathEscapeError);
    await expect(safeResolve("notes\\foo.md", root)).rejects.toBeInstanceOf(PathEscapeError);
  });
  test("rejects nested '..'", async () => {
    await expect(safeResolve("notes/../../../etc", root)).rejects.toBeInstanceOf(PathEscapeError);
  });
  test("rejects symlink escape", async () => {
    await expect(safeResolve("escape-link", root)).rejects.toBeInstanceOf(PathEscapeError);
  });
  test("accepts repo-relative path", async () => {
    await expect(safeResolve("notes/foo.md", root)).resolves.toBeTruthy();
  });
  test("accepts empty string (root)", async () => {
    await expect(safeResolve("", root)).resolves.toBeTruthy();
  });
});

describe("listDirectory", () => {
  test("lists root entries with dirs first", async () => {
    const entries = await listDirectory("", root);
    const names = entries.map((e) => e.name);
    // Dirs first
    const firstFileIdx = entries.findIndex((e) => e.type === "file");
    const lastDirIdx = entries.map((e) => e.type).lastIndexOf("dir");
    expect(lastDirIdx).toBeLessThan(firstFileIdx);
    expect(names).toContain("notes");
    expect(names).toContain("README.md");
  });

  test("excludes .git, node_modules, *.db*, symlink-escape", async () => {
    const entries = await listDirectory("", root);
    const names = entries.map((e) => e.name);
    expect(names).not.toContain(".git");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain("brain.db");
    expect(names).not.toContain("brain.db-wal");
    expect(names).not.toContain("escape-link");
  });

  test("excludes all dotfiles and dot-directories", async () => {
    const entries = await listDirectory("", root);
    const names = entries.map((e) => e.name);
    // Fixture has `.gitignore`; should not be listed
    expect(names).not.toContain(".gitignore");
    for (const n of names) {
      expect(n.startsWith(".")).toBe(false);
    }
  });

  test("excludes build/dependency manifests by name", async () => {
    const fs = await import("node:fs/promises");
    const { join } = await import("node:path");
    for (const name of [
      "package.json",
      "package-lock.json",
      "bun.lock",
      "skills-lock.json",
    ]) {
      await fs.writeFile(join(root, name), "{}");
    }
    const entries = await listDirectory("", root);
    const names = entries.map((e) => e.name);
    expect(names).not.toContain("package.json");
    expect(names).not.toContain("package-lock.json");
    expect(names).not.toContain("bun.lock");
    expect(names).not.toContain("skills-lock.json");
    // Cleanup so subsequent tests aren't affected
    for (const name of [
      "package.json",
      "package-lock.json",
      "bun.lock",
      "skills-lock.json",
    ]) {
      await fs.rm(join(root, name));
    }
  });

  test("respects .gitignore", async () => {
    const entries = await listDirectory("", root);
    const names = entries.map((e) => e.name);
    expect(names).not.toContain("secret");
    expect(names).not.toContain("ignored.log");
  });

  test("lists nested directory", async () => {
    const entries = await listDirectory("notes", root);
    const names = entries.map((e) => e.name);
    expect(names).toContain("projects");
    expect(names).toContain("foo.md");
  });

  test("throws NotFound for missing dir", async () => {
    await expect(listDirectory("nope", root)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("throws NotFound when path is a file", async () => {
    await expect(listDirectory("README.md", root)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("readFileContent", () => {
  test("reads markdown", async () => {
    const r = await readFileContent("README.md", root);
    expect(r.kind).toBe("markdown");
    expect(r.content).toBe("# hello");
    expect(r.size).toBeGreaterThan(0);
  });

  test("reads html", async () => {
    const r = await readFileContent("page.html", root);
    expect(r.kind).toBe("html");
    expect(r.content).toContain("<h1>");
  });

  test("an uncompressed, all-ASCII PDF is served as binary, not as its source", async () => {
    await writeFile(join(root, "plain.pdf"), "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
    const r = await readFileContent("plain.pdf", root);
    expect(r.kind).toBe("binary");
    expect(r.mime).toBe("application/pdf");
    expect(r.content).toBeUndefined();
  });

  test("reads plain text", async () => {
    const r = await readFileContent("notes.txt", root);
    expect(r.kind).toBe("text");
    expect(r.content).toBe("plain text");
  });

  test("reads json as text", async () => {
    const r = await readFileContent("data.json", root);
    expect(r.kind).toBe("text");
  });

  test("detects binary via NUL byte", async () => {
    const r = await readFileContent("binary.bin", root);
    expect(r.kind).toBe("binary");
    expect(r.content).toBeUndefined();
  });

  test("rejects file_too_large", async () => {
    const big = join(root, "big.txt");
    await writeFile(big, Buffer.alloc(FILE_SIZE_CAP_BYTES + 1, 65));
    await expect(readFileContent("big.txt", root)).rejects.toBeInstanceOf(TooLargeError);
    await rm(big);
  });

  test("rejects path escape", async () => {
    await expect(readFileContent("../etc/passwd", root)).rejects.toBeInstanceOf(PathEscapeError);
  });

  test("a child of an existing file is not found without leaking its absolute path", async () => {
    const rel = "README.md/child";

    await expect(readFileContent(rel, root)).rejects.toBeInstanceOf(NotFoundError);

    const response = await createFilesRoutes({ brainRoot: root }).request(
      `/files/content?path=${encodeURIComponent(rel)}`
    );
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: "not_found" });
    expect(body).not.toContain(root);
  });

  test("an overlong path component is not found without leaking its absolute path", async () => {
    const rel = "x".repeat(256);

    const response = await createFilesRoutes({ brainRoot: root }).request(
      `/files/content?path=${encodeURIComponent(rel)}`
    );
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: "not_found" });
    expect(body).not.toContain(root);
  });
});

describe("resolveAncestors", () => {
  test("returns ancestor chain for nested file", async () => {
    const r = await resolveAncestors("notes/projects/bar.md", root);
    expect(r.ancestors).toEqual(["notes", "notes/projects"]);
    expect(r.exists).toBe(true);
    expect(r.type).toBe("file");
  });

  test("returns empty ancestors for top-level file", async () => {
    const r = await resolveAncestors("README.md", root);
    expect(r.ancestors).toEqual([]);
    expect(r.exists).toBe(true);
  });

  test("reports exists=false for missing", async () => {
    const r = await resolveAncestors("notes/missing/path.md", root);
    expect(r.exists).toBe(false);
    expect(r.ancestors).toEqual(["notes", "notes/missing"]);
  });
});

describe("the brain's scratch area (#310)", () => {
  test("a render in .brain/scratch/ opens through the raw file route, and stays out of the tree", async () => {
    // What a chat link to `brain render --scratch` output resolves to.
    await mkdir(join(root, ".brain/scratch"), { recursive: true });
    await writeFile(join(root, ".brain/scratch/trip.pdf"), "%PDF-1.7 scratch");
    const response = await createFilesRoutes({ brainRoot: root }).request(
      `/files/content?path=${encodeURIComponent(".brain/scratch/trip.pdf")}&raw=1`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await response.text()).toBe("%PDF-1.7 scratch");
    const top = await listDirectory("", root);
    expect(top.map((e) => e.name)).not.toContain(".brain");
  });
});

describe("resolveForRaw", () => {
  test("returns abs path and mime for image-style request", async () => {
    const r = await resolveForRaw("binary.bin", root);
    expect(r.kind).toBe("binary");
    expect(r.mime).toBe("application/octet-stream");
    expect(r.abs).toContain(root);
  });
});

describe("classifyKind by extension", () => {
  test("markdown", () => expect(classifyKind("foo.md")).toBe("markdown"));
  test("html", () => expect(classifyKind("foo.html")).toBe("html"));
  test("ts", () => expect(classifyKind("foo.ts")).toBe("text"));
  test("unknown w/o bytes", () => expect(classifyKind("foo.xyz")).toBe("binary"));
  test("Dockerfile is text", () => expect(classifyKind("Dockerfile")).toBe("text"));
  test("README is text", () => expect(classifyKind("README")).toBe("text"));
  test("a PDF is binary even when its bytes are plain ASCII", () =>
    expect(classifyKind("scan.pdf", Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"))).toBe("binary"));
  test("the extension is matched whatever its case", () =>
    expect(classifyKind("REPORT.PDF", Buffer.from("%PDF-1.4\n"))).toBe("binary"));
  test("audio and video are binary whatever their bytes", () => {
    for (const name of ["a.mp3", "a.wav", "a.mp4", "a.webm"]) expect(classifyKind(name, Buffer.from("ascii"))).toBe("binary");
  });
});

describe("buildWikilinkMap", () => {
  test("maps lowercase basename -> repo-relative .md path", async () => {
    const map = await buildWikilinkMap(root);
    expect(map["readme"]).toBe("README.md");
    expect(map["foo"]).toBe("notes/foo.md");
    expect(map["bar"]).toBe("notes/projects/bar.md");
  });

  test("excludes gitignored and hard-excluded directories", async () => {
    const map = await buildWikilinkMap(root);
    // 'hidden' is inside .gitignore-d "secret/" dir
    expect(map["hidden"]).toBeUndefined();
    expect(map["git-internal"]).toBeUndefined();
    expect(map["dependency-readme"]).toBeUndefined();
    expect(map["foo"]).toBe("notes/foo.md");
  });

  test("excludes non-markdown files", async () => {
    const map = await buildWikilinkMap(root);
    expect(map["notes"]).toBeUndefined();
    expect(map["data"]).toBeUndefined();
    expect(map["binary"]).toBeUndefined();
  });

  test("first sorted match wins on slug collisions", async () => {
    await writeFile(join(root, "notes/README.md"), "A second README in the same tree.");
    const map = await buildWikilinkMap(root);
    // The sorted walk visits notes/ before README.md at the root.
    expect(map["readme"]).toBe("notes/README.md");
  });
});

describe("buildWikilinkMap with internally discovered rejected paths", () => {
  let scanRoot: string;

  beforeAll(async () => {
    scanRoot = await Bun.$`mktemp -d`.text().then((s) => s.trim());
    await mkdir(join(scanRoot, "notes/deep"), { recursive: true });
    await writeFile(join(scanRoot, "README.md"), "root");
    await writeFile(join(scanRoot, "notes/alpha.md"), "alpha");
    await writeFile(join(scanRoot, "notes/deep/beta.mdx"), "beta");

    await mkdir(join(scanRoot, "archive:private/nested"), { recursive: true });
    await writeFile(join(scanRoot, "archive:private/hidden.md"), "hidden");
    await writeFile(join(scanRoot, "archive:private/nested/also-hidden.md"), "hidden");
  });

  afterAll(async () => {
    if (scanRoot) await rm(scanRoot, { recursive: true, force: true });
  });

  test("skips a colon-named subtree without aborting the rest of the map", async () => {
    const map = await buildWikilinkMap(scanRoot);

    expect(map).toEqual({
      readme: "README.md",
      alpha: "notes/alpha.md",
      beta: "notes/deep/beta.mdx",
    });
  });

  test("serves wikilinks for the rest of the repo when a colon-named subtree exists", async () => {
    const response = await createFilesRoutes({ brainRoot: scanRoot }).request(
      "/files/wikilinks"
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.count).toBe(3);
    expect(body.slugs).toEqual({
      readme: "README.md",
      alpha: "notes/alpha.md",
      beta: "notes/deep/beta.mdx",
    });
  });
});
