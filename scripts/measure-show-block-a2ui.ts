/**
 * #4507 token measurement. Set up the pinned spike dependencies outside the checkout:
 *
 *   bun install --frozen-lockfile
 *   npm install --prefix /tmp/brain-kit-a2ui --ignore-scripts --save-exact \
 *     @a2ui/agent@0.2.1 @a2ui/web_core@0.16.1 ajv@8.20.0 ajv-formats@3.0.1
 *   bun scripts/measure-show-block-a2ui.ts /tmp/brain-kit-a2ui --validate > /tmp/brain-kit-a2ui/inputs.json
 *   bun scripts/measure-show-block-a2ui.ts /tmp/brain-kit-a2ui
 *
 * --validate emits the catalog and samples without an Anthropic credential.
 * Counting uses the free count_tokens endpoint and runs no inference.
 */
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";

import {
  SHOW_BLOCK_INPUT_SCHEMA, SHOW_BLOCK_TOOL_NAME as CLAUDE_TOOL_NAME,
} from "../packages/ui-backend-claude/src/show-block-tool.js";
import { BLOCKS } from "../packages/ui-react/tests/block-fixtures.js";
import { BLOCK_KINDS, SHOW_BLOCK_TOOL_NAME } from "../packages/ui-sdk/src/tool-contracts/blocks.js";
import { listBridgeTools, type Json, type JsonObject } from "./attribute-show-block-schema.ts";
import { liveCredential, type LiveCredential } from "./show-block-schema-forms.ts";

const MODEL = "claude-sonnet-5-5";
const VERSION = "1.0";
const CATALOG_ID = "https://example.org/brain-kit/show-block/catalog.json";
const CATALOG_SCHEMA = "https://a2ui.org/specification/v1_0/catalog_definition.json";

type ListedSchema = {
  definitions?: Record<string, JsonObject>;
  properties: {
    block: { oneOf: Array<{ type: string; properties: Record<string, JsonObject>; required: string[] }> };
  };
};

/** Translate the shared references and tuple syntax from draft-07 to 2020-12. */
function catalogSchema(schema: Json): Json {
  if (Array.isArray(schema)) return schema.map(catalogSchema);
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema.items)) {
    const { items, additionalItems, ...rest } = schema;
    return catalogSchema({ ...rest, prefixItems: items, items: additionalItems ?? true });
  }
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [
    key,
    key === "$ref" && typeof value === "string"
      ? value.replace(/^#\/definitions\//, "#/$defs/")
      : catalogSchema(value),
  ]));
}

function makeCatalog(input: ListedSchema, description: string) {
  const components = Object.fromEntries(input.properties.block.oneOf.map((variant) => {
    const { kind, ...properties } = variant.properties;
    const name = kind?.const;
    assert(typeof name === "string", "A block variant must have a kind");
    return [name, {
      type: variant.type,
      properties: { component: { const: name }, ...catalogSchema(properties) as JsonObject },
      required: variant.required.map((key) => key === "kind" ? "component" : key),
    }];
  }));
  assert.deepEqual(Object.keys(components), BLOCK_KINDS);
  return {
    $schema: CATALOG_SCHEMA,
    $id: CATALOG_ID,
    protocolVersion: VERSION,
    catalogId: CATALOG_ID,
    title: "Brain-kit answer blocks",
    instructions: [
      "In the guidance below, calling a block means emitting a component and kind means its component name.",
      description,
    ].join("\n\n"),
    $defs: {
      ...catalogSchema(input.definitions ?? {}) as JsonObject,
      anyComponent: {
        oneOf: Object.keys(components).map((name) => ({ $ref: `#/components/${name}` })),
        discriminator: { propertyName: "component" },
      },
      anyFunction: { not: {} },
    },
    components,
    functions: {},
  };
}

async function countTokens(credential: LiveCredential, body: Record<string, unknown> = {}): Promise<number> {
  const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: credential.headers,
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], ...body }),
  });
  if (!response.ok) throw new Error(`count_tokens HTTP ${response.status} via ${credential.source}`);
  const result = await response.json() as { input_tokens?: number };
  assert(typeof result.input_tokens === "number" && Number.isInteger(result.input_tokens));
  return result.input_tokens;
}

const [dependencyDir, option] = process.argv.slice(2);
assert(dependencyDir && (!option || option === "--validate"),
  "Usage: bun scripts/measure-show-block-a2ui.ts <spike-dependency-directory> [--validate]");
