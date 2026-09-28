/**
 * `brain render` contract. Only the HTML format is exercised: PDF and PNG go
 * through the optional puppeteer renderer and a real Chrome, which CI has no
 * business launching. The HTML path covers everything the command itself owns —
 * input resolution, frontmatter stripping, titles, containment, and the
 * envelope — because all three formats build the same document first.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { DOCUMENT_BLOCKS } from "@schlessera/brain-render-template";
import { DOCUMENT_KINDS, readSkeleton, resolveKind } from "@schlessera/brain-render-template/kinds";

import { countPdfPages } from "../src/cli/commands/render";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

let root: string;

const DOC = `---
title: Wallis Day Plan
type: note
---

# Day one

Meet at **08:30**.

![a peak](https://upload.wikimedia.org/wikipedia/commons/thumb/x/peak.jpg/400px-peak.jpg)
`;

beforeAll(() => {
  root = makeTempBrain();
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes/trip.md"), DOC);
  writeFileSync(join(root, "notes/plain.md"), "# No frontmatter\n\nBody.\n");
});

afterAll(() => cleanup(root));

async function render(args: string[]) {
  const res = await runCli(root, ["render", ...args]);
  return res;
}

describe("brain render", () => {
  test("renders markdown to a self-contained HTML document", async () => {
    const res = await render(["notes/trip.md", "--format", "html"]);
    expect(res.code).toBe(0);
    const html = readFileSync(join(root, "notes/trip.html"), "utf8");
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("<h1>Day one</h1>");
    expect(html).toContain("<strong>08:30</strong>");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
  });

  test("strips frontmatter and takes the title from it", async () => {
    await render(["notes/trip.md", "--format", "html", "--out", "notes/t1.html"]);
    const html = readFileSync(join(root, "notes/t1.html"), "utf8");
    expect(html).toContain("<title>Wallis Day Plan</title>");
    // The YAML block itself must not reach the page.
    expect(html).not.toContain("type: note");
    expect(html).not.toContain("---");
  });

  test("--title beats the frontmatter title", async () => {
    await render(["notes/trip.md", "--format", "html", "--out", "notes/t2.html", "--title", "Override"]);
    expect(readFileSync(join(root, "notes/t2.html"), "utf8")).toContain("<title>Override</title>");
  });

  test("falls back to the file path when there is no frontmatter title", async () => {
    await render(["notes/plain.md", "--format", "html", "--out", "notes/t3.html"]);
    expect(readFileSync(join(root, "notes/t3.html"), "utf8")).toContain(
      "<title>notes/plain.md</title>"
    );
  });

  test("defaults the output path to the input with the format's extension", async () => {
    const res = await render(["notes/plain.md", "--format", "html"]);
    expect(res.code).toBe(0);
    expect(existsSync(join(root, "notes/plain.html"))).toBe(true);
  });

  test("emits a JSON envelope when stdout is not a TTY", async () => {
    const res = await render(["notes/trip.md", "--format", "html", "--out", "notes/t4.html"]);
    const envelope = JSON.parse(res.stdout);
    expect(envelope).toMatchObject({
      input: "notes/trip.md",
      output: "notes/t4.html",
      format: "html",
      title: "Wallis Day Plan",
      allowHosts: [],
    });
    expect(envelope.bytes).toBeGreaterThan(0);
  });

  describe("remote images", () => {
    test("are placeholdered by default", async () => {
      await render(["notes/trip.md", "--format", "html", "--out", "notes/t5.html"]);
      const html = readFileSync(join(root, "notes/t5.html"), "utf8");
      expect(html).toContain("[a peak — not embedded]");
      expect(html).not.toContain("400px-peak.jpg");
    });

    test("survive when their host is allowed", async () => {
      await render([
        "notes/trip.md",
        "--format", "html",
        "--out", "notes/t6.html",
        "--allow-host", "upload.wikimedia.org",
      ]);
      const html = readFileSync(join(root, "notes/t6.html"), "utf8");
      expect(html).toContain("400px-peak.jpg");
      expect(html).not.toContain("not embedded");
    });
  });

  describe("the temp directory is not scratch space (#310)", () => {
    test("an output under the system temp directory is refused", async () => {
      const out = join(tmpdir(), `brain-render-${Date.now()}.html`);
      const res = await render(["notes/trip.md", "--format", "html", "--out", out]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("not inside the brain");
      expect(existsSync(out)).toBe(false);
    });

    test("an input under the system temp directory is refused", async () => {
      const src = join(tmpdir(), `brain-render-src-${Date.now()}.md`);
      writeFileSync(src, "# From temp\n");
      const res = await render([src, "--format", "html", "--out", "notes/from-temp.html"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("not inside the brain");
      rmSync(src, { force: true });
    });
  });

  describe("input handling", () => {
    test("reads stdin with --out", async () => {
      const proc = Bun.spawn(
        ["bun", BRAIN_BIN, "render", "-", "--format", "html", "--out", "notes/stdin.html"],
        { env: keylessEnv(root), stdout: "pipe", stderr: "pipe", stdin: "pipe" }
      );
      proc.stdin.write("# From stdin\n");
      await proc.stdin.end();
      expect(await proc.exited).toBe(0);
      expect(readFileSync(join(root, "notes/stdin.html"), "utf8")).toContain("<h1>From stdin</h1>");
    });

    test("treats .html input as HTML, not markdown", async () => {
      writeFileSync(join(root, "notes/raw.html"), '<div class="card">raw</div>');
      await render(["notes/raw.html", "--format", "html", "--out", "notes/t7.html"]);
      const html = readFileSync(join(root, "notes/t7.html"), "utf8");
      expect(html).toContain('<div class="card">raw</div>');
    });

    test("--as overrides the extension", async () => {
      await render(["notes/raw.html", "--format", "html", "--out", "notes/t8.html", "--as", "markdown"]);
      // As markdown, the raw div is a block-level passthrough but the file is
      // still parsed rather than copied — assert the parser ran.
      expect(existsSync(join(root, "notes/t8.html"))).toBe(true);
    });
  });

  describe("rejects", () => {
    test("an input path outside the brain", async () => {
      const res = await render(["../../etc/passwd", "--format", "html"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("not inside the brain");
    });

    test("an output path outside the brain", async () => {
      const res = await render(["notes/trip.md", "--format", "html", "--out", "../escape.html"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("not inside the brain");
    });

    test("an absolute path to somewhere sensitive is still refused", async () => {
      const res = await render(["notes/trip.md", "--format", "html", "--out", "/etc/cron.d/x"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("not inside the brain");
    });

    test("--out and --scratch together", async () => {
      const res = await render(["notes/trip.md", "--format", "html", "--out", "notes/x.html", "--scratch"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("exclusive");
    });

    test("a missing input file", async () => {
      const res = await render(["notes/nope.md", "--format", "html"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("No such file");
    });

    test("an unknown format", async () => {
      const res = await render(["notes/trip.md", "--format", "docx"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("--format must be pdf, png, or html");
    });

    test("an unknown --as value", async () => {
      const res = await render(["notes/trip.md", "--format", "html", "--as", "rtf"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("--as must be markdown or html");
    });


    test("a non-numeric --width", async () => {
      const res = await render(["notes/trip.md", "--format", "html", "--width", "wide"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("--width must be a number");
    });

    test("an output directory that does not exist", async () => {
      const res = await render(["notes/trip.md", "--format", "html", "--out", "nope/out.html"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("Output directory does not exist");
    });

    test("no arguments", async () => {
      const res = await render([]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("Usage: brain render");
    });
  });

  describe("designed documents (#530)", () => {
    test("--kind list is data: a JSON list of kinds when stdout is not a TTY", async () => {
      const res = await render(["--kind", "list"]);
      expect(res.code).toBe(0);
      const { kinds } = JSON.parse(res.stdout);
      expect(kinds.map((k: { name: string }) => k.name)).toEqual(
        DOCUMENT_KINDS.map((k) => k.name)
      );
      expect(kinds.find((k: { name: string }) => k.name === "how-to")).toMatchObject({
        aliases: expect.arrayContaining(["recipe"]),
        opener: "hero--split",
        format: "html",
      });
    });

    test("--kind <kind> --scaffold prints the skeleton verbatim, as text, by name or alias", async () => {
      const res = await render(["--kind", "recipe", "--scaffold"]);
      expect(res.code).toBe(0);
      expect(res.stdout).toBe(readSkeleton(resolveKind("how-to")!));
      expect(res.stdout).toStartWith("<!doctype html>");
      const note = await render(["--kind", "note", "--scaffold"]);
      expect(note.stdout).toStartWith("# ");
    });

    test("--blocks prints the snippets, all or the named ones", async () => {
      const all = await render(["--blocks"]);
      expect(all.code).toBe(0);
      for (const block of DOCUMENT_BLOCKS) expect(all.stdout).toContain(`## ${block.name} (`);
      const two = await render(["--blocks", "callout", "stats"]);
      expect(two.stdout).toContain("## callout (block)");
      expect(two.stdout).toContain('class="doc-stats"');
      expect(two.stdout).not.toContain("## timeline");
    });

    test("refuses what it cannot print", async () => {
      for (const args of [
        ["--kind", "poster", "--scaffold"],
        ["--kind", "report"],
        ["--kind", "list", "--scaffold"],
        ["--kind", "report", "--scaffold", "notes/trip.md"],
        ["--blocks", "nope"],
        ["--blocks", "--scaffold"],
        ["--scaffold"],
      ]) {
        const res = await render(args);
        expect(res.code).toBe(1);
      }
    });

    test("a filled skeleton renders, keeps its own title, and names what is left to fill in", async () => {
      writeFileSync(join(root, "notes/plan.html"), readSkeleton(resolveKind("itinerary")!));
      const res = await render(["notes/plan.html", "--format", "html"]);
      expect(res.code).toBe(0);
      const envelope = JSON.parse(res.stdout);
      expect(envelope.title).toBe("Launch day: Ogygia to open water");
      expect(envelope.pages).toBeNull();
      expect(envelope.warnings).toHaveLength(2);
      expect(envelope.warnings[0]).toContain("placeholder image");
      expect(envelope.warnings[1]).toContain('"#" href');
      const html = readFileSync(join(root, "notes/plan.html"), "utf8");
      expect(html.match(/<body\b/g)).toHaveLength(1);
      expect(html).toContain('@bottom-left { content: "Launch day: Ogygia to open water"');
    });

    test("a clean document has no warnings", async () => {
      const res = await render(["notes/trip.md", "--format", "html", "--out", "notes/t8.html", "--allow-host", "upload.wikimedia.org"]);
      expect(JSON.parse(res.stdout).warnings).toEqual([]);
    });

    test("the footer carries the document's title unless --no-running-title", async () => {
      await render(["notes/trip.md", "--format", "html", "--out", "notes/t9.html"]);
      expect(readFileSync(join(root, "notes/t9.html"), "utf8")).toContain('@bottom-left { content: "Wallis Day Plan"');
      // An untitled note's title is its path, in the footer as in <title>.
      await render(["notes/plain.md", "--format", "html", "--out", "notes/t10.html"]);
      expect(readFileSync(join(root, "notes/t10.html"), "utf8")).toContain('@bottom-left { content: "notes/plain.md"');
      await render(["notes/trip.md", "--format", "html", "--out", "notes/t11.html", "--no-running-title"]);
      expect(readFileSync(join(root, "notes/t11.html"), "utf8")).toContain('@bottom-left { content: ""');
    });

    test("the envelope's title keeps its meaning: the caller's, verbatim, or null for untitled stdin", async () => {
      writeFileSync(join(root, "notes/spaced.md"), "---\ntitle: '  T  '\n---\nx\n");
      const spaced = await render(["notes/spaced.md", "--format", "html"]);
      expect(JSON.parse(spaced.stdout).title).toBe("  T  ");
      const proc = Bun.spawn(["bun", BRAIN_BIN, "render", "-", "--format", "html", "--out", "notes/t12.html"], {
        cwd: root,
        env: keylessEnv(root),
        stdin: new TextEncoder().encode("# From stdin\n"),
        stdout: "pipe",
      });
      expect(JSON.parse(await new Response(proc.stdout).text()).title).toBeNull();
    });
  });

  test("countPdfPages counts page objects, not page-tree nodes", () => {
    const pdf = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >> endobj\n" +
        "2 0 obj << /Type /Page /Parent 1 0 R >> endobj\n3 0 obj <</Type/Page/Parent 1 0 R>> endobj\n" +
        "4 0 obj << /Type /Outlines /Count 5 >> endobj\n%%EOF"
    );
    expect(countPdfPages(pdf)).toBe(2);
  });
});
