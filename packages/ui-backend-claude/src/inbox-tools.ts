import { tool, type createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { INBOX_TOOL_CONTRACTS, handleInboxTool, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
export function createInboxTools(bridge: Pick<BackendBridge, "inboxList" | "inboxGet" | "inboxAdd" | "resolveAction" | "completeShare">) {
  return INBOX_TOOL_CONTRACTS.map(contract => tool(contract.name, contract.description, contract.input.shape, async input => {
    try { return { content: [{ type: "text" as const, text: await handleInboxTool(contract.name, input, bridge as BackendBridge) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Inbox tool refused" }] }; }
  }));
}

/** Preserve strict object validation; SDK raw-shape registration strips extras. */
export function registerInboxTools(server: ReturnType<typeof createSdkMcpServer>["instance"], bridge: Pick<BackendBridge, "inboxList" | "inboxGet" | "inboxAdd" | "resolveAction" | "completeShare">) {
  const tools = createInboxTools(bridge);
  INBOX_TOOL_CONTRACTS.forEach((contract, index) => server.registerTool(contract.name, {
    description: contract.description, inputSchema: contract.input,
    _meta: { "anthropic/alwaysLoad": true },
  }, tools[index]!.handler));
}
