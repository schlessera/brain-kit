import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { classify, loadPathSet, main, matchProofSystemPath, PATH_SET_FILE, timeoutSignals, type Reason } from "../scripts/proof-system";

const ROOT = resolve(import.meta.dir, "..");
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid",
  GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

/** A fixture repository with one base commit; `commit` writes files and returns the new SHA. */
function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-proof-system-"));
  directories.push(dir);
  const git = (...args: string[]) => {
    // Command-scoped, so an environment-scoped signing setting cannot reach these fixture commits (#3485).
    const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: ENV });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const commit = (changes: Record<string, string | null>, message: string) => {
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) { git("rm", "-q", "--", path); continue; }
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
      git("add", "--", path);
    }
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  const base = commit(files, "The fleet leaves Troy");
  return { dir, base, commit, git };
}

const TEST_FILE = [
  'import { expect, test } from "bun:test";',
  "",
  "const RESTART_DEADLINE_MS = 30_000;",
  "",
  'test("the raft holds", async () => {',
  "  expect(1).toBe(1);",
  "}, 5000);",
  "",
  'test("Calypso lets go", () => expect(true).toBe(true), 5000);',
  "",
].join("\n");

const BASE_FILES = {
  "packages/ui-server/src/x.ts": "export const ithaca = 1;\n",
  ".github/workflows/ci.yml": "name: ci\n",
  "packages/core/bunfig.toml": "[test]\n",
  "scripts/unit-workers.ts": "export const workers = 4;\n",
  "packages/core/tests/raft.test.ts": TEST_FILE,
};

const pathReasons = (reasons: Reason[]) => reasons.filter(r => r.kind === "path").map(r => r.path);

