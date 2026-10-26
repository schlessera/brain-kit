/**
 * Test preload for the app-connection write inventory (#3004): records every
 * observed app-connection write to the JSONL file named by
 * BRAIN_UI_APP_WRITE_AUDIT. Use with
 * `BRAIN_UI_APP_WRITE_AUDIT=<file> bun run test --preload ./scripts/app-write-audit-preload.ts <paths>`,
 * then `bun scripts/app-write-inventory.ts <file>`.
 */
import { appendFileSync } from "node:fs";
import { observeAppWrites } from "../packages/ui-server/src/db/write-worker.ts";

const file = process.env.BRAIN_UI_APP_WRITE_AUDIT;
if (!file) throw new Error("app-write-audit-preload: set BRAIN_UI_APP_WRITE_AUDIT to the JSONL file to record into.");
observeAppWrites("every", write => {
  const site = write.stack.split("\n").slice(1).map(line => line.trim().replace(/^at /, ""))
    .filter(line => !line.includes("/db/write-worker.ts") && !line.includes("bun:sqlite") && !line.includes("node_modules"));
  appendFileSync(file, JSON.stringify({ phase: write.phase, rows: write.rows, site: site.slice(0, 24), pid: process.pid }) + "\n");
});
