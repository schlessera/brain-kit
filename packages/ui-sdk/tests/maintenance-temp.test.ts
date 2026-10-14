import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { maintenanceLaunch, launchMaintenanceWorker, runMaintenanceWorker, runMaintenanceWorkerSync } from "../src/server/maintenance-worker";
import { workerCommand, probeWorkerHost } from "../src/server/worker-launcher";
import { reserveMaintenanceTemp } from "../src/server/maintenance-temp-budget";
import { ledgerLine } from "./maintenance-temp-ledger-protocol";
import { createFixtureWorkerStartupView } from "./helpers/worker-startup-view-fixture";
import * as startup from "../src/server/worker-startup-view";

const ROOT = resolve(import.meta.dir, "../../..");
const roots: string[] = [];
const viewCleanups: (() => void)[] = [];
beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/maintenance-temp-probe-"));
  try { const result = probeWorkerHost(root); if (!result.ok) throw new Error(result.requirement); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
afterEach(() => { for (const cleanup of viewCleanups.splice(0)) cleanup(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(ROOT, "tmp/maintenance-temp-")); roots.push(root);
  const brain = join(root, "brain"); const home = join(root, "home");
  mkdirSync(brain); mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), "[user]\nname = Penelope\n");
  writeFileSync(join(brain, "harbour.md"), "Odysseus surveys Ithaca.\n");
  const startupView = createFixtureWorkerStartupView(brain); viewCleanups.push(startupView.cleanup);
  return { root, brain, home, startupView };
}

test("maintenance temporary writes share one actual filesystem allowance, with no HOME or mask overflow", async () => {
  const f = fixture();
  const allowanceBytes = 8 * 1024 * 1024;
  const program = `
    const fs = require("node:fs");
    const paths = ["/tmp", process.env.BRAIN_WORKER_SCRATCH, process.env.XDG_CACHE_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME, process.env.XDG_STATE_HOME];
    for (const path of paths) fs.mkdirSync(path, {recursive:true});
    const topology = paths.map(path => { const s=fs.statfsSync(path); return { path, size:s.blocks*s.bsize, device:fs.statSync(path).dev }; });
    fs.writeFileSync("/tmp/raft", Buffer.alloc(6*1024*1024));
    const results = paths.map((path,i) => { let error=null; try { fs.writeFileSync(path+"/shroud-"+i, Buffer.alloc(4*1024*1024)); } catch(e) { error=e.code; } return error; });
    const refused = [process.env.HOME+"/escape", "/run/escape", "/dev/escape", "/dev/shm/escape"].map(path => { try { fs.writeFileSync(path,"escape"); return null; } catch(e) { return e.code; } });
    console.log(JSON.stringify({topology,results,refused,config:fs.readFileSync(process.env.HOME+"/.gitconfig","utf8")}));
  `;
  const result = await runMaintenanceWorker({ brainPath: f.brain, startupView: f.startupView, command: [realpathSync(process.execPath), "-e", program],
    env: { PATH: "/usr/bin:/bin", HOME: f.home, XDG_CONFIG_HOME:"/tmp/brain-worker-home/config", XDG_CACHE_HOME:"/tmp/brain-worker-home/cache",
      XDG_DATA_HOME:"/tmp/brain-worker-home/data", XDG_STATE_HOME:"/tmp/brain-maintenance-state" }, home: f.home, credentials: true, network: false,
    tempLimits: { allowanceBytes, budgetBytes: 256 * 1024 * 1024 }, timeoutMs: 10_000 });
  expect(result.exitCode, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.results, "MAINTENANCE_TEMP_OVERFLOW: every temporary area refuses beyond the shared allowance").toEqual(Array(6).fill("ENOSPC"));
  expect(output.topology.map((p: { size: number }) => p.size), "MAINTENANCE_TEMP_MOUNT_SIZE").toEqual(Array(6).fill(allowanceBytes));
  expect(new Set(output.topology.map((p: { device: number }) => p.device)).size, "all tool directories and shm use the same tmpfs").toBe(1);
  expect(output.refused, "MAINTENANCE_READ_ONLY_HOME_AND_MASKS").toEqual(Array(4).fill("EROFS"));
  expect(output.config).toContain("Penelope");
  expect(readFileSync(join(f.brain, "harbour.md"), "utf8")).toBe("Odysseus surveys Ithaca.\n");
  expect(readFileSync(join(f.home, ".gitconfig"), "utf8")).toContain("Penelope");
});


