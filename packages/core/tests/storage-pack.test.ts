import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempBrain, cleanup, runCli } from "./cli-harness";
test("storage pack uses existing non-destructive maintenance and preserves history and refs", async () => {
  const root = makeTempBrain();
  const git = (...args: string[]) => { const p = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }); expect(p.exitCode, p.stderr.toString()).toBe(0); return p.stdout.toString(); };
  try {
    git("init"); git("add", "."); git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-m", "Ithaca");
    writeFileSync(join(root, "chart.bin"), Buffer.alloc(8192, 7)); git("add", "chart.bin"); git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-m", "Voyage");
    git("tag", "departure", "HEAD~1"); const refs = git("show-ref"), history = git("log", "--all", "--format=%H"), reflog = git("reflog", "--all", "--format=%H");
    const result = await runCli(root, ["storage", "pack", "--json"]);
    expect(result.code, "STORAGE_PACK_NARROW_COMMAND").toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schema_version: 1, action: "pack", state: "complete", headroom: { requiredBytes: null } });
    expect(git("show-ref"), "STORAGE_PACK_REFS_PRESERVED").toBe(refs); expect(git("log", "--all", "--format=%H")).toBe(history); expect(git("reflog", "--all", "--format=%H")).toBe(reflog);
    expect(git("show", "HEAD:chart.bin")).toHaveLength(8192);
  } finally { cleanup(root); }
});

test("packing on a genuinely full private tmpfs refuses before maintenance and preserves recovery bytes", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "odysseus-packing-full-"));
  const cli = join(import.meta.dir, "../src/cli/brain.ts");
  const source = `import {writeFileSync,openSync,writeSync,closeSync,existsSync,statfsSync} from "node:fs";
const root=${JSON.stringify(root)};
const env={...process.env,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",GIT_OPTIONAL_LOCKS:"0"};
function git(...args){const p=Bun.spawnSync(["git","-C",root,...args],{env,stdout:"pipe",stderr:"pipe"});if(p.exitCode)throw Error(p.stderr.toString());return p.stdout.toString();}
writeFileSync(root+"/brain.config.ts","export default {};\\n");writeFileSync(root+"/recovery.txt","Odysseus retains the chart.");git("init");git("add",".");git("-c","user.name=Odysseus","-c","user.email=odysseus@example.invalid","commit","-m","Ithaca");const before=git("show-ref");
const fd=openSync(root+"/occupied","wx");try{for(let i=0;i<4096;i++)writeSync(fd,Buffer.alloc(4096));}catch(error){if(error.code!=="ENOSPC")throw error;}finally{closeSync(fd);}
if(statfsSync(root).bavail!==0)throw Error("volume did not fill");
const p=Bun.spawnSync([process.execPath,${JSON.stringify(cli)},"storage","pack","--json"],{env:{...env,BRAIN_ROOT:root},stdout:"pipe",stderr:"pipe"});
console.log(JSON.stringify({code:p.exitCode,out:p.stdout.toString(),err:p.stderr.toString(),sameRefs:before===git("show-ref"),retained:existsSync(root+"/recovery.txt")}));`;
  try {
    const child = Bun.spawn(["bwrap", "--unshare-user", "--unshare-net", "--bind", "/", "/", "--size", "1048576", "--tmpfs", root, "--proc", "/proc", "--dev", "/dev", process.execPath, "--config=/dev/null", "--no-env-file", "-e", source], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0); const result = JSON.parse(out) as {code: number; out: string; err: string; sameRefs: boolean; retained: boolean};
    expect(result.code, result.err).toBe(2);
    expect(JSON.parse(result.out), "STORAGE_PACK_ZERO_SPACE_REFUSAL").toMatchObject({ state: "refused", reason: "no_space", packed: null, headroom: { availableBytes: 0 } });
    expect(result.sameRefs).toBe(true); expect(result.retained).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
