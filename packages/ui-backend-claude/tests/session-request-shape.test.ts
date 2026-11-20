import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionPromptContextLocation } from "@schlessera/brain-ui-sdk/internal";
import { installTestHome } from "../../../scripts/test-home.js";
import { claudePromptContext } from "../src/prompt-context.js";
import { HOST_UNUSED_BUILTINS, retainSessionRequestShape } from "../src/session-request-shape.js";
let home: ReturnType<typeof installTestHome>, brain: string;
beforeEach(() => { home = installTestHome(); brain = mkdtempSync(join(tmpdir(), "ithaca-request-shape-")); });
afterEach(() => { rmSync(brain, { recursive: true, force: true }); home.dispose(); });
const legacy = ["AskUserQuestion"];
const current = [...legacy, ...HOST_UNUSED_BUILTINS];
function session() { const id = crypto.randomUUID(); claudePromptContext(brain, id).retainAppend("Odysseus checks Ithaca."); return id; }

test("new sessions persist their original native selection across subsequent upgrades", () => {
  const id = session();
  expect(retainSessionRequestShape(brain, id, false, current, legacy)).toEqual(current);
  expect(retainSessionRequestShape(brain, id, true, [...current, "Read"], legacy), "ORIGINAL_BUILTIN_SELECTION_RETAINED").toEqual(current);
});
test("a legacy session without a snapshot retains its pre-upgrade selection", () => {
  const id = session();
  expect(retainSessionRequestShape(brain, id, true, current, legacy), "LEGACY_BUILTIN_SELECTION_RETAINED").toEqual(legacy);
  expect(retainSessionRequestShape(brain, id, true, current, legacy)).toEqual(legacy);
});
test("one corrupt selection refuses only that session and leaves another usable", () => {
  const id = session(), other = session();
  const { dir, name } = sessionPromptContextLocation(process.env.CLAUDE_CONFIG_DIR!, brain, id);
  const path = join(dir, `${name}.claude-tools`);
  writeFileSync(path, '{"disallowedTools":"unknown"}');
  expect(() => retainSessionRequestShape(brain, id, true, current, legacy)).toThrow("Invalid saved Claude session request shape");
  expect(readFileSync(path, "utf8")).toBe('{"disallowedTools":"unknown"}');
  expect(retainSessionRequestShape(brain, other, false, current, legacy)).toEqual(current);
});
