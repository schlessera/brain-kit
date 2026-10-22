import { afterEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

async function invoke(args: string[], exit = 0, imageState: "warm"|"cold"|"drift" = "warm", nativeExit = 0, nativeOutput: "complete"|"missing-origin-pdf" = "complete") {
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
  const tar = Bun.which("tar");
  if (!tar) throw new Error("visual runner volume transport requires tar");
  await symlink(tar, resolve(root, "commands/tar"));
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
      const image = argv.findIndex((arg) => arg.startsWith("mcr.microsoft.com/playwright@sha256:"));
      if (image < 0 || argv[image + 1] !== "node" || argv[image + 2] !== "scripts/visual.mjs") process.exit(91);
      const child = spawnSync(process.execPath,
        [resolve(process.env.RUNNER_ROOT, "scripts/visual.mjs"), ...argv.slice(image + 3)],
        {env: process.env, stdio: "inherit"});
      process.exit(child.status ?? 92);` : "";
    const nativeRouting = command === "docker" ? `
      import * as nativeFs from "node:fs";
      import {join as nativeJoin} from "node:path";
      import {spawnSync as nativeSpawn} from "node:child_process";
      import assert from "node:assert/strict";
      const nativeArgs=process.argv.slice(2), nativeRoot=process.env.RUNNER_ROOT;
      const store=nativeJoin(nativeRoot,"docker-state");
      const volumePath=name=>{assert(/^brain-kit-native-[a-z0-9-]+$/.test(name));return nativeJoin(store,"volumes",name);};
      const containerPath=name=>{assert(/^brain-kit-native-[a-z0-9-]+$/.test(name));return nativeJoin(store,"containers",name);};
      const nativeRecord=()=>nativeFs.appendFileSync(nativeJoin(nativeRoot,"native-calls.jsonl"),JSON.stringify(nativeArgs)+"\\n");
      const mounts=()=>nativeArgs.flatMap((arg,index)=>arg==="--mount"?[Object.fromEntries(nativeArgs[index+1].split(",").map(part=>part.split("=")))]:[]);
      const finish=()=>{nativeRecord();process.exit(0);};
      if(nativeArgs[0]==="volume"){
        const location=volumePath(nativeArgs[2]);
        if(nativeArgs[1]==="create")nativeFs.mkdirSync(location,{recursive:true});
        else {assert.equal(nativeArgs[1],"rm");nativeFs.rmSync(location,{recursive:true});}
        finish();
      }
      if(nativeArgs[0]==="run"&&nativeArgs.includes("/inputs")){
        for(const flag of ["--rm","--interactive","--pull=never","--network=none","--read-only"])assert(nativeArgs.includes(flag));
        const [mount]=mounts();assert.equal(mount.type,"volume");assert.equal(mount.target,"/inputs");
        assert(nativeArgs.includes(imageRef));
        const unpack=nativeSpawn("tar",["-xf","-","-C",volumePath(mount.source)],{stdio:[0,"pipe","pipe"]});
        assert.equal(unpack.status,0,unpack.stderr?.toString());finish();
      }
      if(nativeArgs[0]==="create"){
        for(const flag of ["--pull=never","--network=none","--read-only","--user","--tmpfs"])assert(nativeArgs.includes(flag));
        assert(nativeArgs.includes(imageRef));assert(nativeArgs.includes("/native-runtime/bun"));
        const mounted=mounts();assert.equal(mounted.length,4);
        for(const mount of mounted){assert.equal(mount.type,"volume");assert(nativeFs.statSync(volumePath(mount.source)).isDirectory());}
        const source=mounted.find(mount=>mount.target===nativeArgs[nativeArgs.indexOf("-w")+1]);
        const runtime=mounted.find(mount=>mount.target==="/native-runtime");
        const modules=mounted.find(mount=>mount.target===nativeJoin(nativeRoot,"node_modules"));
        assert(source&&runtime&&modules);for(const mount of [source,runtime,modules])assert("readonly" in mount);
        assert(nativeFs.readFileSync(nativeJoin(volumePath(source.source),"scripts/visual.mjs")).equals(nativeFs.readFileSync(nativeJoin(nativeRoot,"scripts/visual.mjs"))));
        assert(!nativeFs.existsSync(nativeJoin(volumePath(source.source),"README.md")));
        assert(!nativeFs.existsSync(nativeJoin(volumePath(source.source),"ambient-canary")));
        assert(nativeFs.readFileSync(nativeJoin(volumePath(runtime.source),"bun")).equals(nativeFs.readFileSync(nativeJoin(nativeRoot,"commands/bun"))));
        assert.equal(JSON.parse(nativeFs.readFileSync(nativeJoin(volumePath(modules.source),"vitest/package.json"))).name,"vitest");
        const name=nativeArgs[nativeArgs.indexOf("--name")+1];
        nativeFs.mkdirSync(nativeJoin(store,"containers"),{recursive:true});
        nativeFs.writeFileSync(containerPath(name),JSON.stringify({mounted,exit:null}));finish();
      }
      if(["start","inspect","cp","rm"].includes(nativeArgs[0])){
        const name=nativeArgs[0]==="cp"?nativeArgs[1].split(":")[0]:nativeArgs.at(-1);
        const location=containerPath(name),state=JSON.parse(nativeFs.readFileSync(location));
        const output=volumePath(state.mounted.find(mount=>mount.target==="/proof").source);
        if(nativeArgs[0]==="start"){
          assert.deepEqual(nativeArgs.slice(0,2),["start","--attach"]);
          for(const format of ["svg","png","pdf"])nativeFs.writeFileSync(nativeJoin(output,"release."+format),"owned volume output "+format);
          for(const format of ["svg","png","pdf"]){
            if(format!=="pdf"||${JSON.stringify(nativeOutput)}!=="missing-origin-pdf")nativeFs.writeFileSync(nativeJoin(output,"origin."+format),"owned origin volume output "+format);
          }
          const release=["png","pdf"].map(format=>({format,bytes:Buffer.byteLength("owned volume output "+format)}));
          const origin=["svg","png","pdf"].map(format=>({format,bytes:Buffer.byteLength("owned origin volume output "+format)}));
          state.exit=Number(process.env.NATIVE_EXIT);nativeFs.writeFileSync(location,JSON.stringify(state));console.log(JSON.stringify({release,origin}));
        }else if(nativeArgs[0]==="inspect"){
          assert.equal(nativeArgs[2],"{{.State.ExitCode}}");assert.notEqual(state.exit,null);console.log(state.exit);
        }else if(nativeArgs[0]==="cp"){
          assert.equal(nativeArgs[1],name+":/proof/.");assert.notEqual(state.exit,null);
          nativeFs.cpSync(output,nativeArgs[2],{recursive:true});
        }else {assert.equal(nativeArgs[1],"--force");nativeFs.rmSync(location);}
        finish();
      }
    ` : "";
    const bootstrap=command==="docker"?`
      import * as imageFs from "node:fs";
      const imageArgs=process.argv.slice(2),imageRef="mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27";
      const recordImage=()=>imageFs.appendFileSync(process.env.RUNNER_ROOT+"/image-bootstrap.jsonl",JSON.stringify(imageArgs)+"\\n");
      if(imageArgs[0]==="image"&&imageArgs[1]==="inspect"){
        recordImage();
        if(${JSON.stringify(imageState)}==="cold"&&!imageFs.existsSync(process.env.RUNNER_ROOT+"/image-acquired"))process.exit(1);
        console.log(JSON.stringify([${JSON.stringify(imageState)}==="drift"?"mcr.microsoft.com/playwright@sha256:"+"0".repeat(64):imageRef]));process.exit(0);
      }
      if(imageArgs[0]==="pull"){
        recordImage();if(imageArgs[1]!==imageRef)process.exit(95);
        imageFs.writeFileSync(process.env.RUNNER_ROOT+"/image-acquired","acquired");process.exit(0);
      }
    `:"";
    await writeFile(script, `#!${node}\n` + bootstrap + nativeRouting + record.replace("COMMAND", JSON.stringify(command)) + docker);
    await chmod(script, 0o755);
  }
  const child = Bun.spawn([node!, resolve(root, "scripts/visual.mjs"), ...args], {
    cwd: root,
    env: { ...gitEnv, RUNNER_ROOT: root, RUNNER_LOG: log, RUNNER_EXIT: String(exit), NATIVE_EXIT: String(nativeExit) },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  let calls: Call[] = [];
  try { calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let bootstrapCalls:string[][]=[];
  try{bootstrapCalls=(await readFile(resolve(root,"image-bootstrap.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));}catch{/* Inside mode has no image bootstrap. */}
  return { root, code, stdout, stderr, calls, bootstrapCalls };
}

test("inside default serializes browser files in every configured project", async () => {
  const result = await invoke(["--inside"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0]!.command).toBe("vitest");
  expect(result.calls[0]!.args).toEqual([
    "run", ...projects.map((project) => `--project=${project}`), "--browser.fileParallelism=false",
  ]);
  expect(result.calls[0]!.cwd).toBe(resolve(result.root, "packages/ui-kit"));
});

test("hosted proof adds project-aware case receipts while retaining human output and the runner failure", async () => {
  const result = await invoke(["--inside", "--project=ui-react-endurance", "--proof-report"], 7);
  expect(result.code, result.stderr).toBe(7);
  expect(result.calls[0]!.args).toEqual([
    "run", "--project=ui-react-endurance", "--browser.fileParallelism=false",
    "--reporter=default", `--reporter=${resolve(result.root, "scripts/proof-case-report.mjs")}`,
  ]);
});

test("local container path reaches the same default and preserves project, shard and update", async () => {
  const result = await invoke(["--project=visual", "--shard=1/2", "--update"]);
  expect(result.code, result.stderr).toBe(0);
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
    expect(result.code, result.stderr).toBe(7);
    const call = result.calls.at(-1)!;
    expect(call.command).toBe("vitest");
    expect(call.args).toEqual([
      "run", ...projects.map((project) => `--project=${project}`), "--browser.fileParallelism=true", "--shard=2/2",
    ]);
  });
}

test("an explicit sequential-file control is forwarded once", async () => {
  const result = await invoke(["--inside", "--browser.fileParallelism=false"]);
  expect(result.code, result.stderr).toBe(0);
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
    expect(result.code, result.stderr).toBe(1);
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
    expect(result.code, result.stderr).toBe(7);
    expect(result.calls.at(-1)!.args).toEqual([
      "run", "--project=storybook", "--project=storybook-light", "--browser.fileParallelism=false",
      "Composer.stories", "ComposerRow.stories",
    ]);
  });
}
for (const filter of ["--filter", "--filter=", "--filter=--passWithNoTests"]) {
  test(`rejects empty or option-like file filter: ${filter}`, async () => {
    const result = await invoke([filter]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("use --filter=<nonempty file path fragment>");
    expect(result.calls).toEqual([]);
  });
}

test("cold execution provisions the exact manifest before either native or browser consumption",async()=>{
 const result=await invoke(["--project=diagrams-chromium"],0,"cold");
 expect(result.code,result.stderr).toBe(0);
 expect(result.bootstrapCalls.map(args=>args.slice(0,2)),"COLD_IMAGE_IS_ACQUIRED_BEFORE_CONSUMPTION").toEqual([["image","inspect"],["pull","mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27"],["image","inspect"]]);
});
test("a mismatching manifest is refused before native source preparation",async()=>{
 const result=await invoke(["--project=diagrams-chromium"],0,"drift");
 expect(result.code).not.toBe(0);
 expect(result.stderr,"IMAGE_DRIFT_REFUSED_BEFORE_PRODUCER").toContain("PINNED_VISUAL_IMAGE_DIGEST_MISMATCH");
 expect(result.calls).toEqual([]);
 expect(await Bun.file(resolve(result.root,"tmp/diagram-export-source.json")).exists()).toBe(false);
});


test("native volume handoff publishes all formats and drains only owned resources", async () => {
  const result = await invoke(["--project=diagrams-chromium", "--project=diagrams-webkit"]);
  expect(result.code, result.stderr).toBe(0);
  const prepared = resolve(result.root, "tmp/diagram-export-native-prepared");
  const [session] = await readdir(prepared);
  for (const engine of ["chromium", "webkit"]) {
    const output = resolve(prepared, session!, engine);
    const receipt = JSON.parse(await readFile(resolve(output, "producer.json"), "utf8"));
    expect(receipt.artifacts.map((artifact: {format:string}) => artifact.format)).toEqual(["png", "pdf"]);
    expect(receipt.origin.map((artifact: {format:string}) => artifact.format)).toEqual(["svg", "png", "pdf"]);
    for (const format of ["svg", "png", "pdf"]) {
      const bytes = await readFile(resolve(output, `release.${format}`));
      expect(bytes.toString(), "COPIED_VOLUME_OUTPUT_REACHES_BROWSER_RECEIPT").toBe(`owned volume output ${format}`);
      expect(receipt.files[`release.${format}`]).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
      const origin = await readFile(resolve(output, `origin.${format}`));
      expect(origin.toString(), "ORIGIN_VOLUME_OUTPUT_REACHES_BROWSER_RECEIPT").toBe(`owned origin volume output ${format}`);
      expect(receipt.files[`origin.${format}`], "ORIGIN_RECEIPT_HASH_BINDS_ACTUAL_COPIED_BYTES").toBe(new Bun.CryptoHasher("sha256").update(origin).digest("hex"));
    }
  }
  expect(result.calls.at(-1)!.command).toBe("vitest");
  expect(await readdir(resolve(result.root, "docker-state/volumes"))).toEqual([]);
  expect(await readdir(resolve(result.root, "docker-state/containers"))).toEqual([]);
});

test("native volume producer failure blocks browser execution and still drains resources", async () => {
  const result = await invoke(["--project=diagrams-chromium"], 0, "warm", 17);
  expect(result.code, "NATIVE_FAILURE_MUST_BLOCK_BROWSER").not.toBe(0);
  expect(result.stderr).toContain("Native diagram producer failed (17)");
  expect(result.calls.some(call => call.command === "vitest")).toBe(false);
  const calls = (await readFile(resolve(result.root, "native-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls.some(args => args[0] === "cp")).toBe(false);
  expect(await readdir(resolve(result.root, "docker-state/volumes"))).toEqual([]);
  expect(await readdir(resolve(result.root, "docker-state/containers"))).toEqual([]);
});

test("missing native origin PDF blocks receipt publication and browser execution while draining owned resources", async () => {
  const result = await invoke(["--project=diagrams-chromium"], 0, "warm", 0, "missing-origin-pdf");
  expect(result.code, result.stderr).not.toBe(0);
  expect(result.stderr, "MISSING_ORIGIN_PDF_MUST_REFUSE_PUBLICATION").toContain("ENOENT");
  expect(result.stderr).toContain("origin.pdf");
  expect(result.calls.some(call => call.command === "vitest"), "INCOMPLETE_ORIGIN_MUST_BLOCK_BROWSER").toBe(false);
  const prepared = resolve(result.root, "tmp/diagram-export-native-prepared");
  const [session] = await readdir(prepared);
  expect(session, "FAILED_ORIGIN_OWNS_PREPARATION_SESSION").toBeDefined();
  expect(await readdir(resolve(prepared, session!)), "INCOMPLETE_ORIGIN_MUST_NOT_PUBLISH_RECEIPT").toEqual([]);
  expect(await readdir(resolve(result.root, "docker-state/volumes"))).toEqual([]);
  expect(await readdir(resolve(result.root, "docker-state/containers"))).toEqual([]);
});
