/**
 * The fixed system append names the host GitHub tools (#3799), and a session
 * retained before it keeps its append byte for byte (provider history).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { INTERACTIVE_SESSION_CAPS } from "../src/backend-options";
import { createBrainAccess } from "../src/brain-access";
import { createSessionResources } from "../src/session-resources";
import { toolLockFromKeyed } from "../src/tools";

const LINE = "- **GitHub goes through the host tools.**";
let root: string, brain: string;
const restore: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-github-brief-"));
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

async function sessionAppend(fixedAppend?: string): Promise<{ loaded: string[]; observed: string | undefined }> {
  let observed: string | undefined;
  const caps = { ...INTERACTIVE_SESSION_CAPS };
  const resources = createSessionResources({
    backend: { brainPath: brain, loadExtensions: false }, brain: createBrainAccess(brain),
    lock: toolLockFromKeyed(createKeyedLock()), allowedTools: new Set(), confirmPatterns: [], loadExtensions: false,
    ...(fixedAppend !== undefined ? { fixedAppend } : {}), observeAppend: append => { observed = append; },
  });
  const { loader } = await resources.build(resources.buildToolkit(caps), { caps });
  return { loaded: loader.getAppendSystemPrompt(), observed };
}

test("a new Pi session's fixed append sends GitHub through the host tools under their bare names", async () => {
  const { loaded, observed } = await sessionAppend();
  expect(loaded).toEqual([observed!]);
  expect(observed, "PI_FIXED_APPEND_GITHUB_LINE").toContain(LINE);
  for (const name of ["brain_github_issue_read", "brain_github_issue_search", "brain_github_issue_create", "brain_github_issue_comment"])
    expect(observed, `PI_FIXED_APPEND_NAMES ${name}`).toContain(`\`${name}\``);
  expect(observed).not.toContain("mcp__brain-ui__brain_github");
});

test("a Pi session retained before the GitHub line keeps its append byte for byte", async () => {
  const fresh = (await sessionAppend()).observed!;
  // The line as a pre-#3799 session never had it: up to the next bullet or section.
  const start = fresh.indexOf(LINE);
  const end = Math.min(...["\n- ", "\n\n"].map(mark => fresh.indexOf(mark, start + 1)).filter(index => index > 0));
  const legacy = fresh.slice(0, start - 1) + fresh.slice(end);
  expect(legacy).not.toContain(LINE);
  const { loaded, observed } = await sessionAppend(legacy);
  expect(observed, "PI_RETAINED_APPEND_OBSERVED").toBe(legacy);
  expect(loaded, "PI_RETAINED_APPEND_LOADED").toEqual([legacy]);
});
