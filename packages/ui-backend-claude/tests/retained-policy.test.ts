import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { INFERENCE_PLACEHOLDER, sessionPromptContextLocation } from "@schlessera/brain-ui-sdk/internal";
import { serverErrorSchema } from "@schlessera/brain-ui-sdk/schemas";
import { installTestHome } from "../../../scripts/test-home.js";
import { createClaudeSdkTurn } from "../src/sdk-options.js";
import { claudePromptContext, claudePromptContextProvenanceLocation } from "../src/prompt-context.js";
import { gatedPrompt, promptGateCheck } from "../src/turn-prompt-gate.js";
import { TurnFrames, TurnTerminal, thrownTurnFailure } from "../src/turn-terminal.js";
let home: ReturnType<typeof installTestHome>, brain: string;
beforeEach(() => { home = installTestHome(); brain = mkdtempSync(join(tmpdir(), "ithaca-retained-policy-")); });
afterEach(() => { rmSync(brain, { recursive: true, force: true }); home.dispose(); });
const saved = (id: string) => { const { dir, name } = sessionPromptContextLocation(process.env.CLAUDE_CONFIG_DIR!, brain, id); return readFileSync(join(dir, name), "utf8"); };
function assemble(sessionId?: string, inherited?: string, credential = false, hosted = true) {
  return createClaudeSdkTurn({ backend: { brainPath: brain },
    req: { prompt: "Odysseus checks Ithaca.", sessionId, bridge: { emit() {} }, applicationAuthority: hosted ? "server" : undefined, signal: new AbortController().signal,
      workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] } } as never,
    profile: { id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: credential ? ["ENABLE_TOOL_SEARCH"] : [], buildEnv: () => ({}) },
    turnEnvironment: { ENABLE_TOOL_SEARCH: inherited }, hostInference: { proxyDir: brain, placeholders: { ANTHROPIC_API_KEY: INFERENCE_PLACEHOLDER } },
    abortController: new AbortController(), allowedTools: ["Read"], confirmPatterns: [],
    turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never, log() {},
  });
}
function gate(turn: ReturnType<typeof assemble>, effective: string | undefined, rejected = false) {
  const abortController = new AbortController(), events: unknown[] = [];
  const terminal = new TurnTerminal({ frames: new TurnFrames({ emit() {}, async requestPermission() { return { behavior: "deny", message: "Qualification never approves a tool." }; } }, null), hostSignal: new AbortController().signal,
    abortController, startedAt: Date.now(), pendingFailure: () => null });
  const query = { getSettings: async () => { if (rejected) throw new Error("Offline settings control request rejected"); return { effective: { env: { ENABLE_TOOL_SEARCH: effective } }, sources: [] }; } } as never;
  const check = promptGateCheck({ queryHandle: Promise.resolve(query), initialize: async () => ({ account: {} }) as never,
    sdkTurn: turn, relay: undefined, terminal, runtimeRequirements: [], phase: "fixture", abortController, profileId: "fixture", log() {},
    reportActivity: event => events.push(event), reportRuntime() {} });
  return { terminal, events, prompt: gatedPrompt(turn.prompt, check) };
}
test("a legacy selection records unknown origin and keeps the current unpinned environment behavior", async () => {
  const id = crypto.randomUUID(); claudePromptContext(brain, id).retainAppend("Odysseus retains the original brief.");
  for (const value of ["false", "true", undefined]) {
    const turn = assemble(id, value);
    try {
      expect(turn.options.env!.ENABLE_TOOL_SEARCH, "LEGACY_CURRENT_FILTERED_BEHAVIOR").toBe(value);
      expect((turn.options.settings as any).env.ENABLE_TOOL_SEARCH).toBeUndefined();
      const shape = JSON.parse(saved(id)).claudeRequestShape;
      expect(shape.toolSearch).toBeNull();
      expect(shape, "LEGACY_ORIGINAL_ENV_IS_UNKNOWN").not.toHaveProperty("inheritedToolSearch");
    } finally { await turn.finishWorker(); }
  }
});
test("a credential-named legacy environment variable is neither stored nor restored past relay filtering", async () => {
  const id = crypto.randomUUID(), secret = "offline-odysseus-relay-credential";
  claudePromptContext(brain, id).retainAppend("Odysseus retains the original brief.");
  const turn = assemble(id, secret, true);
  try {
    expect(saved(id), "WITHHELD_CREDENTIAL_NEVER_PERSISTED").not.toContain(secret);
    expect(turn.options.env!.ENABLE_TOOL_SEARCH, "WITHHELD_CREDENTIAL_NEVER_FORWARDED").toBeUndefined();
    expect(JSON.stringify(turn.options.settings)).not.toContain(secret);
  } finally { await turn.finishWorker(); }
});
test("settings refusals leave the saved prompt unchanged and correction recovers without pending growth", async () => {
  const first = assemble(), id = first.options.sessionId!;
  await first.finishWorker();
  const original = saved(id), count = Object.keys(JSON.parse(original).turns).length;
  for (let retry = 0; retry < 2; retry++) {
    const turn = assemble(id);
    try {
      const { prompt } = gate(turn, "true");
      expect(await Array.fromAsync(prompt)).toEqual([]);
      expect(saved(id), "SETTINGS_REFUSAL_NEVER_PERSISTS_PROMPT").toBe(original);
    } finally { await turn.finishWorker(); }
  }
  const restored = assemble(id);
  try {
    expect(await Array.fromAsync(gate(restored, "false").prompt)).toHaveLength(1);
    expect(Object.keys(JSON.parse(saved(id)).turns), "CORRECTED_SETTINGS_PERSIST_ONE_RELEASED_PROMPT").toHaveLength(count + 1);
  } finally { await restored.finishWorker(); }
});
test("settings conflicts have their own failure class and emit no subscription-auth failure", async () => {
  const turn = assemble();
  try {
    const { prompt, terminal, events } = gate(turn, "true");
    expect(await Array.fromAsync(prompt)).toEqual([]);
    expect(terminal.refused?.failure?.errorClass, "SETTINGS_CONFLICT_IS_NOT_AUTH_FAILURE").toBe("settings_conflict");
    expect(events, "SETTINGS_CONFLICT_HAS_NO_LOGIN_ACTION").not.toContainEqual(expect.objectContaining({ kind: "auth_failure" }));
    // This schema predates the change: error code and failure class are strings,
    // not closed enums. No new required field or event kind is introduced.
    const parsed = serverErrorSchema.parse({ type: "error", ...terminal.refused });
    expect(parsed.failure?.errorClass).toBe("settings_conflict");
    expect(parsed.failure?.authAction).toBeUndefined();
  } finally { await turn.finishWorker(); }
});


