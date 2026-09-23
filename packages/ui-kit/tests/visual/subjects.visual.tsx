/**
 * VISUAL REGRESSION — D10, wave 7.
 *
 * ## Why this exists, in two sentences from this repo's own history
 *
 * `GraphView` rendered a 2px vertical line for an entire wave and **all six of
 * its stories passed** — every element inside it is absolutely positioned, so a
 * shrink-to-fit container collapsed the box to nothing, and percentages of zero
 * are all zero: nothing overflowed, no node escaped, the two edge weights were
 * still distinct, the focus node was still heavier. There was no assertion that
 * could have failed. `LaneChart` drew one continuous run as two butted bars,
 * against the only argument the component makes. Both were found by a person
 * looking at Storybook (`docs/decisions/design-feedback.md` §15).
 *
 * That is the class this file covers and nothing else does: **defects in what
 * was painted, invisible to assertions about props, roles, counts and computed
 * styles.**
 *
 * ## Why it is a separate Vitest project rather than a call inside `play`
 *
 * `toMatchScreenshot` comes from `@vitest/browser`'s `expect.element`, and the
 * `expect` a story imports is `storybook/test`'s, which does not have it.
 * Importing `vitest` into a story would break `storybook dev`, where play
 * functions run in a plain browser with no test runner. So the screenshots live
 * in a second project that imports the **real stories** and renders them through
 * CSF Next's `run()` — the baseline is of the story itself, not of a
 * reimplementation of it that can drift.
 *
 * ## The subjects are curated, and that is a decision
 *
 * There are 536 stories. Snapshotting all of them would produce 536 PNGs that
 * nobody can review and that churn on every spacing change, which is how a
 * visual suite becomes a rubber stamp. The set below is chosen by failure mode:
 *
 *   - **the four assembled screens**, because composition bugs live between
 *     components and no component's own stories can see them — `ScreenBody`
 *     crushing its children showed up as three different components looking
 *     broken;
 *   - **the components that PAINT** rather than lay out text — a graph, a chart,
 *     a map, an orbit, a meter — because their correctness is geometry, and
 *     geometry is what a number-based assertion approximates at best;
 *   - **two dense cards**, `AgentRunCard` and `ApprovalCard`, because they are
 *     where the kit's tone ramps, chips, diffs and button rows all meet.
 *
 * Adding a subject is cheap and deliberate. Adding all of them is neither.
 *
 * ## Why `.visual.tsx` and not `.test.tsx`
 *
 * The repo's `bun run test` globs `packages/**` for `*.test.ts(x)` and would
 * claim this file, then fail on the first story import: bun's runner has no
 * Vite and cannot resolve `#.storybook/preview`. Two runners, two extensions.
 *
 * ## Determinism
 *
 * Baselines are `-chromium-linux.png` and rendering is NOT reproducible across
 * environments, so both generation and comparison run inside the pinned
 * Playwright image. This is not a precaution: a host-generated baseline compared
 * inside the container did not merely differ, it hung the matcher until the test
 * timed out, so the failure did not even look like a visual diff. `bun run
 * visual` and the CI job both go through `scripts/visual.mjs`, which is one file
 * precisely so the two cannot drift.
 *
 * The fixture world is pinned to a reference date and every time of day is a
 * literal string (`fixtures/README.md`), so nothing here renders a clock.
 *
 * ## `expect(...)`, NOT `expect.element(...)`
 *
 * `expect.element` is `expect.poll` underneath: it retries the assertion until
 * it passes. That is right for "wait for this to appear" and wrong for a
 * screenshot — `run()` has already awaited the render, so there is nothing to
 * wait for, and a screenshot that will never match is simply re-captured until
 * the TEST times out. Measured: a seeded one-component change failed in
 * **15.1 seconds reported as "Test timed out"**, with no mismatch count and no
 * diff image, versus **232ms reported as "408 pixels (ratio 0.01) differ"**
 * naming the expected, actual and diff files. Same defect, same tolerance; the
 * only difference is which `expect` took the assertion.
 */
// `expect.element` is a module augmentation `@vitest/browser` declares on
// `vitest`. Referenced here rather than added to the root tsconfig's `types`,
// which is `["bun"]`: the augmentation belongs to the two files that run in a
// browser, not to every file in the repo.
/// <reference types="@vitest/browser/matchers" />
import { expect, test } from "vitest";

