import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildProducerPaths } from "../scripts/ci-build-state";

const repo = join(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text);
}
function fixture() {
  const outer = mkdtempSync(join(tmpdir(), "odysseus-build-freshness-")); roots.push(outer);
  const root = join(outer, "checkout"); mkdirSync(root);
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  write(root, ".gitignore", "node_modules/\npackages/*/dist/\ntmp/\n");
  write(root, "package.json", JSON.stringify({ name: "odysseus-workspace", private: true }));
  write(root, "bun.lock", "{}\n");
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2019", module: "ESNext", moduleResolution: "Bundler", types: [], skipLibCheck: true } }));
  mkdirSync(join(root, "scripts"));
  for (const file of ["build.ts", "build-execution.ts", "ci-build-boundary.ts", "ci-build-files.ts", "ci-build-lifetime.ts", "ci-build-context.ts", "ci-build-state.ts", "ci-build-data.ts", "ci-build-trace.ts", "ci-build-consumers.ts", "ci-build-evidence.ts", "ci-build-operation.ts", "ci-build-entry.ts", "ci-build-qualification.json", "build-receipt.ts", "build-repeat-observation.ts", "bin-modes.ts", "publishable-packages.ts", "workspace-lease.mjs"]) {
    copyFileSync(join(repo, "scripts", file), join(root, "scripts", file));
  }
  const compiler = join(root, "node_modules/typescript");
  cpSync(join(repo, "node_modules/typescript"), compiler, { recursive: true });
  expect(lstatSync(join(compiler, "lib/_tsc.js")).ino).not.toBe(lstatSync(join(repo, "node_modules/typescript/lib/_tsc.js")).ino);
  write(root, "node_modules/.bin/tsc", `#!${process.execPath}\nconst child=Bun.spawn([process.execPath,${JSON.stringify(join(compiler, "bin/tsc"))},...process.argv.slice(2)],{stdout:"inherit",stderr:"inherit"});process.exitCode=await child.exited;\n`);
  chmodSync(join(root, "node_modules/.bin/tsc"), 0o755);
  for (const name of ["ithaca", "troy"]) {
    write(root, `packages/${name}/package.json`, JSON.stringify({ name: `@odysseus/${name}`, version: "1.0.0", type: "module" }));
    write(root, `packages/${name}/src/index.ts`, 'export const cargo = 1; export const harbour = (value?: { name?: string }) => value?.name ?? "Ithaca";\n');
    write(root, `packages/${name}/tsconfig.build.json`, JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { outDir: "dist", rootDir: "src", declaration: true }, include: ["src"] }));
  }
  return { root, outer, compiler };
}
async function build(root: string, ...args: string[]) {
  return runBuild(root, args);
}
async function runBuild(root: string, args: string[], options: { env?: NodeJS.ProcessEnv; preload?: string } = {}) {
  const child = Bun.spawn([process.execPath, ...(options.preload ? ["--preload", options.preload] : []), "scripts/build.ts", ...args],
    { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(options.env ? { env: options.env } : {}) });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `ORDINARY_BUILD_COMPLETES_WITHOUT_QUALIFIED_POLICY\n${out}\n${err}`).toBe(0);
  const names = readdirSync(join(root, "tmp")).filter(name => /^build-.*-probe\.json$/.test(name));
  expect(names).toHaveLength(1);
  const receipt = JSON.parse(readFileSync(join(root, "tmp", names[0]!), "utf8"));
  for (const name of names) rmSync(join(root, "tmp", name));
  return { out, receipt };
}
function compiled(result: Awaited<ReturnType<typeof build>>, names = ["ithaca", "troy"]) {
  expect(result.receipt.success).toBe(true);
  expect(result.receipt.packages.map((pkg: { name: string; state: string; children: { compiler: string; code: number }[] }) => ({
    name: pkg.name, state: pkg.state, children: pkg.children.map(child => `${child.compiler}:${child.code}`),
  })), "UNQUALIFIED_INPUTS_RUN_ACTUAL_COMPILERS").toEqual(names.map(name => ({ name, state: "complete", children: ["tsc:0"] })));
}
function output(root: string) { return readFileSync(join(root, "packages/ithaca/dist/index.js"), "utf8"); }
function consume(root: string): number {
  const child = Bun.spawnSync(["node", "--input-type=module", "-e", `import {cargo} from ${JSON.stringify(join(root, "packages/ithaca/dist/index.js"))}; console.log(cargo);`], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  return Number(new TextDecoder().decode(child.stdout).trim());
}

function withoutDocker(root: string, intent = "isolated-v1") {
  const preload = join(root, "docker-denial.ts");
  writeFileSync(preload, `import cp from "node:child_process";
import { appendFileSync } from "node:fs";
import { mock } from "bun:test";
const deny = (args) => {
  if (args.some(arg => typeof arg === "string" && /(^|\\/)docker$/.test(arg))) {
    appendFileSync(${JSON.stringify(join(root, "docker-attempts"))}, "attempt\\n");
    throw new Error("Docker unavailable in ordinary build regression");
  }
};
const sync = cp.spawnSync;
mock.module("node:child_process", () => ({ ...cp, spawnSync: (...args) => { deny([args[0], ...(args[1] ?? [])]); return sync(...args); } }));
for (const name of ["spawn", "spawnSync"]) {
  const original = Bun[name];
  Bun[name] = (...args) => { deny(Array.isArray(args[0]) ? args[0] : args[0].cmd); return original(...args); };
}
`);
  return { preload, env: { ...process.env, BRAIN_CI_BUILD_OPERATION: intent } };
}

for (const field of ["producer", "configuration"] as const) test(`malformed ${field} qualification preserves real ordinary compilation without Docker`, async () => {
  const { root } = fixture(), options = withoutDocker(root);
  const policy = JSON.parse(readFileSync(join(root, "scripts/ci-build-qualification.json"), "utf8"));
  const hash = "a".repeat(64);
  Object.assign(policy, { activation: "qualified", installation: hash, bun: hash, ambientEvidence: hash, compatibilityEvidence: hash, hostedCostEvidence: hash,
    node: { path: "/usr/bin/node", sha256: hash }, producer: Object.fromEntries(buildProducerPaths.map(path => [path, hash])), configuration: { "tsconfig.json": hash }, [field]: null });
  write(root, "scripts/ci-build-qualification.json", JSON.stringify(policy));
  compiled(await runBuild(root, ["--for", "ithaca", "--jobs=2", "--force"], options), ["ithaca"]);
  expect(consume(root), "MALFORMED_POLICY_FALLBACK_REACHES_REAL_CONSUMER").toBe(1);
  expect(lstatSync(join(root, "docker-attempts"), { throwIfNoEntry: false }), "MALFORMED_POLICY_NEVER_INVOKES_DOCKER").toBeUndefined();
});

test("dormant intent, invalid intent and aliased policy preserve ordinary builds without Docker", async () => {
  const { root, outer } = fixture();
  for (const intent of ["isolated-v1", "invalid-operation"]) {
    compiled(await runBuild(root, ["--for", "ithaca"], withoutDocker(root, intent)), ["ithaca"]);
    expect(consume(root)).toBe(1);
  }
  const policy = join(root, "scripts/ci-build-qualification.json");
  copyFileSync(policy, join(outer, "policy.json")); rmSync(policy); symlinkSync("../../policy.json", policy);
  compiled(await runBuild(root, ["--for", "ithaca", "--force"], withoutDocker(root)), ["ithaca"]);
  expect(consume(root)).toBe(1);
  expect(lstatSync(join(root, "docker-attempts"), { throwIfNoEntry: false }), "DORMANT_OR_UNSUPPORTED_PATH_NEVER_INVOKES_DOCKER").toBeUndefined();
});

test("effective aliased compiler configuration is rebuilt before consuming output", async () => {
  const { root, outer } = fixture(); const config = join(outer, "compiler.json");
  writeFileSync(config, readFileSync(join(root, "tsconfig.json"))); rmSync(join(root, "tsconfig.json")); symlinkSync("../compiler.json", join(root, "tsconfig.json"));
  compiled(await build(root)); const warm = output(root); expect(warm).not.toContain("?.");
  const original = readFileSync(config, "utf8");
  try {
    writeFileSync(config, original.replace("ES2019", "ES2022"));
    const changed = await build(root);
    expect(output(root), "EFFECTIVE_CONFIG_ALIAS_CHANGE_REACHES_EMITTED_OUTPUT").toContain("?."); compiled(changed); expect(consume(root)).toBe(1);
  } finally { writeFileSync(config, original); }
  compiled(await build(root)); expect(output(root), "RESTORED_CONFIG_RESTORES_OUTPUT").toBe(warm);
}, 60_000);

test("effective installed compiler changes reach the ordinary built consumer", async () => {
  const { root, compiler } = fixture(); compiled(await build(root)); expect(consume(root)).toBe(1); const warm = output(root);
  const entry = join(compiler, "lib/_tsc.js"), original = readFileSync(entry, "utf8");
  const anchor = "function emitNumericOrBigIntLiteral(node) {"; expect(original.split(anchor)).toHaveLength(2);
  const version = readFileSync(join(compiler, "package.json"), "utf8");
  try {
    writeFileSync(entry, original.replace(anchor, anchor + '\n    if (node.text === "1") { writeStringLiteral("2"); return; }'));
    const changed = await build(root);
    expect(consume(root), "INSTALLED_COMPILER_CHANGE_REACHES_REAL_CONSUMER").toBe(2); compiled(changed);
    expect(readFileSync(join(compiler, "package.json"), "utf8")).toBe(version);
  } finally { writeFileSync(entry, original); }
  compiled(await build(root)); expect(consume(root)).toBe(1); expect(output(root), "RESTORED_COMPILER_RESTORES_OUTPUT").toBe(warm);
}, 60_000);

test("unqualified repeats, damaged output, source and producer changes keep ordinary compilation", async () => {
  const { root } = fixture(); compiled(await build(root, "--jobs=2")); const warm = output(root);
  compiled(await build(root, "--jobs=2")); expect(output(root)).toBe(warm);
  for (const damage of [() => rmSync(join(root, "packages/ithaca/dist/index.js")), () => write(root, "packages/ithaca/dist/index.js", "stale"), () => write(root, "packages/ithaca/dist/extra.js", "stale")]) {
    damage(); compiled(await build(root)); expect(output(root)).toBe(warm); expect(Bun.file(join(root, "packages/ithaca/dist/extra.js")).size).toBe(0);
  }
  write(root, "packages/troy/src/index.ts", 'export const cargo = 3;\n'); compiled(await build(root));
  expect(readFileSync(join(root, "packages/troy/dist/index.js"), "utf8")).toContain("cargo = 3");
  write(root, "packages/troy/src/new.ts", 'export const voyage = "Ithaca";\n'); compiled(await build(root)); expect(Bun.file(join(root, "packages/troy/dist/new.js")).size).toBeGreaterThan(0);
  write(root, "bun.lock", '{"lockfileVersion":2}\n'); compiled(await build(root));
  write(root, "scripts/build-receipt.ts", readFileSync(join(root, "scripts/build-receipt.ts"), "utf8") + "\n// Odysseus observed the next voyage.\n"); compiled(await build(root));
  compiled(await build(root, "--force")); compiled(await build(root, "--for", "ithaca"), ["ithaca"]);
  // Old/foreign admission records are inert; no stamp is read or written.
  write(root, "node_modules/.cache/brain-build/ithaca.json", JSON.stringify({ version: 1, input: "old", output: "old" }));
  compiled(await build(root));
  // Missing output in another checkout and absent Git metadata also rebuild.
  const copied = fixture();
  cpSync(join(root, "node_modules/.cache"), join(copied.root, "node_modules/.cache"), { recursive: true });
  compiled(await build(copied.root));
  rmSync(join(root, ".git"), { recursive: true }); compiled(await build(root));
}, 60_000);
