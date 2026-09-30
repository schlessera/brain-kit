import { expect, test } from "bun:test";

import { createBrainAccess } from "../src/brain-access";
import { makeIndexedBrain, type TempBrain } from "./helpers";

test("makeIndexedBrain removes ambient embedding and reranker credentials", async () => {
  const keys = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "TYPESAFE_API_KEY"] as const;
  const previous = keys.map((key) => process.env[key]);
  let brain: TempBrain | undefined;
  try {
    for (const key of keys) process.env[key] = "dummy";
    // Observe cleanup directly: default-off reranking can mask a retained key.
    expect(process.env.TYPESAFE_API_KEY).toBe("dummy");

    brain = await makeIndexedBrain();
    expect(process.env.TYPESAFE_API_KEY).toBeUndefined();
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
    expect(process.env.GOOGLE_API_KEY).toBeUndefined();

    const { results } = await createBrainAccess(brain.root).search({ query: "agentic retrieval" });
    expect(results.map((result) => result.path)).toContain("notes/agentic-retrieval.md");
  } finally {
    brain?.cleanup();
    for (const [index, key] of keys.entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
});
