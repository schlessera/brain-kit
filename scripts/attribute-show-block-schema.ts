/**
 * Where `show_block`'s input schema spends its characters (#155, D47).
 *
 * D44 put the bridge tools in every prompt, and `show_block` is 5270 of the
 * 7335 tokens that costs. This splits the serialised schema into three parts,
 * per variant of the `block` union, so a proposal to shrink it can say which
 * part it is shrinking:
 *
 * - **prose** — every `description`, key and quotes included. Measured as the
 *   length of the variant minus the length of the same variant with every
 *   `description` removed.
 * - **repeated structure** — what is left of the variant, counted where a
 *   subschema also appears elsewhere in the union and is longer than a
 *   reference to it would be. Only the outermost such subschema is counted.
 * - **irreducible** — the rest: the shape the variant alone has.
 *
 * Only SCHEMA positions are candidates for "repeated": a property's schema, an
 * `items` schema, a member of `anyOf` / `oneOf` / `allOf`. An `enum` array or a
 * `properties` map repeats too, but a `$ref` cannot stand in for either.
 *
 * It needs no key and makes no network call. The schema is the one
 * `createBrainUiMcpServer` registers, listed over an in-memory MCP client —
 * the serialisation the CLI forwards, and the one `measure-show-block.ts
 * --tokens` prices. Token figures are a RANGE derived from D44's counted rows
 * (`CALIBRATION`), printed with the fit and its residuals; the counted figure
 * needs `ANTHROPIC_API_KEY` and `measure-show-block.ts --tokens`.
 *
 *   bun scripts/attribute-show-block-schema.ts           # the tables
 *   bun scripts/attribute-show-block-schema.ts --prose   # plus every description, with counts
 */

import { tmpdir } from "node:os";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/**
 * D44's five `count_tokens` rows, with the characters each tool carried at the
 * commit it was counted on (`2efd725e`, Agent SDK 0.3.278), listed the way
 * this script lists them. `chars` is the tool's description plus its input
 * schema, each as `JSON.stringify` writes it. The prefixed name, which D44's
 * count also included, is left out: it is 23-35 characters per tool and the
 * fit's intercept absorbs it.
 */
export const CALIBRATION = [
  { tool: "show_block", description: 2117, schema: 10653, tokens: 5270 },
  { tool: "ask_user", description: 684, schema: 1313, tokens: 756 },
  { tool: "query_activity", description: 905, schema: 525, tokens: 552 },
  { tool: "request_image_mask", description: 665, schema: 371, tokens: 383 },
  { tool: "get_current_location", description: 768, schema: 246, tokens: 374 },
] as const;

/** Ordinary least squares, `tokens = slope * chars + intercept`. */
export function fitLine(points: readonly { chars: number; tokens: number }[]): {
  slope: number;
  intercept: number;
} {
  const n = points.length;
  const meanX = points.reduce((sum, p) => sum + p.chars, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.tokens, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.chars - meanX) * (p.tokens - meanY);
    sxx += (p.chars - meanX) ** 2;
  }
  const slope = sxy / sxx;
  return { slope, intercept: meanY - slope * meanX };
}

/**
 * The fit over all five rows, its residuals, and the range of slopes a
 * leave-one-out refit gives. The slope is the marginal token cost of one more
 * character of tool definition, which is what a change to the schema moves;
 * the range is how far that rate moves when any one of the five rows is
 * dropped, and it is the honest width of every token figure this prints.
 */
export function calibrate() {
  const points = CALIBRATION.map((row) => ({
    tool: row.tool,
    chars: row.description + row.schema,
    tokens: row.tokens,
  }));
  const fit = fitLine(points);
  const slopes = [fit.slope];
  for (let skip = 0; skip < points.length; skip += 1) {
    slopes.push(fitLine(points.filter((_, index) => index !== skip)).slope);
  }
  return {
    ...fit,
    low: Math.min(...slopes),
    high: Math.max(...slopes),
    rows: points.map((p) => ({
      ...p,
      predicted: fit.slope * p.chars + fit.intercept,
      residual: p.tokens - (fit.slope * p.chars + fit.intercept),
    })),
  };
}

/**
 * The form Zod's draft-7 output gives a reference to a shared schema — the
 * form the shipped path emits, `allOf` wrapper included. A repeated subschema
 * no longer than this cannot be made shorter by sharing it. The id is five
 * characters, which is shorter than any real name would be.
 */
export const REF_FORM = JSON.stringify({ allOf: [{ $ref: "#/definitions/xxxxx" }] });

