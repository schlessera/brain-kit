import { upstreamReportMain } from "../src/upstream-report.js";
process.exitCode = upstreamReportMain(process.argv.slice(2));
