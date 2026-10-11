import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPackages } from "../scripts/check-packages";
import { localChecks, requireRuntimeTools } from "../scripts/check-pr";
import { planChecks, workspaces } from "../scripts/ci-plan";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "local-checks-")); dirs.push(dir);
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  return dir;
}

test("runtime tools reject invalid Chrome paths before launching any child", () => {
  const dir = fixture();
  const file = join(dir, "non-executable"); writeFileSync(file, "fixture"); chmodSync(file, 0o600);
  const dangling = join(dir, "dangling"); symlinkSync(join(dir, "absent-target"), dangling);
  const plan = planChecks(["package.json"], []);
  const previous = process.env.PUPPETEER_EXECUTABLE_PATH;
  const which = spyOn(Bun, "which").mockImplementation(name => `/fixture/${name}`);
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("Unexpected child launch"); });
  try {
    for (const path of [dir, file, join(dir, "absent"), dangling]) {
      process.env.PUPPETEER_EXECUTABLE_PATH = path;
      expect(() => requireRuntimeTools(plan)).toThrow(`Local runtime proof requires real Chrome; set PUPPETEER_EXECUTABLE_PATH (rejected path: ${path})`);
      expect(spawn).not.toHaveBeenCalled();
    }
  } finally {
    which.mockRestore(); spawn.mockRestore();
    if (previous === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previous;
  }
});

test("runtime tools accept executable regular files and symlinks and retain the namespace probe", () => {
  const dir = fixture(); const file = join(dir, "chrome");
  writeFileSync(file, "fixture"); chmodSync(file, 0o700);
  const link = join(dir, "chrome-link"); symlinkSync(file, link);
  const plan = planChecks(["package.json"], []);
  const previous = process.env.PUPPETEER_EXECUTABLE_PATH;
  const which = spyOn(Bun, "which").mockImplementation(name => `/fixture/${name}`);
  const spawn = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0 } as ReturnType<typeof Bun.spawnSync>);
  try {
    for (const path of [file, link]) {
      process.env.PUPPETEER_EXECUTABLE_PATH = path;
      expect(requireRuntimeTools(plan)).toBe(path);
    }
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledWith(["bwrap", "--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"]);
  } finally {
    which.mockRestore(); spawn.mockRestore();
    if (previous === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
    else process.env.PUPPETEER_EXECUTABLE_PATH = previous;
  }
});

test("local packaging executes the source job's phases in order and removes the temporary consumer", async () => {
  const dir = fixture();
  writeFileSync(join(dir, ".github/workflows/ci.yml"), `jobs:
  pack:
    steps:
      - run: mkdir -p "$RUNNER_TEMP/consumer"; echo packed > "$RUNNER_TEMP/consumer/package"
      - run: test -f "$RUNNER_TEMP/consumer/package"; echo "$RUNNER_TEMP" > scratch-path
`);
  await checkPackages(dir);
  const scratch = readFileSync(join(dir, "scratch-path"), "utf8").trim();
  expect(scratch).toContain("brainkit-pack-"); expect(existsSync(scratch)).toBe(false);
});

test("a failing packed probe cannot pass through a pipeline or execute later phases", async () => {
  const dir = fixture();
  writeFileSync(join(dir, ".github/workflows/ci.yml"), `jobs:
  pack:
    steps:
      - name: broken consumer
        run: 'false | true'
      - run: echo incorrectly-passed > passed
`);
  await expect(checkPackages(dir)).rejects.toThrow("broken consumer failed (1)");
  expect(existsSync(join(dir, "passed"))).toBe(false);
});

test("the full local plan retains default discovery, real probes and every pinned browser category", () => {
  const root = join(import.meta.dir, "..");
  const plan = planChecks(["package.json"], workspaces(root));
  const commands = localChecks(plan, true);
  const full = commands.find(command => command.name === "complete unit and integration suite")!;
  expect(full.argv.slice(1)).toEqual(["run", "test"]);
  expect(full.env?.BRAIN_REQUIRE_CHROME).toBe("1");
  const args = commands.map(command => command.argv.join(" ")).join("\n");
  expect(args).toContain("run test:browser"); expect(args).toContain("run test:layout");
  expect(args).toContain("run capture:verify"); expect(args).toContain("measure-claude-runtime.ts");
  expect(args).toContain("measure-claude-enforcement.ts");
  expect(args).toContain("--map-current-user --keep-caps --net");
  expect(args).toContain("measure-claude-delegation.ts");
  expect(args).toContain("measure-claude-capability.ts");
  expect(args).toContain("measure-claude-haiku.ts");
  expect(args).toContain("run test ./tests/measurement-isolation.test.ts");
  expect(args).toContain("--shard=1/1 packages/ui-react/tests/chat-focus-runtime.test.ts packages/ui-react/tests/external-speech-runtime.test.ts");
});


test("ordinary preflight leaves repeatable environment-heavy proof to CI", () => {
  const plan = planChecks(["package.json"], workspaces(join(import.meta.dir, "..")));
  const commands = localChecks(plan);
  expect(commands.length).toBeGreaterThan(0);
  const args = commands.map(command => command.argv.join(" ")).join("\n");
  expect(args).not.toContain("run typecheck");
  expect(commands.some(command => command.name === "complete unit and integration suite")).toBe(false);
  const tests = commands.filter(command => command.argv[1] === "run" && command.argv[2] === "test");
  expect(tests).toHaveLength(1);
  expect(tests[0]!.argv.slice(3)).toEqual(plan.tests.map(path => `./${path}`));
  expect(tests[0]!.argv.slice(3).length).toBeGreaterThan(0);
  expect(args).not.toContain("run test:browser");
  expect(args).not.toContain("run test:layout");
  expect(args).not.toContain("run capture:verify");
  expect(args).not.toContain("unshare");
});
