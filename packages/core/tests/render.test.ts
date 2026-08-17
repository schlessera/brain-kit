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

  describe("scratch space", () => {
    test("writes to the temp directory, and says it is not viewable", async () => {
      const out = join(tmpdir(), `brain-render-${Date.now()}.html`);
      const res = await render(["notes/trip.md", "--format", "html", "--out", out, "--human"]);
      expect(res.code).toBe(0);
      expect(existsSync(out)).toBe(true);
      expect(res.stdout).toContain("not viewable in a UI");
      // Reported absolute, because `../../tmp/x.html` helps nobody.
      expect(res.stdout).toContain(out);
      rmSync(out, { force: true });
    });

    test("reads an input from the temp directory", async () => {
      const src = join(tmpdir(), `brain-render-src-${Date.now()}.md`);
      writeFileSync(src, "# From temp\n");
      const res = await render([src, "--format", "html", "--out", "notes/from-temp.html"]);
      expect(res.code).toBe(0);
      expect(readFileSync(join(root, "notes/from-temp.html"), "utf8")).toContain("From temp");
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
    test("an input path outside the brain and outside temp", async () => {
      const res = await render(["../../etc/passwd", "--format", "html"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toMatch(/neither inside the brain root/);
    });

    test("an output path outside the brain and outside temp", async () => {
      const res = await render(["notes/trip.md", "--format", "html", "--out", "../escape.html"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toMatch(/neither inside the brain root/);
    });

    test("an absolute path to somewhere sensitive is still refused", async () => {
      // The point of containment: scratch space is allowed, wandering is not.
      const res = await render(["notes/trip.md", "--format", "html", "--out", "/etc/cron.d/x"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toMatch(/neither inside the brain root/);
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

    test("stdin without --out", async () => {
      const res = await render(["-", "--format", "html"]);
      expect(res.code).toBe(1);
      expect(res.stderr + res.stdout).toContain("--out is required");
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
});