test("a pre-snapshot native session migrates, but losing its now-required append refuses", async () => {
  const id = crypto.randomUUID();
  let migrated: ReturnType<typeof assemble> | undefined;
  expect(() => { migrated = assemble(id); }, "NEVER_SNAPSHOTTED_SESSION_CAN_RESUME").not.toThrow();
  try {
    expect(migrated!.options.resume).toBe(id);
    expect(migrated!.options.env!.ENABLE_TOOL_SEARCH).toBeUndefined();
    expect(JSON.parse(saved(id)).claudeRequestShape.toolSearch).toBeNull();
  } finally { await migrated!.finishWorker(); }
  const location = sessionPromptContextLocation(process.env.CLAUDE_CONFIG_DIR!, brain, id);
  rmSync(join(location.dir, location.name));
  expect(() => assemble(id), "KNOWN_LOST_SNAPSHOT_IS_NOT_LEGACY").toThrow("prompt context is missing");
});
test("incompatible authority refuses resume without changing its saved or provider roster", async () => {
  const direct = assemble(undefined, undefined, false, false), id = direct.options.sessionId!;
  const roster = direct.options.disallowedTools, original = saved(id);
  await direct.finishWorker();
  let caught: unknown;
  expect(() => { try { assemble(id); } catch (error) { caught = error; throw error; } }, "AUTHORITY_CHANGE_REFUSES_INSTEAD_OF_REWRITING_TOOLS").toThrow("session_roster_incompatible");
  const refusal = thrownTurnFailure(caught).refusal;
  expect(refusal?.failure?.errorClass).toBe("session_roster_incompatible");
  expect(serverErrorSchema.parse({ type: "error", ...refusal }).failure?.errorClass).toBe("session_roster_incompatible");
  expect(saved(id)).toBe(original);
  const resumed = assemble(id, undefined, false, false);
  try { expect(resumed.options.disallowedTools).toEqual(roster); }
  finally { await resumed.finishWorker(); }
});
test("a rejected native settings control request has the named unreadable-setting refusal", async () => {
  const turn = assemble(), original = saved(turn.options.sessionId!);
  try {
    const { terminal, prompt, events } = gate(turn, "false", true);
    expect(await Array.fromAsync(prompt)).toEqual([]);
    expect(terminal.refused?.failure?.errorClass, "REJECTED_SETTINGS_IS_NOT_AN_INIT_FAILURE").toBe("settings_conflict");
    expect(terminal.refused?.message).not.toContain("Install/select");
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "auth_failure" }));
    expect(saved(turn.options.sessionId!)).toBe(original);
  } finally { await turn.finishWorker(); }
});


test("malformed provenance never becomes a never-snapshotted legacy session", async () => {
  const first = assemble(), id = first.options.sessionId!; await first.finishWorker();
  const location = sessionPromptContextLocation(process.env.CLAUDE_CONFIG_DIR!, brain, id);
  const provenance = claudePromptContextProvenanceLocation(brain, id);
  rmSync(join(location.dir, location.name));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(provenance.dir, provenance.name), "invalid");
  expect(() => { assemble(id); }, "BAD_PROVENANCE_IS_NOT_LEGACY").toThrow("provenance");
  const other = assemble(); await other.finishWorker();
});
