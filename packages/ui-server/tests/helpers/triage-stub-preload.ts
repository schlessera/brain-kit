/**
 * Preload for the triage exit-code test. Resolves run.ts's `./providers.js`
 * to the stub next to this file, so the runner executes unchanged — roster
 * loop, scorer, persistence, exit code — with no provider behind it. Every
 * other import resolves normally.
 *
 *   bun --preload tests/helpers/triage-stub-preload.ts evals/triage/run.ts
 */
import { plugin } from "bun";

const STUB = new URL("./triage-stub-providers.ts", import.meta.url).pathname;

plugin({
  name: "triage-stub-providers",
  setup(build) {
    build.onResolve({ filter: /^\.\/providers\.js$/ }, (args) =>
      args.importer.endsWith("/evals/triage/run.ts") ? { path: STUB } : undefined
    );
  },
});
