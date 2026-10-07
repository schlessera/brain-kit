// The in-app digest carries the client's Actions/FYI contribution (#683):
// new waiting decisions and FYIs, with or without an activity window.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DigestSummary } from "../src/components/activity/digest-summary.js";
import type { ActionDigestSummary, ActivityDigest } from "../src/lib/api-client.js";

const actions: ActionDigestSummary = {
  generatedAt: Date.UTC(2026, 6, 12, 6),
  slotAt: Date.UTC(2026, 6, 12, 6),
  timeZone: "Europe/Athens",
  waiting: [
    { episodeId: "raft#1", itemId: "raft", threadId: "ogygia", title: "Build the raft before the swell?" },
    { episodeId: "tribute#1", itemId: "tribute", threadId: "aeaea", title: "Answer Circe's tribute?" },
  ],
  updates: [{ itemId: "omens", threadId: "ithaca", title: "Penelope finished the shroud" }],
};
const noop = () => {};

test("an Actions-only summary lists the new waiting decisions and FYIs without a run window", () => {
  const html = renderToStaticMarkup(
    <DigestSummary digest={null} actions={actions} windowLabel="Actions, Jul 12, 09:00" costClause={null} onDismiss={noop} onOpen={noop} />
  );
  expect(html).toContain("Waiting on you");
  expect(html).toContain("Build the raft before the swell?");
  expect(html).toContain("Penelope finished the shroud");
  expect(html).toContain("Actions, Jul 12, 09:00 · 2 waiting");
  expect(html).not.toContain(">Ran<");
});

test("activity and Actions share one card, with the decisions last", () => {
  const digest: ActivityDigest = {
    generatedAt: actions.generatedAt, windowStart: actions.generatedAt - 86_400_000, windowEnd: actions.generatedAt,
    runs: 4, failures: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, notable: [],
  };
  const html = renderToStaticMarkup(
    <DigestSummary digest={digest} actions={actions} windowLabel="Jul 11 – Jul 12" costClause={null} onDismiss={noop} onOpen={noop} />
  );
  expect(html.indexOf("Ran")).toBeGreaterThan(-1);
  expect(html).toContain("Updates");
  expect(html).toContain("Waiting on you");
  expect(html.indexOf("Waiting on you")).toBeGreaterThan(html.indexOf("Updates"));
  expect(html).toContain("Jul 11 – Jul 12 · 4 runs · 2 waiting");
});
