/**
 * `brain render` and the scratch area (#310): transient output lands inside
 * the brain, where the UI can open it, and only once git ignores it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

let root: string;

// Several CLI launches per test; each takes seconds when the whole suite runs.
const CLI_TIMEOUT_MS = 120_000;

function git(...args: string[]) {
  return Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
}

beforeEach(() => {
  // A git repository with no ignore line for scratch: an existing brain from
  // before the scratch area existed.
  root = makeTempBrain();
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes/trip.md"), "# Trip\n");
  git("init", "-q");
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
});

afterEach(() => cleanup(root));

const scratchFiles = () =>
  existsSync(join(root, ".brain/scratch")) ? readdirSync(join(root, ".brain/scratch")) : [];

describe("render into the scratch area", () => {
  test("refuses while scratch is not gitignored, and names the fix", async () => {
    const res = await runCli(root, ["render", "notes/trip.md", "--format", "html", "--scratch"]);
    expect(res.code).toBe(1);
    expect(res.stderr + res.stdout).toContain("brain doctor --fix");
    expect(scratchFiles()).toEqual([]);
  });

  test("brain doctor --fix makes it writable, and the render lands there, uncommittable", async () => {
    const doctor = await runCli(root, ["doctor", "--fix", "--json"]);
    const report = JSON.parse(doctor.stdout) as { checks: { id: string; status: string }[]; fixesApplied: string[] };
    expect(report.fixesApplied).toContain("scratch");
    expect(report.checks.find((c) => c.id === "scratch")?.status).toBe("pass");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".brain/scratch/");

    const res = await runCli(root, ["render", "notes/trip.md", "--format", "html", "--scratch", "--json"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as { output: string };
    expect(out.output).toMatch(/^\.brain\/scratch\/trip-\d{8}T\d{9}Z-[0-9a-f]{6}\.html$/);
    expect(readFileSync(join(root, out.output), "utf8")).toContain("<h1>Trip</h1>");
    // Nothing in scratch is something git would commit.
    git("add", "-A");
    const staged = new TextDecoder().decode(git("diff", "--cached", "--name-only").stdout);
    expect(staged).not.toContain(".brain/scratch");
    expect(staged).toContain("notes/trip.md");
  }, CLI_TIMEOUT_MS);

  test("a write into scratch prunes it, so it never waits for the daily pass", async () => {
    await runCli(root, ["doctor", "--fix"]);
    mkdirSync(join(root, ".brain/scratch"), { recursive: true });
    const stale = join(root, ".brain/scratch/stale.pdf");
    writeFileSync(stale, "old");
    const t = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, t, t);
    const res = await runCli(root, ["render", "notes/trip.md", "--format", "html", "--scratch"]);
    expect(res.code).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(scratchFiles().filter((f) => f.startsWith("trip-"))).toHaveLength(1);
  }, CLI_TIMEOUT_MS);

  test("two inputs with one basename, and two renders of one input, all keep their own output", async () => {
    await runCli(root, ["doctor", "--fix"]);
    mkdirSync(join(root, "notes/a"), { recursive: true });
    mkdirSync(join(root, "notes/b"), { recursive: true });
    writeFileSync(join(root, "notes/a/report.md"), "# Report A\n");
    writeFileSync(join(root, "notes/b/report.md"), "# Report B\n");
    const outputs: string[] = [];
    for (const input of ["notes/a/report.md", "notes/b/report.md", "notes/a/report.md"]) {
      const res = await runCli(root, ["render", input, "--format", "html", "--scratch", "--json"]);
      expect(res.code).toBe(0);
      outputs.push((JSON.parse(res.stdout) as { output: string }).output);
    }
    expect(new Set(outputs).size).toBe(3);
    expect(readFileSync(join(root, outputs[0]), "utf8")).toContain("<h1>Report A</h1>");
    expect(readFileSync(join(root, outputs[1]), "utf8")).toContain("<h1>Report B</h1>");
    expect(readFileSync(join(root, outputs[2]), "utf8")).toContain("<h1>Report A</h1>");
  }, CLI_TIMEOUT_MS);

  test("a scratch linked to a content directory is refused, and nothing lands in the content", async () => {
    // A link out of the brain is already refused as an escape; a link to a
    // directory inside it is contained, and is the case the guard exists for:
    // a "scratch" write would otherwise become content.
    await runCli(root, ["doctor", "--fix"]);
    // The check created the (empty) directory; the link takes its place.
    rmSync(join(root, ".brain/scratch"), { recursive: true, force: true });
    symlinkSync(join("..", "notes"), join(root, ".brain/scratch"));
    const res = await runCli(root, ["render", "notes/trip.md", "--format", "html", "--scratch"]);
    expect(res.code).toBe(1);
    expect(res.stderr + res.stdout).toContain("redirected by a symlink");
    expect(readdirSync(join(root, "notes")).filter((f) => f.endsWith(".html"))).toEqual([]);
  }, CLI_TIMEOUT_MS);

  test("stdin without --out goes to scratch", async () => {
    await runCli(root, ["doctor", "--fix"]);
    const proc = Bun.spawn(["bun", BRAIN_BIN, "render", "-", "--format", "html", "--json"], {
      env: keylessEnv(root),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
    proc.stdin.write("# From stdin\n");
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
    const out = JSON.parse(await new Response(proc.stdout).text()) as { output: string };
    expect(out.output).toMatch(/^\.brain\/scratch\/render-.*\.html$/);
    expect(readFileSync(join(root, out.output), "utf8")).toContain("<h1>From stdin</h1>");
  }, CLI_TIMEOUT_MS);

  test("an explicit --out into scratch is held to the same rule, and once ignored is the caller's to overwrite", async () => {
    const res = await runCli(root, ["render", "notes/trip.md", "--format", "html", "--out", ".brain/scratch/x.html"]);
    expect(res.code).toBe(1);
    expect(res.stderr + res.stdout).toContain("brain doctor --fix");
    await runCli(root, ["doctor", "--fix"]);
    for (let i = 0; i < 2; i++) {
      const again = await runCli(root, ["render", "notes/trip.md", "--format", "html", "--out", ".brain/scratch/x.html"]);
      expect(again.code).toBe(0);
    }
    expect(scratchFiles()).toEqual(["x.html"]);
  }, CLI_TIMEOUT_MS);

  test("a rule that excludes the files but not the directory is refused, and doctor --fix repairs it", async () => {
    writeFileSync(join(root, ".gitignore"), ".brain/scratch/*\n!.brain/scratch/exposed.html\n");
    const res = await runCli(root, ["render", "notes/trip.md", "--format", "html", "--out", ".brain/scratch/exposed.html"]);
    expect(res.code).toBe(1);
    expect(res.stderr + res.stdout).toContain("not gitignored as a directory");
    expect(scratchFiles()).toEqual([]);
    await runCli(root, ["doctor", "--fix"]);
    const again = await runCli(root, ["render", "notes/trip.md", "--format", "html", "--out", ".brain/scratch/exposed.html"]);
    expect(again.code).toBe(0);
    expect(git("check-ignore", "-q", "--no-index", "--", ".brain/scratch/exposed.html").exitCode).toBe(0);
  }, CLI_TIMEOUT_MS);
});

describe("render --out outside scratch", () => {
  test("never writes through a link: a --out that is a symlink to a note is refused, and the note is untouched", async () => {
    symlinkSync("trip.md", join(root, "notes", "link.html"));
    const res = await runCli(root, ["render", "notes/trip.md", "--format", "html", "--out", "notes/link.html"]);
    expect(res.code).toBe(1);
    expect(res.stderr + res.stdout).toContain("symlink");
    expect(readFileSync(join(root, "notes", "trip.md"), "utf8")).toBe("# Trip\n");
  });
});

describe("brain doctor", () => {
  test("reports the scratch check, and --fix is idempotent", async () => {
    const before = JSON.parse((await runCli(root, ["doctor", "--json"])).stdout) as { checks: { id: string; status: string }[] };
    expect(before.checks.find((c) => c.id === "scratch")?.status).toBe("warn");
    await runCli(root, ["doctor", "--fix"]);
    await runCli(root, ["doctor", "--fix"]);
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignore.split("\n").filter((l) => l === ".brain/scratch/")).toHaveLength(1);
  }, CLI_TIMEOUT_MS);
});