function isObject(node: Json): node is JsonObject {
  return node !== null && typeof node === "object" && !Array.isArray(node);
}

/** The same tree with every `description` removed. */
export function stripProse(node: Json): Json {
  if (Array.isArray(node)) return node.map(stripProse);
  if (isObject(node)) {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "description" && typeof value === "string") continue;
      out[key] = stripProse(value);
    }
    return out;
  }
  return node;
}

/**
 * The subschemas directly under `schema`: the positions where a `$ref` could
 * replace what is there.
 */
export function childSchemas(schema: Json): JsonObject[] {
  if (!isObject(schema)) return [];
  const out: JsonObject[] = [];
  const add = (node: Json | undefined) => {
    if (node !== undefined && isObject(node)) out.push(node);
  };
  if (isObject(schema.properties)) Object.values(schema.properties).forEach(add);
  if (Array.isArray(schema.items)) schema.items.forEach(add);
  else add(schema.items);
  add(schema.additionalProperties);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const members = schema[key];
    if (Array.isArray(members)) members.forEach(add);
  }
  return out;
}

/** Every subschema strictly below `root`, serialised. */
function subschemas(root: Json, into: string[] = []): string[] {
  for (const child of childSchemas(root)) {
    into.push(JSON.stringify(child));
    subschemas(child, into);
  }
  return into;
}

/**
 * The subschemas that occur more than once across `roots` and are longer than
 * `REF_FORM`, with how often each occurs.
 */
export function repeatedShapes(roots: readonly Json[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const root of roots) {
    for (const shape of subschemas(root)) counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  for (const [shape, count] of counts) {
    if (count < 2 || shape.length <= REF_FORM.length) counts.delete(shape);
  }
  return counts;
}

/** The outermost subschemas of `root` that are in `shapes`. */
export function outermost(root: Json, shapes: ReadonlyMap<string, number>): string[] {
  return childSchemas(root).flatMap((child) => {
    const serialised = JSON.stringify(child);
    return shapes.has(serialised) ? [serialised] : outermost(child, shapes);
  });
}

export interface VariantRow {
  kind: string;
  chars: number;
  prose: number;
  repeated: number;
  irreducible: number;
}

/**
 * Split each variant into prose, repeated structure and irreducible shape.
 * `irreducible` is what the other two leave, so the columns sum to `chars`;
 * the other two are measured.
 */
export function attribute(variants: readonly Json[]): {
  rows: VariantRow[];
  shapes: Map<string, number>;
} {
  const skeletons = variants.map(stripProse);
  const shapes = repeatedShapes(skeletons);
  const rows = variants.map((variant, index) => {
    const skeleton = skeletons[index]!;
    const chars = JSON.stringify(variant).length;
    const prose = chars - JSON.stringify(skeleton).length;
    const repeated = outermost(skeleton, shapes).reduce((sum, shape) => sum + shape.length, 0);
    return { kind: kindOf(variant), chars, prose, repeated, irreducible: chars - prose - repeated };
  });
  return { rows, shapes };
}

/**
 * `root` with every outermost repeated subschema of its union moved into a
 * `definitions` table and referenced in Zod's draft-7 form — descriptions
 * included, because a shared definition carries its description with it. A
 * shape is shared only when sharing it makes the schema shorter.
 */
export function shareDefinitions(root: Json): JsonObject {
  const variants = variantsOf(root);
  const refLength = (id: string) =>
    JSON.stringify({ allOf: [{ $ref: `#/definitions/${id}` }] }).length;
  const candidates = repeatedShapes(variants);
  const shared = new Map<string, string>();
  for (const [shape, count] of candidates) {
    const id = `s${shared.size}`;
    // Each site becomes a reference; one copy moves into the table under its
    // key, with a comma between entries.
    const after = count * refLength(id) + `"${id}":`.length + shape.length + 1;
    if (after < count * shape.length) shared.set(shape, id);
  }
  const replace = (schema: Json): Json => {
    if (!isObject(schema)) return schema;
    const serialised = JSON.stringify(schema);
    const id = shared.get(serialised);
    if (id !== undefined) return { allOf: [{ $ref: `#/definitions/${id}` }] };
    const out: JsonObject = { ...schema };
    if (isObject(schema.properties)) {
      out.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([key, value]) => [key, replace(value)])
      );
    }
    if (schema.items !== undefined) {
      out.items = Array.isArray(schema.items) ? schema.items.map(replace) : replace(schema.items);
    }
    if (isObject(schema.additionalProperties)) out.additionalProperties = replace(schema.additionalProperties);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const members = schema[key];
      if (Array.isArray(members)) out[key] = members.map(replace);
    }
    return out;
  };
  const transformed = replace(root) as JsonObject;
  // Sharing a shape can hide a shorter repeat nested in it, so only the
  // shapes the transformed tree still references go in the table.
  const used = new Set(JSON.stringify(transformed).match(/#\/definitions\/s\d+/g) ?? []);
  const definitions: JsonObject = {};
  for (const [shape, id] of shared) {
    if (used.has(`#/definitions/${id}`)) definitions[id] = JSON.parse(shape) as Json;
  }
  return Object.keys(definitions).length > 0 ? { ...transformed, definitions } : transformed;
}

/** `schema` with every `#/definitions/<id>` reference replaced by its target. */
export function dereference(schema: JsonObject): Json {
  const definitions = isObject(schema.definitions) ? schema.definitions : {};
  const walk = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const members = node.allOf;
    if (Object.keys(node).length === 1 && Array.isArray(members) && members.length === 1) {
      const ref = isObject(members[0]!) ? members[0].$ref : undefined;
      if (typeof ref === "string" && ref.startsWith("#/definitions/")) {
        return walk(definitions[ref.slice("#/definitions/".length)]!);
      }
    }
    return Object.fromEntries(
      Object.entries(node).filter(([key]) => key !== "definitions").map(([key, value]) => [key, walk(value)])
    );
  };
  return walk(schema);
}

