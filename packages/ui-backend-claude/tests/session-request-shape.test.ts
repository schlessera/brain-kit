import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  const assemble = (route: string, sessionId?: string, relay = true, inherited?: string, hosted = true, inventory: "core-only" | "module-tools" | "unavailable" = "core-only", diagnosticsThrow = false) => createClaudeSdkTurn({
    backend: { brainPath: brain }, brainBridgeInventory: inventory,
    req: { prompt: "Odysseus checks Ithaca.", sessionId, bridge: { emit() {} }, applicationAuthority: hosted ? "server" : undefined,
      signal: new AbortController().signal,
      workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] } } as never,
    profile: { id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: [], buildEnv: () => ({}) },
    turnEnvironment: { ANTHROPIC_BASE_URL: route, ENABLE_TOOL_SEARCH: inherited }, ...(relay ? { hostInference: { proxyDir: brain, placeholders: { ANTHROPIC_API_KEY: INFERENCE_PLACEHOLDER } } } : {}),
    abortController: new AbortController(), allowedTools: ["Read"], confirmPatterns: [],
    turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never, log() { if (diagnosticsThrow) throw new Error("The owner log is unavailable."); },
  });
  const gateway = assemble("https://gateway.example.com");
  const firstParty = assemble("https://api.anthropic.com");
  expect(firstParty.options.env!.ENABLE_TOOL_SEARCH, "FIRST_PARTY_BRIDGE_ENABLES_SEARCH").toBe("true");
  expect(firstParty.options.mcpServers!.brain?.type, "HOSTED_BRAIN_IS_IN_PROCESS").toBe("sdk");
  const enabledId = firstParty.options.sessionId!;
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
    for (const inventory of ["module-tools", "unavailable"] as const) {
      const fallback = assemble("https://api.anthropic.com", undefined, true, undefined, true, inventory);
      try {
        expect(fallback.options.mcpServers!.brain, "FALLBACK_RETAINS_ORIGINAL_STDIO_ENTRY").toBeUndefined();
        expect(fallback.options.env!.ENABLE_TOOL_SEARCH, "UNKNOWN_INVENTORY_IS_NEVER_CORE_ONLY").toBe("false");
      } finally { await fallback.finishWorker(); }
    }
    let observerFailure: ReturnType<typeof assemble> | undefined;
    expect(() => { observerFailure = assemble("https://api.anthropic.com", undefined, true, undefined, true, "unavailable", true); },
      "OWNER_DIAGNOSTICS_CANNOT_DISABLE_STDIO_FALLBACK").not.toThrow();
    try { expect(observerFailure!.options.env!.ENABLE_TOOL_SEARCH).toBe("false"); }
    finally { await observerFailure?.finishWorker(); }
    const previous = assemble("https://api.anthropic.com");
    const previousId = previous.options.sessionId!;
    await previous.finishWorker();
    const previousState = JSON.parse(readFileSync(path(previousId), "utf8"));
    previousState.claudeRequestShape.version = 4;
    delete previousState.claudeRequestShape.brainBridge;
    previousState.claudeRequestShape.toolSearch = "false";
    previousState.claudeRequestShape.selectionDigest = selectionDigest(previousState.claudeRequestShape.disallowedTools, "false");
    writeFileSync(path(previousId), JSON.stringify(previousState));
    const previousResume = assemble("https://api.anthropic.com", previousId);
    try {
      expect(previousResume.options.mcpServers!.brain, "V4_SESSION_KEEPS_PROJECT_STDIO").toBeUndefined();
      expect(previousResume.options.env!.ENABLE_TOOL_SEARCH, "V4_SESSION_KEEPS_SEARCH_OFF").toBe("false");
    } finally { await previousResume.finishWorker(); }
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
    expect(() => assemble("https://api.anthropic.com", unhostedId, false), "INCOMPATIBLE_MANDATORY_EXCLUSIONS_REFUSE").toThrow("session_roster_incompatible");
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


