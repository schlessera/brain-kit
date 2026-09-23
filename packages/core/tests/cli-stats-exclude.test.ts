/**
 * `brain stats --json`'s corpus figure and the index, spawned, over a brain
 * whose config spells an `exclude.dirs` entry with a trailing slash (#139).
 *
 * Matched literally, `dirs: ["skipme/"]` excluded nothing from the index while
 * the stats corpus walk pruned the directory, so `size.corpus` and the index
 * told different stories about `skipme/`. Normalised on load, both leave it
 * out — which also means a brain carrying that spelling loses those files from
 * its index on the next `brain index`, the ruled behaviour.
 *
 * Keyless: the spawned bin runs with every API key stripped.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

/** What the fixture corpus holds on its own: indexed documents, and files on disk. */
const CORPUS_DOCUMENTS = 25;
const CORPUS_FILES = 29;

let root: string;

beforeAll(async () => {
  root = makeTempBrain();
  const configPath = join(root, "brain.config.ts");
  const config = readFileSync(configPath, "utf8");
  const anchor = "  taxonomy: {";
  expect(config).toContain(anchor);
  writeFileSync(configPath, config.replace(anchor, `  exclude: { dirs: ["skipme/"] },\n\n${anchor}`));

  mkdirSync(join(root, "skipme/sub"), { recursive: true });
  const note = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\nA note the config excludes.\n`;
  writeFileSync(join(root, "skipme/a.md"), note("Skipped A"));
  writeFileSync(join(root, "skipme/sub/b.md"), note("Skipped B"));

  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
});

afterAll(() => cleanup(root));

describe('exclude.dirs: ["skipme/"]', () => {
  test("the index and the corpus figure both leave skipme/ out", async () => {
    const { stdout, code } = await runCli(root, ["stats", "--json"]);
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { documents: number; size: { corpus: { files: number } } };

    // Goldens: exactly the fixture's own figures, as if skipme/ were not there.
    expect(out.documents).toBe(CORPUS_DOCUMENTS);
    expect(out.size.corpus.files).toBe(CORPUS_FILES);
  });

  test("no document under skipme/ reached the index", async () => {
    const { stdout, code } = await runCli(root, ["search", "excludes", "--json"]);
    expect(code).toBe(0);
    const { results } = JSON.parse(stdout) as { results: { path: string }[] };
    expect(results.filter((r) => r.path.startsWith("skipme/"))).toEqual([]);
  });
});
