// Measurement only (#4116): N passes of the selected specs in one Vitest process.
// usage (cwd packages/ui-kit): node rerun.mjs <passes> --project=<p>... <filter>...
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { createVitest } = await import(pathToFileURL(resolve("../../node_modules/vitest/dist/node.js")).href);
process.env.VITEST ??= "true"; // the Storybook plugin registers its stories only under the Vitest CLI flag
const [passes, ...rest] = process.argv.slice(2);
const projects = rest.filter(a => a.startsWith("--project=")).map(a => a.slice(10));
const filters = rest.filter(a => !a.startsWith("--"));
const t0 = performance.now(); let last = t0;
const lap = label => { const now = performance.now(); console.log(`LAP ${label} +${((now - last) / 1000).toFixed(2)}s (at ${((now - t0) / 1000).toFixed(2)}s)`); last = now; };
const vitest = await createVitest("test", { watch: false, project: projects, browser: { fileParallelism: false } });
lap("created");
let failed = false;
await vitest.start(filters);
const failures = () => vitest.state.getCountOfFailedTests() + vitest.state.getFiles().filter(file => file.result?.state === "fail" && !file.tasks?.length).length;
failed ||= failures() > 0 || vitest.state.getFiles().length === 0;
lap(`pass1 failedTests=${failures()}`);
const specs = await vitest.globTestSpecifications(filters);
for (let pass = 2; pass <= Number(passes); pass++) {
  await vitest.rerunTestSpecifications(specs, true);
  failed ||= failures() > 0;
  lap(`pass${pass} failedTests=${failures()}`);
}
await vitest.close();
lap("closed");
console.log(`RESULT ${failed ? "failed" : "passed"} files=${specs.length}`);
process.exit(failed ? 1 : 0);
