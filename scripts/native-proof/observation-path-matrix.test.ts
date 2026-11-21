import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as launcher from "../../packages/ui-sdk/src/server/worker-launcher.js";
import { observationPathMatrix } from "./observation-path-matrix.js";

/** The comparison checkout's public journal/scope surface has no index fields. */
test("the complete timing matrix returns all cells against the previous index-free scope shape", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-base-matrix-")); mkdirSync(join(root, "notes"));
  const db = new Database(":memory:"); db.exec("CREATE TABLE turn_journal_changes(turn_id TEXT,sequence INTEGER,path TEXT,PRIMARY KEY(turn_id,sequence))");
  let id = "", sequence = 0, requested = 0, scopeFinished = 0, indexObservations = 0;
  let observer: { before(): void; after(ok: boolean): void } | undefined;
  const journal = {
    async begin(turnId: string) { id = turnId; }, toolStarted(_id: string, toolUseId: string) { requested = toolUseId.includes("-history-") ? 200 : Number(toolUseId.split("-")[3]); },
    async toolEnded() { observer?.before(); for (let i = 0; i < requested; i++) db.query("INSERT INTO turn_journal_changes VALUES (?,?,?)").run(id, ++sequence, `notes/ithaca-${i}.md`); observer?.after(true); },
    onObservation(_callback: unknown, control: typeof observer) { observer = control; return () => { observer = undefined; return true; }; },
    details() { return { changes: Array(sequence) }; }, summary() { return { scope: { limits: { turn_bytes: 4 * 1024 ** 3 }, receipts: [] } }; },
    async observe() { indexObservations++; }, async finish() {},
  };
  const worker = spyOn(launcher, "launchAgentWorker").mockImplementation((options => {
    // This trusted fixture command tests the harness protocol. It makes no
    // claim of native/sandbox qualification or native timing.
    const child = spawn(options.command![0]!, options.command!.slice(1), { cwd: root, stdio: "pipe" });
    const exited = new Promise<number>(resolve => child.once("exit", code => resolve(code ?? -1)));
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, freeze() { child.kill("SIGSTOP"); }, resume() { child.kill("SIGCONT"); }, kill(signal: NodeJS.Signals) { child.kill(signal); }, released: async () => {} } as never;
  }) as typeof launcher.launchAgentWorker);
  const events: { kind: string; data: object }[] = [];
  try {
    const result = await observationPathMatrix(root, journal as never, { async begin() { return { sandbox: { profile: "governed" }, policy: { hash: "ithaca", policy: {} }, async end() {} }; } } as never,
      (kind, data) => events.push({ kind, data }), { async begin() {}, workerStarted() {}, async finish() { scopeFinished++; } } as never, "athena", db);
    expect(result.samples.map(row => row.changedPaths), "BASE_MATRIX_RETURNS_ALL_OBSERVED_PATH_CELLS_WITHOUT_INDEX_METADATA").toEqual([0, 1, 20, 200].flatMap(n => Array(12).fill(n)));
    expect(result.loadedSamples).toHaveLength(12); expect(result.historyRows).toBeGreaterThanOrEqual(10000);
    expect(indexObservations, "BASE_MATRIX_NEVER_REQUIRES_NEW_INDEX_FACTS").toBe(0);
    expect(events).toContainEqual({ kind: "observation_index_capacity", data: { turnId: result.turnId, supported: false } });
    expect(scopeFinished).toBe(1);
  } finally { worker.mockRestore(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
