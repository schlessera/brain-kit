import { existsSync, readFileSync } from "fs";
import { basename, dirname, extname, join, relative } from "path";
import { parseFrontmatter } from "../../lib/frontmatter-parse.js";
import {
  buildHtmlDocument,
  DOCUMENT_BLOCKS,
  lintDocument,
  type RenderContentType,
} from "@schlessera/brain-render-template";
import { documentTitle, isFullDocument } from "@schlessera/brain-render-template/internal";
import { DOCUMENT_KINDS, readSkeleton, resolveKind } from "@schlessera/brain-render-template/kinds";

import { resolveWritable, writeFileSafely } from "../../lib/safe-path.js";
import {
  assertScratchWritable,
  isInScratch,
  isWriteRefusal,
  pruneScratch,
  SCRATCH_DIR,
  ScratchNotIgnoredError,
  ScratchRedirectedError,
  scratchName,
  writeScratchFile,
} from "../../lib/scratch.js";
import {
  noSandboxFromEnv,
  RendererUnavailableError,
  resolveDocumentRenderer,
} from "../../providers/renderers/puppeteer.js";
import type { CoreCommand } from "../types.js";
import { emit, parseArgs, UsageError } from "../io.js";

const HELP = `brain render <path|-> — render a document to PDF, PNG, or standalone HTML

  --format <fmt>        pdf (default), png, or html
  --out <path>          Output path, inside the brain. Default: the input path
                        with the format's extension; for stdin, the scratch area.
  --scratch             Write the output to the brain's scratch area
                        (${SCRATCH_DIR}/): transient, openable in the UI, never
                        committed, and pruned after 7 days or past 1 GB.
  --as <type>           Treat input as markdown or html. Default: from the file
                        extension; markdown for stdin.
  --title <text>        Document title. Default: the frontmatter title, else the
                        file name. A complete HTML document keeps its own.
  --no-running-title    PDF footer shows page numbers only, not the title.
  --width <px>          Layout width, 320-4096. Default 768.
  --allow-host <host>   Let the page load images from this host (repeatable).
                        Off by default: the page resolves no hostname at all.

Designed documents are composed from the shell's components, never from CSS:

  --kind list               The document kinds, and when to use each.
  --kind <kind> --scaffold  Print that kind's skeleton, a complete example to
                            fill in (HTML, or markdown for "note").
  --blocks [name...]        Print the component snippets, all or the named ones.

These three print text and need no input path.

Frontmatter is stripped before rendering — it is metadata, not content. Every
render is checked for what would come out wrong (unknown component classes, an
opener that is not first, images or stylesheets that cannot load, placeholders
left from a skeleton); the findings are printed and listed in \`warnings\`.

PDF and PNG need the optional @schlessera/brain-render-puppeteer package and a
Chrome binary; --format html needs neither and produces the same document.

--json envelope: { input, output, format, bytes, pages, title, allowHosts, warnings }
--kind list --json: { kinds: [{ name, aliases, label, use, opener, blocks, accent, switches, format }] }`;

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

/**
 * Pages in a PDF Chrome wrote. Skia writes a plain cross-reference table and
 * no object streams, so every page object is visible as `/Type /Page`; the
 * `(?![A-Za-z])` keeps `/Type /Pages` tree nodes out of the count.
 */
export function countPdfPages(pdf: Uint8Array): number {
  return Buffer.from(pdf).toString("latin1").match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
}

function kindsTable(): string {
  const rows = DOCUMENT_KINDS.map((k) => [
    k.name,
    k.aliases.join(", "),
    k.use,
    k.opener,
    k.accent + (k.switches.length ? ` + ${k.switches.join(" ")}` : ""),
  ]);
  const lines = [
    "kind | also | use when | opener | accent",
    ...rows.map((r) => r.join(" | ")),
    "",
    "Print one with: brain render --kind <kind> --scaffold",
  ];
  return lines.join("\n");
}