import * as agentOrbit from "../../stories/agents/AgentOrbit.stories.js";
import * as agentRunCard from "../../stories/agents/AgentRunCard.stories.js";
import * as graphView from "../../stories/agents/GraphView.stories.js";
import * as laneChart from "../../stories/agents/LaneChart.stories.js";
import * as mapView from "../../stories/blocks/MapView.stories.js";
import * as statTiles from "../../stories/blocks/StatTiles.stories.js";
import * as trendChart from "../../stories/blocks/TrendChart.stories.js";
import * as approvalCard from "../../stories/decisions/ApprovalCard.stories.js";
import * as barList from "../../stories/evidence/BarList.stories.js";
import * as traceSteps from "../../stories/evidence/TraceSteps.stories.js";
import * as meter from "../../stories/primitives/Meter.stories.js";
import * as actionsTriage from "../../stories/screens/ActionsTriage.stories.js";
import * as chatAnswer from "../../stories/screens/ChatAnswer.stories.js";
import * as fileViewer from "../../stories/screens/FileViewer.stories.js";
import * as firstRun from "../../stories/screens/FirstRun.stories.js";
import * as morningDigest from "../../stories/screens/MorningDigest.stories.js";
import * as runDetail from "../../stories/screens/RunDetail.stories.js";
import * as weeklyReview from "../../stories/screens/WeeklyReview.stories.js";

/** What CSF Next hands back: a composed story that renders and plays itself.
 * `run` takes a partial story context, which is how the `theme` global reaches
 * the preview's theme decorator outside Storybook. */
interface ComposedStory {
  run: (context?: { globals?: Record<string, unknown> }) => Promise<void>;
}

/**
 * Two numbers, and they answer different questions.
 *
 * `threshold` is how far apart two colours must be before a pixel counts at
 * all. pixelmatch calls a pixel unchanged while its YIQ distance is under
 * `35215 × threshold²`, so the default of 0.1 is a bar of 352 — and the kit's
 * quiet layer lives under that. Composited over its own theme's surface, the
 * quietest `rgba()` token that paints at all is at 4.3
 * (`button-effect-bg-on-solid`, paper), and 208 token/theme pairs sit between
 * there and the bar — `map-land`'s 6% at 77 among them. At 0.1 a component
 * could lose its tint, its hover veil or its land fill and stay green;
 * `ApprovalCard` without `surface-tint-amber` did (issue #140).
 *
 * 0.01 is a bar of 3.5, chosen from a measurement rather than picked. The noise
 * floor, inside `mcr.microsoft.com/playwright:v1.63.0-noble`: five full runs
 * from empty baselines, compared pairwise (270 image pairs). 26 of the 27
 * subjects came out byte-identical every time; the one that did not,
 * `paints-graph-view-shrink-to-fit`, differed by at most 0.51 in YIQ — one
 * level in each channel — on at most 64 pixels over all ten pairs. So the bar
 * sits seven times above the noise and below the quietest token the kit ships.
 *
 * `includeAA: false` (the default, kept) is not enough on its own: of those 64
 * pixels, 20 were not classed as antialiasing. The ratio below is what absorbs
 * them.
 *
 * `allowedMismatchedPixelRatio` is the count: at 0.1% of a phone screen it is
 * about 240 pixels, a softened glyph edge and nowhere near a moved element or a
 * missing fill. Every defect this file exists for — a collapsed box, a seam
 * between two bars, a crushed row, a tint gone — is orders of magnitude larger.
 */
const TOLERANCE = { comparatorOptions: { threshold: 0.01, allowedMismatchedPixelRatio: 0.001 } } as const;

async function looksRight(story: unknown, name: string, globals?: Record<string, unknown>) {
  await (story as ComposedStory).run(globals ? { globals } : undefined);
  await expect(document.body).toMatchScreenshot(name, TOLERANCE);
}

/**
 * The same story on paper. The preview's theme decorator writes `data-theme`
 * on `<html>` from the `theme` global on EVERY render — so setting the
 * attribute by hand is overwritten the moment the story runs, and the first
 * light baselines came out dark for exactly that reason. The global goes in
 * through `run()`'s context instead, and the ground is asserted before the
 * screenshot so a dark "light" baseline can never be written again.
 */
async function looksRightOnPaper(story: unknown, name: string) {
  await (story as ComposedStory).run({ globals: { theme: "light" } });
  expect(getComputedStyle(document.documentElement).colorScheme).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  await expect(document.body).toMatchScreenshot(`${name}-light`, TOLERANCE);
}

/* ── The four assembled screens ───────────────────────────────────────────── */
// Composition, which is the half no component's own stories can see.

test("screen: morning digest", async () => {
  await looksRight(morningDigest.MorningDigest, "screen-morning-digest");
});

test("screen: chat answer", async () => {
  await looksRight(chatAnswer.ChatAnswer, "screen-chat-answer");
});

