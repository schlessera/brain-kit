import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");

/** Actual installed compiler, fixed fixture barrier after the successful peer compile. */
test("parallel build preserves named compiler exit 2 and drains its started peer", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-compiler-drain-"));
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  const release = join(root, "release");
  try {
    mkdirSync(join(root, "scripts"));
    for (const file of ["build.ts", "bin-modes.ts", "publishable-packages.ts", "workspace-lease.mjs"]) {
      copyFileSync(join(repo, "scripts", file), join(root, "scripts", file));
    }
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    const wrapper = join(root, "node_modules/.bin/tsc");
    writeFileSync(wrapper, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const args=process.argv.slice(2), directory=dirname(args[args.indexOf("-p")+1]), name=basename(directory);
writeFileSync(join(${JSON.stringify(root)},name+"-started"), String(process.pid));
const compiler=Bun.spawn([process.execPath,${JSON.stringify(join(repo, "node_modules/typescript/bin/tsc"))},...args],{stdout:"inherit",stderr:"inherit"});
const code=await compiler.exited;
if(name==="beta" && code===0){writeFileSync(join(${JSON.stringify(root)},"peer-ready"),"");while(!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);writeFileSync(join(${JSON.stringify(root)},"peer-drained"),"");}
process.exitCode=code;
`);
    chmodSync(wrapper, 0o755);
    for (const name of ["alpha", "beta", "gamma"]) {
      const directory = join(root, "packages", name);
      mkdirSync(join(directory, "src"), { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@fixture/${name}`, version: "1.0.0",
        ...(name === "gamma" ? { optionalDependencies: { "@fixture/alpha": "workspace:*" } } : {}) }));
      writeFileSync(join(directory, "tsconfig.build.json"), JSON.stringify({ compilerOptions: {
        rootDir: "src", outDir: "dist", target: "ESNext", module: "ESNext", types: [], declaration: true, skipLibCheck: true,
      }, include: ["src"] }));
      writeFileSync(join(directory, "src/index.ts"), name === "alpha" ? "export const value: string = 1;\n" : "export const value = 1;\n");
    }
    child = Bun.spawn([process.execPath, "scripts/build.ts", "--jobs=2"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const output = new Response(child.stdout).text(), error = new Response(child.stderr).text();
    let exited = false;
    void child.exited.then(() => { exited = true; });
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(root, "peer-ready")) && !exited && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(root, "peer-ready")), `REAL_COMPILER_PEER_REACHED_RELEASE_BARRIER${exited ? (await output) + (await error) : ""}`).toBe(true);
    await Bun.sleep(300);
    expect(exited, "PARALLEL_BUILD_WAITS_LIVE_COMPILER_PEER_AFTER_ERROR").toBe(false);
    writeFileSync(release, "");
    const code = await child.exited;
    const [out, err] = await Promise.all([output, error]);
    expect(code, err).toBe(2);
    expect(out).toContain("TS2322");
    expect(err).toContain("packages/alpha: compiler exited 2");
    expect(existsSync(join(root, "peer-drained"))).toBe(true);
    expect(existsSync(join(root, "gamma-started")), "DEPENDENT_NOT_STARTED_AFTER_COMPILER_FAILURE").toBe(false);
    expect(readFileSync(join(root, "packages/beta/dist/index.js"), "utf8")).toContain("export const value");
  } finally {
    writeFileSync(release, "");
    if (child) await child.exited;
    // An early-exit mutation must also release and observe the owned peer,
    // rather than remove its fixture while the compiler wrapper is alive.
    const peer = join(root, "beta-started");
    if (existsSync(peer)) {
      const pid = Number(readFileSync(peer, "utf8"));
      const proc = `/proc/${pid}/stat`;
      const identity = () => {
        try { return readFileSync(proc, "utf8").split(") ").at(-1)!.split(" "); }
        catch { return undefined; }
      };
      const start = identity()?.[19];
      const deadline = Date.now() + 5_000;
      let current = identity();
      while (current && current[19] === start && current[0] !== "Z" && Date.now() < deadline) {
        await Bun.sleep(10); current = identity();
      }
      expect(!current || current[19] !== start || current[0] === "Z", "OWNED_COMPILER_PEER_EXIT_CONFIRMED").toBe(true);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("parallel optional dependency finishes before a lexical-first consumer, despite a peer cycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-compiler-levels-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const file of ["build.ts", "bin-modes.ts", "publishable-packages.ts", "workspace-lease.mjs"]) {
      copyFileSync(join(repo, "scripts", file), join(root, "scripts", file));
    }
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    const wrapper = join(root, "node_modules/.bin/tsc");
    writeFileSync(wrapper, `#!${process.execPath}
const args=process.argv.slice(2);
if(args.some(arg=>arg.includes("/z-dependency/"))) await Bun.sleep(500);
const compiler=Bun.spawn([process.execPath,${JSON.stringify(join(repo, "node_modules/typescript/bin/tsc"))},...args],{stdout:"inherit",stderr:"inherit"});
process.exitCode=await compiler.exited;
`);
    chmodSync(wrapper, 0o755);
    for (const name of ["a-consumer", "b-peer", "c-peer", "z-dependency"]) {
      const directory = join(root, "packages", name);
      mkdirSync(join(directory, "src"), { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@fixture/${name}`, version: "1.0.0",
        ...(name === "a-consumer" ? { optionalDependencies: { "@fixture/z-dependency": "workspace:*" } } : {}),
        ...(name === "z-dependency" ? { peerDependencies: { "@fixture/a-consumer": "*" } } : {}) }));
      writeFileSync(join(directory, "tsconfig.build.json"), JSON.stringify({ compilerOptions: {
        rootDir: "src", outDir: "dist", target: "ESNext", module: "ESNext", moduleResolution: "Bundler",
        types: [], declaration: true, skipLibCheck: true,
      }, include: ["src"] }));
      writeFileSync(join(directory, "src/index.ts"), name === "a-consumer"
        ? 'export { value } from "../../z-dependency/dist/index.js";\n' : "export const value = 1;\n");
    }
    const child = Bun.spawn([process.execPath, "scripts/build.ts", "--for", "a-consumer,b-peer,c-peer", "--jobs=2"],
      { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `OPTIONAL_DEPENDENCY_FINISHED_BEFORE_CONSUMER\n${out}\n${err}`).toBe(0);
    expect(readFileSync(join(root, "packages/a-consumer/dist/index.d.ts"), "utf8")).toContain("z-dependency/dist");
    expect(existsSync(join(root, "packages/b-peer/dist/index.js"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
