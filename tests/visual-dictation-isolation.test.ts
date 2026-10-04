import { expect, test } from "bun:test";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("the actual browser config gives the complete dictation file exactly one isolated owner", () => {
  // Load the runner's real config in its own runtime; importing it into the
  // root compiler would add the separately owned Vite config to that graph.
  const probe = Bun.spawnSync([process.execPath, "-e", `
    import config from "./packages/ui-kit/vitest.config.ts";
    const projects = config.test.projects;
    const visual = projects.find(project => project.test.name === "visual");
    console.log(JSON.stringify(projects.map(project => ({
      name: project.test.name, include: project.test.include, exclude: project.test.exclude,
      commands: Object.keys(project.test.browser.commands ?? {}),
      isolated: project.test.browser.provider !== visual.test.browser.provider,
    }))));
  `], { cwd: resolve(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(probe.exitCode, probe.stderr.toString()).toBe(0);
  const projects = JSON.parse(probe.stdout.toString()) as Array<{
    name: string; include?: string[]; exclude?: string[]; commands: string[]; isolated: boolean;
  }>;
  const dictation = projects.find(project => project.name === "dictation");
  const visual = projects.find(project => project.name === "visual")!;
  expect(dictation, "all incumbent dictation cases have a configured project").toBeDefined();
  expect(dictation!.include).toEqual(["tests/visual/dictation-panel.visual.tsx"]);
  expect(visual.exclude).toContain("tests/visual/dictation-panel.visual.tsx");
  expect(dictation!.isolated).toBe(true);
  expect(dictation!.commands).toContain("dictationPointer");
  expect(visual.commands).not.toContain("dictationPointer");
});

// Execute the real wrapper; only its child Vitest entry is a recording fixture.
// This proves project/shard forwarding, not browser rendering or CDP cleanup.
async function wrapper(...args: string[]) {
  const root = await mkdtemp(resolve(tmpdir(), "brain-visual-dictation-"));
  try {
    await mkdir(resolve(root, "scripts"));
    await mkdir(resolve(root, "packages/ui-kit"), { recursive: true });
    await mkdir(resolve(root, "node_modules/vitest"), { recursive: true });
    await copyFile(resolve(import.meta.dir, "../scripts/visual.mjs"), resolve(root, "scripts/visual.mjs"));
    await writeFile(resolve(root, "node_modules/vitest/vitest.mjs"), "console.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));\n");
    const result = Bun.spawnSync(["node", resolve(root, "scripts/visual.mjs"), "--inside", ...args], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const recorded = JSON.parse(result.stdout.toString()) as { argv: string[]; cwd: string };
    expect(recorded.cwd).toBe(resolve(root, "packages/ui-kit"));
    return recorded.argv;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the default browser wrapper includes isolated dictation in each sharded invocation", async () => {
  for (const shard of ["1/2", "2/2"]) {
    const argv = await wrapper(`--shard=${shard}`, "--update");
    expect(argv, "the default matrix cannot silently omit 65 incumbent dictation cases").toEqual([
      "run", "--project=storybook", "--project=storybook-light", "--project=visual",
      "--project=rank-footer-touch", "--project=module-settings", "--project=subjects", "--project=dictation",
      "--update", `--shard=${shard}`,
    ]);
  }
});

test("a scoped dictation wrapper invocation retains its project and shard", async () => {
  expect(await wrapper("--project=dictation", "--shard=2/2")).toEqual([
    "run", "--project=dictation", "--shard=2/2",
  ]);
});
