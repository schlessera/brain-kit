import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUnitMemorySampler, unitMemorySnapshot } from "../scripts/unit-memory";

test("memory diagnostics retain cgroup high-water marks, limits, OOM events and top RSS ownership", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-memory-"));
  const write = (name: string, value: string) => {
    mkdirSync(join(root, name, ".."), { recursive: true }); writeFileSync(join(root, name), value);
  };
  try {
    write("proc/meminfo", "MemTotal: 16384 kB\nMemAvailable: 1024 kB\n");
    write("proc/self/cgroup", "0::/job/worker\n");
    write("cgroup/job/worker/memory.current", "4096\n");
    write("cgroup/job/memory.current", "8192\n");
    write("cgroup/job/memory.peak", "12288\n");
    write("cgroup/job/memory.max", "16384\n");
    write("cgroup/job/memory.events", "oom 1\noom_kill 1\n");
    for (let pid = 1; pid <= 22; pid++) {
      write(`proc/${pid}/status`, `Name:\tbun\nPPid:\t1\nVmRSS:\t${pid} kB\nVmHWM:\t${pid + 10} kB\n`);
      write(`proc/${pid}/cmdline`, "bun\0test\0tests/odysseus.test.ts\0");
      symlinkSync("/odysseus/worker-2", join(root, `proc/${pid}/cwd`));
    }
    const sample = unitMemorySnapshot(join(root, "proc"), join(root, "cgroup"));
    expect(sample.meminfoKiB).toEqual({ MemTotal: 16384, MemAvailable: 1024 });
    expect(sample.cgroups).toContainEqual({ path: join(root, "cgroup/job"), current: "8192", peak: "12288", limit: "16384", events: "oom 1\noom_kill 1" });
    expect(sample.topRss).toHaveLength(20);
    expect(sample.topRss[0]).toEqual({ pid: 22, ppid: 1, rssKiB: 22, peakRssKiB: 32, name: "bun",
      cwd: "/odysseus/worker-2", command: "bun test tests/odysseus.test.ts " });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("memory diagnostics support cgroup v1 and unavailable optional counters", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-memory-"));
  try {
    mkdirSync(join(root, "proc/self"), { recursive: true });
    mkdirSync(join(root, "cgroup/memory/job"), { recursive: true });
    writeFileSync(join(root, "proc/self/cgroup"), "5:cpu,cpuacct:/job\n7:memory:/job\n");
    writeFileSync(join(root, "cgroup/memory/job/memory.max_usage_in_bytes"), "1234\n");
    const sample = unitMemorySnapshot(join(root, "proc"), join(root, "cgroup"));
    expect(sample.cgroups[0]?.peak).toBe("1234");
    expect(sample.topRss).toEqual([]);
    expect(sample.meminfoKiB).toEqual({});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a live sampler flushes incremental process samples and its final snapshot before returning", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-memory-")), output = join(root, "memory.jsonl");
  writeFileSync(output, '{"event":"stale"}\n');
  const sampler = await startUnitMemorySampler(output, 20);
  try {
    const first = JSON.parse(readFileSync(output, "utf8").trim().split("\n")[0]!);
    expect(first.event).toBe("start");
    expect(first.meminfoKiB.MemTotal).toBeGreaterThan(0);
    expect(first.topRss[0].rssKiB).toBeGreaterThan(0);
    const end = Date.now() + 2000;
    while (!readFileSync(output, "utf8").includes('"interval"') && Date.now() < end) await Bun.sleep(10);
    expect(readFileSync(output, "utf8")).toContain('"interval"');
  } finally { await sampler.stop(); }
  try {
    const samples = readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(samples.at(-1).event).toBe("stop");
    expect(samples.at(-1).topRss.length).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sampler keeps completed samples and final diagnostics after its coordinator is killed", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-memory-")), output = join(root, "memory.jsonl");
  const child = Bun.spawn([process.execPath, "-e", `import {startUnitMemorySampler} from ${JSON.stringify(join(import.meta.dir, "../scripts/unit-memory.ts"))};
    await startUnitMemorySampler(${JSON.stringify(output)},20); console.log("ready"); setInterval(()=>{},1000);`], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    child.kill("SIGKILL"); await child.exited;
    const end = Date.now() + 2000;
    while (!readFileSync(output, "utf8").includes("coordinator-disconnected") && Date.now() < end) await Bun.sleep(10);
    const samples = readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(samples[0].event).toBe("start");
    expect(samples.at(-1).event, "SAMPLER_SURVIVES_COORDINATOR_SIGKILL").toBe("coordinator-disconnected");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await child.exited;
    await new Response(child.stderr).text();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unit memory summaries reach live job output before artifact upload", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-memory-")), output = join(root, "memory.jsonl");
  try {
    const child = Bun.spawn([process.execPath, "-e", `import {startUnitMemorySampler} from ${JSON.stringify(join(import.meta.dir, "../scripts/unit-memory.ts"))};
      const sampler=await startUnitMemorySampler(${JSON.stringify(output)},10000,true); await sampler.stop();`], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
    const records = out.trim().split("\n").map(line => {
      expect(line).toStartWith("BRAIN_UNIT_MEMORY ");
      return JSON.parse(line.slice("BRAIN_UNIT_MEMORY ".length));
    });
    expect(records.map(record => record.event)).toEqual(["start", "stop"]);
    expect(records[0].topRss).toHaveLength(3);
    expect(records[0].memAvailableKiB).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
