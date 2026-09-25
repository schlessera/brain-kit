import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { makeIndexedBrain, resultText, type TempBrain } from "./helpers";

const CTX = {} as never;
// The core fixture's identity note, the document the MCP tool's tests read.
const IDENTITY = readFileSync(join(import.meta.dir, "../../core/fixtures/corpus/me/identity.md"), "utf-8");

let brain: TempBrain;

beforeAll(async () => {
  brain = await makeIndexedBrain({ "me/identity.md": IDENTITY });
});

afterAll(() => {
  brain.cleanup();
});

function readTool(): ToolDefinition {
  const list = createBrainTools({
    brain: createBrainAccess(brain.root),
    turn: createTurnContext(),
    lock: toolLockFromKeyed(createKeyedLock()),
  });
  return list.find((t) => t.name === "brain_read")!;
}

const read = async (params: Record<string, unknown>) =>
  resultText(await readTool().execute("r", params as never, undefined, undefined, CTX));

describe("brain_read wrapper", () => {
  test("with only a path returns the file as it did before", async () => {
    expect(await read({ path: "me/identity.md" })).toBe(IDENTITY);
  });

  test("section returns that section and not the one before it", async () => {
    const text = await read({ path: "me/identity.md", section: "How to Work With Alex" });
    expect(text.startsWith("## How to Work With Alex\n")).toBe(true);
    expect(text).toContain("Prefer concrete, checklist-shaped guidance");
    expect(text).not.toContain("## Current Identity");
  });

  test("max_tokens over the file's size returns the outline with every ## heading, and no body", async () => {
    const text = await read({ path: "me/identity.md", max_tokens: 50 });
    const headings = IDENTITY.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## Current Identity", "## How to Work With Alex"]);
    expect(text).toContain("- ## Current Identity (~206 tokens)\n- ## How to Work With Alex (~63 tokens)\n");
    expect(text).toContain('section: "<heading>"');
    expect(text).not.toContain("Prefer concrete");
  });

  test("an unknown section is an error naming the headings", async () => {
    await expect(read({ path: "me/identity.md", section: "No Such Heading" })).rejects.toThrow(
      'available headings: "Current Identity", "How to Work With Alex"'
    );
  });

  test("the tool declares both options, optional, with max_tokens a positive integer", () => {
    const schema = readTool().parameters as unknown as {
      properties: Record<string, { type: string; minimum?: number }>;
      required: string[];
    };
    expect(schema.required).toEqual(["path"]);
    expect(schema.properties).toMatchObject({
      section: { type: "string" },
      max_tokens: { type: "integer", minimum: 1 },
    });
  });
});
