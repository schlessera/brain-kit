/** Spawned only by host-storage-isolation.test.ts; also harmless in full discovery. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeBackend } from "../../src/backend";
import { transcriptPaths } from "../../src/transcript-archive";
import { turnEnv } from "../../src/sdk-options";
import { mockWorkerHostForSdkStream } from "../helpers/worker-host";

mockWorkerHostForSdkStream();
test("default and explicit profile saves settle in the disposable test home", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-isolation-turn-"));
  const records: number[] = [];
  let storageWasInsideTestHome = true;
  try {
    for (const explicit of [false, true]) {
      const brain = join(root, String(explicit)); mkdirSync(brain);
      const profile = { id: "voyage", label: "Voyage", billing: "api" as const, requiredEnvKeys: [], buildEnv: () => ({}) };
      const session = "44444444-4444-4444-8444-444444444444";
      const backend = createClaudeBackend({ brainPath: brain, log: () => {},
        ...(explicit ? { profiles: [profile] } : {}),
        queryFn: (() => (async function* () {
          yield { type: "system", subtype: "init", session_id: session };
          yield { type: "result", subtype: "success", session_id: session, is_error: false,
            duration_ms: 1, duration_api_ms: 0, num_turns: 1, result: "", total_cost_usd: 0, usage: {}, modelUsage: {} };
        })()) as never,
      });
      await backend.startTurn({ prompt: "Return to Ithaca", signal: new AbortController().signal,
        bridge: { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }) } });
      const storage = join(transcriptPaths(brain, explicit ? turnEnv(profile) : undefined).archive, "native-observations");
      records.push(readdirSync(storage).filter(name => name.endsWith(".json")).length);
      storageWasInsideTestHome &&= storage.startsWith(join(process.env.HOME!, ".claude") + "/");
    }
    expect(records).toEqual([1, 1]);
    if (process.env.ODYSSEUS_ISOLATION_REPORT) writeFileSync(process.env.ODYSSEUS_ISOLATION_REPORT,
      JSON.stringify({ records, storageWasInsideTestHome, home: process.env.HOME }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