function blocksText(names: string[]): string {
  const unknown = names.filter((n) => !DOCUMENT_BLOCKS.some((b) => b.name === n));
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown block: ${unknown.join(", ")}. Blocks: ${DOCUMENT_BLOCKS.map((b) => b.name).join(", ")}`
    );
  }
  const chosen = names.length ? DOCUMENT_BLOCKS.filter((b) => names.includes(b.name)) : DOCUMENT_BLOCKS;
  const header = names.length
    ? []
    : [
        "Switches on <body>: data-accent=\"amber|teal|blue|purple|graphite\", class=\"doc--editorial\" (serif display), class=\"doc--compact\" (tighter).",
        "One opener at most, as the first element in <body>. Blocks keep together across pages; long lists and tables split only between items. Columns stack under 600px.",
        "",
      ];
  return [
    ...header,
    ...chosen.map((b) => `## ${b.name} (${b.group})\n${b.use}\n${b.html}\n`),
  ].join("\n");
}

/**
 * `--kind` and `--blocks`: reference output for composing a designed
 * document. No input, no rendering. A skeleton and the block snippets print
 * as text even when stdout is not a TTY, because they are documents to fill
 * in, not reports; `--kind list` is data and follows the usual JSON rule.
 */
function runReference(pos: string[], flags: Record<string, string | boolean>, json: boolean): void {
  if (flags.blocks === true) {
    if (flags.kind !== undefined) throw new UsageError("--blocks and --kind are exclusive");
    if (flags.scaffold === true) throw new UsageError("--blocks takes no --scaffold");
    process.stdout.write(blocksText(pos));
    return;
  }
  const name = flags.kind;
  if (typeof name !== "string") throw new UsageError("--kind requires a value: a kind, or list");
  if (pos.length > 0) throw new UsageError("--kind takes no input path");
  if (name === "list") {
    if (flags.scaffold === true) throw new UsageError("--kind list takes no --scaffold");
    emit(
      json,
      {
        kinds: DOCUMENT_KINDS.map(({ name, aliases, label, use, opener, blocks, accent, switches, format }) => ({
          name, aliases, label, use, opener, blocks, accent, switches, format,
        })),
      },
      () => console.log(kindsTable())
    );
    return;
  }
  const kind = resolveKind(name);
  if (!kind) {
    throw new UsageError(`Unknown kind "${name}". Kinds: ${DOCUMENT_KINDS.map((k) => k.name).join(", ")}`);
  }
  if (flags.scaffold !== true) {
    throw new UsageError(`--kind ${kind.name} needs --scaffold to print its skeleton`);
  }
  process.stdout.write(readSkeleton(kind));
}

