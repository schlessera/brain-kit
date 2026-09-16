/**
 * Tool component contracts (D3).
 *
 * One declaration per tool the chat surface can render as a component: the
 * name the model calls, the description it reads, the input schema it fills,
 * the one-line brief that tells it WHEN to call — and, for a tool whose result
 * the UI draws rather than prints, the PAYLOAD schema that result carries.
 *
 * React-free and free of node built-ins on purpose. The same object is
 * imported by the server (to build the tool definition and generate the prompt
 * brief) and by the browser (to bind a renderer and parse the payload), so it
 * must not drag either half into the other's bundle.
 *
 * The payload rides as JSON inside the existing `ServerToolResult.output`
 * string, which is already a string — no `PROTOCOL_REV` bump. That is a
 * convention this file ESTABLISHES rather than one it follows: before it, two
 * of the four bridge tools serialised a payload and the others did not.
 */

import { z } from "zod";

/** The backends that expose these tools, and how each one names them. */
export type ToolAdapter = "claude" | "pi";

/**
 * The Claude backend registers the bridge tools in an in-process MCP server
 * called `brain-ui`, so Claude sees them prefixed. pi registers plain names.
 */
export const BRIDGE_MCP_PREFIX = "mcp__brain-ui__";

/** The name a given adapter's model sees for a contract's tool. */
export function visibleToolName(name: string, adapter: ToolAdapter): string {
  return adapter === "claude" ? `${BRIDGE_MCP_PREFIX}${name}` : name;
}

/**
 * A tool the model can call. `brief` is not optional: a tool that is schema'd
 * but never described to the model is the failure this shape exists to make
 * unreachable, and the generated prompt section is built by walking the
 * contract list rather than by hand-maintaining a parallel one.
 */
export interface ToolContract<
  Name extends string = string,
  Input extends z.ZodObject = z.ZodObject,
> {
  readonly name: Name;
  readonly description: string;
  readonly input: Input;
  /**
   * The system-prompt line, given the name the model actually sees — which
   * differs per adapter, so the line cannot be a constant string.
   */
  readonly brief: (visibleName: string) => string;
}

/** A tool whose result the chat surface renders as a component. */
export interface ToolComponentContract<
  Name extends string = string,
  Input extends z.ZodObject = z.ZodObject,
  Payload extends z.ZodType = z.ZodType,
> extends ToolContract<Name, Input> {
  readonly payload: Payload;
}

/** Declare a tool contract, preserving the literal name and schema types. */
export function defineToolContract<
  Name extends string,
  Input extends z.ZodObject,
>(contract: ToolContract<Name, Input>): ToolContract<Name, Input> {
  return contract;
}

/** Declare a contract whose result a component renders. */
export function defineToolComponentContract<
  Name extends string,
  Input extends z.ZodObject,
  Payload extends z.ZodType,
>(
  contract: ToolComponentContract<Name, Input, Payload>
): ToolComponentContract<Name, Input, Payload> {
  return contract;
}

/** What a bound component receives: the parsed, validated payload. */
export type ToolPayload<Contract> =
  Contract extends ToolComponentContract<string, z.ZodObject, infer Payload>
    ? z.infer<Payload>
    : never;

/** What the model is handed as the tool's argument schema. */
export type ToolInput<Contract> =
  Contract extends ToolContract<string, infer Input> ? z.infer<Input> : never;

/**
 * JSON Schema for a tool's input — a contract, or a bare input schema — with
 * zod's `$schema` key removed, because every backend's tool-definition shape
 * wants the bare object. `io: "input"` is the house idiom: it describes what
 * the MODEL must send, so defaults and transforms are presented as optional
 * rather than as already-applied.
 */
export function toolInputJsonSchema(
  contract: ToolContract | z.ZodObject
): Record<string, unknown> {
  const schema = "input" in contract ? contract.input : contract;
  const { $schema: _schema, ...parameters } = z.toJSONSchema(schema, {
    io: "input",
  });
  return parameters;
}

/**
 * Parse a tool result's `output` string into the contract's payload.
 *
 * Returns null on anything unexpected — absent output, prose instead of JSON,
 * a shape the schema rejects, an errored call. A renderer that gets null falls
 * back to the generic view: a tool result is the least appropriate place to
 * throw, because the work already happened and the reader wants to see it. The
 * same reasoning as `fetchCoastline` degrading to an empty coastline.
 */
export function parseToolPayload<Contract extends ToolComponentContract>(
  contract: Contract,
  output: string | undefined
): ToolPayload<Contract> | null {
  if (typeof output !== "string" || output.trim() === "") return null;
  let json: unknown;
  try {
    json = JSON.parse(output);
  } catch {
    return null;
  }
  const parsed = contract.payload.safeParse(json);
  return parsed.success ? (parsed.data as ToolPayload<Contract>) : null;
}

/**
 * The prompt lines for the contracts this deployment actually exposes.
 *
 * `available` maps a contract to the name the model sees, or false when this
 * backend does not expose that tool at all — naming a tool the running backend
 * does not have is worse than saying nothing.
 */
export function toolBriefLines(
  contracts: readonly ToolContract[],
  available: (contract: ToolContract) => string | false | undefined
): string[] {
  const lines: string[] = [];
  for (const contract of contracts) {
    const name = available(contract);
    if (!name) continue;
    lines.push(contract.brief(name));
  }
  return lines;
}