describe("path set", () => {
  test("a diff touching only product source is not a proof-system change", () => {
    const repo = fixture(BASE_FILES);
    const head = repo.commit({ "packages/ui-server/src/x.ts": "export const ithaca = 2;\n" }, "product");
    const result = classify(repo.base, head, { cwd: repo.dir });
    expect(result.proofSystem).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  for (const [path, content] of [
    [".github/workflows/ci.yml", "name: ci\non: push\n"],
    ["packages/core/bunfig.toml", "[test]\ntimeout = 1\n"],
    ["scripts/unit-workers.ts", "export const workers = 2;\n"],
  ] as const) {
    test(`a diff touching ${path} is a proof-system change with that path as the reason`, () => {
      const repo = fixture(BASE_FILES);
      const head = repo.commit({ [path]: content }, "proof system");
      const result = classify(repo.base, head, { cwd: repo.dir });
      expect(result.proofSystem).toBe(true);
      expect(pathReasons(result.reasons)).toEqual([path]);
    });
  }

  test("the root bunfig.toml, a nested proof-inputs.json, scripts/ci-* and deletions match", () => {
    const repo = fixture({ ...BASE_FILES, "bunfig.toml": "[test]\n", "scripts/ci-plan.ts": "export {};\n" });
    const head = repo.commit({ "bunfig.toml": "[test]\nroot = true\n", "packages/ui-kit/tests/proof-inputs.json": "{}\n",
      "scripts/ci-plan.ts": null }, "proof system");
    expect(pathReasons(classify(repo.base, head, { cwd: repo.dir }).reasons).sort())
      .toEqual(["bunfig.toml", "packages/ui-kit/tests/proof-inputs.json", "scripts/ci-plan.ts"]);
  });

  test("a rename out of the path set reports the old path", () => {
    const repo = fixture(BASE_FILES);
    repo.git("mv", "scripts/unit-workers.ts", "scripts/workers.ts");
    const head = repo.commit({}, "rename");
    expect(pathReasons(classify(repo.base, head, { cwd: repo.dir }).reasons)).toEqual(["scripts/unit-workers.ts"]);
  });

  test("the path-set file is the only place the globs are listed", () => {
    const set = loadPathSet();
    expect(set.paths).toEqual(JSON.parse(readFileSync(PATH_SET_FILE, "utf8")).paths);
    const files = Bun.spawnSync(["git", "ls-files", "-z", "--", "scripts", "tests", ".github", "packages"], { cwd: ROOT, stdout: "pipe" })
      .stdout.toString().split("\0").filter(f => /\.(?:[cm]?[jt]sx?|json|ya?ml|sh)$/.test(f) && join(ROOT, f) !== PATH_SET_FILE);
    expect(files.length).toBeGreaterThan(100);
    const globs = set.paths.filter(p => p.includes("*"));
    const literals = set.paths.filter(p => !p.includes("*"));
    const duplicates: string[] = [];
    for (const file of files) {
      let text: string;
      try { text = readFileSync(join(ROOT, file), "utf8"); } catch { continue; }
      const quoted = (p: string) => [`"${p}"`, `'${p}'`, `\`${p}\``].some(q => text.includes(q));
      if (globs.some(quoted) || literals.every(quoted)) duplicates.push(file);
    }
    expect(duplicates).toEqual([]);
  });
});

describe("timeout-change check", () => {
  test("changing a Bun test third-argument timeout is a proof-system change naming file and line", () => {
    const repo = fixture(BASE_FILES);
    const head = repo.commit({ "packages/core/tests/raft.test.ts": TEST_FILE.replace("}, 5000);", "}, 10000);") }, "slower");
    const result = classify(repo.base, head, { cwd: repo.dir });
    expect(result.proofSystem).toBe(true);
    expect(result.reasons).toEqual([{ kind: "timeout-change", path: "packages/core/tests/raft.test.ts", line: 7, side: "head",
      signal: "test-argument", name: "test", from: "5000", to: "10000" }]);
  });

  test("changing a single-line test(\"x\", fn, 5000) timeout is flagged", () => {
    const repo = fixture(BASE_FILES);
    const head = repo.commit({ "packages/core/tests/raft.test.ts":
      TEST_FILE.replace("expect(true).toBe(true), 5000);", "expect(true).toBe(true), 10000);") }, "slower");
    const result = classify(repo.base, head, { cwd: repo.dir });
    expect(result.reasons).toMatchObject([{ kind: "timeout-change", path: "packages/core/tests/raft.test.ts", line: 9, from: "5000", to: "10000" }]);
  });

  test("changing a RESTART_DEADLINE_MS constant is flagged", () => {
    const repo = fixture(BASE_FILES);
    const head = repo.commit({ "packages/core/tests/raft.test.ts": TEST_FILE.replace("30_000", "60_000") }, "longer deadline");
    const result = classify(repo.base, head, { cwd: repo.dir });
    expect(result.proofSystem).toBe(true);
    expect(result.reasons).toEqual([{ kind: "timeout-change", path: "packages/core/tests/raft.test.ts", line: 3, side: "head",
      signal: "constant", name: "RESTART_DEADLINE_MS", from: "30000", to: "60000" }]);
  });

  test("a test-file diff that changes no timeout is not a proof-system change", () => {
    const repo = fixture(BASE_FILES);
    const head = repo.commit({ "packages/core/tests/raft.test.ts": TEST_FILE
      .replace("the raft holds", "the raft still holds").replace("expect(1).toBe(1);", "expect(2).toBe(2);")
      .replace("Calypso lets go", "Calypso releases him") }, "rename tests");
    const result = classify(repo.base, head, { cwd: repo.dir });
    expect(result.proofSystem).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  test("renaming a test file without changing its timeouts is not flagged", () => {
    const repo = fixture(BASE_FILES);
    repo.git("mv", "packages/core/tests/raft.test.ts", "packages/core/tests/voyage.test.ts");
    const head = repo.commit({}, "rename");
    expect(classify(repo.base, head, { cwd: repo.dir }).proofSystem).toBe(false);
  });

  test("a removed timeout is reported at its base line", () => {
    const repo = fixture(BASE_FILES);
    const head = repo.commit({ "packages/core/tests/raft.test.ts": TEST_FILE.replace("}, 5000);", "});") }, "default timeout");
    expect(classify(repo.base, head, { cwd: repo.dir }).reasons).toEqual([{ kind: "timeout-change",
      path: "packages/core/tests/raft.test.ts", line: 7, side: "base", signal: "test-argument", name: "test", from: "5000", to: null }]);
  });

  test("a new test or test file that sets its own timeout changes no existing budget", () => {
    const repo = fixture(BASE_FILES);
    const head = repo.commit({
      "packages/core/tests/raft.test.ts": `${TEST_FILE}test("Scylla passes", async () => {\n  const deadline = Date.now() + 2000;\n}, 120_000);\n`,
      "packages/core/tests/cyclops.test.ts": 'import { test } from "bun:test";\nconst CAVE_TIMEOUT_MS = 9000;\ntest("no one escapes", () => {}, 60_000);\n',
    }, "new tests");
    expect(classify(repo.base, head, { cwd: repo.dir }).reasons).toEqual([]);
    const removed = repo.commit({ "packages/core/tests/cyclops.test.ts": null }, "drop tests");
    expect(classify(head, removed, { cwd: repo.dir }).proofSystem).toBe(false);
  });

  test("a setDefaultTimeout inserted into an existing test file is flagged", () => {
    const repo = fixture(BASE_FILES);
    const head = repo.commit({ "packages/core/tests/raft.test.ts":
      TEST_FILE.replace('from "bun:test";\n', 'from "bun:test";\nsetDefaultTimeout(60_000);\n') }, "file-wide budget");
    expect(classify(repo.base, head, { cwd: repo.dir }).reasons).toEqual([{ kind: "timeout-change", path: "packages/core/tests/raft.test.ts",
      line: 2, side: "head", signal: "call", name: "setDefaultTimeout", from: null, to: "60000" }]);
  });

  test("adding a timeout argument to an existing test is flagged", () => {
    const repo = fixture(BASE_FILES);
    const head = repo.commit({ "packages/core/tests/raft.test.ts":
      TEST_FILE.replace("}, 5000);", "}, { timeout: 8000 });") }, "option");
    expect(classify(repo.base, head, { cwd: repo.dir }).reasons).toMatchObject([
      { kind: "timeout-change", line: 7, side: "head", signal: "option", name: "timeout", from: null, to: "8000" },
      { kind: "timeout-change", line: 7, side: "base", signal: "test-argument", from: "5000", to: null },
    ]);
  });

  test("product source outside the test scope is not checked for timeouts", () => {
    const repo = fixture({ ...BASE_FILES, "packages/ui-server/src/ws/host.ts": "export const HANDSHAKE_TIMEOUT_MS = 5000;\n" });
    const head = repo.commit({ "packages/ui-server/src/ws/host.ts": "export const HANDSHAKE_TIMEOUT_MS = 9000;\n" }, "product");
    expect(classify(repo.base, head, { cwd: repo.dir }).proofSystem).toBe(false);
  });

  test("signals read options, setDefaultTimeout calls and numeric expressions", () => {
    expect(timeoutSignals('test("x", fn, { timeout: 5_000 });')).toEqual([{ kind: "option", name: "timeout", value: "5000" }]);
    expect(timeoutSignals("setDefaultTimeout(30 * 1000);")).toEqual([{ kind: "call", name: "setDefaultTimeout", value: "30*1000" }]);
    expect(timeoutSignals("const deadlineMs = 2.5;")).toEqual([{ kind: "constant", name: "deadlineMs", value: "2.5" }]);
    expect(timeoutSignals("setTimeout(resolve, 100);")).toEqual([]);
    expect(timeoutSignals('test("x", fn);')).toEqual([]);
  });
});

describe("command", () => {
  test("--json carries the boolean, the reasons and the input SHAs", () => {
    const repo = fixture(BASE_FILES);
    const head = repo.commit({ ".github/workflows/ci.yml": "name: ci2\n" }, "workflow");
    const out = main(["classify", "--base", repo.base, "--head", "HEAD", "--json"], repo.dir);
    expect(out.code).toBe(0);
    const pattern = matchProofSystemPath(".github/workflows/ci.yml");
    expect(pattern).toStartWith(".github/workflows/");
    expect(JSON.parse(out.stdout)).toEqual({ schemaVersion: 1, base: repo.base, head, proofSystem: true,
      reasons: [{ kind: "path", path: ".github/workflows/ci.yml", pattern }] });
  });

  test("an uncomputable diff exits nonzero and never reports false", () => {
    const repo = fixture(BASE_FILES);
    for (const head of ["0000000000000000000000000000000000000000", "no-such-ref", "--output=/tmp/x"]) {
      const out = main(["classify", "--base", repo.base, "--head", head, "--json"], repo.dir);
      expect(out.code).not.toBe(0);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("cannot classify");
    }
    expect(() => classify(repo.base, "no-such-ref", { cwd: repo.dir })).toThrow();
  });

  test("the script runs as a process and exits nonzero outside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "odysseus-proof-system-bare-"));
    directories.push(dir);
    const ok = Bun.spawnSync(["bun", join(ROOT, "scripts/proof-system.ts"), "classify", "--base", "HEAD~0", "--head", "HEAD", "--json"],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout.toString()).proofSystem).toBe(false);
    const bad = Bun.spawnSync(["bun", join(ROOT, "scripts/proof-system.ts"), "classify", "--base", "HEAD~1", "--head", "HEAD", "--json"],
      { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...ENV, GIT_CEILING_DIRECTORIES: tmpdir() } });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stdout.toString()).toBe("");
    const usage = Bun.spawnSync(["bun", join(ROOT, "scripts/proof-system.ts"), "classify", "--base", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(usage.exitCode).toBe(2);
  });
});
