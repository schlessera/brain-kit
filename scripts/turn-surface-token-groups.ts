import type { CapturedRequest } from "./capture-turn-surface";

export const TOKEN_GROUPS = ["everythingElse", "builtinTools", "brainMcpTools", "bridgeTools", "skillListing"] as const;
export type TokenGroup = typeof TOKEN_GROUPS[number];
type TextBlock = { type: string; text?: string; [key: string]: unknown };
const SKILL_START = "The following skills are available for use with the Skill tool:\n\n";
const SKILL_END = "\n\n<total_tokens>";
const DEFERRED_START = "The following deferred tools are now available via ToolSearch.";

/** Actual emitted name-only catalogue, not the init inventory or schemas. */
export function deferredToolNames(request: CapturedRequest): string[] {
  const names: string[] = [];
  let listings = 0;
  for (const message of request.messages) for (const block of Array.isArray(message.content) ? message.content as TextBlock[] : []) {
    if (block.type !== "text" || !block.text?.includes(DEFERRED_START)) continue;
    const start = block.text.indexOf("\n", block.text.indexOf(DEFERRED_START)) + 1;
    const end = block.text.indexOf("\n\n", start);
    if (!start || end < 0) throw Error("CLI deferred-tool boundaries changed");
    names.push(...block.text.slice(start, end).split("\n")); listings++;
  }
  if (listings !== 1 || !names.length || names.some(name => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name))
    || new Set(names).size !== names.length) throw Error("Missing or invalid deferred-tool listing");
  return names;
}

/** Keep the actual message roles/blocks and tool order, removing one group at a time. */
export function tokenGroupPayloads(request: CapturedRequest) {
  if (!request.system || !request.tools.length || !request.messages.length) throw Error("Incomplete installed-CLI capture");
  const groups = {
    builtinTools: request.tools.filter(tool => !tool.name.startsWith("mcp__")),
    brainMcpTools: request.tools.filter(tool => tool.name.startsWith("mcp__brain__")),
    bridgeTools: request.tools.filter(tool => tool.name.startsWith("mcp__brain-ui__")),
  };
  const deferred = deferredToolNames(request);
  const nameGroups = {
    builtinTools: deferred.filter(name => !name.startsWith("mcp__")),
    brainMcpTools: deferred.filter(name => name.startsWith("mcp__brain__")),
    bridgeTools: deferred.filter(name => name.startsWith("mcp__brain-ui__")),
  };
  if (Object.entries(groups).some(([key, tools]) => !tools.length && !nameGroups[key as keyof typeof nameGroups].length)) {
    throw Error("Missing tool category in actual capture");
  }
  if (Object.values(groups).reduce((total, tools) => total + tools.length, 0) !== request.tools.length) {
    throw Error("Unclassified MCP server in capture; extend explicit attribution before counting");
  }
  if (Object.values(nameGroups).reduce((total, names) => total + names.length, 0) !== deferred.length) {
    throw Error("Unclassified deferred MCP server in capture");
  }
  let listings = 0;
  const strippedMessages = request.messages.map(message => ({ ...message,
    content: Array.isArray(message.content) ? message.content.map((block: TextBlock) => {
      if (block.type !== "text" || !block.text?.includes(SKILL_START)) return block;
      const start = block.text.indexOf(SKILL_START);
      const end = block.text.indexOf(SKILL_END, start);
      if (end < 0 || block.text.indexOf(SKILL_START, start + 1) >= 0) throw Error("CLI skill-listing boundaries changed");
      listings++;
      return { ...block, text: block.text.slice(0, start) + block.text.slice(end) };
    }) : message.content,
  }));
  if (listings !== 1) throw Error("Expected exactly one observed CLI skill listing");
  const enabled = new Set<string>();
  const enabledNames = new Set<string>();
  return TOKEN_GROUPS.map(group => {
    if (group !== "everythingElse" && group !== "skillListing") {
      for (const tool of groups[group]) enabled.add(tool.name);
      for (const name of nameGroups[group]) enabledNames.add(name);
    }
    const messages = group === "skillListing" ? request.messages : strippedMessages.map(message => ({ ...message,
      content: Array.isArray(message.content) ? message.content.map((block: TextBlock) => {
        if (block.type !== "text" || !block.text?.includes(DEFERRED_START)) return block;
        const start = block.text.indexOf("\n", block.text.indexOf(DEFERRED_START)) + 1;
        const end = block.text.indexOf("\n\n", start);
        return { ...block, text: block.text.slice(0, start) + deferred.filter(name => enabledNames.has(name)).join("\n") + block.text.slice(end) };
      }) : message.content,
    }));
    return { group, body: {
      model: request.model, system: request.system,
      messages,
      tools: request.tools.filter(tool => enabled.has(tool.name)),
      ...(request.thinking ? { thinking: request.thinking } : {}),
    } };
  });
}

/** Ordered marginal counts, not a claim that separately tokenized fragments add. */
export function attributeTokenCounts(counts: readonly { group: TokenGroup; inputTokens: number }[]) {
  if (counts.length !== TOKEN_GROUPS.length || counts.some((entry, i) => entry.group !== TOKEN_GROUPS[i]
    || !Number.isSafeInteger(entry.inputTokens) || entry.inputTokens < 0)) throw Error("Missing or invalid cumulative token counts");
  return counts.map((entry, i) => ({ ...entry,
    marginalTokens: entry.inputTokens - (i ? counts[i - 1]!.inputTokens : 0),
  }));
}
