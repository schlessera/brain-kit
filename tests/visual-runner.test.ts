import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { diagramSourceSetup, diagramSourceDomains } from "../scripts/diagram-export-source.mjs";

const roots: string[] = [];
const node = Bun.which("node");
if (!node) throw new Error("visual runner tests require Node, as does the pinned browser image");
const projects = ["storybook", "storybook-light", "visual", "rank-footer-touch", "module-settings", "subjects", "dictation", "rail-fine", "rail-coarse", "rail-mixed", "keyboard-hints-live", "diagrams-chromium", "diagrams-webkit"];
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
  // Run the real source preparer as well as the wrapper. Its tiny tracked
  // fixture owns every Git/configuration input. Docker below records routing;
  // actual native exports have separate pinned-container runtime proof.
  for (const file of [...diagramSourceSetup, ...diagramSourceDomains.map(name => `packages/${name}/package.json`)]) {
    await mkdir(dirname(resolve(root, file)), { recursive: true });
    await copyFile(resolve(import.meta.dir, "..", file), resolve(root, file));
  }
  for (const domain of diagramSourceDomains) {
    const manifest = JSON.parse(await readFile(resolve(root, `packages/${domain}/package.json`), "utf8"));
    const alias = resolve(root, "node_modules", manifest.name);await mkdir(dirname(alias), {recursive:true});await symlink(resolve(root, "packages", domain), alias);
  }
  const git = Bun.which("git");
  if (!git) throw new Error("visual runner source preparation requires Git");
  await symlink(git, resolve(root, "commands/git"));
  const gitEnv = { PATH: resolve(root, "commands"), HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TEMPLATE_DIR: resolve(root, "template") };
  await mkdir(resolve(root, "template"));
  for (const args of [["init", "-q"], ["add", "scripts", "packages", "package.json", "bun.lock", "tsconfig.json", "bunfig.toml"],
    ["-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.com", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-qm", "owned wrapper source fixture"]]) {
    const result = Bun.spawnSync([git, ...args], { cwd: root, env: gitEnv, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw Error(result.stderr.toString());
  }
  const flock = Bun.which("flock");
  if (!flock) throw new Error("visual runner tests require flock");
  await symlink(flock, resolve(root, "commands/flock"));
  await writeFile(resolve(root, "scripts/captures/font-lock.json"), "{}\n");
  await writeFile(resolve(root, "node_modules/vitest/package.json"), JSON.stringify({name:"vitest",version:"1.0.0"}));
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
      import { dirname, resolve } from "node:path";
      const argv = process.argv.slice(2);
      const image = argv.findIndex((arg) => arg.startsWith("mcr.microsoft.com/playwright:"));
      if (image < 0 || argv[image + 1] !== "node" || argv[image + 2] !== "scripts/visual.mjs") process.exit(91);
      const child = spawnSync(process.execPath,
        [resolve(process.env.RUNNER_ROOT, "scripts/visual.mjs"), ...argv.slice(image + 3)],
        {env: process.env, stdio: "inherit"});
      process.exit(child.status ?? 92);` : "";
    const nativeRouting = command === "docker" ? `
      import {mkdirSync,writeFileSync} from "node:fs";
      import {join} from "node:path";
      const nativeArgs=process.argv.slice(2);
      if(nativeArgs.some(value=>/^sha256:[a-f0-9]{64}$/.test(value))){
        const mount=nativeArgs.find(value=>value.endsWith(":/proof"));const output=mount.slice(0,-7);mkdirSync(output,{recursive:true});
        for(const format of ["svg","png","pdf"])writeFileSync(join(output,"release."+format),"owned wrapper routing output");
        console.log("[]");process.exit(0);
      }
    ` : "";
    await writeFile(script, `#!${node}\n` + nativeRouting + record.replace("COMMAND", JSON.stringify(command)) + docker);
    await chmod(script, 0o755);
  }
  const child = Bun.spawn([node!, resolve(root, "scripts/visual.mjs"), ...args], {
    cwd: root,
    env: { ...gitEnv, RUNNER_ROOT: root, RUNNER_LOG: log, RUNNER_EXIT: String(exit) },
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

test("hosted proof adds project-aware case receipts while retaining human output and the runner failure", async () => {
  const result = await invoke(["--inside", "--project=ui-react-endurance", "--proof-report"], 7);
  expect(result.code).toBe(7);
  expect(result.calls[0]!.args).toEqual([
    "run", "--project=ui-react-endurance", "--browser.fileParallelism=false",
    "--reporter=default", `--reporter=${resolve(result.root, "scripts/proof-case-report.mjs")}`,
  ]);
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

for (const inside of [true, false]) {
  test(`${inside ? "inside" : "local"} forwards focused file filters and preserves failing exit`, async () => {
    const result = await invoke([
      ...(inside ? ["--inside"] : []), "--project=storybook", "--project=storybook-light",
      "--filter=Composer.stories", "--filter=ComposerRow.stories",
    ], 7);
    expect(result.code).toBe(7);
    expect(result.calls.at(-1)!.args).toEqual([
      "run", "--project=storybook", "--project=storybook-light", "--browser.fileParallelism=false",
      "Composer.stories", "ComposerRow.stories",
    ]);
  });
}
for (const filter of ["--filter", "--filter=", "--filter=--passWithNoTests"]) {
  test(`rejects empty or option-like file filter: ${filter}`, async () => {
    const result = await invoke([filter]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("use --filter=<nonempty file path fragment>");
    expect(result.calls).toEqual([]);
  });
}
