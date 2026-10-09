import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

test("the measurement owner keeps a nonempty fixture until normal exit then removes it", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
import { readdirSync } from "node:fs";
import { optionsFor } from "./scripts/measure-show-block.ts";
const brain = optionsFor("flat", new AbortController(), true, []).cwd;
console.log("FIXTURE_LIFETIME " + JSON.stringify({ brain, files: readdirSync(brain) }));
`], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  const receipts = stdout.split("\n").filter(line => line.startsWith("FIXTURE_LIFETIME "));
  expect(receipts).toHaveLength(1);
  const { brain, files } = JSON.parse(receipts[0]!.slice("FIXTURE_LIFETIME ".length)) as { brain: string; files: string[] };
  expect(brain.startsWith(resolve(tmpdir(), "show-block-brain-"))).toBe(true);
  try {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(".claude");
    expect(existsSync(brain), "the exited owner must release its staged fixture").toBe(false);
  } finally {
    // Bound the deliberate missing-cleanup mutation without concealing its failure.
    rmSync(dirname(brain), { recursive: true, force: true });
  }
});
