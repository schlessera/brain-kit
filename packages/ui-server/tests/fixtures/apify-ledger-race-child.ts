/**
 * One process of the two-process ledger race (#3161): waits for the shared
 * start signal, then tries to reserve $2 against a $3 account day. Prints
 * `admitted` or `refused:<reason>`. Keyless and offline: it only opens the
 * ledger file the parent names, and marks itself ready beside the start
 * signal once that ledger is open.
 */
import { existsSync, writeFileSync } from "node:fs";
import { ApifyLedgerRefusal, openApifyLedger } from "@schlessera/brain-common/internal/apify";

const [path, go, index] = process.argv.slice(2) as [string, string, string];
const ledger = openApifyLedger(path);
// At the start line: the parent opens it once every child has said so.
writeFileSync(`${go}.${index}.ready`, "");
while (!existsSync(go)) await Bun.sleep(5);
const now = Date.parse("2026-07-12T09:00:00.000Z");
try {
  ledger.reserve({
    account_id: "IthacaHousehold01", generation: "gen-1", brain_id: `brain-${index}`, principal_id: `p-${index}`, session_id: `s-${index}`, turn_id: `t-${index}`,
    proposal_digest: `proposal-${index}`, actor_id: "SeaCharts01", build_id: "SeaBuild142", build_number: "1.4.2", profile_id: "odysseus-sea-charts@1",
    input_sha256: "0".repeat(64), run_cap_micro: 2_000_000, request_micro: 8_000, storage_micro: 44, request_unit_micro: 400,
    deadline_at: now + 720_000, retention_seconds: 86_400, timeout_secs: 600, memory_mbytes: 1024, items_bound: 3, max_result_items: 3,
    max_result_bytes: 262_144, status_budget: 12, result_budget: 6, abort_budget: 2,
  }, { run_micro: 3_000_000, turn_micro: 5_000_000, session_micro: 10_000_000, day_micro: 3_000_000, brain_day_micro: 10_000_000,
    max_runs_per_turn: 2, max_concurrent_runs: 10 }, now, 10);
  console.log("admitted");
} catch (error) {
  if (error instanceof ApifyLedgerRefusal) console.log(`refused:${error.reason}`);
  else throw error;
} finally {
  ledger.close();
}
