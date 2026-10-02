import { join } from "node:path";
import { pathToFileURL } from "node:url";

const source = process.env.JOBS_FIXTURE_SOURCE ?? new URL("../../src/", import.meta.url).pathname;
const { runScrape } = await import(pathToFileURL(`${source}/scrape.ts`).href);
console.log(JSON.stringify(await runScrape({ dbPath: join(process.env.BRAIN_ROOT!, "direct.db") })));
