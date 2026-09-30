import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@schlessera/brain-ui-sdk/server";
import * as claude from "@schlessera/brain-backend-claude";
import * as pi from "@schlessera/brain-backend-pi";
import type { AgentBackend, BackendBridge, PermissionDecision, PermissionRequest, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const permissionExports = ["decideToolPermission", "createToolPermissionRequest", "requestToolPermission", "checkEditedApproval", "compileConfirmPatterns"] as const;
test("ordinary entry points expose the toolkit and exclude bundled implementation policies", () => {
  for (const name of permissionExports) expect(typeof sdk[name], name).toBe("function");
  for (const name of ["DEFAULT_CONFIRM_BASH_PATTERNS", "ARCHIVING_UPDATE_REASON", "archivesDocument", "bashCommand", "SUBPROCESS_ENV", "filterSubprocessEnv", "parseSubprocessEnvExtra"]) {
    expect(Object.hasOwn(sdk, name), `SDK exposes internal ${name}`).toBe(false);
  }
  expect(typeof claude.createClaudeBackend).toBe("function");
  expect(Object.hasOwn(claude, "VOICE_ALLOWED_TOOLS")).toBe(false);
  expect(Object.hasOwn(claude, "DEFAULT_CONFIRM_BASH_PATTERNS")).toBe(false);
  expect(typeof pi.createPiBackend).toBe("function");
  expect(Object.hasOwn(pi, "DEFAULT_PI_ALLOWED_TOOLS")).toBe(false);
  expect(Object.hasOwn(pi, "TOOL_RISK")).toBe(false);
});

/** A third-party-style backend: the runtime proposes one write; only the SDK toolkit gates dispatch. */
function scriptedBackend(root: string, toolName: string, input: Record<string, unknown>): AgentBackend {
  const patterns = sdk.compileConfirmPatterns([{ pattern: "^erase ", effect: "erase a document" }], () => {});
  const allowedTools = new Set(["shell"]);
  return {
    id: "scripted",
    capabilities: { resume: false, permissions: true, thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: false, followUp: false },
    listProfiles: () => [], listSessions: async () => [], getHistory: async () => [],
    async startTurn(req: StartTurnRequest) {
      sdk.assertTurnPosture(req);
      const options = { toolName, shellToolName: "shell", updateToolName: "update", input, allowedTools, confirmPatterns: patterns };
      const approval = sdk.decideToolPermission(options);
      let effectiveInput = input;
      if (approval) {
        const request = sdk.createToolPermissionRequest({ toolUseId: "call-1", toolName, input, description: approval.reason, approval, outsideEnforcedAllowlist: req.enforceAllowedTools && !allowedTools.has(toolName) });
        const decision = await sdk.requestToolPermission(req.bridge, request, { noGrantSurface: req.noGrantSurface });
        if (decision.behavior === "deny") return;
        if (decision.updatedInput !== undefined) {
          const rejection = sdk.checkEditedApproval({ ...options, originalInput: input, editedInput: decision.updatedInput });
          if (rejection) return;
          effectiveInput = decision.updatedInput;
        }
      }
      writeFileSync(join(root, "executed.json"), JSON.stringify(effectiveInput));
    },
  };
}
function fixture(decision: PermissionDecision) {
  const root = mkdtempSync(join(tmpdir(), "backend-toolkit-")); roots.push(root);
  const requests: PermissionRequest[] = [];
  const bridge: BackendBridge = { emit: () => {}, requestPermission: async request => { requests.push(request); return decision; } };
  const run = async (tool: string, input: Record<string, unknown>, posture: Partial<StartTurnRequest> = {}) => {
    await scriptedBackend(root, tool, input).startTurn({ prompt: "scripted write", signal: new AbortController().signal, bridge, ...posture });
  };
  return { root, requests, run, executed: () => existsSync(join(root, "executed.json")) };
}

test("a host denial reaches the backend without executing the proposed mutation", async () => {
  const f = fixture({ behavior: "deny", message: "Denied by host." });
  await f.run("write", { path: "note.md", text: "changed" });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({ toolUseId: "call-1", toolName: "write", kind: "tool", input: { path: "note.md", text: "changed" } });
  expect(f.executed(), "denied tool wrote its dispatch receipt").toBe(false);
});

test.each([
  ["write", { path: "note.md" }],
  ["shell", { command: "erase note.md" }],
] as const)("a no-grant turn refuses %s before dispatch", async (tool, input) => {
  const f = fixture({ behavior: "allow" });
  await f.run(tool, input, { enforceAllowedTools: true, noGrantSurface: true });
  expect(f.executed(), `${tool} ran without a grant surface`).toBe(false);
  expect(f.requests).toHaveLength(0);
});

test("an edited approval cannot authorize a different destructive command", async () => {
  const f = fixture({ behavior: "allow", updatedInput: { command: "erase other.md" } });
  await f.run("shell", { command: "erase note.md" });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.kind).toBe("command");
  expect(f.requests[0]?.input.command).toBe("erase note.md");
  expect(f.executed(), "unconfirmed edited command wrote its dispatch receipt").toBe(false);
});

test("safe edits execute the snapshotted input once", async () => {
  const f = fixture({ behavior: "allow", updatedInput: { path: "other.md", text: "approved" } });
  await f.run("write", { path: "note.md", text: "original" });
  expect(f.requests).toHaveLength(1);
  expect(f.executed()).toBe(true);
  expect(JSON.parse(readFileSync(join(f.root, "executed.json"), "utf8"))).toEqual({ path: "other.md", text: "approved" });
});

test("internal entries retain the original shared policies and environment operation", async () => {
  const internal = await import("@schlessera/brain-ui-sdk/internal");
  const claudeInternal = await import("@schlessera/brain-backend-claude/internal");
  const piInternal = await import("@schlessera/brain-backend-pi/internal");
  expect(internal.DEFAULT_CONFIRM_BASH_PATTERNS.length).toBeGreaterThan(0);
  expect(claudeInternal.DEFAULT_CONFIRM_BASH_PATTERNS).toBe(internal.DEFAULT_CONFIRM_BASH_PATTERNS);
  expect(claudeInternal.VOICE_ALLOWED_TOOLS.length).toBeGreaterThan(0);
  expect(piInternal.DEFAULT_PI_ALLOWED_TOOLS.length).toBeGreaterThan(0);
  expect(piInternal.TOOL_RISK.write_file).toBe("mutate");
  expect(internal.filterSubprocessEnv({ PATH: "/bin", COOKIE_SECRET: "fixture", EXTRA: "allowed" }, "agent", ["EXTRA"]))
    .toEqual({ PATH: "/bin", EXTRA: "allowed" });
});