test("migration refuses before an encoded snapshot would cross its read limit", () => {
  const id = session(), limit = 64 * 1024 * 1024;
  const state = { append: "Odysseus retains the original brief.", delivered: {}, turns: {}, padding: "" };
  const empty = Buffer.byteLength(JSON.stringify(state));
  // Multi-byte padding makes a character-count-only bound insufficient.
  state.padding = "\u03bb".repeat(Math.floor((limit - 96 - empty) / 2));
  const before = JSON.stringify(state);
  expect(Buffer.byteLength(before)).toBeLessThan(limit);
  writeFileSync(path(id), before);
  expect(() => retain(id, true), "MIGRATION_NEVER_WRITES_AN_UNREADABLE_CONTEXT").toThrow("storage limit");
  expect(readFileSync(path(id), "utf8")).toBe(before);
});


test("the bridge marker is retained and included in the session selection digest", () => {
  const id = session();
  const saved = retainSessionRequestShape(brain, id, false, current, legacy, undefined, "true", 1);
  expect(saved).toMatchObject({ version: 5, brainBridge: 1, toolSearch: "true" });
  expect(retain(id, true), "BRIDGE_PATH_SURVIVES_LATER_DEFAULTS").toEqual(saved);
  const state = JSON.parse(readFileSync(path(id), "utf8"));
  delete state.claudeRequestShape.brainBridge;
  const before = JSON.stringify(state); writeFileSync(path(id), before);
  expect(() => retain(id, true), "LOST_BRIDGE_MARKER_IS_NOT_STDIO").toThrow("Invalid saved Claude session request shape");
  expect(readFileSync(path(id), "utf8")).toBe(before);
});

test("a context file written before the owner accessor reads back as the same shape, byte-identically (#4826)", () => {
  const id = session();
  // Captured from the tree before #4826: retainAppend, then a new session's shape with tool search "false".
  const bytes = '{"delivered":{},"turns":{},"append":"Odysseus checks Ithaca.","claudeRequestShapeInitialized":true,"claudeRequestShape":{"version":4,"selectionDigest":"af84139a9c488614cdff468b92d18f1209bc305c1164aec26fcc8e5b61970312","disallowedTools":["AskUserQuestion","mcp__brain__brain_add","mcp__brain__brain_update","mcp__brain__brain_archive","CronCreate","CronDelete","CronList","ScheduleWakeup","RemoteTrigger","SendMessage","ListAgents"],"toolSearch":"false"}}';
  writeFileSync(path(id), bytes);
  expect(retain(id, true)).toEqual({ version: 4, selectionDigest: selectionDigest(current, "false"), disallowedTools: current, toolSearch: "false" });
  expect(readFileSync(path(id), "utf8"), "SAVED_SHAPE_BYTES_UNCHANGED").toBe(bytes);
  const store = claudePromptContext(brain, id), sent = store.prepare("Penelope checks Ithaca.", { device: "tablet" });
  store.acknowledge(sent.id);
  const shapeKeys = (text: string) => { const state = JSON.parse(text); return JSON.stringify([state.claudeRequestShapeInitialized, state.claudeRequestShape]); };
  expect(shapeKeys(readFileSync(path(id), "utf8")), "SHAPE_KEYS_BYTE_IDENTICAL_AFTER_WRITES").toBe(shapeKeys(bytes));
});

test("missing, append-less, aliased and oversized contexts refuse without writing (#4826)", () => {
  const missing = crypto.randomUUID();
  expect(() => retain(missing)).toThrow();
  expect(() => readFileSync(path(missing)), "MISSING_CONTEXT_NOT_CREATED").toThrow();
  const bare = session(), bareBytes = JSON.stringify({ delivered: {}, turns: {} });
  writeFileSync(path(bare), bareBytes);
  expect(() => retain(bare)).toThrow();
  expect(readFileSync(path(bare), "utf8"), "APPEND_LESS_CONTEXT_UNCHANGED").toBe(bareBytes);
  const aliased = session(), dir = dirname(path(aliased)), real = `${dir}.real`;
  renameSync(dir, real); symlinkSync(real, dir);
  const aliasedBytes = readFileSync(path(aliased), "utf8");
  expect(() => retain(aliased), "DIRECTORY_ALIAS_REFUSED").toThrow("directory aliases");
  expect(readFileSync(path(aliased), "utf8")).toBe(aliasedBytes);
  rmSync(dir); renameSync(real, dir);
  const large = session();
  writeFileSync(path(large), Buffer.alloc(64 * 1024 * 1024 + 1, 0x20));
  expect(() => retain(large), "OVERSIZED_CONTEXT_REFUSED").toThrow();
  expect(lstatSync(path(large)).size).toBe(64 * 1024 * 1024 + 1);
});