test("actual maintenance admission releases after completion, command failure, abort, deadline and startup refusal", async () => {
  const f = fixture();
  const tempLimits = { allowanceBytes: 8 * 1024 * 1024, budgetBytes: 8 * 1024 * 1024 };
  const base = { brainPath: f.brain, startupView: f.startupView, env: { PATH: "/usr/bin:/bin" }, credentials: false, tempLimits, tempDomain: {statePath:join(f.root,"ui.db")} };
  const command = [realpathSync(process.execPath), "-e", 'console.log("ready"); await Bun.stdin.text();'];
  const held = launchMaintenanceWorker({ ...base, command });
  try {
    expect(await ledgerLine(held.stdout)).toBe("ready");
    expect(() => launchMaintenanceWorker({ ...base, command }), "MAINTENANCE_ACTUAL_ADMISSION: no second command starts").toThrow("Nothing ran");
  } finally { await held.input(""); await held.exited; }
  const assertReleased = () => {
    expect(() => {
      const next = reserveMaintenanceTemp(tempLimits, base.tempDomain);
      next.release();
    }, "MAINTENANCE_SHARED_ACTUAL_RELEASE: the full allowance is available while this launcher lives").not.toThrow();
  };
  assertReleased();
  const failed = await runMaintenanceWorker({ ...base, command: ["/bin/sh", "-c", "exit 7"] });
  expect(failed.exitCode).toBe(7); assertReleased();
  const controller = new AbortController();
  const aborted = runMaintenanceWorker({ ...base, command: ["/bin/sleep", "30"], signal: controller.signal });
  controller.abort();
  await expect(aborted).rejects.toThrow(); assertReleased();
  const deadline = await runMaintenanceWorker({ ...base, command: ["/bin/sleep", "30"], timeoutMs: 100 });
  expect(deadline.killed).toBe(true); assertReleased();
  expect(() => launchMaintenanceWorker({ ...base, command: ["/bin/true"], maskPaths: [f.brain] })).toThrow();
  assertReleased();
  // Foundation integration creates an immutable startup view after admission.
  // A failure before bootstrap must return that reservation in both forms.
  const refusal = spyOn(startup, "createWorkerStartupView").mockImplementation(() => {
    throw new Error("owned immutable startup refusal");
  });
  try {
    expect(() => launchMaintenanceWorker({ ...base, startupView: undefined, command: ["/bin/true"] })).toThrow("owned immutable startup refusal");
    assertReleased();
    expect(() => runMaintenanceWorkerSync({ ...base, startupView: undefined, command: ["/bin/true"], timeoutMs: 1000 })).toThrow("owned immutable startup refusal");
    assertReleased();
  } finally { refusal.mockRestore(); }
});


test("trusted transport temporary writes are bounded while mirror writes retain their separate storage", async () => {
  const f = fixture(); const mirror = join(f.root, "mirror"); mkdirSync(mirror);
  const allowanceBytes = 8 * 1024 * 1024;
  const program = `
    const fs=require("node:fs");
    fs.writeFileSync("/tmp/raft",Buffer.alloc(6*1024*1024));
    const attempt=path=>{try{fs.writeFileSync(path,Buffer.alloc(4*1024*1024));return null;}catch(error){return error.code;}};
    const overflow=attempt(process.env.XDG_CACHE_HOME+"/shroud");
    const refused=["/shroud","/dev/shroud","/dev/shm/shroud"].map(attempt);
    fs.writeFileSync("transport-output","Penelope receives the objects.");
    console.log(JSON.stringify({overflow,refused}));
  `;
  const result = await runMaintenanceWorker({brainPath:f.brain,command:[realpathSync(process.execPath),"-e",program],
    env:{PATH:"/usr/bin:/bin",HOME:"/tmp/brain-worker-home"},credentials:true,
    transport:{mirror,readPaths:[realpathSync(process.execPath)]},tempLimits:{allowanceBytes,budgetBytes:268435456},timeoutMs:10_000});
  expect(result.exitCode,result.stderr).toBe(0);
  const output=JSON.parse(result.stdout);
  expect(output.overflow,"TRANSPORT_TEMP_OVERFLOW").toBe("ENOSPC");
  expect(output.refused,"TRANSPORT_NON_OUTPUT_MOUNTS_READ_ONLY").toEqual(Array(3).fill("EROFS"));
  expect(readFileSync(join(mirror,"transport-output"),"utf8")).toBe("Penelope receives the objects.");
});


test("both maintenance envelopes carry the approved paired restriction while agent launches retain their existing flags", () => {
  const f=fixture(); const mirror=join(f.root,"mirror"); mkdirSync(mirror);
  const base={brainPath:f.brain,command:["/bin/true"],env:{PATH:"/usr/bin:/bin"},credentials:false};
  for (const input of [base,{...base,credentials:true,transport:{mirror,readPaths:[]}}]) {
    const argv=workerCommand(maintenanceLaunch(input));
    expect(argv.includes("--disable-userns"),"MAINTENANCE_TRANSPORT_RESTRICTION").toBe(true);
    expect(argv.includes("--assert-userns-disabled")).toBe(true);
  }
  const agent=workerCommand({brainPath:f.brain,command:["/bin/true"],env:{}});
  expect(agent.includes("--disable-userns")).toBe(false);
  expect(agent.includes("--assert-userns-disabled")).toBe(false);
});


test("shared admission state inside the authoritative brain refuses without creating repository-controlled ledger storage", () => {
  const f=fixture(); const statePath=join(f.brain,"ui.db");
  expect(()=>launchMaintenanceWorker({brainPath:f.brain,command:["/bin/true"],env:{},credentials:false,tempDomain:{statePath}})).toThrow("outside the authoritative brain");
  expect(()=>launchMaintenanceWorker({brainPath:f.brain,command:["/bin/true"],env:{},credentials:false,tempDomain:{statePath:join(f.brain,"harbour.md")}})).toThrow("outside the authoritative brain");
});
