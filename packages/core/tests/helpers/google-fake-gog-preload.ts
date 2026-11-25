/**
 * Loaded first by a `brain` child a CLI contract test starts (`runCli(…, {
 * preload })`): it hands `brain google` the test's fake gog through the
 * command's own seam (`googleCommandDeps.binary`), never through anything
 * production reads, and registers the fake with this child's offline guard,
 * which refuses every gog it did not register. The fake's path comes from
 * `BRAIN_TEST_FAKE_GOG`, which only this test file reads; without it the
 * child runs exactly as production would.
 */
import { registerFakeGog } from "../../../../scripts/test-network-guard";
import { googleCommandDeps } from "../../src/cli/commands/google.ts";

const path = process.env.BRAIN_TEST_FAKE_GOG;
if (path) {
  registerFakeGog(path);
  googleCommandDeps.binary = { kind: "fake", path };
}
