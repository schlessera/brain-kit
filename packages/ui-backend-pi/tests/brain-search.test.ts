import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../src/tools";
import { createTurnContext } from "../src/turn-context";
import { makeIndexedBrain, resultText, type TempBrain } from "./helpers";

const CTX = {} as never;

let brain: TempBrain;

beforeAll(async () => {
  brain = await makeIndexedBrain();
});

afterAll(() => {
  brain.cleanup();
});

function tools(): Record<string, ToolDefinition> {
  const turn = createTurnContext();
  const list = createBrainTools({
    brain: createBrainAccess(brain.root),
    turn,
    lock: toolLockFromKeyed(createKeyedLock()),
  });
  return Object.fromEntries(list.map((t) => [t.name, t]));
}

describe("brain_search wrapper (keyless FTS)", () => {
  test("finds documents by keyword", async () => {
    const res = await tools().brain_search.execute(
      "s1",
      { query: "agentic retrieval" },
      undefined,
      undefined,
      CTX
    );
    const text = resultText(res);
    expect(text).toContain("agentic-retrieval.md");
    expect(text).not.toContain("cooking.md");
  });

  test("returns a no-results message for an unmatched query", async () => {
    const res = await tools().brain_search.execute(
      "s2",
      { query: "zzzznonexistentterm" },
      undefined,
      undefined,
      CTX
    );
    expect(resultText(res)).toContain("No results found.");
  });

  test("read-only search tool never consults the permission bridge", async () => {
    // No bridge is bound; a read tool that tried to gate would throw.
    const res = await tools().brain_search.execute(
      "s3",
      { query: "sqlite-vec" },
      undefined,
      undefined,
      CTX
    );
    expect(resultText(res)).toContain("sqlite-vec.md");
  });
});

describe("brain_context wrapper", () => {
  test("assembles a retrieval context block for a query", async () => {
    const res = await tools().brain_context.execute(
      "c1",
      { query: "hybrid search fusion" },
      undefined,
      undefined,
      CTX
    );
    const text = resultText(res);
    expect(text).toContain("agentic-retrieval.md");
  });
});

describe("brain_add wrapper", () => {
  // Approval denial is the tool_call gate's job now (see
  // tools-permission.test.ts); the wrapper itself just captures.
  test("adds a note and reports the written path", async () => {
    const turn = createTurnContext();
    const list = createBrainTools({
      brain: createBrainAccess(brain.root),
      turn,
      lock: toolLockFromKeyed(createKeyedLock()),
    });
    const brainAdd = list.find((t) => t.name === "brain_add")!;
    const res = await brainAdd.execute(
      "a1",
      { content: "A captured pi-backend test note about retrieval" },
      undefined,
      undefined,
      CTX
    );
    expect(resultText(res)).toContain(".md");
  });
});
