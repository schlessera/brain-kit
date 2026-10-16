import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { changedFiles, FAST_TESTS, planChecks, planFromEnvironment, workspaces, proofSelections, rootConsumers, ROOT_CONSUMERS } from "../scripts/ci-plan";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ci-plan-")); scratch.push(dir);
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text);
  };
  for (const [name, deps, kind] of [
    ["core", [], "dependencies"], ["ui-sdk", ["core"], "optionalDependencies"],
    ["ui-server", ["ui-sdk"], "peerDependencies"], ["ui-react", ["ui-sdk"], "devDependencies"],
    ["module-video", [], "dependencies"],
  ] as const) write(`packages/${name}/package.json`, JSON.stringify({ name: `@fixture/${name}`,
    [kind]: Object.fromEntries(deps.map(dep => [`@fixture/${dep}`, "*"])), files: ["src", "skills"] }));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
      { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(p.exitCode, new TextDecoder().decode(p.stderr)).toBe(0);
    return new TextDecoder().decode(p.stdout).trim();
  };
  git("init", "-q"); git("config", "user.name", "Odysseus"); git("config", "user.email", "odysseus@example.invalid");
  write("packages/core/src/note.ts", "export const note = 1;\n");
  git("add", "."); git("commit", "-qm", "fixture base");
  return { dir, write, git, base: git("rev-parse", "HEAD") };
}

