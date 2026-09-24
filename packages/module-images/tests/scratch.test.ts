// `brain image --scratch` (#310): a draft goes to the brain's scratch area,
// and only once git ignores it. `--dry-run` decides the path and stops before
// any provider call, so a placeholder key routes and no request is made.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildTaxonomy, ignoreScratch } from "@schlessera/brain";

import { imageCommand } from "../src/cli";
import { configSchema } from "../src/module";

let root: string;
const saved = { key: process.env.GEMINI_API_KEY, log: console.log, error: console.error };
let out: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brain-image-scratch-"));
  Bun.spawnSync(["git", "-C", root, "init", "-q"]);
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  process.env.GEMINI_API_KEY = "placeholder-never-sent";
  out = [];
  console.log = (line: string) => void out.push(line);
  console.error = (line: string) => void out.push(line);
});

afterEach(() => {
  console.log = saved.log;
  console.error = saved.error;
  if (saved.key === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = saved.key;
  rmSync(root, { recursive: true, force: true });
});

const run = (argv: string[]) =>
  imageCommand.run(argv, { root, json: true, config: configSchema.parse({}), taxonomy: buildTaxonomy({}) } as never);

describe("brain image --scratch", () => {
  test("refuses while scratch is not gitignored, naming the fix", async () => {
    expect(await run(["a lighthouse", "--draft", "--scratch", "--dry-run"])).toBe(1);
    expect(out.join("\n")).toContain("brain doctor --fix");
  });

  test("once ignored, the draft goes to .brain/scratch/", async () => {
    ignoreScratch(root);
    expect(await run(["a lighthouse", "--draft", "--scratch", "--dry-run"])).toBe(0);
    const payload = JSON.parse(out.join("\n")) as { output: string };
    expect(payload.output).toMatch(/^\.brain\/scratch\/a-lighthouse-\d{4}-\d{2}-\d{2}\.[a-z]+$/);
  });

  test("--out and --scratch together are refused", async () => {
    expect(await run(["a lighthouse", "--scratch", "--out", "assets/x.png", "--dry-run"])).toBe(1);
    expect(out.join("\n")).toContain("exclusive");
  });
});
