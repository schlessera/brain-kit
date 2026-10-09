import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommands, verificationCommands } from "../scripts/ci-runner";
import { planChecks } from "../scripts/ci-plan";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "ci-runner-")); dirs.push(dir); return dir; }

test("the runner executes independent children concurrently", async () => {
  const dir = fixture();
  const script = join(dir, "pair.ts");
  writeFileSync(script, `import { existsSync, watch, writeFileSync } from "node:fs";
    const [mine, other] = process.argv.slice(2);
    const watcher = watch(".", () => { if (existsSync(other!)) finish(); });
    const timer = setTimeout(() => { watcher.close(); process.exit(7); }, 1500);
    function finish() { clearTimeout(timer); watcher.close(); }
    writeFileSync(mine!, "started");
    if (existsSync(other!)) finish();
  `);
  await expect(runCommands([
    { name: "first", argv: [process.execPath, script, "first", "second"] },
    { name: "second", argv: [process.execPath, script, "second", "first"] },
  ], dir)).resolves.toBeUndefined();
  expect(existsSync(join(dir, "first"))).toBe(true); expect(existsSync(join(dir, "second"))).toBe(true);
});

test("a failed check stops its running sibling and remains a failure", async () => {
  const dir = fixture(); const alive = join(dir, "alive.ts");
  const marker = join(dir, "stopped"); const fail = join(dir, "fail.ts");
  writeFileSync(alive, `import { writeFileSync } from "node:fs";
    const timer = setInterval(() => {}, 60000);
    process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(marker)}, "stopped"); clearInterval(timer); });
    writeFileSync("ready", "ready");
  `);
  writeFileSync(fail, `import { existsSync, watch } from "node:fs";
    const watcher = watch(".", () => { if (existsSync("ready")) process.exit(3); });
    if (existsSync("ready")) process.exit(3);
  `);
  await expect(runCommands([
    { name: "running", argv: [process.execPath, alive] },
    { name: "refused", argv: [process.execPath, fail] },
    { name: "queued", argv: [process.execPath, "-e", 'await Bun.write("incorrectly-started", "queued")'] },
  ], dir)).rejects.toThrow("refused failed (3)");
  expect(existsSync(marker), "a failing sibling was stopped before the runner returned").toBe(true);
  expect(existsSync(join(dir, "incorrectly-started")), "a failed batch must not start queued work").toBe(false);
});

test("empty selections do not invoke bun test with its full-suite defaults", () => {
  const plan = planChecks(["README.md"], []);
  expect(verificationCommands(plan, "/fixture")).toEqual([]);
});

test("selected tests retain the root command and are explicit absolute files", () => {
  const plan = planChecks(["tsconfig.json"], []);
  const root = join(import.meta.dir, "..");
  const commands = verificationCommands(plan, root);
  expect(commands).toHaveLength(3);
  expect(commands[1]!.argv.slice(1, 3)).toEqual(["run", "test"]);
  const selected = commands.slice(1).flatMap(command => command.argv.slice(3));
  expect(selected).toContain(join(root, "tests/release-manifest.test.ts"));
  expect(new Set(selected).size).toBe(plan.tests.length);
  expect(selected.sort()).toEqual(plan.tests.map(file => join(root, file)).sort());
});

test("a renamed or deleted curated test fails instead of silently dropping its guarantee", () => {
  const plan = planChecks(["README.md"], []); plan.tests = ["tests/no-longer-present.test.ts"];
  expect(() => verificationCommands(plan, fixture())).toThrow("Selected CI test is missing");
});

test("a single child failure cannot be reported as success", async () => {
  await expect(runCommands([{ name: "broken", argv: [process.execPath, "-e", "process.exit(3)"] }], fixture()))
    .rejects.toThrow("broken failed (3)");
});
