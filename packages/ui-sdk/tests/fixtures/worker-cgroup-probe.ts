import { launchFixtureAgentWorker as launchAgentWorker } from "../helpers/worker-startup-view-fixture.js";
/**
 * Runs as the only process of a delegated cgroup (systemd-run --user --scope
 * -p Delegate=yes), as a server under a `Delegate=yes` unit would. Establishes
 * the per-worker cgroups for real and drives workers into their cgroup
 * limits, and one worker into trying to raise its own. Prints one JSON line,
 * which the test asserts on from outside.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { workerLimitsPlan } from "../../src/server/worker-limits";
import { establishWorkerCgroups } from "../../src/server/worker-cgroup";

const root = mkdtempSync(join(process.argv[2]!, "cgroup-probe-"));
const brainPath = join(root, "brain");
mkdirSync(brainPath);

/** `sampleMs`: read the report while the worker runs, as a backend does after each tool step. */
async function drive(spec: string, command: string[], sampleMs?: number) {
  const cgroup = establishWorkerCgroups();
  if (!cgroup.available) return { unavailable: cgroup.reason };
  const limits = workerLimitsPlan({ spec, cgroup });
  const worker = launchAgentWorker({ brainPath, command, env: { PATH: "/usr/bin:/bin" }, limits });
  worker.stdin.end();
  const out: string[] = [];
  worker.stdout.on("data", chunk => out.push(String(chunk)));
  worker.stderr.on("data", () => {});
  const sampler = sampleMs ? setInterval(() => worker.limitReport(), sampleMs) : undefined;
  const code = await worker.exited;
  clearInterval(sampler);
  return { code, stdout: out.join("").trim(), report: worker.limitReport(), enforced: limits.status.enforced.map(entry => entry.limit),
    leftover: readdirSync(cgroup.workers).filter(name => name.startsWith("w-")) };
}
const bun = (program: string) => [process.execPath, "-e", program];

try {
  // Fork until the cgroup refuses; process rlimit off so only pids.max applies.
  const pids = await drive("pids=48,processes=unlimited", bun(`
    const s=[]; let refused="";
    for(let i=0;i<500;i++){ try{ s.push(Bun.spawn(["/usr/bin/sleep","20"],{stdio:["ignore","ignore","ignore"]})) }catch(e){ refused=e.code; break } }
    console.log(JSON.stringify({started:s.length,refused})); for(const p of s) p.kill("SIGKILL"); process.exit(0);`));
  // Allocate and touch 1 GiB against a 192 MiB worker; per-process rlimit off so only memory.max applies.
  const memory = await drive("memory=192MiB,data=unlimited", bun(`
    const held=[]; for(let i=0;i<32;i++){ held.push(Buffer.alloc(32*1024*1024,1)) } console.log("allocated", held.length);`));
  // Burn CPU for a second against a tenth of one CPU.
  const cpu = await drive("cpu=0.1", bun(`const end=Date.now()+1000; let n=0; while(Date.now()<end) n++; console.log("spun")`));
  // From a nested user, mount and cgroup namespace, mount cgroup2 afresh and
  // try to lift this worker's own limits and to leave its cgroup.
  const escape = await drive("memory=300MiB,pids=300", ["/bin/sh", "-c", `unshare -U -C -m -r sh -c '
    mkdir -p /tmp/cg && mount -t cgroup2 none /tmp/cg && echo mounted
    echo max > /tmp/cg/memory.max 2>/dev/null && echo memory-raised || echo memory-refused
    echo max > /tmp/cg/pids.max 2>/dev/null && echo pids-raised || echo pids-refused
    echo "memory.max=$(cat /tmp/cg/memory.max) pids.max=$(cat /tmp/cg/pids.max)"
    echo max > /tmp/cg/cgroup.max.descendants 2>/dev/null && echo descendants-raised || echo descendants-refused
    mkdir /tmp/cg/odysseus 2>/dev/null && echo child-created || echo child-refused'
    cat /proc/self/cgroup`]);
  // A command the limit killed earlier, which the worker survived, does not
  // make the worker's own later exit 137 a limit's doing.
  const survived = await drive("memory=192MiB,data=unlimited", ["/bin/sh", "-c",
    `${process.execPath} -e 'const h=[]; for(let i=0;i<32;i++) h.push(Buffer.alloc(32*1024*1024,1))'; echo "child=$?"; sleep 2; exit 137`], 100);
  const server = readFileSync("/proc/self/cgroup", "utf8").trim();
  console.log(JSON.stringify({ pids, memory, cpu, escape, survived, server, alive: true }));
} finally { rmSync(root, { recursive: true, force: true }); }
