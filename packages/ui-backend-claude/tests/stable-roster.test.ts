import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClaudeSdkTurn } from "../src/sdk-options.js";
import { createPermissionWiring } from "../src/permission-hooks.js";
import { APIFY_TOOL_NAMES } from "@schlessera/brain-ui-sdk/server";

const refused = ["request_image_mask", "request_image_markup", "ask_user_list", "ask_user_rank", "ask_user_form", "propose_policy_change", "inbox_add", "resolve_action", "complete_share"];
const bridge = () => Object.fromEntries(["askUser", "askUserList", "askUserRank", "askUserForm", "requestMask", "requestImageMarkup", "proposePolicyChange", "inboxList", "inboxGet", "inboxAdd", "resolveAction", "completeShare", "queryActivity", "getLocation", "applyBrain", "readBrainBase", "compute"].map(name => [name, async () => { throw new Error("PRIVILEGED_HANDLER_EXECUTED"); }]));
// The in-worker core server's copies of every fixed Apify operation (#3788), derived from the contract so a new operation is covered.
const inWorkerApify = Object.values(APIFY_TOOL_NAMES).map(name => `mcp__brain__${name}`);

test("Claude complete tool schemas and native exclusions stay identical voice-first, typed, missing-handler and strict", async () => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-roster-"));
  const rosters: string[] = [], exclusions: string[] = [], appends: string[] = [];
  try {
    for (const mode of ["voice", "typed", "missing", "strict", "no-grant", "unhosted", "partial", "apify"] as const) {
      const turn = createClaudeSdkTurn({ backend: { brainPath: brain }, req: {
        prompt: "Return to Ithaca", signal: new AbortController().signal,
        bridge: (["missing", "unhosted"].includes(mode) ? {} : mode === "partial" ? { ...bridge(), inboxList: undefined } : mode === "apify" ? { ...bridge(), apify: async () => { throw new Error("PRIVILEGED_HANDLER_EXECUTED"); } } : bridge()) as never,
        ...(mode !== "unhosted" ? { applicationAuthority: "server" as const } : {}),
        ...(mode === "voice" ? { posture: "voice", enforceAllowedTools: true } : {}),
        noGrantSurface: mode === "voice" || mode === "no-grant",
        workerSandbox: { brain, profile: mode === "strict" ? "strict" : "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
      }, profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never,
      abortController: new AbortController(), allowedTools: [], confirmPatterns: [],
      turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never, log() {} });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "roster", version: "1" });
      try {
        await (turn.options.mcpServers!["brain-ui"] as any).instance.connect(st);
        await client.connect(ct);
        const tools = (await client.listTools()).tools;
        if (mode === "partial") expect(turn.options.allowedTools, "PARTIAL_INBOX_HANDLER_AUTO_ALLOWED").toContain("mcp__brain-ui__inbox_add");
        for (const legacy of ["brain_add", "brain_update", "brain_archive"])
          expect(turn.options.disallowedTools?.includes(`mcp__brain__${legacy}`), `LEGACY_DEPLOYMENT_MEMBERSHIP_${mode}_${legacy}`).toBe(mode !== "unhosted");
        for (const name of [...refused, "brain_read_base", "brain_add", "show_block", "turn_temp", "brain_compute_run", "brain_compute_collect"])
          expect(tools.some(tool => tool.name === name), `FULL_ROSTER_${mode}_${name}`).toBe(true);
        // The in-worker compute tools are disallowed in every session, whatever the host configured (#3108).
        for (const name of ["health", "plan", "run", "status", "cancel", "collect"])
          expect(turn.options.disallowedTools, `IN_WORKER_COMPUTE_DISALLOWED_${mode}_${name}`).toContain(`mcp__brain__brain_compute_${name}`);
        // So are the in-worker Apify tools: a worker holds neither the token nor the ledger, so they only refuse (#3788).
        expect(inWorkerApify.filter(name => !turn.options.disallowedTools?.includes(name)), `IN_WORKER_APIFY_DISALLOWED_${mode}`).toEqual([]);
        if (mode === "apify") expect(turn.options.allowedTools, "HOST_APIFY_UNAFFECTED").toContain("mcp__brain-ui__brain_apify_run");
        rosters.push(JSON.stringify(tools)); exclusions.push(JSON.stringify(turn.options.disallowedTools?.filter(name => ["Write", "Edit", "NotebookEdit"].includes(name) || name.includes("compute") || name.includes("apify"))));
        appends.push(JSON.stringify(turn.options.systemPrompt));
      } finally { await client.close(); await turn.finishWorker(); }
    }
    for (const roster of rosters.slice(1)) expect(roster, "BYTE_IDENTICAL_TOOL_SCHEMAS").toBe(rosters[0]);
    for (const exclusion of exclusions.slice(1)) expect(exclusion, "BYTE_IDENTICAL_NATIVE_EXCLUSIONS").toBe(exclusions[0]);
    // Compute present or not, typed or voice: the fixed brief is the same bytes (#3108).
    for (const append of appends.slice(1)) expect(append, "BYTE_IDENTICAL_SYSTEM_APPEND").toBe(appends[0]);
  } finally { rmSync(brain, { recursive: true, force: true }); }
});

