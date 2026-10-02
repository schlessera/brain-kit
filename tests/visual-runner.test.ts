import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const roots: string[] = [];
const node = Bun.which("node");
if (!node) throw new Error("visual runner tests require Node, as does the pinned browser image");
const projects = ["storybook", "storybook-light", "visual", "rank-footer-touch", "module-settings"];
type Call = { command: string; args: string[]; cwd: string };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function invoke(args: string[], exit = 0) {
  const root = await mkdtemp(resolve(tmpdir(), "brain-visual-runner-"));
  roots.push(root);
  for (const path of ["scripts/captures", "packages/ui-kit", "node_modules/vitest", "commands"]) {
    await mkdir(resolve(root, path), { recursive: true });
  }
  await copyFile(resolve(import.meta.dir, "../scripts/visual.mjs"), resolve(root, "scripts/visual.mjs"));
  await writeFile(resolve(root, "scripts/captures/font-lock.json"), "{}\n");
  const log = resolve(root, "calls.jsonl");
  const record = `import { appendFileSync } from "node:fs";
    appendFileSync(process.env.RUNNER_LOG, JSON.stringify({command: COMMAND,
      args: process.argv.slice(2), cwd: process.cwd()}) + "\\n");`;
  await writeFile(resolve(root, "node_modules/vitest/vitest.mjs"),
    record.replace("COMMAND", '"vitest"') + "process.exit(Number(process.env.RUNNER_EXIT));");
  for (const command of ["bun", "docker"]) {
    const script = resolve(root, "commands", command);
    const docker = command === "docker" ? `
      import { spawnSync } from "node:child_process";
      import { resolve } from "node:path";
      const argv = process.argv.slice(2);
      const image = argv.findIndex((arg) => arg.startsWith("mcr.microsoft.com/playwright:"));
      if (image < 0 || argv[image + 1] !== "node" || argv[image + 2] !== "scripts/visual.mjs") process.exit(91);
      const child = spawnSync(process.execPath,
        [resolve(process.env.RUNNER_ROOT, "scripts/visual.mjs"), ...argv.slice(image + 3)],
        {env: process.env, stdio: "inherit"});
      process.exit(child.status ?? 92);` : "";
    await writeFile(script, `#!${node}\n` + record.replace("COMMAND", JSON.stringify(command)) + docker);
    await chmod(script, 0o755);
  }
  const child = Bun.spawn([node!, resolve(root, "scripts/visual.mjs"), ...args], {
    cwd: root,
    env: { PATH: resolve(root, "commands"), RUNNER_ROOT: root, RUNNER_LOG: log, RUNNER_EXIT: String(exit) },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  let calls: Call[] = [];
  try { calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { root, code, stdout, stderr, calls };
}

test("inside default serializes browser files in every configured project", async () => {
  const result = await invoke(["--inside"]);
  expect(result.code).toBe(0);
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0]!.command).toBe("vitest");
  expect(result.calls[0]!.args).toEqual([
    "run", ...projects.map((project) => `--project=${project}`), "--browser.fileParallelism=false",
  ]);
  expect(result.calls[0]!.cwd).toBe(resolve(result.root, "packages/ui-kit"));
});

test("local container path reaches the same default and preserves project, shard and update", async () => {
  const result = await invoke(["--project=visual", "--shard=1/2", "--update"]);
  expect(result.code).toBe(0);
  expect(result.calls.map((call) => call.command)).toEqual(["bun", "docker", "vitest"]);
  expect(result.calls[0]!.args).toEqual(["scripts/capture.ts", "--prepare-fonts"]);
  expect(result.calls[1]!.args).toContain("--inside");
  expect(result.calls[2]!.args).toEqual([
    "run", "--project=visual", "--browser.fileParallelism=false", "--update", "--shard=1/2",
  ]);
});

for (const inside of [true, false]) {
  test(`${inside ? "inside" : "local"} forwards an explicit parallel-file diagnostic override and exit status`, async () => {
    const result = await invoke([
      ...(inside ? ["--inside"] : []), "--browser.fileParallelism=true", "--shard=2/2",
    ], 7);
    expect(result.code).toBe(7);
    const call = result.calls.at(-1)!;
    expect(call.command).toBe("vitest");
    expect(call.args).toEqual([
      "run", ...projects.map((project) => `--project=${project}`), "--browser.fileParallelism=true", "--shard=2/2",
    ]);
  });
}

test("an explicit sequential-file control is forwarded once", async () => {
  const result = await invoke(["--inside", "--browser.fileParallelism=false"]);
  expect(result.code).toBe(0);
  expect(result.calls[0]!.args.filter((arg) => arg.startsWith("--browser.fileParallelism")))
    .toEqual(["--browser.fileParallelism=false"]);
});

for (const args of [
  ["--browser.fileParallelism"],
  ["--browser.fileParallelism=maybe"],
  ["--browser.fileParallelism=false", "--browser.fileParallelism=true"],
]) {
  test(`rejects ambiguous scheduling before starting any command: ${args.join(" ")}`, async () => {
    const result = await invoke(args);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("use --browser.fileParallelism=true or --browser.fileParallelism=false once");
    expect(result.calls).toEqual([]);
  });
}