/**
 * How many characters `shareDefinitions` takes out of `root`: the length of
 * the schema before, less the length after. Short ids (`s0`, `s1`, …), so a
 * real set of names costs a few characters more per site.
 */
export function sharingSaving(root: Json): number {
  return JSON.stringify(root).length - JSON.stringify(shareDefinitions(root)).length;
}

function kindOf(variant: Json): string {
  const kind = (variant as { properties?: { kind?: { const?: string } } }).properties?.kind?.const;
  return typeof kind === "string" ? kind : "?";
}

/** The `block` union's variants, in the order the schema lists them. */
export function variantsOf(inputSchema: Json): Json[] {
  const block = (inputSchema as { properties?: { block?: { oneOf?: Json[] } } }).properties?.block;
  if (!block?.oneOf) throw new Error("show_block's schema has no `block.oneOf`: the union moved.");
  return block.oneOf;
}

/** Every description string under `node`, with how often it occurs. */
export function descriptions(node: Json, into = new Map<string, number>()): Map<string, number> {
  if (Array.isArray(node)) for (const child of node) descriptions(child, into);
  else if (isObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "description" && typeof value === "string") into.set(value, (into.get(value) ?? 0) + 1);
      else descriptions(value, into);
    }
  }
  return into;
}

/** The bridge tools as the server registers them, every handler supplied. */
export async function listBridgeTools(): Promise<{ name: string; description?: string; inputSchema: Json }[]> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createBrainUiMcpServer } = await import(
    "../packages/ui-backend-claude/src/ask-user-tool.js"
  );
  // A handler the host does not pass is a tool never registered, so all of
  // them are supplied. None is ever called, so nothing is written to the path.
  const unreachable = () => Promise.reject(new Error("not called"));
  const server = createBrainUiMcpServer({
    askUser: unreachable as never,
    getLocation: unreachable as never,
    requestMask: unreachable as never,
    queryActivity: unreachable as never,
    brainPath: tmpdir(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "attribute-show-block-schema", version: "0.1.0" }, {});
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools as { name: string; description?: string; inputSchema: Json }[];
}

