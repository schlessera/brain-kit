import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, extname, relative } from "path";
import matter from "gray-matter";
import { buildHtmlDocument, type RenderContentType } from "@schlessera/brain-render-template";

import { resolveWritable } from "../../lib/safe-path.js";
import {
  noSandboxFromEnv,
  RendererUnavailableError,
  resolveDocumentRenderer,
} from "../../providers/renderers/puppeteer.js";
import type { CoreCommand } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";

const HELP = `brain render <path|-> — render a document to PDF, PNG, or standalone HTML

  --format <fmt>        pdf (default), png, or html
  --out <path>          Output path, repo-relative. Default: the input path with
                        the format's extension. Required when reading stdin.
  --as <type>           Treat input as markdown or html. Default: from the file
                        extension; markdown for stdin.
  --title <text>        Document title. Default: the frontmatter title, else the
                        file name.
  --width <px>          Layout width, 320-4096. Default 768.
  --allow-host <host>   Let the page load images from this host (repeatable).
                        Off by default: the page resolves no hostname at all.

Frontmatter is stripped before rendering — it is metadata, not content.

PDF and PNG need the optional @schlessera/brain-render-puppeteer package and a
Chrome binary; --format html needs neither and produces the same document.

--json envelope: { input, output, format, bytes, title, allowHosts }`;

const FORMATS = new Set(["pdf", "png", "html"]);

function repeatedValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== `--${flag}`) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new UsageError(`--${flag} requires a value`);
    values.push(value);
    i++;
  }
  return values;
}

function contentTypeFor(path: string, override?: string): RenderContentType {
  if (override) {
    if (override !== "markdown" && override !== "html") {
      throw new UsageError(`--as must be markdown or html, got "${override}"`);
    }
    return override;
  }
  const ext = extname(path).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  return "markdown";
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export const renderCommand: CoreCommand = {
  summary: "Render a document to PDF, PNG, or standalone HTML",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    const input = pos[0];
    if (!input) {
      throw new UsageError("Usage: brain render <path|-> [--format pdf|png|html] [--out <path>]");
    }

    const format = typeof flags.format === "string" ? flags.format : "pdf";
    if (!FORMATS.has(format)) {
      throw new UsageError(`--format must be pdf, png, or html, got "${format}"`);
    }

    const root = cli.brain.root;
    const fromStdin = input === "-";

    // --- read the source
    let raw: string;
    let sourceLabel: string;
    if (fromStdin) {
      raw = await readStdin();
      sourceLabel = "(stdin)";
    } else {
      const resolved = resolveWritable(root, input);
      if (!resolved) {
        throw new UsageError(
          `Path is neither inside the brain root nor under the temp directory: ${input}`
        );
      }
      const abs = resolved.abs;
      if (!existsSync(abs)) throw new UsageError(`No such file: ${input}`);
      raw = readFileSync(abs, "utf8");
      sourceLabel = relative(root, abs);
    }

    const asFlag = typeof flags.as === "string" ? flags.as : undefined;
    const contentType = contentTypeFor(fromStdin ? "stdin.md" : input, asFlag);

    // Frontmatter is metadata; rendering it verbatim would put a wall of YAML
    // at the top of every brain document.
    const parsed = matter(raw);
    const content = parsed.content.trimStart();
    const frontmatterTitle =
      typeof parsed.data.title === "string" && parsed.data.title ? parsed.data.title : undefined;
    const title =
      (typeof flags.title === "string" && flags.title) ||
      frontmatterTitle ||
      (fromStdin ? undefined : sourceLabel);

    // --- resolve the output path
    const outFlag = typeof flags.out === "string" ? flags.out : undefined;
    if (!outFlag && fromStdin) {
      throw new UsageError("--out is required when reading from stdin");
    }
    const outRel = outFlag ?? input.replace(/\.[^./\\]+$/, "") + "." + format;
    const out = resolveWritable(root, outRel);
    if (!out) {
      throw new UsageError(
        `Output path is neither inside the brain root nor under the temp directory: ${outRel}`
      );
    }
    const outAbs = out.abs;
    if (!existsSync(dirname(outAbs))) {
      throw new UsageError(`Output directory does not exist: ${relative(root, dirname(outAbs))}`);
    }

    const allowHosts = repeatedValues(args, "allow-host");
    const width = flags.width !== undefined ? Number(flags.width) : undefined;
    if (width !== undefined && !Number.isFinite(width)) {
      throw new UsageError(`--width must be a number, got "${String(flags.width)}"`);
    }

    const html = buildHtmlDocument({ content, contentType, title, allowHosts });

    // --- write
    if (format === "html") {
      writeFileSync(outAbs, html, "utf8");
    } else {
      let renderer;
      try {
        renderer = await resolveDocumentRenderer({
          noSandbox: noSandboxFromEnv(),
          allowHosts,
        });
      } catch (error) {
        if (error instanceof RendererUnavailableError) throw new UsageError(error.message);
        throw error;
      }
      try {
        const buf =
          format === "png"
            ? await renderer.renderPng({ html, width })
            : await renderer.renderPdf({ html, width });
        writeFileSync(outAbs, buf);
      } finally {
        await renderer.shutdown();
      }
    }

    const bytes = Bun.file(outAbs).size;
    // A path outside the repo is reported absolute: `../../tmp/x.pdf` is not
    // a useful thing to hand back, and the caller should see that it landed
    // somewhere the app cannot browse.
    const outputRel = out.inRepo ? relative(root, outAbs) : outAbs;
    emit(
      cli.json,
      {
        input: sourceLabel,
        output: outputRel,
        format,
        bytes,
        title: title ?? null,
        allowHosts,
      },
      () => {
        console.log(`Rendered ${sourceLabel} → ${outputRel} (${format}, ${formatBytes(bytes)})`);
        if (!out.inRepo) {
          console.log("  outside the brain repo — fine for an intermediate, not viewable in a UI");
        }
        if (allowHosts.length > 0) {
          console.log(`  Images allowed from: ${allowHosts.join(", ")}`);
        }
      }
    );
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
