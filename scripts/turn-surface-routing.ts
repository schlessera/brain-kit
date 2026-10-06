/** Private, keyless #587 preparation. Never imported by a shipping package. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { BRIDGE_TOOL_CONTRACTS } from "@schlessera/brain-ui-sdk/server";
import { type ClassificationRequest, type ClassificationAnswers } from "@schlessera/brain-ui-sdk/internal";
import { createClaudeSdkTurn, type ClaudeSdkTurn } from "../packages/ui-backend-claude/src/sdk-options.js";
import type { JevClient, JevOutcome } from "../packages/ui-server/src/classification/jev-client.js";

export const ARMS = ["baseline", "hint", "load-set", "hard-prune"] as const;
export type Arm = typeof ARMS[number];
export interface SkillEntry { name: string; description: string }
export interface SurfaceTool extends Tool { id: string; serverName: string }
export interface Peer { client: Client; tools: SurfaceTool[] }

/** Connect to the actual instance in the production turn's mcpServers entry. */
export async function connectSurface(serverName: string, server: McpSdkServerConfigWithInstance): Promise<Peer> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "turn-surface-probe", version: "0.1.0" });
  try {
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    return { client, tools: tools.map(tool => ({ ...tool, id: `mcp__${serverName}__${tool.name}`, serverName })) };
  } catch (error) {
    await client.close();
    await server.instance.close();
    throw error;
  }
}

/** Bound this preparatory catalogue instead of silently dropping entries. */
export function routingRequest(prompt: string, previousTail: string, tools: readonly SurfaceTool[], skills: readonly SkillEntry[]): ClassificationRequest {
  if (!tools.length || !skills.length || tools.length + skills.length > 64) {
    throw new Error("preparation requires nonempty tool/skill catalogues, at most 64 entries combined");
  }
  const request: ClassificationRequest = {
    model: "jev-latest",
    state: { request: prompt, previous_assistant_tail: previousTail.slice(-1000) },
    questions: {},
  };
  for (const [kind, entries] of [
    ["tool", tools.map(tool => ({ name: tool.id, description: tool.description ?? "" }))],
    ["skill", skills],
  ] as const) {
    request.questions[kind] = {
      type: "choice", instructions: `Which ${kind} best fits the latest request?`,
      criteria: Object.fromEntries(entries.map(entry => [entry.name, entry.description.slice(0, 300)])),
    };
    request.questions[`needs_${kind}`] = { type: "noul", instructions: `Does satisfying this request require any ${kind}, rather than prose alone?` };
    // In this bounded preparation the candidate set is exhaustive. A large
    // roster's shortlist strategy remains part of the measured experiment.
    for (const entry of entries) request.questions[`fits_${kind}:${entry.name}`] = {
      type: "noul", instructions: `Does ${entry.name} do the specific thing requested? ${entry.description}`,
    };
  }
  return request;
}

function selected(answers: ClassificationAnswers, kind: "tool" | "skill", names: readonly string[], threshold: number): string[] | null {
  const need = answers[`needs_${kind}`];
  if (need?.type !== "noul" || !Number.isFinite(need.noul) || need.noul < 0 || need.noul > 1) return null;
  // A confident "none needed" must not select the relative choice's winner.
  if (1 - need.noul >= threshold) return [];
  const choice = answers[kind];
  if (need.noul < threshold || choice?.type !== "choice" || !names.includes(choice.choice)) return null;
  const fit = answers[`fits_${kind}:${choice.choice}`];
  if (fit?.type !== "noul") return null;
  const confidence = Math.min(choice.confidence, fit.noul);
  if (!Number.isFinite(confidence) || choice.confidence > 1 || fit.noul > 1 || confidence < threshold) return null;
  return [choice.choice];
}

/** Public MCP APIs preserve the original listed schema and original executor. */
function routedServer(name: string, peer: Peer, arm: Arm, picked: ReadonlySet<string>): McpSdkServerConfigWithInstance {
  const instance = new McpServer({ name, version: "0.1.0" }, { capabilities: { tools: {} }, instructions: peer.client.getInstructions() });
  const exposed = peer.tools.filter(tool => arm !== "hard-prune" || picked.has(tool.id));
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposed.map(({ id, serverName: _serverName, ...tool }) => ({
    ...tool, _meta: { ...tool._meta, "anthropic/alwaysLoad": arm === "load-set" ? picked.has(id) : true },
  })) }));
  instance.server.setRequestHandler(CallToolRequestSchema, async request => {
    if (!exposed.some(tool => tool.name === request.params.name)) throw new McpError(ErrorCode.InvalidParams, "Tool is absent from this diagnostic arm");
    return peer.client.callTool(request.params);
  });
  return { type: "sdk", name, instance };
}