describe("affected CI checks", () => {
  test("real git diff selects optional, peer and dev reverse dependants transitively", () => {
    const f = fixture(); f.write("packages/core/src/note.ts", "export const note = 2;\n");
    f.git("add", "."); f.git("commit", "-qm", "edit core");
    const plan = planFromEnvironment(f.dir, { GITHUB_EVENT_NAME: "pull_request", BASE_SHA: f.base, HEAD_SHA: "HEAD" });
    expect(plan.changed).toEqual(["packages/core/src/note.ts"]);
    expect(plan.affected).toEqual(["core", "ui-react", "ui-sdk", "ui-server"]);
    expect(plan.tests.length).toBeGreaterThan(0);
    expect(plan.tests).toContain("packages/ui-sdk/tests/permission-gate.test.ts");
    expect(plan.pack).toBe(true); expect(plan.local.browser).toBe(true);
    expect(plan.tests).not.toContain("packages/module-video/tests/module.test.ts");
  });

  test("push checks exactly the previous tip while a PR uses its merge base", () => {
    const f = fixture(); f.git("checkout", "-qb", "topic");
    f.write("packages/core/src/note.ts", "export const note = 2;\n"); f.git("add", "."); f.git("commit", "-qm", "topic edit");
    const topic = f.git("rev-parse", "HEAD"); f.git("checkout", "--detach", f.base);
    f.write("packages/module-video/src/video.ts", "export const video = 1;\n"); f.git("add", "."); f.git("commit", "-qm", "base edit");
    const base = f.git("rev-parse", "HEAD");
    expect(changedFiles(f.dir, base, topic, true)).toEqual(["packages/core/src/note.ts"]);
    expect(changedFiles(f.dir, base, topic, false)).toEqual(["packages/core/src/note.ts", "packages/module-video/src/video.ts"]);
  });

  test("rename/deletion and filenames with spaces cannot hide the former owner", () => {
    const f = fixture(); f.git("mv", "packages/core/src/note.ts", "packages/module-video/old note.ts");
    f.git("commit", "-qm", "move");
    const files = changedFiles(f.dir, f.base);
    expect(files).toEqual(["packages/core/src/note.ts", "packages/module-video/old note.ts"]);
    expect(planChecks(files, workspaces(f.dir)).affected).toContain("ui-server");
  });

  test("local planning includes committed, staged, unstaged and untracked work", () => {
    const f = fixture(); f.write("packages/core/src/note.ts", "export const note = 2;\n");
    f.write("packages/module-video/new.ts", "export {};\n");
    expect(changedFiles(f.dir, f.base, "HEAD", true, true)).toEqual(["packages/core/src/note.ts", "packages/module-video/new.ts"]);
  });

  test("ordinary docs and changeset entries do not buy heavy automatic checks", () => {
    const f = fixture();
    const plan = planChecks(["README.md", "docs/cli.md", ".changeset/odysseus.md"], workspaces(f.dir));
    expect(plan.tests).toEqual([]); expect(plan.typecheck).toBe(false); expect(plan.pack).toBe(false);
    expect(Object.values(plan.local)).toEqual([false, false, false, false, false, false]);
  });

  test("package tests and stories require local runtime proof but no packed consumer install", () => {
    const f = fixture(); const packages = workspaces(f.dir);
    for (const path of ["packages/ui-react/tests/slow-runtime.test.ts", "packages/ui-react/stories/Note.stories.tsx"]) {
      const plan = planChecks([path], packages);
      expect(plan.local.fullTests).toBe(true); expect(plan.local.browser).toBe(true);
      expect(plan.pack).toBe(false); expect(plan.typecheck).toBe(true);
    }
    expect(planChecks(["packages/core/skills/capture/SKILL.md"], packages).pack).toBe(true);
  });

  test("global dependency/tooling edits and unknown packages expand checks conservatively", () => {
    const f = fixture();
    for (const path of ["bun.lock", "scripts/test-network-preload.ts", "tsconfig.json", "packages/new/src/index.ts", ".changeset/config.json"]) {
      const plan = planChecks([path], workspaces(f.dir));
      expect(plan.global).toBe(true); expect(plan.affected).toContain("module-video");
      expect(plan.tests).toContain("tests/release-manifest.test.ts"); expect(plan.pack).toBe(true);
      expect(Object.values(plan.local).every(Boolean)).toBe(true);
    }
  });

  test("fixture Markdown and shipped skills select behavioral checks without unnecessary typechecking", () => {
    const f = fixture();
    for (const path of ["packages/core/fixtures/corpus/notes/tide.md", "packages/core/skills/capture/SKILL.md"]) {
      const plan = planChecks([path], workspaces(f.dir));
      expect(plan.tests).toContain("packages/core/tests/eval-corpus.test.ts");
      expect(plan.typecheck).toBe(false); expect(plan.local.fullTests).toBe(true);
    }
  });

  test("missing or unreachable bases fail rather than reporting an empty selection", () => {
    const f = fixture();
    expect(() => changedFiles(f.dir, "" )).toThrow("diff base");
    expect(() => changedFiles(f.dir, "0".repeat(40))).toThrow("diff base");
    expect(() => changedFiles(f.dir, "no-such-commit")).toThrow("Cannot determine");
  });

  test("the executable writes affected job outputs and keeps drafts on cheap gates", async () => {
    const f = fixture(); f.write("scripts/ci-plan.ts", readFileSync(join(import.meta.dir, "../scripts/ci-plan.ts"), "utf8"));
    f.write("packages/core/src/note.ts", "export const note = 2;\n");
    f.git("add", "."); f.git("commit", "-qm", "planner fixture");
    for (const draft of ["true", "false"]) {
      const output = join(f.dir, `outputs-${draft}`); const plan = join(f.dir, `plan-${draft}.json`);
      const eventPath = join(f.dir, "event.json");
      writeFileSync(eventPath, JSON.stringify({ action: "ready_for_review", pull_request: { draft: draft === "true" } }));
      const child = Bun.spawn([process.execPath, join(f.dir, "scripts/ci-plan.ts")], { cwd: f.dir,
        stdout: "pipe", stderr: "pipe", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request",
          BASE_SHA: f.base, HEAD_SHA: "HEAD", GITHUB_EVENT_PATH: eventPath, PR_DRAFT: draft, GITHUB_OUTPUT: output, CI_PLAN_PATH: plan } });
      const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code, err).toBe(0);
      const expected = proofSelections(JSON.parse(readFileSync(plan, "utf8")), draft === "true");
      expect(readFileSync(output, "utf8")).toBe(`cadence=${draft === "true" ? "draft" : "confirmation"}\n` + Object.entries(expected).map(([name, value]) => `${name}=${value}\n`).join(""));
      expect(expected.unit).toBe(draft === "false");
      expect(expected.runtime).toBe(draft === "false");
      expect(JSON.parse(readFileSync(plan, "utf8")).tests.length).toBeGreaterThan(0);
    }
  });

  test("every curated test exists and no browser/endurance filename joins implicitly", () => {
    const root = resolve(import.meta.dir, ".."); const files = Object.values(FAST_TESTS).flat();
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      expect(Bun.file(join(root, file)).size, file).toBeGreaterThan(0);
      // This names a manifest-only version guard, not a runtime launch suite.
      if (file.endsWith("/measured-runtime.test.ts")) continue;
      expect(file, file).not.toMatch(/-runtime\.test|\/browser\/|\.visual\.|\.offline\./);
    }
  });
});


