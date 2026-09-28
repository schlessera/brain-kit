/**
 * The template's search-eval support: the `eval` scripts a generated brain
 * ships, the README's example query lines (parsed with the same validator
 * `brain eval` uses, so the documented format cannot drift from it), and a
 * scratch brain generated from `template/` running `bun run eval` for real.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { parseEvalSet } from "../packages/core/src/lib/retrieval-eval";

const ROOT = resolve(import.meta.dir, "..");
const TEMPLATE = join(ROOT, "template");

/** The JSON Lines code blocks of the README's "Measuring search" section. */
function readmeExampleLines(readme: string): string[] {
  const section = readme.split(/^## /m).find((s) => s.startsWith("Measuring search"));
  if (!section) throw new Error('template/README.md has no "Measuring search" section');
  const lines: string[] = [];
  for (const block of section.matchAll(/```jsonl\n([\s\S]*?)```/g)) {
    lines.push(...block[1].split("\n").filter((l) => l.trim() !== ""));
  }
  return lines;
}

describe("the template ships search evaluation", () => {
  test("package.json has the eval and eval:baseline scripts", () => {
    const pkg = JSON.parse(readFileSync(join(TEMPLATE, "package.json"), "utf-8"));
    expect(pkg.scripts.eval).toBe("brain eval --mode fts");
    expect(pkg.scripts["eval:baseline"]).toBe("brain eval --mode fts --out evals/baseline.json");
  });

  test("the README's example lines parse with brain eval's own validator", () => {
    const lines = readmeExampleLines(readFileSync(join(TEMPLATE, "README.md"), "utf-8"));
    expect(lines.length).toBe(3);
    const { queries } = parseEvalSet(lines.join("\n"));
    // One static answer, one selector, one no-answer, as the README says.
    expect(queries.map((q) => [q.class, q.expected !== undefined, q.expect !== undefined])).toEqual([
      ["exact", true, false],
      ["time", false, true],
      ["no-answer", true, false],
    ]);
  });

  test("the evals directory exists in a new brain", () => {
    expect(readFileSync(join(TEMPLATE, "evals", ".gitkeep"), "utf-8")).toBe("");
  });
});

/**
 * A brain generated from `template/`, with `node_modules` wired the way
 * `bun install` would: `@schlessera/brain` resolvable for brain.config.ts,
 * and a `brain` bin that runs this checkout's CLI.
 */
describe("bun run eval in a brain generated from the template", () => {
  let brain: string;

  function env(): Record<string, string> {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
    delete e.GEMINI_API_KEY;
    delete e.ANTHROPIC_API_KEY;
    delete e.GOOGLE_API_KEY;
    // The jev reranker is the default with its key: a developer key would
    // turn these runs into paid network calls.
    delete e.TYPESAFE_API_KEY;
    delete e.BRAIN_RERANK_MODE;
    e.BRAIN_ROOT = brain;
    return e;
  }

  async function run(cmd: string[]) {
    const proc = Bun.spawn(cmd, { cwd: brain, env: env(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  }

  beforeAll(async () => {
    brain = mkdtempSync(join(tmpdir(), "brain-template-eval-"));
    cpSync(TEMPLATE, brain, { recursive: true });
    mkdirSync(join(brain, "node_modules", ".bin"), { recursive: true });
    symlinkSync(join(ROOT, "node_modules", "@schlessera"), join(brain, "node_modules", "@schlessera"));
    const bin = join(brain, "node_modules", ".bin", "brain");
    writeFileSync(bin, `#!/bin/sh\nexec bun ${JSON.stringify(join(ROOT, "packages/core/src/cli/brain.ts"))} "$@"\n`);
    chmodSync(bin, 0o755);
    const index = await run(["bun", "run", "brain", "index", "--json"]);
    expect(index.stderr).not.toContain("error");
    expect(index.code).toBe(0);
  });

  afterAll(() => rmSync(brain, { recursive: true, force: true }));

  test("with no set it exits 2 with the pointer to the docs, not a stack trace", async () => {
    const { code, stdout, stderr } = await run(["bun", "run", "eval", "--", "--json"]);
    expect(code).toBe(2);
    expect(stdout).not.toContain('"schema_version"');
    expect(stderr).toContain("no query set at evals/retrieval.jsonl");
    expect(stderr).toContain("docs/evaluating-search.md");
    expect(stderr).not.toMatch(/\n\s+at /);
  });

  test("with the README's static example line it scores keyless and exits 0", async () => {
    const [staticLine] = readmeExampleLines(readFileSync(join(TEMPLATE, "README.md"), "utf-8"));
    writeFileSync(join(brain, "evals", "retrieval.jsonl"), staticLine + "\n");
    const { code, stdout, stderr } = await run(["bun", "run", "eval", "--", "--json"]);
    // `bun run` echoes the script's command line to stderr; nothing else may follow.
    expect(stderr.replace(/^\$ brain eval .*\n/, "")).toBe("");
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.meta.modes).toEqual(["fts"]);
    expect(out.per_query).toHaveLength(1);
    expect(out.per_query[0]).toMatchObject({ id: "hello", rank: 1 });
  });
});