const deps = resolve(dependencyDir);
const sdk = await import(Bun.resolveSync("@a2ui/agent", deps));
const { default: Ajv2020 } = await import(Bun.resolveSync("ajv/dist/2020.js", deps));
const { default: addFormats } = await import(Bun.resolveSync("ajv-formats", deps));
const schemaDir = join(dirname(Bun.resolveSync("@a2ui/web_core", deps)), "v1_0/schemas");

const listed = (await listBridgeTools()).find(({ name }) => name === SHOW_BLOCK_TOOL_NAME);
assert(listed?.description, "The bridge server did not list show_block with a description");
const catalog = makeCatalog(listed.inputSchema as unknown as ListedSchema, listed.description);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(await Bun.file(join(schemaDir, "common_types.json")).json());
const checkCatalog = ajv.compile(await Bun.file(join(schemaDir, "catalog_definition.json")).json());
assert(checkCatalog(catalog), ajv.errorsText(checkCatalog.errors));

const activeCatalogs = [new sdk.InMemoryCatalogProvider(catalog).load()];
const directPrompt = new sdk.DirectJsonPromptGenerator(activeCatalogs).generate();
const express = new sdk.ExpressFormat(activeCatalogs);
const expressPrompt = express.promptGenerator.generate();
const parser = express.createParser();
const samples = [
  BLOCKS.comparison,
  BLOCKS.trend,
  BLOCKS.table,
  BLOCKS.steps,
  BLOCKS.quote,
  BLOCKS.graph,
].map((fixture) => {
  const showBlock = SHOW_BLOCK_INPUT_SCHEMA.parse({ block: fixture });
  const { kind, ...fields } = showBlock.block;
  const wire = {
    version: VERSION,
    createSurface: {
      surfaceId: "main",
      catalogId: CATALOG_ID,
      components: [{ id: "root", component: kind, ...fields }],
    },
  };
  sdk.validatePayload(activeCatalogs, [wire]);
  const dsl = parser.decompile([wire]);
  const compiled = parser.compile(dsl);
  sdk.validatePayload(activeCatalogs, compiled);
  assert.deepEqual(compiled, [wire], `${kind} changed on Express round-trip`);
  return { kind, showBlock, wire, express: dsl };
});

if (option === "--validate") {
  console.log(JSON.stringify({ catalog, directPrompt, expressPrompt, samples }, null, 2));
} else {
  const credential = liveCredential();
  assert(credential, "Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN for count_tokens");
  const count = (body?: Record<string, unknown>) => countTokens(credential, body);

  // Same tools, user turn, and model as measure-show-block.ts --tokens.
  const floorTools = [
    { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
    { name: "noop", description: "An undeferred tool, so the request is legal.",
      input_schema: { type: "object", properties: {} } },
  ];
  const tool = { name: CLAUDE_TOOL_NAME, description: listed.description, input_schema: listed.inputSchema };
  const promptFloor = await count({ tools: floorTools });
  const promptTokens = {
    showBlock: await count({ tools: [...floorTools, tool] }) - promptFloor,
    // Direct JSON's generated prompt already includes the serialized catalog.
    direct: await count({ tools: floorTools, system: directPrompt }) - promptFloor,
    // Express emits compact signatures. Include the raw catalog for the requested arm.
    express: await count({ tools: floorTools, system: `${expressPrompt}\n\n${JSON.stringify(catalog)}` }) - promptFloor,
    expressSdkOnly: await count({ tools: floorTools, system: expressPrompt }) - promptFloor,
  };

  // count_tokens counts input text. Hold the message framing and separator
  // fixed and measure each raw payload as a suffix, an output-token proxy.
  const outputInput = (payload = "") => ({ messages: [{ role: "user", content: `hi\n\n${payload}` }] });
  const outputFloor = await count(outputInput());
  const output = [];
  const totals = { showBlock: 0, wire: 0, express: 0 };
  for (const sample of samples) {
    const row = {
      showBlock: await count(outputInput(JSON.stringify(sample.showBlock))) - outputFloor,
      wire: await count(outputInput(JSON.stringify(sample.wire))) - outputFloor,
      express: await count(outputInput(sample.express)) - outputFloor,
    };
    output.push({ kind: sample.kind, ...row });
    for (const encoding of Object.keys(row) as Array<keyof typeof row>) totals[encoding] += row[encoding];
  }
  console.log(JSON.stringify({
    model: MODEL, date: new Date().toISOString().slice(0, 10), credential: credential.source,
    promptFloor, promptTokens, outputFloor, output, totals,
  }, null, 2));
}
