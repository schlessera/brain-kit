/** Bounded offline investigation; run only inside the owned native fixture. */
import { expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as accountingModule from "../../packages/ui-server/src/brain/journal-accounting.js";
import * as objectsModule from "../../packages/ui-server/src/brain/journal-objects.js";
import { serveNativeBrainManager } from "../../packages/ui-sdk/src/server/native-brain-manager.js";
import { createNativeBrainManagerClient } from "../../packages/ui-sdk/src/server/native-brain-manager-client.js";
import { createUiDb } from "../../packages/ui-server/src/db/client.js";
import { hostOutputStagingLimits } from "../../packages/ui-sdk/src/server/worker-state-limits.js";

type Counters = Record<string, { calls: number; ms: number }>;
const results: unknown[] = [];
let counters: Counters = {};
function add(name: string, start: number) {
  const row = counters[name] ??= { calls: 0, ms: 0 }; row.calls++; row.ms += performance.now() - start;
}
function sync<T>(name: string, call: () => T): T { const at = performance.now(); try { return call(); } finally { add(name, at); } }
async function asyncTime<T>(name: string, call: () => Promise<T>): Promise<T> { const at = performance.now(); try { return await call(); } finally { add(name, at); } }
const CAP = 10 * 1024 ** 3;
const brain = "/brain-fixture/brain";
function command(args: string[]) { const r = Bun.spawnSync(args); expect(r.exitCode, r.stderr.toString()).toBe(0); return r.stdout.toString(); }
function content(index: number, size: number, revision: number): Buffer {
  const motif = `Odysseus Ithaca 2026-07-12 file ${index} revision ${revision}.\r\n`;
  return Buffer.from(motif.repeat(Math.ceil(size / motif.length)).slice(0, size));
}

test("finite durable native journal profiling", async () => {
  expect(process.env.BRAIN_JOURNAL_PROFILE_OWNED, "EXPLICIT_OWNED_NATIVE_FIXTURE_REQUIRED").toBe("1752");
  const brainUuid = /^\s*UUID:\s*([0-9a-f-]+)/m.exec(command(["btrfs", "subvolume", "show", brain]))![1]!.replaceAll("-", "");
  const fsid = /^fsid\s+([0-9a-f-]+)/m.exec(command(["btrfs", "inspect-internal", "dump-super", "/dev/brain-native-proof-loop"]))![1]!;
  fs.mkdirSync("/native-runtime", { recursive: true });
  const socketPath = "/native-runtime/profile1752.sock";
  const staging = hostOutputStagingLimits({});
  const service = await serveNativeBrainManager({ storePath: "/brain-fixture", devicePath: "/dev/brain-native-proof-loop", fsid, brainUuid, socketPath,
    appUid: 0, appGid: 0, stageAllowanceBytes: staging.allowanceBytes, stageBudgetBytes: staging.budgetBytes,
    capacityBytes: 4 * 1024 ** 3, recoveryReserveBytes: 16 * 1024 ** 2 });
  const client = createNativeBrainManagerClient({ socketPath });
  const ready = await client.ready();
  const accountFactory = accountingModule.createJournalAccounting;
  const objectFactory = objectsModule.createJournalObjects;
  const accountSpy = spyOn(accountingModule, "createJournalAccounting").mockImplementation((...args) => {
    const actual = accountFactory(...args);
    return { ...actual,
      write: operation => sync("accountingWrite", () => actual.write(operation)),
      reserve: (bytes, hash) => {
        const r = sync("accountingReserve", () => actual.reserve(bytes, hash));
        return { ...r, finish: (...values) => sync("accountingFinish", () => r.finish(...values)), cancel: () => sync("accountingCancel", () => r.cancel()) };
      },
    };
  });
  const objectSpy = spyOn(objectsModule, "createJournalObjects").mockImplementation((...args) => {
    const actual = objectFactory(...args);
    return { ...actual, putFileAsync: (...values) => asyncTime("objectRetainIncludingAccounting", () => actual.putFileAsync(...values)), remove: hash => sync("objectCollection", () => actual.remove(hash)) };
  });
  // Dynamic import makes the existing concrete factories observable; all original methods execute.
  const { createTurnJournal } = await import("../../packages/ui-server/src/brain/turn-journal.js");
  const native = { ...client,
    checkpoint: (...args: Parameters<typeof client.checkpoint>) => asyncTime("nativeCheckpoint", () => client.checkpoint(...args)),
    release: (...args: Parameters<typeof client.release>) => asyncTime("nativeRelease", () => client.release(...args)),
    async delta(...args: Parameters<typeof client.delta>) {
      const start = performance.now(), job = await client.delta(...args);
      const completed = job.completed.finally(() => add("nativeDeltaThroughConsumption", start));
      return { stream: job.stream, completed };
    },
  };
  try {
    for (const workload of [{ name: "small", count: 300, size: 1024 }, { name: "large", count: 3, size: 102400 }]) {
      for (let sample = 0; sample < 3; sample++) {
        fs.rmSync(join(brain, "notes"), { recursive: true, force: true }); fs.mkdirSync(join(brain, "notes"));
        const root = `/proof/profile-${workload.name}-${sample}`; fs.mkdirSync(root, { mode: 0o700 });
        const expected = new Map<string, Buffer>();
        const write = (revision: number) => { for (let i = 0; i < workload.count; i++) {
          const path = `notes/voyage-${i}.md`, bytes = content(i, workload.size, revision); expected.set(path, bytes); fs.writeFileSync(join(brain, path), bytes);
        } };
        write(0);
        const dbPath = join(root, "ui.db"), db = createUiDb(dbPath);
        const journal = createTurnJournal(db, { nativeManager: native, brainPath: brain, dbPath, objectsRoot: join(root, "objects"), capBytes: CAP });
        const phases: unknown[] = [];
        const measure = async (name: string, call: () => Promise<unknown>) => {
          counters = {}; const at = performance.now(); await call();
          const elapsedMs = performance.now() - at;
          const objects = db.query("SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes FROM turn_journal_objects WHERE state='present'").get();
          const pins = db.query("SELECT count(*) AS count FROM turn_journal_object_refs").get();
          phases.push({ name, elapsedMs, counters: structuredClone(counters), objects, pins });
        };
        try {
          await measure("coldAdmission", () => journal.begin("voyage", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; }));
          expect(db.query("SELECT count(*) AS n FROM turn_journal_objects").get(), "NO_BASELINE_CAS_CONTENT").toEqual({ n: 0 });
          write(1); await measure("firstChanged", () => journal.observe());
          await measure("warmUnchanged", () => journal.observe());
          write(2); await measure("warmChanged", () => journal.observe());
          const details = journal.details("ithaca", "voyage")!;
          expect(details.summary.state).toBe("recording");
          for (const change of details.changes) for (const side of ["before", "after"] as const) {
            const version = change[side]; if (!version?.hash) continue;
            const bytes = journal.version("ithaca", "voyage", change.sequence, side)!.bytes(workload.size);
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(version.hash);
            const index = Number(/voyage-(\d+)\.md/.exec(change.path)![1]);
            expect([0, 1, 2].some(revision => bytes.equals(content(index, workload.size, revision))), "EXACT_RETAINED_RAW_VERSION").toBe(true);
            expect(db.query("SELECT 1 AS n FROM turn_journal_object_refs WHERE turn_id='voyage' AND hash=?").get(version.hash), "ACTIVE_VERSION_PINNED").toEqual({ n: 1 });
          }
          const usage = accountFactory(db, dbPath).usage(); expect(usage).toBeLessThan(CAP);
          await journal.finish("voyage"); expect(journal.summary("voyage").state).toBe("complete");
          results.push({ workload, sample, phases, usageBytes: usage, capBytes: CAP, exactVersionsAndPinsVerified: true });
          fs.writeFileSync("/proof/journal-profile.json", JSON.stringify({ schemaVersion: 1, runtime: Bun.version, kernel: command(["uname", "-r"]).trim(), ready, samples: results }, null, 2));
        } finally { await journal.close(); db.close(); }
      }
    }
  } finally { objectSpy.mockRestore(); accountSpy.mockRestore(); await service.close(); }
}, 300000);
