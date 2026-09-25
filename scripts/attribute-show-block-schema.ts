/**
 * Where `show_block`'s input schema spends its characters (#155).
 *
 * D44 put the bridge tools in every prompt, and `show_block` is 5270 of the
 * 7335 tokens that costs. This splits the serialised schema into three parts,
 * per variant of the `block` union, so a proposal to shrink it can say which
 * part it is shrinking:
 *
 * - **prose** — every `description`, key and quotes included. Measured as the
 *   length of the variant minus the length of the same variant with every
 *   `description` removed, so the three parts always sum to the total.
 * - **repeated structure** — what is left of the variant, counted where a
 *   subtree also appears elsewhere in the union and is long enough that a
 *   `$ref` to one shared copy would be shorter than it. Only the outermost such
 *   subtree is counted, so nothing is counted twice.
 * - **irreducible** — the rest: the shape the variant alone has.
 *
 * It needs no key and makes no network call. The schema is the one
 * `createBrainUiMcpServer` registers, listed over an in-memory MCP client —
 * the serialisation the CLI forwards, and the one `measure-show-block.ts
 * --tokens` prices. Token figures here are ESTIMATES: characters times the
 * rates fitted to D44's `count_tokens` figures (`TOKENS_PER_CHAR`). The
 * counted figure needs `ANTHROPIC_API_KEY` and `measure-show-block.ts
 * --tokens`.
 *
 *   bun scripts/attribute-show-block-schema.ts           # the tables
 *   bun scripts/attribute-show-block-schema.ts --prose   # plus every description, with counts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Tokens per serialised character, fitted by least squares to D44's five
 * `count_tokens` rows (`show_block` 5270, `ask_user` 756, `query_activity`
 * 552, `request_image_mask` 383, `get_current_location` 374) against the
 * schemas the server registered at that commit, `2efd725e`, split into
 * description text and everything else. The fit reproduces each of the five
 * counted rows to within 22 tokens. Five rows is a small sample, and the two
 * rates are close enough that the split between them is not well determined:
 * read an estimate here to two significant figures, not four.
 */
export const TOKENS_PER_CHAR = { prose: 0.429, structure: 0.404 } as const;

/**
 * The form Zod's draft-7 output gives a reference to a shared schema — the
 * form the shipped path emits, `allOf` wrapper included. A repeated subtree
 * no longer than this cannot be made shorter by sharing it. The id is five
 * characters, which is shorter than any real name would be.
 */
export const REF_FORM = JSON.stringify({ allOf: [{ $ref: "#/definitions/xxxxx" }] });

/** The same tree with every `description` removed. */
export function stripProse(node: Json): Json {
  if (Array.isArray(node)) return node.map(stripProse);
  if (node !== null && typeof node === "object") {
    const out: { [key: string]: Json } = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "description" && typeof value === "string") continue;
      out[key] = stripProse(value);
    }
    return out;
  }
  return node;
}

/** Every object or array strictly below `root`, serialised. */
function subtrees(root: Json, into: string[] = [], isRoot = true): string[] {
  if (root === null || typeof root !== "object") return into;
  if (!isRoot) into.push(JSON.stringify(root));
  for (const child of Array.isArray(root) ? root : Object.values(root)) {
    subtrees(child, into, false);
  }
  return into;
}

/**
 * The subtrees that occur more than once across `roots` and are longer than
 * `REF_FORM`, with how often each occurs.
 */
