/**
 * The application-routing layer (#2517): each brain application operation
 * becomes a tool that sends its input to the server's authoritative
 * `applyBrain`, falling back to the legacy in-process tool of the same name
 * only when the turn has no server route. `brain_read_base` supplies the
 * same-turn base a routed write needs.
 */
import type { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { brainApplicationInput, brainReadBaseInput, brainReadBaseResult, BRAIN_APPLICATION_TOOLS, BRAIN_APPLICATION_DESCRIPTIONS,
  BRAIN_READ_BASE_DESCRIPTION, type BackendBridge, type BrainReadBaseInput } from "@schlessera/brain-ui-sdk/server";

import { toPiParameters } from "./bridge-tools.js";
import { textResult, type BrainToolKit } from "./tool-kit.js";

type ApplicationSchema = (typeof brainApplicationInput.options)[number];

/** The routed application tools, in schema order; a direct-write roster keeps its own write and edit. */
export function routedApplicationTools(kit: BrainToolKit, tools: readonly ToolDefinition[]): ToolDefinition[] {
  const { deps } = kit;
  return brainApplicationInput.options.filter(schema => !deps.directWrites || !["write", "edit"].includes(schema.shape.operation.value)).map(schema => routedApplicationTool(kit, schema, tools));
}

/** One application operation's routed tool; `tools` supplies the legacy tool it replaces. */
export function routedApplicationTool(kit: BrainToolKit, schema: ApplicationSchema, tools: readonly ToolDefinition[]): ToolDefinition {
  const { turn, bases } = kit;
  const operation = schema.shape.operation.value;
  const name = BRAIN_APPLICATION_TOOLS[operation];
  const legacy = tools.find(t => t.name === name);
  const shape = (schema as z.ZodObject).omit({ operation: true });
  // Existing pi inputs gain an optional base; a preceding read in this
  // same turn supplies it when absent. No read receipt crosses turns.
  const parameters = "expectedBaseHash" in shape.shape
    ? shape.extend({ expectedBaseHash: brainApplicationInput.options[0].shape.expectedBaseHash.optional() }) : shape;
  return {
    name, label: legacy?.label ?? "Apply staged changes", description: BRAIN_APPLICATION_DESCRIPTIONS[operation],
    parameters: toPiParameters(parameters),
    async execute(id: string, params: Record<string, unknown>, signal, onUpdate, ctx) {
      const bridge = turn.bridge;
      if (!bridge?.applyBrain) {
        if (!legacy) throw new Error("No authoritative server application route is available for this turn.");
        return legacy.execute(id, params, signal, onUpdate, ctx);
      }
      const input = { ...params, operation };
      if ("expectedBaseHash" in schema.shape && params.expectedBaseHash === undefined && typeof params.path === "string") {
        const receipt = bases.get(bridge)?.get(params.path);
        if (receipt === undefined && operation !== "write") throw new Error("Read brain_read_base or read_file first and use that document's exact base hash.");
        Object.assign(input, { expectedBaseHash: receipt ?? null });
      }
      const pending = bridge.applyBrain(input as Parameters<NonNullable<BackendBridge["applyBrain"]>>[0]);
      turn.pendingMutations?.add(pending);
      let result;
      try { result = await pending; }
      finally { turn.pendingMutations?.delete(pending); }
      if (!result.ok) throw new Error(JSON.stringify(result));
      return textResult(JSON.stringify(result), result);
    },
  } satisfies ToolDefinition;
}

/** `brain_read_base`: the server's base of one document, remembered for this turn's writes. */
export function brainReadBaseTool(kit: BrainToolKit): ToolDefinition {
  const { turn, rememberHash } = kit;
  return {
    name: "brain_read_base", label: "Read document base",
    description: BRAIN_READ_BASE_DESCRIPTION,
    parameters: toPiParameters(brainReadBaseInput),
    async execute(_id: string, params: BrainReadBaseInput) {
      if (!turn.bridge?.readBrainBase) throw new Error("No server document-base reader is available.");
      const base = await turn.bridge.readBrainBase(params.path);
      rememberHash(params.path, base.expectedBaseHash);
      const result = brainReadBaseResult(base, { offset: params.offset, limit: params.limit, column: params.column });
      return textResult(JSON.stringify(result), result);
    },
  } satisfies ToolDefinition;
}