describe("root consumer proof selection", () => {
  const emptyLocal = { fullTests: true, browser: false, layout: false, captures: false, runtime: false, endurance: false };
  test.each([
    ["tests/owned.test.ts", []],
    ["scripts/captures/x.ts", ["captures"]],
    ["scripts/native-proof/x.sh", ["runtime"]],
    ["scripts/prove-native-host.ts", ["runtime"]],
    ["scripts/visual.mjs", ["browser", "layout", "endurance"]],
    ["scripts/browser-shards.ts", ["browser", "layout", "endurance"]],
    ["scripts/ci-example.ts", []],
    ["scripts/proof-example.ts", []],
    ["scripts/candidate-proof.ts", []],
    ["website/example.html", []],
    ["experiments/foo.ts", []],
  ] as const)("maps %s to exact consumers and categories", (path, categories) => {
    const f = fixture(); f.write(path, "// owned input\n");
    f.write("tests/consumer.test.ts", `// consumes ${path}\n`);
    f.write("tests/unrelated.test.ts", "// unrelated\n"); f.git("add", ".");
    const plan = planChecks([path], workspaces(f.dir), f.dir);
    expect(plan.global, "ROOT_CONSUMER_NOT_GLOBAL").toBe(false);
    expect(plan.affected).toEqual([]);
    const consumers = path.startsWith("tests/") ? [path] : ["tests/consumer.test.ts"];
    expect(plan.unitTests, "ROOT_CONSUMER_EXACT_FILES").toEqual([...new Set([...FAST_TESTS.tooling!, ...consumers])].sort());
    expect(plan.local, "ROOT_CONSUMER_EXACT_CATEGORIES").toEqual({ ...emptyLocal, ...Object.fromEntries(categories.map(category => [category, true])) });
    expect(plan.pack).toBe(false);
  });

  test("helper references propagate through relative imports and fixture strings", () => {
    const f = fixture(); f.write("tests/fixtures/tide.json", "{}");
    f.write("tests/helpers/tide.ts", 'const fixture = "../fixtures/tide.json";');
    f.write("packages/core/tests/helper.test.ts", 'import "../../../tests/helpers/tide";');
    f.write("tests/unrelated.test.ts", "// unrelated"); f.git("add", ".");
    const plan = planChecks(["tests/fixtures/tide.json"], workspaces(f.dir), f.dir);
    expect(plan.global, "HELPER_CONSUMER_SCAN_REQUIRED").toBe(false);
    expect(plan.unitTests, "HELPER_CONSUMER_SCAN_REQUIRED").toContain("packages/core/tests/helper.test.ts");
    expect(plan.unitTests).not.toContain("tests/unrelated.test.ts");
  });

  test("unknown inputs, unreadable files, outside symlinks and conflicting mappings remain global", () => {
    const f = fixture(); f.write("scripts/new.ts", "export {};"); f.git("add", ".");
    expect(planChecks(["scripts/new.ts"], workspaces(f.dir), f.dir).global, "UNKNOWN_INPUT_GLOBAL").toBe(true);
    f.write("scripts/captures/x.ts", "export {};"); f.git("add", ".");
    chmodSync(join(f.dir, "scripts/captures/x.ts"), 0);
    expect(planChecks(["scripts/captures/x.ts"], workspaces(f.dir), f.dir).global, "UNREADABLE_INPUT_GLOBAL").toBe(true);
    chmodSync(join(f.dir, "scripts/captures/x.ts"), 0o644);
    const outside = fixture(); symlinkSync(join(outside.dir, "packages/core/src/note.ts"), join(f.dir, "scripts/captures/outside.ts")); f.git("add", ".");
    expect(planChecks(["scripts/captures/outside.ts"], workspaces(f.dir), f.dir).global, "OUTSIDE_SYMLINK_GLOBAL").toBe(true);
    rmSync(join(f.dir, "scripts/captures/outside.ts")); f.git("add", ".");
    expect(rootConsumers(f.dir, ["scripts/captures/x.ts"], [...ROOT_CONSUMERS,
      { prefix: "scripts/", categories: ["runtime"] }]).global, "CONFLICTING_PREFIX_GLOBAL").toBe(true);
  });

  test("package changes retain complete root discovery alongside selected consumers", () => {
    const f = fixture(); f.write("tests/owned.test.ts", "// owned"); f.git("add", ".");
    const plan = planChecks(["tests/owned.test.ts", "packages/core/src/note.ts"], workspaces(f.dir), f.dir);
    expect(plan.unitTests).toBeUndefined(); expect(plan.affected).toContain("ui-server");
  });
});