export function repeatedShapes(roots: readonly Json[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const root of roots) {
    for (const shape of subtrees(root)) counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  for (const [shape, count] of counts) {
    if (count < 2 || shape.length <= REF_FORM.length) counts.delete(shape);
  }
  return counts;
}

/** The outermost subtrees of `root` that are in `shapes`. */
export function outermost(root: Json, shapes: ReadonlyMap<string, number>, isRoot = true): string[] {
  if (root === null || typeof root !== "object") return [];
  const serialised = JSON.stringify(root);
  if (!isRoot && shapes.has(serialised)) return [serialised];
  return (Array.isArray(root) ? root : Object.values(root)).flatMap((child) =>
    outermost(child, shapes, false)
  );
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
 * The three always sum to `chars`.
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
 * The most a `definitions` table could take out of `root`: for each outermost
 * repeated subtree, every copy but one, less a reference at each use site and
 * the definition's own key. Measured on the tree as serialised, descriptions
 * included, because a shared definition carries its description with it.
 */
export function sharingBound(root: Json): number {
  const variants = variantsOf(root);
  const shapes = repeatedShapes(variants);
  const sites = new Map<string, number>();
  for (const variant of variants) {
    for (const shape of outermost(variant, shapes)) sites.set(shape, (sites.get(shape) ?? 0) + 1);
  }
  let saved = 0;
  for (const [shape, count] of sites) {
    if (count < 2) continue;
    // `"xxxxx":` in the table, and the comma between entries.
    const entry = '"xxxxx":,'.length;
    saved += Math.max(0, (count - 1) * shape.length - count * REF_FORM.length - entry);
  }
  return saved;
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
  else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "description" && typeof value === "string") into.set(value, (into.get(value) ?? 0) + 1);
      else descriptions(value, into);
    }
  }
  return into;
}

function tokens(prose: number, structure: number): number {
  return Math.round(prose * TOKENS_PER_CHAR.prose + structure * TOKENS_PER_CHAR.structure);
}

/** The bridge tools as the server registers them, every handler supplied. */
export async function listBridgeTools(): Promise<{ name: string; description?: string; inputSchema: Json }[]> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createBrainUiMcpServer } = await import(
    "../packages/ui-backend-claude/src/ask-user-tool.js"
  );
  // A handler the host does not pass is a tool never registered, so all of
  // them are supplied. None is ever called.
  const unreachable = () => Promise.reject(new Error("not called"));
  const server = createBrainUiMcpServer({
    askUser: unreachable as never,
    getLocation: unreachable as never,
    requestMask: unreachable as never,
    queryActivity: unreachable as never,
    brainPath: mkdtempSync(join(tmpdir(), "attribute-show-block-")),
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
  const schemaChars = JSON.stringify(schema).length;
  const unionChars = JSON.stringify(variants).length;
  const descriptionChars = JSON.stringify(tool.description ?? "").length;
  const sum = (pick: (row: VariantRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const refs = JSON.stringify(schema).match(/"\$ref"|"\$defs"|"definitions"/g)?.length ?? 0;

  const lines = [
    "# Where `show_block`'s schema spends its characters",
    "",
    `Taken ${new Date().toISOString().slice(0, 10)} from the schema \`createBrainUiMcpServer\` registers. Tokens are estimates at ${TOKENS_PER_CHAR.prose} per prose character and ${TOKENS_PER_CHAR.structure} per structure character (D44's counts, fitted); \`measure-show-block.ts --tokens\` is the counted figure.`,
    "",
    `Input schema ${schemaChars} characters, of which the \`block\` union is ${unionChars}. \`$ref\` / \`$defs\` / \`definitions\` keys in it: ${refs}. The tool description, which the model also reads, is another ${descriptionChars}.`,
    "",
    "| variant | chars | prose | repeated structure | irreducible | ≈ tokens |",
    "| --- | --- | --- | --- | --- | --- |",
    ...[...rows]
      .sort((a, b) => b.chars - a.chars)
      .map(
        (row) =>
          `| \`${row.kind}\` | ${row.chars} | ${row.prose} | ${row.repeated} | ${row.irreducible} | ${tokens(row.prose, row.repeated + row.irreducible)} |`
      ),
    `| **all ${rows.length}** | **${sum((r) => r.chars)}** | **${sum((r) => r.prose)}** | **${sum((r) => r.repeated)}** | **${sum((r) => r.irreducible)}** | **${tokens(sum((r) => r.prose), sum((r) => r.repeated + r.irreducible))}** |`,
    "",
    `Repeated structure is counted on the variants with their descriptions removed, and only where a subtree is longer than a reference to it (${REF_FORM.length} characters, \`${REF_FORM}\`). The shapes:`,
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
    `What a shared \`definitions\` table could take out of the union if every repeated subtree were given an id, descriptions included: **${sharingBound(schema)}** characters (≈ ${Math.round(sharingBound(schema) * TOKENS_PER_CHAR.structure)} tokens). An estimate, at a five-character id per definition; what Zod actually emits for a given set of ids is the number to quote.`,
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