export interface RoutingOptions {
  enabled?: boolean;
  arm: Arm;
  client: JevClient;
  peers: Readonly<Record<string, Peer>>;
  skills: readonly SkillEntry[];
  previousTail?: string;
  budgetMs?: number;
  threshold?: number;
}
export interface RoutingResult {
  turn: ClaudeSdkTurn;
  outcome: JevOutcome | "off" | "low_confidence" | "unsupported_input";
  durationMs: number;
  tools: string[];
  skills: string[];
  /** Only the private fixture runner may apply this to its disposable files. */
  pruneFixtureSkills: boolean;
}

/** No query/spawn here. Baseline assembly can proceed while this pass runs. */
export async function routePreparedTurn(turn: ClaudeSdkTurn, opts: RoutingOptions): Promise<RoutingResult> {
  const started = performance.now();
  const fallback = (outcome: RoutingResult["outcome"]): RoutingResult => ({
    turn, outcome, durationMs: performance.now() - started, tools: [], skills: [], pruneFixtureSkills: false,
  });
  if (!opts.enabled || opts.arm === "baseline") return fallback("off");
  if (!opts.client.enabled) return fallback("no_key");
  if (opts.client.breaker().open) return fallback("circuit_open");
  if (typeof turn.prompt !== "string") return fallback("unsupported_input");
  const budgetMs = opts.budgetMs ?? 2000;
  const threshold = opts.threshold ?? 0.6; // Test setting; no calibrated policy.
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || !Number.isFinite(threshold) || threshold <= 0.5 || threshold > 1) {
    throw new Error("invalid preparation budget or confidence threshold");
  }
  const tools = Object.values(opts.peers).flatMap(peer => peer.tools);
  const request = routingRequest(turn.prompt, opts.previousTail ?? "", tools, opts.skills);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The transport already has a single HTTP deadline/retry/breaker. This
  // assembly deadline also covers a transport that ignores AbortSignal.
  const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), budgetMs); });
  const result = await Promise.race([opts.client.classify(request), deadline]).finally(() => clearTimeout(timer));
  if (!result) return fallback("timeout");
  if (performance.now() - started >= budgetMs) return fallback("timeout");
  if (result.outcome !== "answered" || !result.answers) return fallback(result.outcome);
  const toolNames = selected(result.answers, "tool", tools.map(tool => tool.id), threshold);
  const skillNames = selected(result.answers, "skill", opts.skills.map(skill => skill.name), threshold);
  if (!toolNames || !skillNames) return fallback("low_confidence");
  const picked = new Set(toolNames);
  const options = { ...turn.options };
  if (opts.arm === "hint") {
    const system = options.systemPrompt;
    if (!system || typeof system === "string" || Array.isArray(system) || system.type !== "preset") throw new Error("expected production preset prompt");
    options.systemPrompt = { ...system, append: `${system.append ?? ""}\n\n<tool_relevance>${toolNames.join(", ") || "none"}</tool_relevance>\n<skill_relevance>${skillNames.join(", ") || "none"}</skill_relevance>` };
  } else {
    options.mcpServers = { ...options.mcpServers };
    for (const [name, peer] of Object.entries(opts.peers)) options.mcpServers[name] = routedServer(name, peer, opts.arm, picked);
  }
  return { turn: { ...turn, options }, outcome: "answered", durationMs: performance.now() - started,
    tools: toolNames, skills: skillNames, pruneFixtureSkills: opts.arm === "hard-prune" };
}

export type AssemblyInput = Parameters<typeof createClaudeSdkTurn>[0];
export const assembleTurn = createClaudeSdkTurn;

/** JSON boundary only: callbacks/controllers cannot be compared by encoding. */
export function serializedTurn(turn: ClaudeSdkTurn): string {
  const { mcpServers, env: _env, ...options } = turn.options;
  return JSON.stringify({ prompt: turn.prompt, subscriptionOnly: turn.subscriptionOnly, options,
    // Environment is intentionally absent from artifacts (may hold secrets).
    mcpServers: Object.fromEntries(Object.entries(mcpServers ?? {}).map(([name, config]) => [name,
      config.type === "sdk" ? { type: config.type, name: config.name } : config])),
  });
}

/** D44 valid main-agent calls; the fixtures deliberately include exclusions. */
export function scoreCalls(frames: readonly { parent_tool_use_id: string | null; calls: readonly { name: string; input: unknown }[] }[], completed: boolean) {
  if (!completed) return { included: false, valid: [], rejected: 0 };
  const valid: string[] = [];
  let rejected = 0;
  for (const frame of frames) {
    if (frame.parent_tool_use_id !== null) continue;
    for (const call of frame.calls) {
      const contract = BRIDGE_TOOL_CONTRACTS.find(tool => `mcp__brain-ui__${tool.name}` === call.name);
      if (!contract) continue;
      if (contract.input.safeParse(call.input).success) valid.push(call.name);
      else rejected++;
    }
  }
  return { included: true, valid, rejected };
}
