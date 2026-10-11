/** Real CLI entry with a fixture clock and physical invocation receipts. */
import { appendFileSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
const epoch = Number(readFileSync(join(process.cwd(), "clock.txt"), "utf8"));
const NativeDate = Date;
class FixtureDate extends NativeDate {
  constructor(value?: string | number) { super(value === undefined ? epoch : value); }
  static now() { return epoch; }
}
globalThis.Date = FixtureDate as DateConstructor;
appendFileSync(join(process.cwd(), "argv.jsonl"), JSON.stringify(process.argv.slice(2)) + "\n");
// The wall-clock filesystem is not virtualized by Date. Align only fixture
// mtimes at process exit, before the server receives its physical exit code;
// a July corpus must not acquire October silent edits from the host clock.
process.on("exit", () => {
  const journeys = join(process.cwd(), "journeys");
  for (const name of readdirSync(journeys)) utimesSync(join(journeys, name), new NativeDate(epoch), new NativeDate(epoch));
});
await import("../../../core/src/cli/brain.ts");
