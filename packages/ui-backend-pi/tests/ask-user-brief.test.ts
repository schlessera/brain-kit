import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_USER_TOOL_NAME } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";

import type { SessionCaps } from "../src/backend-options";
import { createBrainAccess } from "../src/brain-access";
import { createSessionResources } from "../src/session-resources";
import { PI_ASK_USER_TOOL_NAME, toolLockFromKeyed } from "../src/tools";

// The picker line of the ask-user brief, as a new session renders it and as a
// session started before #2800 retained it.
const FIXED_LINE = "call `ask_user` — it renders tappable";
const LEGACY_LINE = "call `inbox_list` — it renders tappable";
const caps: SessionCaps = { askUser: true, askUserList: false, askUserRank: false, location: false, activity: false, mask: false };
let root: string, brain: string;
const restore: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-ask-user-brief-"));
  brain = join(root, "ithaca"); mkdirSync(brain);
  for (const [key, value] of [["HOME", join(root, "home")], ["PI_CODING_AGENT_DIR", join(root, "agent")]] as const) {
    const previous = process.env[key];
    process.env[key] = value;
    restore.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
});
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  rmSync(root, { recursive: true, force: true });
});

/** The system-prompt append a Pi worker builds, and what it reports for the host to retain. */
async function sessionAppend(fixedAppend?: string): Promise<{ loaded: string[]; observed: string | undefined }> {
  let observed: string | undefined;
  const resources = createSessionResources({
    backend: { brainPath: brain, loadExtensions: false }, brain: createBrainAccess(brain),
    lock: toolLockFromKeyed(createKeyedLock()), allowedTools: new Set(), confirmPatterns: [], loadExtensions: false,
    ...(fixedAppend !== undefined ? { fixedAppend } : {}), observeAppend: append => { observed = append; },
  });
  const { loader } = await resources.build(resources.buildToolkit(caps), { caps });
  return { loaded: loader.getAppendSystemPrompt(), observed };
}

test("Pi names the ask-user tool from its contract, not a roster position (#2800)", () => {
  expect(PI_ASK_USER_TOOL_NAME, "PI_ASK_USER_TOOL_NAME").toBe(ASK_USER_TOOL_NAME);
  expect(PI_ASK_USER_TOOL_NAME).toBe("ask_user");
});

test("a new Pi session's brief names ask_user for the picker (#2800)", async () => {
  const { loaded, observed } = await sessionAppend();
  expect(loaded).toEqual([observed!]);
  expect(observed, "PI_NEW_SESSION_ASK_USER_LINE").toContain(FIXED_LINE);
  expect(observed, "PI_NEW_SESSION_NO_INBOX_PICKER").not.toContain(LEGACY_LINE);
});

test("an existing Pi session keeps its retained append byte for byte (#2800)", async () => {
  const fresh = (await sessionAppend()).observed!;
  const legacy = fresh.replace(FIXED_LINE, LEGACY_LINE);
  expect(legacy).not.toBe(fresh);
  const { loaded, observed } = await sessionAppend(legacy);
  expect(observed, "PI_RETAINED_APPEND_OBSERVED").toBe(legacy);
  expect(loaded, "PI_RETAINED_APPEND_LOADED").toEqual([legacy]);
});
