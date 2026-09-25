/**
 * `brain index --on-commit`, the post-commit hook's call (#424): it embeds
 * what a commit changed only when the brain opts in with
 * `hooks.embedOnCommit` and has an embedding provider, and is otherwise the
 * free keyword pass it always was.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import { indexCommand } from "../src/cli/commands/index-cmd";
import type { CliContext } from "../src/cli/types";
import { installGitHooks } from "../src/cli/hooks-util";
import { initContext, setContext } from "../src/lib/context";
import type { EmbeddingProvider } from "../src/lib/seams";
import { vecAvailable } from "./vec-fixture";

const DIM = 16;
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const section = (word: string, text = `${word} `.repeat(120).trim()) => [`## About ${word}`, "", text, ""];
function doc(blimpText?: string): string {
  return [
    "---",
    "type: note",
    "title: Airships",
    'created: "2026-01-01"',
    'updated: "2026-01-02"',
    "---",
    "",
    ...section("zeppelin"),
    ...section("blimp", blimpText),
    ...section("dirigible"),
  ].join("\n");
}

function brain(config: object | null): string {
  const root = mkdtempSync(join(tmpdir(), "brain-on-commit-"));
  dirs.push(root);
  const files: Record<string, string> = { "notes/airships.md": doc() };
  if (config) files["brain.config.json"] = JSON.stringify(config);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

/** The fake provider, counting provider calls and the texts in them. */
function countingProvider(): { provider: EmbeddingProvider; calls: string[][] } {
  const calls: string[][] = [];
  const vector = (seed: number) => new Float32Array(DIM).map((_, i) => ((seed * 31 + i * 7) % 97) / 97);
  return {
    calls,
    provider: {
      id: "fake:on-commit",
      dimensions: DIM,
      async embed(texts) {
        calls.push(texts);
        return texts.map((t, i) => vector(t.length + i));
      },
      async embedQuery(text) {
        return vector(text.length);
      },
    },
  };
}

/** Run `brain index <args>` in-process, the way the CLI would, with `embeddings` as the configured provider. */
async function index(root: string, args: string[], embeddings?: EmbeddingProvider): Promise<{ errors: string; stdout: string }> {
  const previous = setContext(null);
  const brainCtx = await initContext({ root });
  setContext(previous);
  const cli: CliContext = { brain: brainCtx, json: true, embeddings };
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const warn = console.warn;
  const error = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.warn = (...a: unknown[]) => err.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  try {
    await indexCommand.run(args, cli);
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
  return { errors: err.join("\n"), stdout: out.join("\n") };
}

const HOOK_ARGS = ["--incremental", "--quiet", "--on-commit"];

describe("brain index --on-commit", () => {
  test.if(vecAvailable)("with hooks.embedOnCommit on, a commit that changes one chunk embeds that chunk alone", async () => {
    const root = brain({ hooks: { embedOnCommit: true } });
    const seed = countingProvider();
    await index(root, ["--embeddings"], seed.provider);
    expect(seed.calls.flat().length).toBe(3);

    writeFileSync(join(root, "notes/airships.md"), doc(`${"blimp ".repeat(119)}airship`));
    const counting = countingProvider();
    await index(root, HOOK_ARGS, counting.provider);
    expect(counting.calls.length).toBe(1);
    expect(counting.calls[0].length).toBe(1);
    expect(counting.calls[0][0]).toContain("airship");
  });

  for (const config of [null, { hooks: {} }, { hooks: { embedOnCommit: false } }]) {
    test.if(vecAvailable)(`with the option ${config ? JSON.stringify(config.hooks) : "absent"}, it makes no provider call`, async () => {
      const root = brain(config);
      const counting = countingProvider();
      await index(root, HOOK_ARGS, counting.provider);
      writeFileSync(join(root, "notes/airships.md"), doc(`${"blimp ".repeat(119)}airship`));
      await index(root, HOOK_ARGS, counting.provider);
      expect(counting.calls).toEqual([]);
    });
  }

  test("with the option on and no provider configured, it is the plain pass, silently", async () => {
    const root = brain({ hooks: { embedOnCommit: true } });
    // Assets are registered only by an embeddings pass, so one tells the two apart.
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets/logo.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const { errors, stdout } = await index(root, HOOK_ARGS);
    expect(errors).toBe("");
    const stats = JSON.parse(stdout) as { added: number; assets: number };
    expect(stats.added).toBe(1);
    expect(stats.assets).toBe(0);
  });

  test("the config schema rejects a non-boolean embedOnCommit", async () => {
    const root = brain({ hooks: { embedOnCommit: "yes" } });
    await expect(initContext({ root })).rejects.toThrow(/embedOnCommit/);
    setContext(null);
  });
});

describe("the installed post-commit hook", () => {
  test("passes --on-commit, so the brain's config decides", () => {
    const root = mkdtempSync(join(tmpdir(), "brain-on-commit-hook-"));
    dirs.push(root);
    Bun.spawnSync(["git", "init", "-q", root]);
    const result = installGitHooks(root);
    expect(result.installed).toBe(true);
    const hook = readFileSync(join(root, result.hooksPath!, "post-commit"), "utf8");
    expect(hook).toContain('index --incremental --quiet --on-commit >/dev/null 2>&1 &');
  });
});
