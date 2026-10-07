/**
 * `show_block`'s schema forms, asserted (#336, D47).
 *
 * The forms exist so that the A/B in `measure-show-block.ts --schema-forms`
 * measures exactly what would ship. That is only worth something if three
 * things hold, and each is asserted here rather than argued:
 *
 * - **What ships has not moved.** The shipped form lists with no
 *   `definitions`, and the `flat` arm lists what the production factory lists.
 * - **Every form accepts exactly what the shipped form accepts.** The kit's
 *   own fixtures, one per kind, and a set of payloads each form must refuse,
 *   parse identically through all of them: the same verdict, the same output,
 *   the same issues. This is the proof the issue's "Contract impact" asks for.
 * - **Each form says what it claims to.** `shared` puts `tone`, `valueTone`
 *   and `icon` under `definitions` and dereferences back to the flat schema;
 *   `shared-trimmed` drops only the restated descriptions.
 *
 * Keyless: the schemas are listed over the Agent SDK's own in-process MCP
 * server, the serialisation the CLI forwards, and nothing is sent anywhere.
 */

import { describe, expect, test } from "bun:test";

import {
  BLOCK_KINDS,
  SHIPPED_SHOW_BLOCK_SCHEMA_FORM,
  SHOW_BLOCK_INPUT_SCHEMA,
  showBlockInputSchema,
} from "../packages/ui-sdk/src/tool-contracts/blocks.ts";
import { BLOCKS, SUGGESTIONS } from "../packages/ui-react/tests/block-fixtures.ts";
import { dereference, descriptions, type Json, type JsonObject } from "../scripts/attribute-show-block-schema.ts";
import {
  liveCredential,
  listedShowBlock,
  OAUTH_BETA,
  SCHEMA_ARM_NAMES,
  SCHEMA_ARMS,
} from "../scripts/show-block-schema-forms.ts";

const FIXTURES: unknown[] = [...Object.values(BLOCKS), SUGGESTIONS];

/**
 * Payloads every form must refuse. Each one breaks a field the forms write
 * differently, or a rule next to one, so a form that loosened a shared field
 * would accept it.
 */
const REFUSED: Record<string, unknown> = {
  "a valueTone outside the set": { kind: "stats", tiles: [{ label: "Crew", value: "600", tone: "crimson" }] },
  "an ink tone where only an accent is allowed": { kind: "trend", values: [1, 2], tone: "ink" },
  "a non-string icon": { kind: "quote", quote: "Nobody.", icon: 42 },
  "a titleIcon that is not a string": { kind: "receipt", titleIcon: false, rows: [{ k: "a", v: "b" }] },
  "a table cell tone outside the set": {
    kind: "table",
    columns: [{ label: "a" }],
    rows: [{ cells: [{ v: "x", tone: "dim" }] }],
  },
  "one comparison column": { kind: "comparison", columns: [{ label: "a" }], rows: [{ label: "r", cells: ["1"] }] },
  "a lat with no lon": { kind: "map", places: [{ label: "Ithaca", lat: 38.4 }] },
  "a two-line suggestion": { kind: "suggestions", items: [{ label: "first line\nsecond line" }] },
  "an unknown kind": { kind: "gauge", value: "3" },
};

/** What a parse says, in a form two parses can be compared by. */
function verdict(schema: typeof SHOW_BLOCK_INPUT_SCHEMA, block: unknown) {
  const parsed = schema.safeParse({ block });
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, issues: parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path })) };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("the shipped form", () => {
  test("is SHOW_BLOCK_INPUT_SCHEMA itself, not a rebuilt copy", () => {
    expect(showBlockInputSchema(SHIPPED_SHOW_BLOCK_SCHEMA_FORM)).toBe(SHOW_BLOCK_INPUT_SCHEMA);
    expect(SCHEMA_ARMS.flat).toBe(SHIPPED_SHOW_BLOCK_SCHEMA_FORM);
  });

  test("lists with no definitions, and the flat arm lists what production lists", async () => {
    // `listedShowBlock("flat")` throws if the arm differs from the production
    // factory's listing, so resolving is the second half of this test.
    const flat = JSON.stringify((await listedShowBlock("flat")).inputSchema);
    expect(flat).toContain('"oneOf"');
    expect(flat).not.toContain("definitions");
    expect(flat).not.toContain("$ref");
  });
});

