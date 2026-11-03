/**
 * The provider-facing part of the SDK `Options` a turn is built with, for a
 * fixed fictional request per mode (#2519). The tool roster, the allowlist and
 * the system prompt are what the provider caches; they must stay byte-identical
 * across a refactor of their assembly (docs/decisions/provider-history.md).
 *
 * Every input is fixed: an empty turn environment, so no host credential or
 * variable reaches the note, and the temporary brain path and generated
 * session id are replaced by placeholders before comparison.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

import { createClaudeSdkTurn } from "../../src/sdk-options.js";

export const SNAPSHOT_MODES = ["hosted-typed", "voice", "unhosted", "relayed", "autonomous-summary", "restricted"] as const;
export type SnapshotMode = (typeof SNAPSHOT_MODES)[number];

const handler = async () => { throw new Error("PRIVILEGED_HANDLER_EXECUTED"); };
const fullBridge = () => ({
  emit: () => {}, checkpointPermission: () => {},
  requestPermission: async () => ({ behavior: "deny", message: "Penelope is weaving; no." }),
  ...Object.fromEntries(["askUser", "askUserList", "askUserRank", "askUserForm", "requestMask", "proposePolicyChange",
    "inboxList", "inboxGet", "inboxAdd", "resolveAction", "completeShare", "queryActivity", "getLocation",
    "applyBrain", "readBrainBase", "referenceAccess"].map(name => [name, handler])),
});

function requestFor(mode: SnapshotMode, brain: string): Record<string, unknown> {
  const base = { prompt: "Chart the course from Ogygia to Scheria", signal: new AbortController().signal, turnBudgetMs: 180_000 };
  const sandbox = { brain, profile: "governed", restricted: false, areas: [], scratchAliasesRemoved: [] };
  switch (mode) {
    case "hosted-typed":
      return { ...base, bridge: fullBridge(), applicationAuthority: "server", workerSandbox: sandbox };
    case "voice":
      return { ...base, bridge: fullBridge(), applicationAuthority: "server", workerSandbox: sandbox,
        posture: "voice", enforceAllowedTools: true, noGrantSurface: true };
    case "unhosted":
      return { ...base, bridge: { emit: () => {} }, workerSandbox: { ...sandbox, profile: "strict" } };
    case "relayed":
      return { ...base, bridge: fullBridge(), applicationAuthority: "server", workerSandbox: sandbox };
    case "autonomous-summary":
      return { ...base, bridge: { emit: () => {} }, enforceAllowedTools: true, noGrantSurface: true,
        autonomous: { origin: "autonomous", persistence: "none", allowedTools: ["Read"], systemPromptAppend: "Summarise the voyage so far." } };
    case "restricted":
      return { ...base, bridge: { emit: () => {} }, enforceAllowedTools: true, noGrantSurface: true,
        autonomous: { origin: "autonomous", persistence: "none", containment: "restricted", allowedTools: ["Bash", "mcp__brain-ui__show_block"],
          systemPromptAppend: "Server snapshot of the Ithaca household brief." } };
  }
}

function hooksShape(hooks: Options["hooks"]): Record<string, { matcher: string | null; hooks: number }[]> {
  return Object.fromEntries(Object.entries(hooks ?? {}).map(([event, groups]) =>
    [event, (groups ?? []).map(group => ({ matcher: group.matcher ?? null, hooks: group.hooks.length }))]));
}

/** The normalised snapshot for one mode; the worker is finished before it returns. */
export async function sdkOptionsSnapshot(mode: SnapshotMode): Promise<Record<string, unknown>> {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-sdk-options-"));
  const restricted = mode === "restricted";
  const turn = createClaudeSdkTurn({
    backend: { brainPath: brain } as never,
    req: requestFor(mode, brain) as never,
    ...(restricted ? {} : { turnEnvironment: {} }),
    ...(mode === "relayed" ? { hostInference: { proxyDir: brain, baseUrl: "http://localhost" } } : {}),
    profile: (restricted
      ? { id: "fixture", label: "Fixture", requiredEnvKeys: [], billing: "api",
        buildEnv: () => ({ ANTHROPIC_API_KEY: "sk-odysseus-fixture", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "" }) }
      : { id: "fixture", label: "Fixture", requiredEnvKeys: [], buildEnv: () => ({}) }) as never,
    abortController: new AbortController(),
    allowedTools: restricted ? ["Bash", "mcp__brain-ui__show_block"] : mode === "autonomous-summary" ? ["Read"]
      : ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "mcp__brain__brain_add", "mcp__brain__brain_update"],
    confirmPatterns: [/\brm\s+-rf\b/],
    turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never,
    log: () => undefined,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "sdk-options-snapshot", version: "1" });
  try {
    await (turn.options.mcpServers!["brain-ui"] as { instance: { connect(t: unknown): Promise<void> } }).instance.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    const { options } = turn;
    const snapshot = {
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      systemPrompt: options.systemPrompt,
      // The complete schemas as one digest (they are long); the names stay readable.
      toolNames: tools.map(tool => tool.name),
      toolSchemasSha256: createHash("sha256").update(JSON.stringify(tools).replaceAll(brain, "<brain>")).digest("hex"),
      mcpServers: Object.keys(options.mcpServers ?? {}),
      permissionMode: options.permissionMode,
      settingSources: options.settingSources,
      settings: options.settings,
      strictMcpConfig: options.strictMcpConfig ?? null,
      persistSession: options.persistSession ?? null,
      hooks: hooksShape(options.hooks),
      session: { resume: options.resume ?? null, sessionId: options.sessionId === undefined ? null : "<generated>" },
      subscriptionOnly: turn.subscriptionOnly,
      pinnedSettingsEnv: turn.pinnedSettingsEnv ?? null,
      promptIsStream: typeof turn.prompt !== "string",
    };
    return JSON.parse(JSON.stringify(snapshot).replaceAll(brain, "<brain>"));
  } finally {
    await client.close();
    await turn.finishWorker();
    rmSync(brain, { recursive: true, force: true });
  }
}
