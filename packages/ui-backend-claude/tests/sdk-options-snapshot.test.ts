import * as worker from "@schlessera/brain-ui-sdk/internal";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareClaudeTurnSandbox } from "../src/sdk-options.js";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { installTestHome } from "../../../scripts/test-home";

import expected from "./fixtures/sdk-options-snapshot.json" with { type: "json" };
import { SNAPSHOT_MODES, sdkOptionsSnapshot } from "./helpers/sdk-options-snapshot.js";

// Assembly persists prompt context. Each invocation owns its storage even
// when the shared preload has already cleaned up an earlier repetition (#4244).
let testHome: ReturnType<typeof installTestHome> | undefined;
beforeEach(() => { testHome = installTestHome(); });
afterEach(() => { testHome?.dispose(); testHome = undefined; });

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
 * #4307/#4308 re-record new hosted selections and the fixed batching brief.
 * Regenerate it only for a reviewed, intended change to
 * the roster, allowlist or system prompt, and say so in the PR.
 */
for (const mode of SNAPSHOT_MODES) test(`the SDK options for a fixed ${mode} request are byte-identical to the captured tree`, async () => {
  const actual = await sdkOptionsSnapshot(mode);
  expect(JSON.stringify(actual, null, 2), `SDK_OPTIONS_DRIFT_${mode}`)
    .toBe(JSON.stringify((expected as Record<string, unknown>)[mode], null, 2));
});


test("the real handoff preparation preserves its populated-workspace system prompt", async () => {
  const direct = await sdkOptionsSnapshot("autonomous-summary", { populatedWorkspace: true });
  const prepared = await sdkOptionsSnapshot("autonomous-summary", { populatedWorkspace: true, prepareSandbox: true });
  expect(JSON.stringify(prepared.systemPrompt), "HANDOFF_STILL_DESCRIBES_THE_LEGACY_WRITABLE_AREA").toContain("is writable: clone, fetch and commit");
  expect(JSON.stringify(prepared.systemPrompt)).not.toContain("code-changes switch");
  expect(prepared.systemPrompt, "HANDOFF_PREPARATION_DOES_NOT_CHANGE_SYSTEM_PROMPT").toEqual(direct.systemPrompt);
});


test("an interactive caller without a host switch prepares inspection, never writable code", async () => {
  const brain=mkdtempSync(join(tmpdir(),"odysseus-default-sandbox-"));mkdirSync(join(brain,"workspaces/ithaca"),{recursive:true});
  try {
    const own=await prepareClaudeTurnSandbox({backend:{brainPath:brain} as never,req:{prompt:"Read Ithaca source.",bridge:{emit(){}},signal:new AbortController().signal} as never,profile:{} as never,turnEnvironment:{}});
    expect(own!.workerSandbox.areas.find(area=>area.name==="workspaces")!.mount.writable,"HOSTLESS_CALLER_CANNOT_GRANT_CODE_WRITES").toBe(false);
    expect(own!.workerSandbox.codeChanges).toBe(false);
  }finally{rmSync(brain,{recursive:true,force:true});}
});


test("direct interactive assembly without a host grant describes inspection", async () => {
  const snapshot=await sdkOptionsSnapshot("hosted-typed",{populatedWorkspace:true,withoutHostSandbox:true});
  expect(JSON.stringify(snapshot.systemPrompt),"HOSTLESS_ASSEMBLY_HAS_NO_WRITABLE_WORKSPACE").not.toContain("is writable: clone, fetch and commit");
  expect(JSON.stringify(snapshot.contextTail)).toContain("code-changes switch");
  expect(JSON.stringify(snapshot.contextTail),"HOSTLESS_CONTEXT_USES_THE_READ_ONLY_MOUNT").not.toContain("is writable: clone, fetch and commit");
});


test("prepared handoff rendering never prepares the worker synchronously again",async()=>{
 const preparation=spyOn(worker,"prepareWorkerSandbox");
 try{const snapshot=await sdkOptionsSnapshot("autonomous-summary",{populatedWorkspace:true,prepareSandbox:true});expect(JSON.stringify(snapshot.systemPrompt)).toContain("is writable: clone, fetch and commit");expect(preparation,"HANDOFF_REUSES_THE_PREPARED_SANDBOX").not.toHaveBeenCalled();}finally{preparation.mockRestore();}
});


test("Claude handoff retains an actually refused legacy workspace qualification",async()=>{
 const snapshot=await sdkOptionsSnapshot("autonomous-summary",{populatedWorkspace:true,aliasWorkspace:true,prepareSandbox:true});
 expect(JSON.stringify(snapshot.systemPrompt),"HANDOFF_PRESERVES_LEGACY_ALIAS_REFUSAL").toContain("hard-linked to files outside workspaces/");expect(JSON.stringify(snapshot.systemPrompt)).not.toContain("is writable: clone, fetch and commit");
});
