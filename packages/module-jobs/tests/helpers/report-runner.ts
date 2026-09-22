// Isolated HTTP replacement: exercise the real adapter, runner and SQLite log.
import { ScrapeClient } from "@schlessera/brain-scrape";
import { openDatabase, getLastCursor, logScrapeRun } from "../../src/db.js";
import { runScrape } from "../../src/scrape.js";

const [mode, dbPath] = process.argv.slice(2);
const cursor = "2025-01-01T00:00:00.000Z";
const db = openDatabase(dbPath!);
logScrapeRun(db, "remoteok", "running");
logScrapeRun(db, "remoteok", "completed", { cursor });
db.run("UPDATE scrape_runs SET started_at = '2000-01-01T00:00:00.000Z'");
db.close();
ScrapeClient.prototype.get = async () => {
  if (mode === "not_run") throw new Error("fixture transport unavailable");
  const body = mode === "empty" ? [] : mode === "ok"
    ? [{ id: "1", position: "Engineer", company: "Example Corp", date: "2025-02-01T00:00:00.000Z" }]
    : [{ id: "1", renamed_position: "Engineer", renamed_company: "Example Corp" }];
  return new Response(JSON.stringify(body));
};
const report = await runScrape({ dbPath: dbPath!, sources: ["remoteok"], incremental: true });
const stored = openDatabase(dbPath!);
const run = stored.query("SELECT status, cursor, error FROM scrape_runs ORDER BY id DESC LIMIT 1").get();
const lastCursor = getLastCursor(stored, "remoteok");
stored.close();
console.log(JSON.stringify({ report, run, lastCursor }));