test("screen: weekly review", async () => {
  await looksRight(weeklyReview.WeeklyReview, "screen-weekly-review");
});

test("screen: run detail", async () => {
  await looksRight(runDetail.RunDetail, "screen-run-detail");
});

/* ── The three after the acceptance set ───────────────────────────────────── */
// The sixth-pass ruling's next three, in its order (§12). Not the gate — the
// four above stay the gate — but composition all the same, and two of them
// carry the kit's widest content: a real diff on the triage list, and a tree
// that has to open inside a 390px frame.

test("screen: actions triage", async () => {
  await looksRight(actionsTriage.ActionsTriage, "screen-actions-triage");
});

test("screen: file viewer", async () => {
  await looksRight(fileViewer.FileViewer, "screen-file-viewer");
});

test("screen: first run", async () => {
  await looksRight(firstRun.FirstRun, "screen-first-run");
});

/* ── The same four, on paper ──────────────────────────────────────────────── */
// The light theme is a value swap and never a layout change (D32) — so the
// light screens are the same subjects, and a light baseline catches the one
// thing the dark one cannot: a token whose paper half is wrong or missing.

test("screen: morning digest, light", async () => {
  await looksRightOnPaper(morningDigest.MorningDigest, "screen-morning-digest");
});

test("screen: chat answer, light", async () => {
  await looksRightOnPaper(chatAnswer.ChatAnswer, "screen-chat-answer");
});

test("screen: weekly review, light", async () => {
  await looksRightOnPaper(weeklyReview.WeeklyReview, "screen-weekly-review");
});

test("screen: run detail, light", async () => {
  await looksRightOnPaper(runDetail.RunDetail, "screen-run-detail");
});

test("screen: actions triage, light", async () => {
  await looksRightOnPaper(actionsTriage.ActionsTriage, "screen-actions-triage");
});

test("screen: file viewer, light", async () => {
  await looksRightOnPaper(fileViewer.FileViewer, "screen-file-viewer");
});

test("screen: first run, light", async () => {
  await looksRightOnPaper(firstRun.FirstRun, "screen-first-run");
});

/* ── The components that paint ────────────────────────────────────────────── */
// Correctness here is geometry, and geometry is what an assertion approximates.

test("paints: graph view", async () => {
  await looksRight(graphView.Default, "paints-graph-view");
});

/**
 * AND THE HAZARD, SEPARATELY — because a baseline only catches what its story
 * renders, which is the same blind spot the accessibility gate has.
 *
 * `GraphView`'s collapse was reintroduced as a test of this suite, and
 * `paints: graph view` above **passed**: `Default` renders inside a stated-width
 * wrapper now, so the shrink-to-fit condition that caused the bug is not on
 * screen. The subject that catches it is the story that reproduces the
 * condition. A visual suite is not a safety net under the stories; it is a
 * second reading of exactly the stories it is pointed at.
 */
test("paints: graph view in a shrink-to-fit container", async () => {
  await looksRight(graphView.ItCannotCollapseInAShrinkToFitContainer, "paints-graph-view-shrink-to-fit");
});

test("paints: lane chart", async () => {
  await looksRight(laneChart.Default, "paints-lane-chart");
});

/**
 * This subject sees the land fill. `map-land` is 6% alpha, a YIQ distance of 77
 * on the dark ground: at the old default threshold it was invisible, so #48
 * added a second, SVG-only reading of this story at a stricter threshold. At
 * the suite's threshold above, removing the fill fails this subject on its own,
 * so there is one rule and no exception.
 */
test("paints: map view", async () => {
  await looksRight(mapView.Default, "paints-map-view");
});

test("paints: agent orbit", async () => {
  await looksRight(agentOrbit.Default, "paints-agent-orbit");
});

test("paints: trend chart", async () => {
  await looksRight(trendChart.Default, "paints-trend-chart");
});

test("paints: bar list", async () => {
  await looksRight(barList.Default, "paints-bar-list");
});

test("paints: meter, every tone", async () => {
  await looksRight(meter.Tones, "paints-meter-tones");
});

test("paints: stat tiles", async () => {
  await looksRight(statTiles.Default, "paints-stat-tiles");
});

test("paints: trace steps", async () => {
  await looksRight(traceSteps.List, "paints-trace-steps");
});

/* ── Two dense cards ──────────────────────────────────────────────────────── */
// Where the tone ramps, chips, diffs and button rows all meet at once.

test("dense: agent run card", async () => {
  await looksRight(agentRunCard.Default, "dense-agent-run-card");
});

test("dense: approval card", async () => {
  await looksRight(approvalCard.Default, "dense-approval-card");
});