describe("every form accepts exactly what the shipped form accepts", () => {
  test("the fixtures cover every kind, and use every field the forms rewrite", () => {
    const kinds = FIXTURES.map((block) => (block as { kind: string }).kind);
    expect([...kinds].sort()).toEqual([...BLOCK_KINDS].sort());
    const text = JSON.stringify(FIXTURES);
    // A valueTone ("dim" on a comparison column), an accent tone and an icon,
    // so the round trip below passes through each shared field.
    expect(text).toContain('"tone":"dim"');
    expect(text).toContain('"tone":"red"');
    expect(text).toContain('"icon":"wallet"');
  });

  test("the refused payloads are refused by the shipped form, each for a reason", () => {
    expect(Object.keys(REFUSED).length).toBeGreaterThan(0);
    for (const [name, block] of Object.entries(REFUSED)) {
      const result = verdict(SHOW_BLOCK_INPUT_SCHEMA, block);
      expect(result.ok, name).toBe(false);
      expect(result.issues?.length, name).toBeGreaterThan(0);
    }
  });

  for (const arm of SCHEMA_ARM_NAMES.filter((name) => name !== "flat")) {
    test(`${arm} parses every fixture and every refused payload as the shipped form does`, () => {
      const form = showBlockInputSchema(SCHEMA_ARMS[arm]);
      expect(form).not.toBe(SHOW_BLOCK_INPUT_SCHEMA);
      for (const block of FIXTURES) {
        const result = verdict(form, block);
        expect(result.ok).toBe(true);
        expect(result).toEqual(verdict(SHOW_BLOCK_INPUT_SCHEMA, block));
      }
      for (const [name, block] of Object.entries(REFUSED)) {
        expect(verdict(form, block), name).toEqual(verdict(SHOW_BLOCK_INPUT_SCHEMA, block));
      }
    });
  }
});

describe("each form says what it claims to", () => {
  test("shared: tone, valueTone and icon are defined once and referenced at all sixteen sites", async () => {
    const flat = (await listedShowBlock("flat")).inputSchema as JsonObject;
    const shared = (await listedShowBlock("shared")).inputSchema as JsonObject;
    const definitions = shared.definitions as JsonObject | undefined;
    expect(Object.keys(definitions ?? {}).sort()).toEqual(["icon", "tone", "valueTone"]);
    const text = JSON.stringify(shared);
    // Five valueTone sites, seven tone sites and four icon sites.
    expect(count(text, '{"allOf":[{"$ref":"#/definitions/valueTone"}]}')).toBe(5);
    expect(count(text, '{"allOf":[{"$ref":"#/definitions/tone"}]}')).toBe(7);
    expect(count(text, '{"allOf":[{"$ref":"#/definitions/icon"}]}')).toBe(4);
    // Resolving the references gives back the schema that ships.
    expect(dereference(shared)).toEqual(flat as Json);
    expect(text.length).toBeLessThan(JSON.stringify(flat).length);
  });

  test("shared-trimmed: drops the 23 restated descriptions and nothing else", async () => {
    const flat = (await listedShowBlock("flat")).inputSchema as JsonObject;
    const trimmed = dereference((await listedShowBlock("shared-trimmed")).inputSchema as JsonObject);
    const before = descriptions(flat);
    const after = descriptions(trimmed);
    const dropped = [...before.keys()].filter((text) => !after.has(text));
    // D47 classified 21 on eleven variants (1,564 characters); `map` and
    // `suggestions` add one each (165 and 63).
    expect(dropped.length).toBe(23);
    // Each costs `,"description":"…"` in the listing: its own object's length,
    // less the two braces, plus the comma before it.
    expect(dropped.reduce((sum, text) => sum + JSON.stringify({ description: text }).length - 1, 0)).toBe(1792);
    // The shared docs are not restatements and survive.
    for (const kept of [...after.keys()].filter((text) => (before.get(text) ?? 0) > 1)) {
      expect(after.get(kept)).toBe(before.get(kept));
    }
    // Put the dropped descriptions back by removing them from the flat schema
    // instead: what is left must be the trimmed schema exactly.
    const strip = (node: Json): Json => {
      if (Array.isArray(node)) return node.map(strip);
      if (node === null || typeof node !== "object") return node;
      return Object.fromEntries(
        Object.entries(node)
          .filter(([key, value]) => !(key === "description" && typeof value === "string" && dropped.includes(value)))
          .map(([key, value]) => [key, strip(value)])
      );
    };
    expect(trimmed).toEqual(strip(flat));
  });
});

describe("the live credential", () => {
  test("an API key wins, and goes out as x-api-key", () => {
    const credential = liveCredential({ ANTHROPIC_API_KEY: "key", CLAUDE_CODE_OAUTH_TOKEN: "token" });
    expect(credential?.source).toBe("ANTHROPIC_API_KEY");
    expect(credential?.headers["x-api-key"]).toBe("key");
    expect(credential?.headers.authorization).toBeUndefined();
  });

  test("with no key, the subscription token goes out as a bearer with the OAuth beta", () => {
    const credential = liveCredential({ ANTHROPIC_API_KEY: " ", CLAUDE_CODE_OAUTH_TOKEN: "token" });
    expect(credential?.source).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(credential?.headers.authorization).toBe("Bearer token");
    expect(credential?.headers["anthropic-beta"]).toBe(OAUTH_BETA);
    expect(credential?.headers["x-api-key"]).toBeUndefined();
  });

  test("with neither, there is no live run", () => {
    expect(liveCredential({})).toBeNull();
  });
});
