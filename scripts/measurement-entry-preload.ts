import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { installNetworkGuard } from "./test-network-guard";
import { enterMeasurement } from "./measurement-entry";

// Synchronous first-import admission: denial precedes sibling runtime imports.
let entry = "";
try {
  const source = realpathSync(process.argv[1]!);
  const name = basename(source);
  if (source === realpathSync(join(import.meta.dir, name))) entry = name;
} catch { /* Library/test imports retain offline admission. */ }
export const measurementAdmission = enterMeasurement({ entry, argv: process.argv.slice(2), liveEval: process.env.BRAIN_LIVE_EVAL },
  { installOffline: () => { installNetworkGuard(); }, warn: message => console.error(message) });
// Keep existing command parsers unchanged after the explicit flag is consumed.
export const measurementAuthorizationArgs = measurementAdmission === "live" && process.argv.includes("--allow-real-provider")
  ? ["--allow-real-provider"] : [];
if (measurementAuthorizationArgs.length) process.argv = process.argv.filter(arg => arg !== "--allow-real-provider");
