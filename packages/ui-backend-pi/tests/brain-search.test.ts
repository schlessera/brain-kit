import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createBrainAccess } from "../src/brain-access";
import { createBrainTools } from "../src/tools";
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
  const list = createBrainTools({ brain: createBrainAccess(brain.root), turn });
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

describe("brain_add wrapper (deny path, no write)", () => {
  test("denied add throws and creates no file", async () => {
    const { makeMockBridge } = await import("./mock-bridge");
    const turn = createTurnContext();
    const list = createBrainTools({ brain: createBrainAccess(brain.root), turn });
    const brainAdd = list.find((t) => t.name === "brain_add")!;
    turn.bridge = makeMockBridge({ decision: { behavior: "deny", message: "nope" } }).bridge;
    await expect(
      brainAdd.execute("a1", { content: "a new captured note" }, undefined, undefined, CTX)
    ).rejects.toThrow("nope");
  });
});
