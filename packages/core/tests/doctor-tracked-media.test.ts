/**
 * `brain doctor`'s `tracked-media` check: the five largest tracked binaries,
 * and a warning for any tracked file over `media.maxTrackedBytes`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { indexedFiles, parseCatFileBatch, type GitRun } from "../src/lib/media";

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

// Review round 2: conflicted paths and objects that vanish mid-inspection.
function gitIn(root: string) {
  return (...args: string[]) =>
    Bun.spawnSync(["git", "-C", root, "-c", "user.name=Alex Example", "-c", "user.email=alex@example.test", "-c", "commit.gpgsign=false", ...args]);
}

test("a delete/modify conflict is reported as not inspected, not passed over", async () => {
  const root = repo({ "render.png": 1_000 });
  const git = gitIn(root);
  expect(git("checkout", "-q", "-b", "theirs").exitCode).toBe(0);
  writeFileSync(join(root, "render.png"), Buffer.alloc(200_000, 7));
  expect(git("commit", "-qam", "bigger").exitCode).toBe(0);
  expect(git("checkout", "-q", "main").exitCode).toBe(0);
  expect(git("rm", "-q", "render.png").exitCode).toBe(0);
  expect(git("commit", "-qm", "delete").exitCode).toBe(0);
  expect(git("merge", "-q", "theirs").exitCode).not.toBe(0);
  const stages = new TextDecoder().decode(git("ls-files", "-s", "render.png").stdout);
  expect(stages).toContain(" 3\trender.png");

  const check = await mediaCheck(root);
  expect(check.status).toBe("warn");
  expect(check.detail).toStartWith("could not inspect 1 tracked file(s), so the figures are incomplete: 1 conflicted path(s) not inspected until the merge is resolved: render.png");
});

test("a conflict whose sides differ in size is reported as not inspected too", async () => {
  const root = repo({ "render.png": 1_000 });
  const git = gitIn(root);
  expect(git("checkout", "-q", "-b", "theirs").exitCode).toBe(0);
  writeFileSync(join(root, "render.png"), Buffer.alloc(200_000, 7));
  expect(git("commit", "-qam", "bigger").exitCode).toBe(0);
  expect(git("checkout", "-q", "main").exitCode).toBe(0);
  writeFileSync(join(root, "render.png"), Buffer.alloc(2_000, 9));
  expect(git("commit", "-qam", "smaller").exitCode).toBe(0);
  expect(git("merge", "-q", "theirs").exitCode).not.toBe(0);

  const check = await mediaCheck(root);
  expect(check.status).toBe("warn");
  expect(check.detail).toContain("1 conflicted path(s) not inspected until the merge is resolved: render.png");
});

test("an object that disappears between the size and content queries is reported, not read as media", () => {
  const root = repo({ "icon.png": 500 });
  const sha = new TextDecoder().decode(Bun.spawnSync(["git", "-C", root, "rev-parse", ":icon.png"]).stdout).trim();
  const run: GitRun = (dir, args, stdin) => {
    // Between `--batch-check` and `--batch`, the object goes.
    if (args[0] === "cat-file" && args[1] === "--batch") rmSync(join(dir, ".git", "objects", sha.slice(0, 2), sha.slice(2)));
    const proc = Bun.spawnSync(["git", "-C", dir, ...args], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
    return { ok: proc.exitCode === 0, stdout: Buffer.from(proc.stdout), stderr: new TextDecoder().decode(proc.stderr).trim() };
  };
  const { problems } = indexedFiles(root, run);
  expect(problems).toEqual([`icon.png: object ${sha} could not be read to check for a Git LFS pointer`]);
});

describe("parseCatFileBatch", () => {
  const blob = (sha: string, body: string) => `${sha} blob ${Buffer.byteLength(body)}\n${body}\n`;
  const A = "a".repeat(40);
  const B = "b".repeat(40);

  test("reads each body, and a missing object as null", () => {
    const out = Buffer.from(`${A} missing\n` + blob(B, "hello"));
    expect(parseCatFileBatch(out, [A, B]).map((b) => b?.toString() ?? null)).toEqual([null, "hello"]);
  });

  test("stops at an answer for another object, or a body that does not end where its size says", () => {
    expect(parseCatFileBatch(Buffer.from(blob(B, "x")), [A])).toEqual([null]);
    const short = Buffer.from(`${A} blob 10\nabc\n` + blob(B, "hello"));
    expect(parseCatFileBatch(short, [A, B])).toEqual([null, null]);
  });
});
