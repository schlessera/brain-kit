import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { INFERENCE_PLACEHOLDER, sessionPromptContextLocation } from "@schlessera/brain-ui-sdk/internal";
import { installTestHome } from "../../../scripts/test-home.js";
import { createClaudeSdkTurn } from "../src/sdk-options.js";
import { claudePromptContext } from "../src/prompt-context.js";
import { HOST_UNUSED_BUILTINS, retainSessionRequestShape, type ClaudeSessionRequestShape } from "../src/session-request-shape.js";
let home: ReturnType<typeof installTestHome>, brain: string;
beforeEach(() => { home = installTestHome(); brain = mkdtempSync(join(tmpdir(), "ithaca-request-shape-")); });
afterEach(() => { rmSync(brain, { recursive: true, force: true }); home.dispose(); });
const legacy = ["AskUserQuestion", "mcp__brain__brain_add", "mcp__brain__brain_update", "mcp__brain__brain_archive"];
const current = [...legacy, ...HOST_UNUSED_BUILTINS];
const selectionDigest = (tools: string[], toolSearch: string | null) => createHash("sha256").update(JSON.stringify({ version: 4, disallowedTools: tools, toolSearch })).digest("hex");
const expected = { version: 4, selectionDigest: selectionDigest(current, "true"), disallowedTools: current, toolSearch: "true" } satisfies ClaudeSessionRequestShape;
function session() { const id = crypto.randomUUID(); claudePromptContext(brain, id).retainAppend("Odysseus checks Ithaca."); return id; }
function path(id: string) { const { dir, name } = sessionPromptContextLocation(process.env.CLAUDE_CONFIG_DIR!, brain, id); return join(dir, name); }
const retain = (id: string, resumed = false, candidate = current) => retainSessionRequestShape(brain, id, resumed, candidate, legacy, undefined, "true");

test("new sessions retain the exact native selection and tool-search pin across upgrades", () => {
  const id = session();
  expect(retain(id)).toEqual(expected);
  expect(retain(id, true, [...current, "Read"]), "ORIGINAL_BUILTIN_SELECTION_RETAINED").toEqual(expected);
});
test("a genuine legacy prompt snapshot gains the exact legacy roster and no new SDK pin", () => {
  const id = session(), before = readFileSync(path(id), "utf8");
  expect(before).not.toContain("claudeRequestShape");
  expect(retain(id, true), "LEGACY_BUILTIN_SELECTION_RETAINED").toEqual({ version: 4, selectionDigest: selectionDigest(legacy, null), disallowedTools: legacy, toolSearch: null });
});
test("empty, arbitrary and incomplete snapshots cannot drop mandatory exclusions", () => {
  const other = session();
  for (const bad of [[], ["NeverConfigured"], current.filter(name => name !== "mcp__brain__brain_add"), current.filter(name => name !== "SendMessage"), [...current, "NeverConfigured"], [...current, current[0]!]]) {
    const id = session(); retain(id);
    const state = JSON.parse(readFileSync(path(id), "utf8"));
    state.claudeRequestShape.disallowedTools = bad;
    const bytes = JSON.stringify(state); writeFileSync(path(id), bytes);
    expect(() => retain(id, true), "INVALID_SELECTION_NEVER_REPLACES_MANDATORY_EXCLUSIONS").toThrow("Invalid saved Claude session request shape");
    expect(readFileSync(path(id), "utf8")).toBe(bytes);
  }
  expect(retain(other)).toEqual(expected);
});
test("lost post-upgrade selection is refused, not reclassified as legacy", () => {
  const id = session(); retain(id);
  const state = JSON.parse(readFileSync(path(id), "utf8"));
  delete state.claudeRequestShape;
  writeFileSync(path(id), JSON.stringify(state));
  expect(() => retain(id, true), "LOST_SELECTION_IS_NOT_LEGACY").toThrow("Invalid saved Claude session request shape");
});
test("ordinary prompt-context writes preserve selection and the initialized marker atomically", () => {
  const id = session(); retain(id);
  const store = claudePromptContext(brain, id), message = store.prepare("Penelope checks Ithaca.", { device: "tablet" });
  store.acknowledge(message.id);
  expect(message.text).not.toContain("claudeRequestShape");
  expect(retain(id, true)).toEqual(expected);
  expect(JSON.parse(readFileSync(path(id), "utf8")).claudeRequestShapeInitialized).toBe(true);
});
test("a dangling context alias is refused rather than replaced with a legacy roster", () => {
  const id = session();
  rmSync(path(id)); symlinkSync(join(brain, "missing-selection.json"), path(id));
  expect(() => retain(id, true)).toThrow();
  expect(lstatSync(path(id)).isSymbolicLink()).toBe(true);
});