async function main(): Promise<void> {
  const tools = await listBridgeTools();
  const tool = tools.find((entry) => entry.name === "show_block");
  if (!tool) throw new Error("createBrainUiMcpServer registered no show_block.");
  const schema = tool.inputSchema;
  const variants = variantsOf(schema);
  const { rows, shapes } = attribute(variants);
  const calibration = calibrate();
  const range = (chars: number) =>
    `${Math.round(chars * calibration.low)}–${Math.round(chars * calibration.high)}`;
  const schemaChars = JSON.stringify(schema).length;
  const unionChars = JSON.stringify(variants).length;
  const descriptionChars = JSON.stringify(tool.description ?? "").length;
  const sum = (pick: (row: VariantRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const refs = JSON.stringify(schema).match(/"\$ref"|"\$defs"|"definitions"/g)?.length ?? 0;
  const shared = shareDefinitions(schema);
  if (JSON.stringify(dereference(shared)) !== JSON.stringify(schema)) {
    throw new Error("shareDefinitions changed the schema: dereferencing it does not give it back.");
  }
  const saving = sharingSaving(schema);
  const fmt = (value: number, digits: number) => value.toFixed(digits);

  const lines = [
    "# Where `show_block`'s schema spends its characters",
    "",
    `Taken ${new Date().toISOString().slice(0, 10)} from the schema \`createBrainUiMcpServer\` registers.`,
    "",
    `Input schema ${schemaChars} characters, of which the \`block\` union is ${unionChars}. \`$ref\` / \`$defs\` / \`definitions\` keys in it: ${refs}. The tool description, which the model also reads, is another ${descriptionChars}.`,
    "",
    `Token figures are ESTIMATES, a range: characters times ${fmt(calibration.low, 3)}–${fmt(calibration.high, 3)}, the fitted marginal rate and how far it moves when any one calibration row is left out (see the calibration table below). \`measure-show-block.ts --tokens\` is the counted figure.`,
    "",
    "| variant | chars | prose | repeated structure | irreducible | ≈ tokens |",
    "| --- | --- | --- | --- | --- | --- |",
    ...[...rows]
      .sort((a, b) => b.chars - a.chars)
      .map(
        (row) =>
          `| \`${row.kind}\` | ${row.chars} | ${row.prose} | ${row.repeated} | ${row.irreducible} | ${range(row.chars)} |`
      ),
    `| **all ${rows.length}** | **${sum((r) => r.chars)}** | **${sum((r) => r.prose)}** | **${sum((r) => r.repeated)}** | **${sum((r) => r.irreducible)}** | **${range(sum((r) => r.chars))}** |`,
    "",
    `Repeated structure is counted on the variants with their descriptions removed, only at schema positions, and only where a subschema is longer than a reference to it (${REF_FORM.length} characters, \`${REF_FORM}\`). The shapes:`,
    "",
    "| shape | occurrences | chars each |",
    "| --- | --- | --- |",
    ...[...shapes]
      .filter(([shape]) => variants.some((variant) => outermost(stripProse(variant), shapes).includes(shape)))
      .sort((a, b) => b[0].length * b[1] - a[0].length * a[1])
      .map(([shape, count]) => {
        const preview = shape.length > 70 ? `${shape.slice(0, 67)}...` : shape;
        return `| \`${preview.replaceAll("|", "\\|")}\` | ${count} | ${shape.length} |`;
      }),
    "",
    `Moving every repeated subschema, descriptions included, into a \`definitions\` table and referencing it the way Zod's draft-7 output does takes the schema from ${schemaChars} to ${JSON.stringify(shared).length} characters: **${saving}** fewer (≈ ${range(saving)} tokens). That is a transform of the listed JSON, checked by dereferencing it back to the original, with two-character ids; what Zod emits for a chosen set of ids is the number to quote.`,
    "",
    "## Calibration",
    "",
    `D44's counted rows against the characters each tool carried at \`2efd725e\` (description plus input schema; the prefixed name is left to the intercept). Fit: **tokens = ${fmt(calibration.slope, 4)} × chars ${calibration.intercept < 0 ? "−" : "+"} ${fmt(Math.abs(calibration.intercept), 1)}**. Leave-one-out slopes run ${fmt(calibration.low, 4)}–${fmt(calibration.high, 4)}; the low end is the fit without \`show_block\`, the only large row.`,
    "",
    "| tool | chars | counted tokens | fitted | residual |",
    "| --- | --- | --- | --- | --- |",
    ...calibration.rows.map(
      (row) =>
        `| \`${row.tool}\` | ${row.chars} | ${row.tokens} | ${fmt(row.predicted, 0)} | ${fmt(row.residual, 0)} |`
    ),
    "",
    "Limits, which apply to every token figure above: five rows; one of them carries most of the leverage; the API renders a tool in its own format rather than as this JSON, so a character is a proxy; and a marginal rate assumes the characters removed tokenise like the average character of these five tools.",
    "",
  ];

  if (process.argv.includes("--prose")) {
    lines.push("| description | occurrences | chars each |", "| --- | --- | --- |");
    for (const [text, count] of [...descriptions(schema)].sort(
      (a, b) => JSON.stringify(b[0]).length * b[1] - JSON.stringify(a[0]).length * a[1]
    )) {
      lines.push(`| ${text.replaceAll("|", "\\|")} | ${count} | ${JSON.stringify(text).length + '"description":,'.length} |`);
    }
    lines.push("");
  }
  console.log(lines.join("\n"));
}

if (import.meta.main) await main();
