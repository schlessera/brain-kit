/**
 * ui-server takes the pill labeller's model structurally, so it never imports
 * core (#1004). A core `CompletionProvider` value must still satisfy
 * `LabelCompletionProvider` as it is after the optional `completeWithUsage`
 * was added (#1083): typecheck covers the assignment below, and the run shows
 * such a provider labels through `complete()` and records an unpriced run.
 */
import { expect, test } from "bun:test";

import type { CompletionProvider } from "../packages/core/src/lib/seams";
import { createActivityStore, rowToRunRollup } from "../packages/ui-server/src/activity/store";
import { createUiDb } from "../packages/ui-server/src/db/client";
import { createLabeller, type LabelCompletionProvider } from "../packages/ui-server/src/labels/index";

test("a core CompletionProvider is a LabelCompletionProvider, and its calls are unpriced runs", async () => {
  const core: CompletionProvider = {
    id: "fixture-core",
    capabilities: { vision: false },
    complete: async () => "Bag of winds",
  };
  const provider: LabelCompletionProvider = core;
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  const labeller = createLabeller({ options: { provider, billing: "api" }, activity: { store } });

  expect(await labeller.label("follow-up:a", "Keep the bag of winds shut", "sess-ithaca")).toBe("Bag of winds");
  const runs = db.query("SELECT * FROM activity_run_rollups").all().map(rowToRunRollup);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ name: "pill label", sessionId: "sess-ithaca", effectiveCostUsd: null });
});