export const renderCommand: CoreCommand = {
  summary: "Render a document to PDF, PNG, or standalone HTML",
  helpBlock: HELP,
  async run(args, cli) {
    const { args: pos, flags } = parseArgs(args);
    if (flags.kind !== undefined || flags.blocks === true) {
      runReference(pos, flags, cli.json);
      return;
    }
    if (flags.scaffold === true) throw new UsageError("--scaffold needs --kind <kind>");
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
      const abs = resolveWritable(root, input);
      if (!abs) {
        throw new UsageError(`Path is not inside the brain: ${input}`);
      }
      if (!existsSync(abs)) throw new UsageError(`No such file: ${input}`);
      raw = readFileSync(abs, "utf8");
      sourceLabel = relative(root, abs);
    }

    const asFlag = typeof flags.as === "string" ? flags.as : undefined;
    const contentType = contentTypeFor(fromStdin ? "stdin.md" : input, asFlag);

    // Frontmatter is metadata; rendering it verbatim would put a wall of YAML
    // at the top of every brain document.
    const parsed = parseFrontmatter(raw);
    const content = parsed.content.trimStart();
    const frontmatterTitle =
      typeof parsed.data.title === "string" && parsed.data.title ? parsed.data.title : undefined;
    const title =
      (typeof flags.title === "string" && flags.title) ||
      frontmatterTitle ||
      (fromStdin ? undefined : sourceLabel);

    // --- resolve the output path
    const outFlag = typeof flags.out === "string" ? flags.out : undefined;
    if (outFlag && flags.scratch === true) {
      throw new UsageError("--out and --scratch are exclusive");
    }
    // Transient output goes to the scratch area: on request, and for stdin,
    // which has no file of its own to sit next to. A generated name is unique
    // per render (scratchName): the input's directory is not part of it, and
    // two renders must never replace each other under a link already shared.
    const toScratch = flags.scratch === true || (!outFlag && fromStdin);
    const outRel = toScratch
      ? join(SCRATCH_DIR, scratchName(fromStdin ? "render" : basename(input).replace(/\.[^.]+$/, ""), format))
      : (outFlag ?? input.replace(/\.[^./\\]+$/, "") + "." + format);
    const outAbs = resolveWritable(root, outRel);
    if (!outAbs) {
      throw new UsageError(`Output path is not inside the brain: ${outRel}`);
    }
    // Asked for scratch (lexically), or resolved into it: either way the
    // write is held to the scratch rules, pre-flighted here so a refusal
    // costs no render, and checked again by the write itself.
    const scratchOutput = isInScratch(root, outRel) || isInScratch(root, outAbs);
    if (scratchOutput) {
      try {
        assertScratchWritable(root, outAbs);
      } catch (error) {
        if (error instanceof ScratchNotIgnoredError || error instanceof ScratchRedirectedError) {
          throw new UsageError(error.message);
        }
        throw error;
      }
    }
    if (!existsSync(dirname(outAbs))) {
      throw new UsageError(`Output directory does not exist: ${relative(root, dirname(outAbs))}`);
    }

    const allowHosts = repeatedValues(args, "allow-host");
    const width = flags.width !== undefined ? Number(flags.width) : undefined;
    if (width !== undefined && !Number.isFinite(width)) {
      throw new UsageError(`--width must be a number, got "${String(flags.width)}"`);
    }

    // A complete HTML document keeps its own <title>, and the envelope says so.
    const ownTitle = contentType === "html" && isFullDocument(content) ? documentTitle(content) : undefined;
    const runningTitle = flags["no-running-title"] === true ? false : undefined;

    const html = buildHtmlDocument({ content, contentType, title, allowHosts, runningTitle });
    const warnings = lintDocument(html).map((w) => w.message);

    // --- write. The destination is classified again now, from its name and
    // its freshly resolved directory: the renderer ran in between, and a
    // directory that came to resolve into scratch puts the write under the
    // scratch rules (the primitive, then the prune). A generated name refuses
    // an existing file; a name the caller chose (--out) is theirs to replace.
    // Refusals by design are usage errors; a filesystem failure (ENOSPC, ...)
    // stays an internal error.
    let wroteScratch = false;
    const write = (data: string | Uint8Array) => {
      const parent = resolveWritable(root, dirname(outRel));
      if (!parent) throw new UsageError(`Output path is not inside the brain: ${outRel}`);
      const target = join(parent, basename(outRel));
      const inScratch = scratchOutput || isInScratch(root, outRel) || isInScratch(root, target);
      try {
        if (inScratch) {
          writeScratchFile(root, outRel, data, { replace: !toScratch });
          wroteScratch = true;
        } else {
          writeFileSafely(target, data);
        }
      } catch (error) {
        if (isWriteRefusal(error)) throw new UsageError((error as Error).message);
        throw error;
      }
    };
    let pages: number | null = null;
    if (format === "html") {
      write(html);
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
        if (format === "pdf") pages = countPdfPages(buf);
        write(buf);
      } finally {
        await renderer.shutdown();
      }
    }

    const bytes = Bun.file(outAbs).size;
    const outputRel = relative(root, outAbs);
    // This command's writes into scratch prune it.
    if (wroteScratch) pruneScratch(root);
    emit(
      cli.json,
      {
        input: sourceLabel,
        output: outputRel,
        format,
        bytes,
        pages,
        title: ownTitle ?? title ?? null,
        allowHosts,
        warnings,
      },
      () => {
        const size = pages === null ? formatBytes(bytes) : `${pages} page${pages === 1 ? "" : "s"}, ${formatBytes(bytes)}`;
        console.log(`Rendered ${sourceLabel} → ${outputRel} (${format}, ${size})`);
        if (scratchOutput) {
          console.log("  in the scratch area: openable in the UI, never committed, pruned after 7 days");
        }
        if (allowHosts.length > 0) {
          console.log(`  Images allowed from: ${allowHosts.join(", ")}`);
        }
        for (const warning of warnings) console.log(`  warning: ${warning}`);
      }
    );
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
