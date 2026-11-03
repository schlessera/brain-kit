import { expect, test } from "bun:test";

import expected from "./fixtures/sdk-options-snapshot.json" with { type: "json" };
import { SNAPSHOT_MODES, sdkOptionsSnapshot } from "./helpers/sdk-options-snapshot.js";

/**
 * #2519 splits `assembleClaudeSdkTurn` and `createPermissionWiring`. Neither
 * may change what the provider is sent: the fixture was captured from the tree
 * BEFORE that split (at epic/1342-turn-path-split 2efaf6c23), never computed by
 * the code under test. Regenerate it only for a reviewed, intended change to
 * the roster, allowlist or system prompt, and say so in the PR.
 */
for (const mode of SNAPSHOT_MODES) test(`the SDK options for a fixed ${mode} request are byte-identical to the captured tree`, async () => {
  const actual = await sdkOptionsSnapshot(mode);
  expect(JSON.stringify(actual, null, 2), `SDK_OPTIONS_DRIFT_${mode}`)
    .toBe(JSON.stringify((expected as Record<string, unknown>)[mode], null, 2));
});
