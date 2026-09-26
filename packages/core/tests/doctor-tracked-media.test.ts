/**
 * `brain doctor`'s `tracked-media` check: the five largest tracked binaries,
 * and a warning for any tracked file over `media.maxTrackedBytes`.
 */

import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

/** A git brain with a 100 KB limit and the given files committed (a size, or exact content). */
function repo(files: Record<string, number | string>): string {
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
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(root, rel), typeof content === "number" ? Buffer.alloc(content, 7) : content);
  }
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

// Review round 1: what counts is the blob git stores, not the work tree.
test("a committed file over the limit still warns after its work-tree copy is deleted", async () => {
  const root = repo({ "render.png": 200_000 });
  rmSync(join(root, "render.png"));
  const check = await mediaCheck(root);
  expect(check.status).toBe("warn");
  expect(check.detail).toStartWith("1 tracked file(s) over media.maxTrackedBytes (97.7 KB): render.png (195.3 KB)");
});

test("a work-tree copy grown past the limit, not yet committed, does not warn", async () => {
  const root = repo({ "render.png": 1_000 });
  writeFileSync(join(root, "render.png"), Buffer.alloc(200_000, 7));
  const check = await mediaCheck(root);
  expect(check.status).toBe("pass");
  expect(check.detail).toContain("render.png (1000 B)");
});

const POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 6000000\n";

test("a Git LFS pointer is counted as a pointer, even with the payload checked out", async () => {
  const root = repo({ "master.mov": POINTER });
  // What `git lfs pull` leaves in the work tree: the 6 MB payload, while the index holds the pointer.
  writeFileSync(join(root, "master.mov"), Buffer.alloc(6_000_000, 7));
  const check = await mediaCheck(root);
  expect(check.status).toBe("pass");
  expect(check.detail).toContain("1 file(s) in Git LFS");
  expect(check.detail).not.toContain("master.mov");
});

test("a tracked symlink is not weighed by its target", async () => {
  const outside = makeTempBrain({ empty: true });
  temps.push(outside);
  writeFileSync(join(outside, "huge.png"), Buffer.alloc(200_000, 7));
  const root = repo({});
  symlinkSync(join(outside, "huge.png"), join(root, "linked.png"));
  const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-C", root, ...args]).exitCode).toBe(0);
  git("add", "linked.png");
  git("-c", "user.name=Alex Example", "-c", "user.email=alex@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "link");
  const check = await mediaCheck(root);
  expect(check.status).toBe("pass");
  expect(check.detail).not.toContain("linked.png");
});

test("an object git cannot read makes the check warn that it is incomplete", async () => {
  const root = repo({ "render.png": 50_000 });
  const sha = new TextDecoder().decode(Bun.spawnSync(["git", "-C", root, "rev-parse", ":render.png"]).stdout).trim();
  rmSync(join(root, ".git", "objects", sha.slice(0, 2), sha.slice(2)), { force: true });
  const check = await mediaCheck(root);
  expect(check.status).toBe("warn");
  expect(check.detail).toStartWith("could not inspect 1 tracked file(s), so the figures are incomplete: render.png: object");
});