test("main pushes preserve previous global root selection while PRs map consumers", () => {
  const f = fixture(); f.write("tests/owned.test.ts", "// owned"); f.git("add", "."); f.git("commit", "-qm", "root test");
  const env = { BASE_SHA: f.base, BEFORE_SHA: f.base, HEAD_SHA: "HEAD" };
  expect(planFromEnvironment(f.dir, { ...env, GITHUB_EVENT_NAME: "push" }).global).toBe(true);
  expect(planFromEnvironment(f.dir, { ...env, GITHUB_EVENT_NAME: "pull_request" }).global).toBe(false);
});


test("exported tests remain helpers and ordinary leaves do not expand through runner inventories", () => {
  const f = fixture(); f.write("tests/helper.test.ts", "export const tide = 1;");
  f.write("tests/consumer.test.ts", 'import { tide } from "./helper.test";');
  f.write("scripts/runner.ts", 'const files = ["tests/consumer.test.ts"];'); f.git("add", ".");
  expect(rootConsumers(f.dir, ["tests/helper.test.ts"]).tests, "EXPORTED_TEST_CONSUMERS_REQUIRED").toEqual(["tests/consumer.test.ts", "tests/helper.test.ts"]);
  const leaf = rootConsumers(f.dir, ["tests/consumer.test.ts"]);
  expect(leaf.global).toBe(false); expect(leaf.tests).toEqual(["tests/consumer.test.ts"]);
});

test("internal symlink aliases retain target and transitive test consumers", () => {
  const f = fixture(); f.write("tests/fixtures/tide.json", "{}");
  symlinkSync("fixtures/tide.json", join(f.dir, "tests/tide-alias.json"));
  f.write("tests/alias.test.ts", 'const fixture = "./tide-alias.json";'); f.git("add", ".");
  expect(rootConsumers(f.dir, ["tests/fixtures/tide.json"]).tests, "SYMLINK_TARGET_CONSUMER_REQUIRED").toEqual(["tests/alias.test.ts"]);
});