for (const autonomous of [false, true]) for (const hosted of [false, true]) for (const apify of [false, true]) for (const posture of ["typed", "voice"] as const)
  test(`Claude ${autonomous ? "autonomous" : "interactive"} ${hosted ? "hosted" : "unhosted"} ${posture} turn with Apify ${apify ? "enabled" : "disabled"} disallows every in-worker Apify tool`, async () => {
    const brain = mkdtempSync(join(tmpdir(), "odysseus-apify-roster-"));
    try {
      const turn = createClaudeSdkTurn({ backend: { brainPath: brain }, req: {
        prompt: "Count the cattle of the sun", signal: new AbortController().signal,
        bridge: { ...bridge(), ...(apify ? { apify: async () => { throw new Error("PRIVILEGED_HANDLER_EXECUTED"); } } : {}) } as never,
        ...(hosted ? { applicationAuthority: "server" as const } : {}),
        ...(posture === "voice" ? { posture: "voice", enforceAllowedTools: true } : {}),
        ...(autonomous ? { enforceAllowedTools: true, noGrantSurface: true, autonomous: { origin: "autonomous", persistence: "none", containment: "restricted", allowedTools: [], systemPromptAppend: "Server snapshot." } } : {}),
        workerSandbox: { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] },
      } as never, profile: { id: "fixture", label: "Fixture", requiredEnvKeys: [], ...(autonomous ? { billing: "api" } : {}),
        buildEnv: () => autonomous ? { ANTHROPIC_API_KEY: "sk-odysseus-fixture", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "" } : {} } as never,
      abortController: new AbortController(), allowedTools: [], confirmPatterns: [],
      turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never, log() {} });
      try {
        expect(inWorkerApify.filter(name => !turn.options.disallowedTools?.includes(name)), "IN_WORKER_APIFY_DISALLOWED").toEqual([]);
        // The host's own Apify tools are never caught by the exclusion.
        expect(turn.options.disallowedTools?.filter(name => name.startsWith("mcp__brain-ui__")), "HOST_TOOLS_NOT_DISALLOWED").toEqual([]);
      } finally { await turn.finishWorker(); }
    } finally { rmSync(brain, { recursive: true, force: true }); }
  });

for (const mode of ["voice", "no-grant", "missing"] as const) for (const name of refused) test(`Claude ${mode} refuses ${name} before approval or handler`, async () => {
  let cards = 0;
  const req = { prompt: "Return to Ithaca", signal: new AbortController().signal,
    bridge: { ...(mode === "missing" ? {} : bridge()), requestPermission: async () => { cards++; return { behavior: "allow" }; } },
    ...(mode === "voice" ? { posture: "voice" } : {}), noGrantSurface: mode === "no-grant",
  };
  const wiring = createPermissionWiring({ req: req as never, allowedTools: [`mcp__brain-ui__${name}`], brainPath: "/tmp/odysseus", confirmPatterns: [],
    turnLock: { releaseForTool() {} } as never, childEnv: {}, log() {} });
  const hook = wiring.hooks!.PreToolUse!.find(group => !group.matcher)!.hooks[0]!;
  const output = await hook({ hook_event_name: "PreToolUse", tool_name: `mcp__brain-ui__${name}`, tool_input: {}, tool_use_id: "loom" } as never, undefined, { signal: req.signal });
  expect(output, `HOOK_REFUSAL_${mode}_${name}`).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(await wiring.canUseTool!(`mcp__brain-ui__${name}`, {}, { toolUseID: "loom" } as never)).toMatchObject({ behavior: "deny" });
  expect(cards).toBe(0);
});
for (const mode of ["voice", "strict", "unknown"] as const) for (const name of ["Write", "Edit", "NotebookEdit"]) test(`Claude ${mode} denies registered native ${name}`, async () => {
  const req = { signal: new AbortController().signal, bridge: { requestPermission: async () => { throw new Error("CARD_OPENED"); } },
    workerSandbox: { profile: mode === "unknown" ? undefined : mode === "strict" ? "strict" : "governed" }, ...(mode === "voice" ? { posture: "voice" } : {}) };
  const wiring = createPermissionWiring({ req: req as never, allowedTools: [name], brainPath: "/tmp/odysseus", confirmPatterns: [],
    turnLock: { releaseForTool() {} } as never, childEnv: {}, log() {} });
  const hook = wiring.hooks!.PreToolUse!.find(group => !group.matcher)!.hooks[0]!;
  expect(await hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: { file_path: "notes/raft.md" }, tool_use_id: "loom" } as never,
    undefined, { signal: req.signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(await wiring.canUseTool!(name, {}, { toolUseID: "loom" } as never)).toMatchObject({ behavior: "deny" });
});
