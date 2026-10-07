/** Private #587 experiment: overlap installed-CLI startup with a bounded router.
 * MCP listing waits for the decision; claim discovers the fixture's project
 * skills after any diagnostic pruning. All arms use the same startup path.
 */
import type { Options, Query, SpareProcess } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Arm, Peer } from "./turn-surface-routing.js";

export interface SurfaceDecision {
  arm: Arm;
  /** False means preserve the complete original surface, including metadata. */
  routed: boolean;
  tools: readonly string[];
  skills: readonly string[];
}

/** Delegate to the actual executor; changing availability grants no authority. */
export function gatedSurfaceServer(name: string, peer: Peer, decision: Promise<SurfaceDecision>) {
  const instance = new McpServer({ name, version: "0.1.0" }, {
    capabilities: { tools: {} }, instructions: peer.client.getInstructions(),
  });
  const exposed = async () => {
    const selected = await decision;
    return peer.tools.filter(tool => !selected.routed || selected.arm !== "hard-prune" || selected.tools.includes(tool.id));
  };
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const selected = await decision;
    return { tools: (await exposed()).map(({ id, serverName: _server, ...tool }) => {
      if (!selected.routed || selected.arm === "hint") return tool;
      return { ...tool, _meta: { ...tool._meta,
        "anthropic/alwaysLoad": selected.arm === "load-set" ? selected.tools.includes(id) : true,
      } };
    }) };
  });
  instance.server.setRequestHandler(CallToolRequestSchema, async request => {
    if (!(await exposed()).some(tool => tool.name === request.params.name)) {
      throw new McpError(ErrorCode.InvalidParams, "Tool is absent from this diagnostic arm");
    }
    return peer.client.callTool(request.params);
  });
  return { type: "sdk" as const, name, instance };
}

export function relevance(decision: SurfaceDecision): string {
  if (!decision.routed || decision.arm !== "hint") return "";
  return `<tool_relevance>${decision.tools.join(", ") || "none"}. Ignore this hint if it does not fit the request.</tool_relevance>\n`
    + `<skill_relevance>${decision.skills.join(", ") || "none"}. Ignore this hint if it does not fit the request.</skill_relevance>`;
}

export interface OverlappedTurn { query: Query; spare: SpareProcess; decision: SurfaceDecision }

/** The caller starts its bounded decision before calling this function.
 * No claim/prompt is sent until both initialization and fixture preparation
 * settle. The installed SDK's supported prewarm/claim APIs own the transport.
 */
export async function startOverlappedTurn(params: {
  options: Options;
  parkingDirectory: string;
  projectDirectory: string;
  prompt: string;
  decision: Promise<SurfaceDecision>;
  skillCatalogue?: readonly string[];
  beforeClaim?: (decision: SurfaceDecision) => void | Promise<void>;
}): Promise<OverlappedTurn> {
  const sdkEntry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", import.meta.dir + "/../packages/ui-backend-claude/src");
  const { prewarm } = await import(sdkEntry) as typeof import("@anthropic-ai/claude-agent-sdk");
  const system = params.options.systemPrompt;
  if (!system || typeof system === "string" || Array.isArray(system) || system.type !== "preset") {
    throw Error("Overlap requires the production preset system prompt");
  }
  const originalHook = params.options.hooks?.UserPromptSubmit ?? [];
  const options: Options = {
    ...params.options, cwd: params.parkingDirectory,
    systemPrompt: { ...system, append: undefined },
    hooks: { ...params.options.hooks, UserPromptSubmit: [...originalHook, { hooks: [async () => {
      const hint = relevance(await params.decision);
      return hint ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: hint } } : {};
    }] }] },
  };
  const warming = prewarm({ options, initializeTimeoutMs: 30_000 });
  void warming.catch(() => {});
  let spare: SpareProcess | undefined;
  try {
    const decision = await params.decision;
    await params.beforeClaim?.(decision);
    spare = await warming;
    const query = spare.claim({ prompt: params.prompt, options: {
      cwd: params.projectDirectory, model: params.options.model,
      appendSystemPrompt: system.append ?? "", permissionMode: params.options.permissionMode,
      ...(decision.routed && decision.arm !== "hint" && params.skillCatalogue ? {
        settings: { skillOverrides: Object.fromEntries(params.skillCatalogue.filter(name => !decision.skills.includes(name))
          .map(name => [name, decision.arm === "hard-prune" ? "off" : "name-only"])),
          ...(decision.arm === "hard-prune" ? { permissions: {
            deny: params.skillCatalogue.filter(name => !decision.skills.includes(name)).map(name => `Skill(${name})`),
          } } : {}),
        },
      } : {}),
    } });
    // Avoid admitting a turn if claim was refused or its model was not applied.
    await spare.claimed;
    return { query, spare, decision };
  } catch (error) {
    spare?.close();
    // Initialization can settle after an earlier decision/preparation failure.
    // Close that late process too, rather than orphaning a parked CLI.
    void warming.then(value => value.close(), () => {});
    throw error;
  }
}