test("production assembly retains a gateway pin and confines a changed-upstream refusal to its session", async () => {
  const assemble = (route: string, sessionId?: string, relay = true, inherited?: string, hosted = true) => createClaudeSdkTurn({
    backend: { brainPath: brain },
    req: { prompt: "Odysseus checks Ithaca.", sessionId, bridge: { emit() {} }, applicationAuthority: hosted ? "server" : undefined,
      signal: new AbortController().signal,
      workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] } } as never,
    profile: { id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: [], buildEnv: () => ({}) },
    turnEnvironment: { ANTHROPIC_BASE_URL: route, ENABLE_TOOL_SEARCH: inherited }, ...(relay ? { hostInference: { proxyDir: brain, placeholders: { ANTHROPIC_API_KEY: INFERENCE_PLACEHOLDER } } } : {}),
    abortController: new AbortController(), allowedTools: ["Read"], confirmPatterns: [],
    turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never, log() {},
  });
  const gateway = assemble("https://gateway.example.com");
  const enabledId = session(); retain(enabledId);
  const firstParty = assemble("https://api.anthropic.com");
  try {
    const resumed = assemble("https://api.anthropic.com", gateway.options.sessionId!);
    try {
      expect(resumed.options.env!.ENABLE_TOOL_SEARCH).toBe("false");
      expect((resumed.options.settings as any).env.ENABLE_TOOL_SEARCH).toBe("false");
    } finally { await resumed.finishWorker(); }
    expect(() => assemble("https://gateway.example.com", enabledId, false), "QUALIFIED_UPSTREAM_REQUIRED_ON_RESUME").toThrow("requires its qualified first-party inference upstream");
    const direct = assemble("https://gateway.example.com", gateway.options.sessionId!, false);
    try { expect(direct.options.env!.ENABLE_TOOL_SEARCH).toBe("false"); expect((direct.options.settings as any).env.ENABLE_TOOL_SEARCH).toBe("false"); }
    finally { await direct.finishWorker(); }
    const legacyId = session();
    const legacyTurn = assemble("https://api.anthropic.com", legacyId, true, "true");
    try { expect(legacyTurn.options.env!.ENABLE_TOOL_SEARCH, "INHERITED_LEGACY_SELECTION_PRESERVED").toBe("true"); expect((legacyTurn.options.settings as any).env.ENABLE_TOOL_SEARCH).toBeUndefined(); }
    finally { await legacyTurn.finishWorker(); }
    const drift = assemble("https://api.anthropic.com", legacyId, true, "false");
    try { expect(drift.options.env!.ENABLE_TOOL_SEARCH, "UNKNOWN_LEGACY_ENV_KEEPS_CURRENT_BEHAVIOR").toBe("false"); }
    finally { await drift.finishWorker(); }
    const absentId = session();
    const absent = assemble("https://api.anthropic.com", absentId);
    await absent.finishWorker();
    const laterEnv = assemble("https://api.anthropic.com", absentId, true, "true");
    try { expect(laterEnv.options.env!.ENABLE_TOOL_SEARCH, "UNKNOWN_LEGACY_ENV_IS_NOT_SNAPSHOTTED").toBe("true"); }
    finally { await laterEnv.finishWorker(); }
    const missingId = firstParty.options.sessionId!;
    rmSync(path(missingId));
    expect(() => assemble("https://api.anthropic.com", missingId), "MISSING_WHOLE_CONTEXT_IS_NOT_LEGACY").toThrow("prompt context is missing");
    expect(() => readFileSync(path(missingId))).toThrow();
    const unhosted = assemble("https://api.anthropic.com", undefined, false, undefined, false);
    const unhostedId = unhosted.options.sessionId!;
    await unhosted.finishWorker();
    const savedRoster = JSON.parse(readFileSync(path(unhostedId), "utf8")).claudeRequestShape.disallowedTools;
    expect(savedRoster).not.toContain("mcp__brain__brain_add");
    const hosted = assemble("https://api.anthropic.com", unhostedId, false);
    try { for (const name of ["brain_add", "brain_update", "brain_archive"]) expect(hosted.options.disallowedTools, "CURRENT_MANDATORY_EXCLUSIONS_ALWAYS_APPLY").toContain(`mcp__brain__${name}`); }
    finally { await hosted.finishWorker(); }
    expect(JSON.parse(readFileSync(path(unhostedId), "utf8")).claudeRequestShape.disallowedTools).toEqual(savedRoster);
    const corrupt = assemble("https://api.anthropic.com");
    const corruptId = corrupt.options.sessionId!; await corrupt.finishWorker();
    const corruptState = JSON.parse(readFileSync(path(corruptId), "utf8"));
    corruptState.claudeRequestShape.selectionDigest = "invalid";
    const corruptBytes = JSON.stringify(corruptState); writeFileSync(path(corruptId), corruptBytes);
    for (let retry = 0; retry < 2; retry++) {
      expect(() => assemble("https://api.anthropic.com", corruptId)).toThrow("Invalid saved Claude session request shape");
      expect(readFileSync(path(corruptId), "utf8"), "REFUSED_RETRY_NEVER_PERSISTS_PROMPT").toBe(corruptBytes);
    }
    const other = assemble("https://gateway.example.com");
    try { expect(other.options.env!.ENABLE_TOOL_SEARCH).toBe("false"); }
    finally { await other.finishWorker(); }
  } finally { await gateway.finishWorker(); await firstParty.finishWorker(); }
});

test("a later release's removal list cannot invalidate a recorded roster", () => {
  const id = session(), future = [...current, "FutureBuiltIn"];
  const recorded = retain(id, false, future);
  expect(retain(id, true, legacy), "RECORDED_ROSTER_SURVIVES_REMOVAL_LIST_CHANGE").toEqual(recorded);
});


test("the retained digest covers the tool-search pin, including a forged legacy null", () => {
  const id = session(); retainSessionRequestShape(brain, id, false, current, legacy, undefined, "false");
  const state = JSON.parse(readFileSync(path(id), "utf8"));
  state.claudeRequestShape.toolSearch = null;
  writeFileSync(path(id), JSON.stringify(state));
  expect(() => retain(id, true), "TOOL_SEARCH_PIN_IS_DIGESTED").toThrow("Invalid saved Claude session request shape");
});
