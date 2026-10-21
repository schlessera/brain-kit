/** Executable fixture for planning-observer.test.ts; never used by production observations. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { observePlanning, type PlanningRecord } from "./planning-observer";
import { burnCpu, bunControl, census, pause, runControl, until, withCompetitors } from "./planning-control";

const [mode, dir, index] = process.argv.slice(2) as [string, string, string?];
const readRecord = (label: string): PlanningRecord => JSON.parse(readFileSync(join(dir, `${label}-${process.pid}.json`), "utf8"));
const go = () => writeFileSync(join(dir, "go"), "");
function finishCompetitors(count: number) {
  until(() => Array.from({ length: count }, (_, i) => existsSync(join(dir, `done-${i}`))).every(Boolean), "COMPETITOR_CPU_BUDGET_EXHAUSTED");
}
function complete(record: PlanningRecord) { assert.deepEqual(record.incomplete, [], "CONTROLLED_RECORD_IS_COMPLETE"); }

if (mode === "competitor-child") {
  writeFileSync(join(dir, `ready-${index}`), JSON.stringify({ pid: process.pid, namespace: readlinkSync("/proc/self/ns/pid") }));
  until(() => existsSync(join(dir, "go")), "COMPETITOR_RENDEZVOUS_EXPIRED", 15_000);
  const cpuMs = burnCpu(Number(process.argv[5]));
  writeFileSync(join(dir, `done-${index}`), JSON.stringify({ cpuMs }));
  // Independent lifetime bound still works if the parent fails before its finally.
  pause(15_000);
} else if (mode === "hold") {
  await withCompetitors(dir, 1, async () => {
    writeFileSync(join(dir, "holding"), readlinkSync("/proc/self/ns/pid"));
    await Bun.sleep(15_000);
  });
} else if (mode === "sync-child") {
  burnCpu(400);
} else if (mode === "outside-census") {
  await withCompetitors(dir, 11, async pids => {
    const child = await runControl("busy", dir);
    assert.equal(child.exit, 0, child.stderr);
    finishCompetitors(11);
    writeFileSync(join(dir, "outside.json"), JSON.stringify({ pids, namespace: readlinkSync("/proc/self/ns/pid"), count: 11 }));
    process.stdout.write(child.stdout);
  });
} else {
  let result: unknown;
  let sameError = false;
  let competitorPids: number[] = [];
  let observation: PlanningRecord | undefined;
  let unwritableResult: unknown;
  const failure = new Error("Scylla");
  const execute = async (pids: number[] = []) => {
    competitorPids = pids;
    try {
      result = await observePlanning("/unused", mode, () => {
        switch (mode) {
          case "busy": {
            go();
            // Eleven owned processes outside this namespace run during the same window.
            if (existsSync(join(dir, "ready-10"))) finishCompetitors(11);
            burnCpu(600);
            pause(250); // Allow a second real sampler tick even on a fast CPU.
            return "Ithaca";
          }
          case "blocked": pause(500); return 7;
          case "child": {
            const child = Bun.spawnSync(bunControl("sync-child", dir), { timeout: 6_000, stdout: "pipe", stderr: "pipe" });
            assert.equal(child.exitCode, 0, child.stderr.toString());
            return 7;
          }
          case "competitor": case "cap-return": case "cap-throw":
            go(); finishCompetitors(pids.length); pause(250);
            if (mode === "cap-throw") throw failure;
            return "Ithaca";
          case "throws": throw failure;
          case "cleanup-failure": go(); finishCompetitors(pids.length); throw failure;
          default: throw new Error(`Unknown control ${mode}`);
        }
      }, dir);
    } catch (error) {
      sameError = error === failure;
      if (!sameError && mode !== "cap-throw" && mode !== "throws") throw error;
    }
    observation = readRecord(mode);
    if (!mode.startsWith("cap-")) complete(observation);
    if (mode === "throws") {
      const blocked = join(dir, "file"); writeFileSync(blocked, "");
      unwritableResult = await observePlanning("/unused", "unwritable", () => 7, join(blocked, "under-a-file"));
      assert.equal(readdirSync(dir).filter(name => name.endsWith(".json")).length, 1, "ONLY_THE_ORIGINAL_RECORD_WAS_WRITTEN");
    }
  };
  if (["competitor", "cap-return", "cap-throw", "cleanup-failure"].includes(mode)) {
    await withCompetitors(dir, mode.startsWith("cap-") ? 11 : 1, execute);
  } else await execute();
  console.log(JSON.stringify({ result, sameError, unwritableResult, observation, competitorPids,
    namespace: readlinkSync("/proc/self/ns/pid"), remaining: census() }));
}
