import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../src/internal.js";
import { isReadOnlyBrainMount, readOnlyBrainError } from "../src/cli/read-only.js";
let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

test("only EROFS receives the hosted read-only error envelope", () => {
  expect(readOnlyBrainError("add", { code: "EACCES" })).toBeNull();
  expect(readOnlyBrainError("add", { code: "EROFS" })).toMatchObject({ schema_version: 1, ok: false, error: { code: "read_only_brain", tool: "brain_add" } });
  expect(readOnlyBrainError("archive", { code: "EROFS" })?.error.tool).toBe("brain_archive");
});

test("mount topology selects visible stacks and excludes hidden descendants independent of record order", () => {
  root = mkdtempSync(join(tmpdir(), "odysseus mount-topology-"));
  const target = fs.realpathSync(root);
  const row = (id: number, parent: number, point: string, mode: string) =>
    `${id} ${parent} 0:1 / ${point.replaceAll(" ", "\\040")} ${mode},relatime - tmpfs tmpfs rw`;
  const cases = [
    { name: "writable over readonly", ro: false, rows: [row(42, 42, "/", "rw"), row(90, 42, "/tmp", "ro"), row(7, 90, "/tmp", "rw")] },
    { name: "readonly over writable", ro: true, rows: [row(42, 42, "/", "rw"), row(90, 42, "/tmp", "rw"), row(7, 90, "/tmp", "ro")] },
    { name: "hidden readonly descendant", ro: false, rows: [row(42, 42, "/", "rw"), row(90, 42, "/tmp", "ro"), row(95, 90, target, "ro"), row(7, 90, "/tmp", "rw")] },
    { name: "hidden writable descendant", ro: true, rows: [row(42, 42, "/", "rw"), row(90, 42, "/tmp", "rw"), row(95, 90, target, "rw"), row(7, 90, "/tmp", "ro")] },
    { name: "visible child of top mount", ro: true, rows: [row(42, 42, "/", "rw"), row(90, 42, "/tmp", "ro"), row(7, 90, "/tmp", "rw"), row(3, 7, target, "ro")] },
    { name: "ancestor cover hides a separately mounted descendant", ro: true, rows: [row(42, 42, "/", "rw"), row(95, 42, target, "rw"), row(90, 42, "/tmp", "ro")] },
    { name: "root stack hides old descendants", ro: false, rows: [row(42, 900, "/", "ro"), row(90, 42, target, "ro"), row(7, 42, "/", "rw")] },
  ];
  const original = fs.readFileSync;
  let mountinfo = "";
  const spy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathLike, options?: unknown) =>
    path === "/proc/self/mountinfo" ? mountinfo : original(path, options as never)) as typeof fs.readFileSync);
  try {
    for (const fixture of cases) {
      for (const rows of [fixture.rows, [...fixture.rows].reverse(), [...fixture.rows.slice(1), fixture.rows[0]!]]) {
        mountinfo = rows.join("\n");
        expect(isReadOnlyBrainMount(target), `VISIBLE_MOUNT_${fixture.name}`).toBe(fixture.ro);
      }
    }
  } finally { spy.mockRestore(); }
});

