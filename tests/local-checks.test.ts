import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPackages } from "../scripts/check-packages";
import { localChecks } from "../scripts/check-pr";
import { planChecks, workspaces } from "../scripts/ci-plan";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "local-checks-")); dirs.push(dir);
  mkdirSync(join(dir, ".depot/workflows"), { recursive: true });
  return dir;
}

test("local packaging executes the source job's phases in order and removes the temporary consumer", async () => {
  const dir = fixture();
  writeFileSync(join(dir, ".depot/workflows/ci.yml"), `jobs:
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
  writeFileSync(join(dir, ".depot/workflows/ci.yml"), `jobs:
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
  const commands = localChecks(plan);
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
