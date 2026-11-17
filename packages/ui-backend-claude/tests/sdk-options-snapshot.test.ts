import { expect, test } from "bun:test";

import expected from "./fixtures/sdk-options-snapshot.json" with { type: "json" };
import { SNAPSHOT_MODES, sdkOptionsSnapshot } from "./helpers/sdk-options-snapshot.js";

/**
 * #2519 splits `assembleClaudeSdkTurn` and `createPermissionWiring`. Neither
 * may change what the provider is sent: the fixture was captured from the tree
 * BEFORE that split (at epic/1342-turn-path-split 2efaf6c23), never computed by
 * the code under test. It was re-recorded once from the unsplit main tree
 * (418b037ae, after #3103 added the compute tools) when that landed, and the
 * split tree still matches it byte for byte. #3154 re-recorded it with this helper for one reviewed
 * change: `read_attachment` joins the stable roster of every mode, and nothing else moves.
 * #3580 re-records the fixed Apify roster with availability/approvals/revoke
 * and the reviewed Actor-approval guidance.
 * #3623 prepends the reviewed common brain-interaction brief in the four
 * interactive modes; all other options and autonomous modes stay byte-identical.
 * #3600 adds the safety result hook to PostToolUse and PostToolUseFailure in
 * those four modes; provider tools, prompts and autonomous modes stay unchanged.
 * #3624 re-records only the tool-description digest for approved Actor reuse
 * and the user-selected shortlist; tool names, allowlists and prompts stay fixed.
 * #3788 adds the ten in-worker `mcp__brain__brain_apify_*` names to every mode's
 * `disallowedTools`; nothing else moves.
 * #3797 adds the two host GitHub read tools to the four interactive modes'
 * stable roster (names and the schema digest); allowlists, prompts and
 * autonomous modes stay byte-identical.
 * #3798 adds the two host GitHub write tools after them, in the same four
 * modes (names and the schema digest); everything else stays byte-identical.
 * #3975 adds `request_image_markup` after the mask tool in those four modes'
 * stable roster (names, schema digest and its brief in the retained append);
 * allowlists and autonomous modes stay byte-identical.
 * #3799 inserts the host GitHub tools' bullet in the retained append of those
 * four modes, after the tool briefs; everything else stays byte-identical.
 * #3613 adds reference_read to the four interactive rosters and retained
 * briefs, and to the allowlist where reference access is available. The two
 * autonomous modes and all unrelated options remain byte-identical.
 * Regenerate it only for a reviewed, intended change to
 * the roster, allowlist or system prompt, and say so in the PR.
 */
for (const mode of SNAPSHOT_MODES) test(`the SDK options for a fixed ${mode} request are byte-identical to the captured tree`, async () => {
  const actual = await sdkOptionsSnapshot(mode);
  expect(JSON.stringify(actual, null, 2), `SDK_OPTIONS_DRIFT_${mode}`)
    .toBe(JSON.stringify((expected as Record<string, unknown>)[mode], null, 2));
});