test("a real agent worker indexes a brain in its writable tmpfs over the readonly host tmp mount", async () => {
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(join(resolve("tmp"), "odysseus-worker-mount-"));
  const corpus = resolve("packages/core/fixtures/corpus");
  const cli = resolve("packages/core/src/cli/brain.ts");
  const index = resolve("packages/core/src/index.ts");
  const program = `const fs=require("node:fs"); const brain="/tmp/odysseus-corpus";
    fs.cpSync(${JSON.stringify(corpus)},brain,{recursive:true});
    const config=brain+"/brain.config.ts";
    fs.writeFileSync(config,fs.readFileSync(config,"utf8").replace('"@schlessera/brain"',${JSON.stringify(JSON.stringify(index))}));
    fs.writeFileSync(brain+"/witness.md","Odysseus repairs the raft.\\n");
    const result=Bun.spawnSync([process.execPath,${JSON.stringify(cli)},"index","--force","--json"],
      {cwd:brain,env:{...process.env,BRAIN_ROOT:brain},stdout:"pipe",stderr:"pipe"});
    console.log(JSON.stringify({witness:fs.readFileSync(brain+"/witness.md","utf8"),
      exit:result.exitCode,stdout:result.stdout.toString(),stderr:result.stderr.toString(),database:fs.existsSync(brain+"/brain.db"),
      mounts:fs.readFileSync("/proc/self/mountinfo","utf8").split("\\n").filter(line=>line.split(" ")[4]==="/tmp")}));`;
  const launch = `const {launchAgentWorker}=await import(${JSON.stringify(resolve("packages/ui-sdk/src/server/worker-launcher.ts"))});
    const worker=launchAgentWorker({brainPath:${JSON.stringify(root)},env:{},command:${JSON.stringify([process.execPath, "--config=/dev/null", "--no-env-file", "-e", program])}});
    try {const [out,err,exit]=await Promise.all([new Response(worker.stdout).text(),new Response(worker.stderr).text(),worker.exited]);
      process.stdout.write(out);process.stderr.write(err);process.exitCode=exit;}finally{worker.turnTemp?.close();}`;
  // Supply a genuine host /tmp mount even on hosts where /tmp is ordinarily
  // just a directory. The real launcher then covers its readonly copy with
  // the worker's private writable tmpfs, reproducing the specified stack.
  const child = Bun.spawn(["bwrap", "--unshare-user", "--unshare-net", "--bind", "/", "/", "--bind", "/tmp", "/tmp", "--proc", "/proc", "--dev", "/dev",
    process.execPath, "--config=/dev/null", "--no-env-file", "-e", launch], { env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit, stderr + stdout).toBe(0);
  const receipt = JSON.parse(stdout);
  expect(receipt.mounts.length, "ACTUAL_TMP_MOUNT_STACK").toBeGreaterThanOrEqual(2);
  expect(receipt.witness, "KERNEL_TMP_WRITE_SUCCEEDED").toBe("Odysseus repairs the raft.\n");
  expect(receipt.exit, `WRITABLE_TMP_CLI_INDEX: ${receipt.stdout} ${receipt.stderr}`).toBe(0);
  expect(receipt.database, "WRITABLE_TMP_INDEX_DATABASE_CREATED").toBe(true);
  expect(JSON.parse(receipt.stdout).total).toBeGreaterThan(0);
});

test("read-only bind refuses capture visibly and leaves search usable", async () => {
  root = mkdtempSync(join(tmpdir(), "brain-read-only-"));
  cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
  const config = join(root, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
  const run = async (readOnly: boolean, ...args: string[]) => {
    const prefix = readOnly ? ["bwrap", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--ro-bind", root!, root!] : [];
    const child = Bun.spawn([...prefix, process.execPath, resolve("packages/core/src/cli/brain.ts"), ...args], { cwd: process.cwd(), env: { ...process.env, BRAIN_ROOT: root!, GEMINI_API_KEY: "", GOOGLE_API_KEY: "", TYPESAFE_API_KEY: "", ANTHROPIC_API_KEY: "" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  };
  // Index in a fresh actual CLI process as well: setup must not inherit any
  // parent suite's module/context caches or globals.
  const indexed = await run(false, "index", "--force", "--json");
  expect(indexed.exit, indexed.stderr).toBe(0);
  const db = openDatabase(join(root, "brain.db"));
  try {
    expect((db.query("SELECT count(*) AS n FROM documents_fts WHERE documents_fts MATCH 'raft'").get() as { n: number }).n).toBeGreaterThan(0);
  } finally { db.close(); }
  const before = readdirSync(join(root, "notes"));
  const add = await run(true, "add", "Odysseus needs a stronger mast", "--json");
  expect(add.exit).toBe(2);
  expect(add.stdout).toContain('"read_only_brain"');
  expect(JSON.parse(add.stdout)).toMatchObject({ schema_version: 1, ok: false, error: { code: "read_only_brain", tool: "brain_add" } });
  expect(JSON.parse(add.stdout).error.message).toContain("read-only here");
  expect(JSON.parse(add.stdout).error.message).toContain("mcp__brain-ui__brain_add");
  expect(readdirSync(join(root, "notes"))).toEqual(before);
  const registry = await run(true, "registry", "--json");
  expect(registry.exit).toBe(2);
  expect(registry.stdout).toContain('"read_only_brain"');
  expect(JSON.parse(registry.stdout).error.tool).toBe("apply_staged_changes");
  const search = await run(true, "search", "raft", "--json");
  expect(search.exit).toBe(0);
  expect(JSON.parse(search.stdout).results.length, JSON.stringify(search)).toBeGreaterThan(0);
});

test("a hosted scratch mount keeps render --scratch and scratch prune working; brain writes name the scratch route", async () => {
  // Outside /tmp, which the worker sees as its own fresh tmpfs.
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(join(resolve("tmp"), "brain-read-only-scratch-"));
  cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
  const config = join(root, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
  writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n");
  const scratch = join(root, ".brain/scratch");
  mkdirSync(scratch, { recursive: true });
  // The worker's layout (#1626): the brain read-only, its scratch area bound writable on top.
  const run = async (bindScratch: boolean, ...args: string[]) => {
    const prefix = ["bwrap", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/tmp", "--ro-bind", root!, root!, ...(bindScratch ? ["--bind", scratch, scratch] : [])];
    const child = Bun.spawn([...prefix, process.execPath, resolve("packages/core/src/cli/brain.ts"), ...args], { cwd: process.cwd(),
      env: { ...process.env, BRAIN_ROOT: root!, GEMINI_API_KEY: "", GOOGLE_API_KEY: "", TYPESAFE_API_KEY: "", ANTHROPIC_API_KEY: "" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  };
  const prune = await run(true, "scratch", "prune", "--json");
  expect(prune.exit, prune.stderr + prune.stdout).toBe(0);
  const rendered = await run(true, "render", "notes/loose-idea.md", "--format", "html", "--scratch", "--json");
  expect(rendered.exit, rendered.stderr + rendered.stdout).toBe(0);
  expect(readdirSync(scratch).filter(name => name.endsWith(".html"))).toHaveLength(1);
  const before = readdirSync(join(root, "notes"));
  const inBrain = await run(true, "render", "notes/loose-idea.md", "--format", "html", "--json");
  expect(inBrain.exit, "RENDER_REFUSAL").toBe(2);
  expect(JSON.parse(inBrain.stdout).error).toMatchObject({ code: "read_only_brain" });
  expect(JSON.parse(inBrain.stdout).error.message, "RENDER_REFUSAL").toContain("Write the output with --scratch");
  expect(readdirSync(join(root, "notes"))).toEqual(before);
  const unbound = await run(false, "scratch", "prune", "--json");
  expect(unbound.exit).toBe(2);
  expect(JSON.parse(unbound.stdout).error.message).toContain(".brain/scratch/ is read-only here");
  const noScratch = await run(false, "render", "notes/loose-idea.md", "--format", "html", "--scratch", "--json");
  expect(noScratch.exit).toBe(2);
  expect(JSON.parse(noScratch.stdout).error.message).toContain("read-only in this turn as well");
  // A scratch directory missing from the read-only brain is no route either; the refusal must not suggest it.
  rmSync(scratch, { recursive: true, force: true });
  const missing = await run(false, "render", "notes/loose-idea.md", "--format", "html", "--scratch", "--json");
  expect(missing.exit).toBe(2);
  expect(JSON.parse(missing.stdout).error.message, "MISSING_SCRATCH").toContain("read-only in this turn as well");
  expect(JSON.parse(missing.stdout).error.message).not.toContain("Write the output with --scratch");
});
