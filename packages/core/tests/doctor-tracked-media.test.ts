/**
 * `brain doctor`'s `tracked-media` check: the five largest tracked binaries,
 * and a warning for any tracked file over `media.maxTrackedBytes`.
 */

import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

/** A git brain with a 100 KB limit and the given files committed. */
function repo(files: Record<string, number>): string {
  const root = makeTempBrain();
  temps.push(root);
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } })
  );
  const config = join(root, "brain.config.ts");
  const text = readFileSync(config, "utf8");
  expect(text).toContain("  taxonomy: {\n");
  writeFileSync(config, text.replace("  taxonomy: {\n", "  media: { maxTrackedBytes: 100_000 },\n  taxonomy: {\n"));
  for (const [rel, bytes] of Object.entries(files)) writeFileSync(join(root, rel), Buffer.alloc(bytes, 7));
  const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-C", root, ...args]).exitCode).toBe(0);
  git("init", "-q", "-b", "main");
  git("add", "-A", "--", ".", ":!node_modules");
  git("-c", "user.name=Alex Example", "-c", "user.email=alex@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return root;
}

async function mediaCheck(root: string) {
  const { stdout, code } = await runCli(root, ["doctor", "--json"]);
  expect(code).toBe(0);
  const check = JSON.parse(stdout).checks.find((c: { id: string }) => c.id === "tracked-media");
  expect(check).toBeDefined();
  return check as { status: string; detail: string; fix?: string };
}

test("a tracked file over the limit warns, naming it, beside the largest binaries", async () => {
  const check = await mediaCheck(repo({ "render.png": 200_000, "photo.jpg": 50_000, "notes.pdf": 1_000 }));
  expect(check.status).toBe("warn");
  expect(check.detail).toBe(
    "1 tracked file(s) over media.maxTrackedBytes (97.7 KB): render.png (195.3 KB); " +
      // The fixture corpus ships two small binaries of its own.
      "largest tracked binaries: render.png (195.3 KB), photo.jpg (48.8 KB), notes.pdf (1000 B), studies/star-chart.pdf (598 B), me/avatar.png (72 B)"
  );
  expect(check.fix).toContain("docs/media.md");
});

test("without a file over the limit it passes and lists the five largest binaries", async () => {
  const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`img-${i}.png`, 1_000 * (i + 1)]));
  const check = await mediaCheck(repo(files));
  expect(check.status).toBe("pass");
  expect(check.detail).toBe(
    "largest tracked binaries: img-6.png (6.8 KB), img-5.png (5.9 KB), img-4.png (4.9 KB), img-3.png (3.9 KB), img-2.png (2.9 KB)"
  );
});
