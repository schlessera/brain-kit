/**
 * The schema forms #336 A/Bs, and the credential its live half runs on.
 *
 * `measure-show-block.ts` stages a brain on import; its CLI runs directly. The A/B
 * inputs live here, where a test can load them: which form each arm sends,
 * the schema each arm's tool lists through the Agent SDK's own MCP server,
 * and which credential a live run uses. Nothing here makes a network call.
 *
 * The forms are `showBlockInputSchema`'s (`packages/ui-sdk/src/tool-contracts/blocks.ts`):
 * the same variants, the same parser, written three ways. The arms are
 * cumulative, so each reduction reads against the arm before it:
 *
 * - `flat` — the historical D47/#336 baseline.
 * - `shared` — reduction 1: `tone`, `valueTone` and `icon` under `definitions`.
 * - `shared-trimmed` — reduction 1 plus reduction 2, the descriptions that
 *   restate `SHOW_BLOCK_DESCRIPTION` dropped.
 */

import { join } from "node:path";

import { handleShowBlock } from "@schlessera/brain-ui-sdk/internal";
import {
  SHOW_BLOCK_DESCRIPTION,
  SHOW_BLOCK_TOOL_NAME,
} from "@schlessera/brain-ui-sdk/server";
import {
  SHIPPED_SHOW_BLOCK_SCHEMA_FORM,
  showBlockInputSchema,
  type ShowBlockSchemaForm,
} from "../packages/ui-sdk/src/tool-contracts/blocks.js";

import type { Json } from "./attribute-show-block-schema.ts";

export const SCHEMA_ARMS = {
  flat: { sharedDefinitions: false, restatedProse: true },
  shared: { sharedDefinitions: true, restatedProse: true },
  "shared-trimmed": { sharedDefinitions: true, restatedProse: false },
} as const satisfies Record<string, ShowBlockSchemaForm>;

export type SchemaArm = keyof typeof SCHEMA_ARMS;

export const SCHEMA_ARM_NAMES = Object.keys(SCHEMA_ARMS) as SchemaArm[];

// The SDK the BACKEND loads, as `measure-show-block.ts` resolves it, so the
// listing below is the serialisation production's copy performs.
export const SDK_ENTRY = Bun.resolveSync(
  "@anthropic-ai/claude-agent-sdk",
  join(import.meta.dir, "../packages/ui-backend-claude/src")
);
const sdk = (await import(SDK_ENTRY)) as typeof import("@anthropic-ai/claude-agent-sdk");

/**
 * `show_block` in one arm's form: the backend factory's description and
 * handler, over that form's schema. The `flat` arm is built here too, not
 * taken from `createShowBlockTool`, so all three arms come from one code path;
 * `listedShowBlock` checks the selected shipped arm lists byte for byte what the
 * production factory lists.
 */
export function showBlockToolIn(arm: SchemaArm) {
  const schema = showBlockInputSchema(SCHEMA_ARMS[arm]);
  return sdk.tool(SHOW_BLOCK_TOOL_NAME, SHOW_BLOCK_DESCRIPTION, schema.shape, async (input) => {
    try {
      const payload = handleShowBlock(schema.parse(input));
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: err instanceof Error ? err.message : "show_block failed" }],
        isError: true,
      };
    }
  });
}

type SdkTool = Parameters<typeof sdk.createSdkMcpServer>[0]["tools"] extends (infer T)[] | undefined
  ? T
  : never;

/**
 * What a tool lists as over the Agent SDK's own in-process MCP server: the
 * `tools/list` serialisation the CLI forwards to the API as the tool's
 * `input_schema`.
 */
export async function listedTool(tool: SdkTool): Promise<{ description?: string; inputSchema: Json }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = sdk.createSdkMcpServer({ name: "brain-ui", version: "0.1.0", tools: [tool] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "show-block-schema-forms", version: "0.1.0" }, {});
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  const [listed] = tools;
  if (!listed) throw new Error("the SDK server listed no tool");
  return listed as { description?: string; inputSchema: Json };
}

/**
 * `show_block` as one arm lists it. Listing the shipped arm also lists the production
 * factory's tool and throws if the selected shipped arm differs. Historical
 * baseline options stay fixed when the shipped default changes.
 */
export async function listedShowBlock(arm: SchemaArm): Promise<{ description?: string; inputSchema: Json }> {
  const listed = await listedTool(showBlockToolIn(arm));
  if (JSON.stringify(SCHEMA_ARMS[arm]) === JSON.stringify(SHIPPED_SHOW_BLOCK_SCHEMA_FORM)) {
    const { createShowBlockTool } = await import("../packages/ui-backend-claude/src/show-block-tool.js");
    const shipped = await listedTool(createShowBlockTool());
    if (JSON.stringify(shipped) !== JSON.stringify(listed)) {
      throw new Error("the selected shipped arm no longer lists what createShowBlockTool lists");
    }
  }
  return listed;
}

/** The credential a live run uses, and the headers `count_tokens` needs for it. */
export interface LiveCredential {
  /** The variable it came from, named in every report. */
  readonly source: "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN";
  readonly headers: Record<string, string>;
}

/** Without it the Messages API rejects an OAuth token (`model-discovery.ts`'s `OAUTH_BETA`). */
export const OAUTH_BETA = "oauth-2025-04-20";

/**
 * An API key when one is set; otherwise the subscription token (#336's
 * ruling O1). The key wins because the key is what D43 and D44 ran on, and a
 * run that holds both should reproduce them. The SDK's `query()` reads the
 * same variables itself, so this choice only decides the `count_tokens`
 * headers and what the report names; each turn also records the
 * `apiKeySource` its `init` reported, which is the CLI's own account of it.
 */
export function liveCredential(env: Record<string, string | undefined> = process.env): LiveCredential | null {
  const base = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  const apiKey = env["ANTHROPIC_API_KEY"]?.trim();
  if (apiKey) return { source: "ANTHROPIC_API_KEY", headers: { ...base, "x-api-key": apiKey } };
  const oauth = env["CLAUDE_CODE_OAUTH_TOKEN"]?.trim();
  if (oauth) {
    return {
      source: "CLAUDE_CODE_OAUTH_TOKEN",
      headers: { ...base, authorization: `Bearer ${oauth}`, "anthropic-beta": OAUTH_BETA },
    };
  }
  return null;
}
