import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { invocationFixture } from "./helpers/test-invocation-fixture";
import { runUnitWorkers } from "../scripts/unit-workers";

test("two native private workers attest actual independent builds and reject sibling receipt transplants", async () => {
  const { root, write } = invocationFixture(dirname(resolve(import.meta.dir, "..")));
  const reports = join(root, "tmp/reports"), shared = join(root, "tmp/shared"); mkdirSync(shared, { recursive: true });
  const files = ["tests/odysseus.test.ts", "tests/penelope.test.ts"];
  for (const [index, file] of files.entries()) write(file, `import {test,expect} from "bun:test";
import {readFileSync,writeFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import {invocationBuild} from "../scripts/test-invocation";
import {runtimePackageBuild} from "../packages/ui-react/tests/fixtures/runtime-package-build";
import {runtimeHookPhases} from "../packages/ui-react/tests/fixtures/runtime-hook-phases";
test("independent prepared worker ${index}",async()=>{
const root=process.cwd(),shared=${JSON.stringify(shared)};
const receipt=invocationBuild(root,["ithaca","troy"]);expect(receipt,"PRIVATE_WORKER_ACTUAL_SUCCESSFUL_AUTHORITY").toBeDefined();
const own={authority:process.env.BRAIN_TEST_BUILD_AUTHORITY,nonce:process.env.BRAIN_TEST_INVOCATION_NONCE,lease:receipt.lease,build:receipt.build.pid};
writeFileSync(join(shared,"${index}.json"),JSON.stringify(own));
await runtimePackageBuild(root,["ithaca"],runtimeHookPhases("private-worker-${index}"));
const end=Date.now()+10000;while(!existsSync(join(shared,"${1-index}.json"))&&Date.now()<end)await Bun.sleep(10);
const sibling=JSON.parse(readFileSync(join(shared,"${1-index}.json"),"utf8"));expect(sibling.nonce).not.toBe(own.nonce);expect(sibling.lease.ino).not.toBe(own.lease.ino);
writeFileSync(join(root,"packages/ithaca/dist/index.js"),"export const cargo=0;\\n");
process.env.BRAIN_TEST_BUILD_AUTHORITY=sibling.authority;process.env.BRAIN_TEST_INVOCATION_NONCE=sibling.nonce;
await runtimePackageBuild(root,["ithaca"],runtimeHookPhases("sibling-rejection-${index}"));
const child=Bun.spawnSync(["node","--input-type=module","-e",'import {cargo} from '+JSON.stringify(join(root,"packages/ithaca/dist/index.js"))+';console.log(cargo)'],{stdout:"pipe",stderr:"pipe"});
expect(child.exitCode,new TextDecoder().decode(child.stderr)).toBe(0);expect(new TextDecoder().decode(child.stdout).trim(),"SIBLING_RECEIPT_CANNOT_SUPPRESS_COMPILER").toBe("1");
writeFileSync(join(shared,"${index}.done"),"done");
const stopped=Date.now()+10000;while(!existsSync(join(shared,"${1-index}.done"))&&Date.now()<stopped)await Bun.sleep(10);
expect(existsSync(join(shared,"${1-index}.done")),"BOTH_LIVE_WORKER_CONTROLS_COMPLETE").toBe(true);
});
`);
  const git = (...args: string[]) => { const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" }); expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0); };
  git("init", "-q"); git("add", "."); git("-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-qm", "Private invocation fixture");
  try {
    await runUnitWorkers(root, files, undefined, reports);
    const receipts = readdirSync(reports).filter(file => /-build-.*-probe.json$/.test(file)).map(file => JSON.parse(readFileSync(join(reports, file), "utf8")));
    expect(receipts).toHaveLength(4);
    expect(receipts.filter(receipt => receipt.mode === "full"), "ONE_ACTUAL_FULL_PREPARATION_PER_WORKER").toHaveLength(2);
    for (const receipt of receipts) expect(receipt.success).toBe(true);
    const workers = JSON.parse(readFileSync(join(reports, "unit-worker-checkouts.json"), "utf8"));
    expect(new Set(workers.map((worker: { dependency: { ino: number } }) => worker.dependency.ino)).size).toBe(2);
    for (const worker of workers) expect(existsSync(join(root, worker.workspace)), "PRIVATE_WORKER_CLEANED").toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
