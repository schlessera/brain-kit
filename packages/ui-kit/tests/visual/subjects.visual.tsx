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
 *     where the kit's tone ramps, chips, diffs and button rows all meet;
 *   - **the list question** (`AskUserListCard`, #583), because its one claim
 *     is geometry: thirty rows of chips at 320px, every chip in the same
 *     column on every row, nothing past the edge — and on desktop, six
 *     options beside the label.
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
import { page, commands } from "vitest/browser";

import * as agentOrbit from "../../stories/agents/AgentOrbit.stories.js";
import * as agentRunCard from "../../stories/agents/AgentRunCard.stories.js";
import * as turnErrorCard from "../../stories/conversation/TurnErrorCard.stories.js";
import * as graphView from "../../stories/agents/GraphView.stories.js";
import * as laneChart from "../../stories/agents/LaneChart.stories.js";
import * as inPrint from "../../stories/blocks/InPrint.stories.js";
import * as mapView from "../../stories/blocks/MapView.stories.js";
import * as placeMap from "../../stories/blocks/PlaceMap.stories.js";
import * as statTiles from "../../stories/blocks/StatTiles.stories.js";
import * as trendChart from "../../stories/blocks/TrendChart.stories.js";
import * as approvalCard from "../../stories/decisions/ApprovalCard.stories.js";
import * as conditionalForm from "../../stories/decisions/AskUserFormCard.stories.js";
import * as rankedQuestion from "../../stories/decisions/AskUserRankCard.stories.js";
import * as questionAndMask from "../../stories/decisions/QuestionAndMask.stories.js";
import * as barList from "../../stories/evidence/BarList.stories.js";
import * as traceSteps from "../../stories/evidence/TraceSteps.stories.js";
import * as sideRail from "../../stories/desktop/SideRail.stories.js";
import * as meter from "../../stories/primitives/Meter.stories.js";
import * as actionsTriage from "../../stories/screens/ActionsTriage.stories.js";
import * as chatAnswer from "../../stories/screens/ChatAnswer.stories.js";
import * as fileViewer from "../../stories/screens/FileViewer.stories.js";
import * as firstRun from "../../stories/screens/FirstRun.stories.js";
import * as morningDigest from "../../stories/screens/MorningDigest.stories.js";
import * as runDetail from "../../stories/screens/RunDetail.stories.js";
import * as weeklyReview from "../../stories/screens/WeeklyReview.stories.js";
import * as discButton from "../../stories/chrome/DiscButton.stories.js";
import * as suggestionChips from "../../stories/conversation/SuggestionChips.stories.js";

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
 * pixels, 20 were not classed as antialiasing, so at a threshold of 0 they
 * would count. At 0.01 none of them does — every one is under the bar — so
 * the measured noise is absorbed by the threshold, and the ratio below is
 * headroom the measurement never used.
 *
 * `allowedMismatchedPixelRatio` is the count: at 0.1% of a phone screen it is
 * about 240 pixels, a softened glyph edge and nowhere near a moved element or a
 * missing fill. The defects this file was built after — a collapsed box, a run
 * drawn as two bars, a crushed row, a tint gone — are the size of an element
 * (a tint removed from `ApprovalCard` moved 28,141). It is not a bound on
 * everything: a one-pixel seam cut into `LaneChart`'s bar counts a dozen or fewer
 * mismatches, with or without antialiasing, and passes. A defect that small
 * needs an assertion, not a baseline.
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

/* ── Print ─────────────────────────────────────────────────────────────────── */
// What a shared PNG or PDF draws (#46): every answer block in the print theme.
// The story pins the theme; the ground is asserted first so a baseline in the
// wrong theme cannot be written, as with paper below.

async function looksRightInPrint(story: unknown, name: string) {
  await (story as ComposedStory).run();
  expect(document.documentElement.dataset.theme).toBe("print");
  expect(getComputedStyle(document.documentElement).colorScheme).toBe("light");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--bk-color-canvas").trim()).toBe("#ffffff");
  await expect(document.body).toMatchScreenshot(name, TOLERANCE);
}

test("print: figures (comparison, stats, trend, table)", async () => {
  await looksRightInPrint(inPrint.Figures, "print-figures");
});

test("print: records (bars, receipt, steps)", async () => {
  await looksRightInPrint(inPrint.Records, "print-records");
});

test("print: events (timeline, schedule)", async () => {
  await looksRightInPrint(inPrint.Events, "print-events");
});

test("print: people (quote, contact)", async () => {
  await looksRightInPrint(inPrint.People, "print-people");
});

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

/* ── Place maps (#44) ──────────────────────────────────────────────────────── */
// The two acceptance cases, at the width a block gets on a 320px phone: eight
// places in one town, and two a continent apart. The stories' play functions
// assert what "legible" measures as (no mark covers another, every place is a
// badge or a cluster member, nothing clipped); the baseline is for what they
// cannot see. Side by side from 560px is the `TwoContinentsWide` story's own
// assertion: this runner's viewport is a phone's.

test("paints: place map, eight places in one town, phone", async () => {
  await looksRight(placeMap.EightInOneTown, "paints-place-map-town");
});

test("paints: place map, eight places in one town, phone, light", async () => {
  await looksRightOnPaper(placeMap.EightInOneTown, "paints-place-map-town");
});

test("paints: place map, two places a continent apart, phone", async () => {
  await looksRight(placeMap.TwoContinents, "paints-place-map-pair");
});

test("paints: place map, no geometry from the route", async () => {
  await looksRight(placeMap.NoGeometry, "paints-place-map-no-geometry");
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

// A label is the record and wraps (#174): what a wrapped row looks like —
// bar and figure on its first line, continuation lines in the label column
// alone — is geometry, so it is a baseline, in both themes.
test("paints: bar list, long labels wrap", async () => {
  await looksRight(barList.LongTaxonomyWraps, "paints-bar-list-long-labels");
});

test("paints: bar list, long labels wrap, on paper", async () => {
  await looksRightOnPaper(barList.LongTaxonomyWraps, "paints-bar-list-long-labels");
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

/* ── The rail with its acts (#944) ─────────────────────────────────────────── */
// D52 §1: the divider, the acts' geometry, a `spends` chip and a reason line
// printed at rest, and All commands in place of the passive cap — expanded
// and collapsed, on both grounds.

for (const light of [false, true]) {
  test(`dense: side rail acts, expanded${light ? ", on paper" : ""}`, async () => {
    await inViewport(900, 600, () => light
      ? looksRightOnPaper(sideRail.ActsAtRest, "dense-side-rail-acts")
      : looksRight(sideRail.ActsAtRest, "dense-side-rail-acts"));
  });
  test(`dense: side rail acts, collapsed${light ? ", on paper" : ""}`, async () => {
    await inViewport(480, 600, () => light
      ? looksRightOnPaper(sideRail.CollapsedActsAtRest, "dense-side-rail-acts-collapsed")
      : looksRight(sideRail.CollapsedActsAtRest, "dense-side-rail-acts-collapsed"));
  });
}

/* ── The list question ────────────────────────────────────────────────────── */
// #583's acceptance criterion is a baseline: thirty items at 320px, with the
// chip grid holding its columns row after row, and the desktop layout where
// the chips move beside the label.
//
// Each runs in a viewport tall enough to hold the WHOLE card. The card's
// header and action row are sticky, so in the default phone viewport they
// pin mid-card, and a screenshot paints only what the viewport holds: the
// baseline would be of one scroll position, not of the card. The viewport is
// restored after, so no later subject inherits it.

async function inViewport(width: number, height: number, body: () => Promise<void>) {
  const before = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, height);
  try {
    await body();
  } finally {
    await page.viewport(before.width, before.height);
  }
}

// The two failure tones, with the closed disclosure on a phone and the
// initially open unknown explanation on desktop (#576).
for (const light of [false, true]) {
  test(`dense: failed turn, phone${light ? ", on paper" : ""}`, async () => {
    await inViewport(320, 900, () => light
      ? looksRightOnPaper(turnErrorCard.Default, "dense-failed-turn-phone")
      : looksRight(turnErrorCard.Default, "dense-failed-turn-phone"));
  });
  test(`dense: failed turn, desktop${light ? ", on paper" : ""}`, async () => {
    await inViewport(900, 900, () => light
      ? looksRightOnPaper(turnErrorCard.UnknownWide, "dense-failed-turn-wide")
      : looksRight(turnErrorCard.UnknownWide, "dense-failed-turn-wide"));
  });
}

test("dense: ask list, thirty by three at 320px", async () => {
  await inViewport(320, 3000, () => looksRight(questionAndMask.ListThirtyByThree, "dense-ask-list-thirty"));
});

test("dense: ask list, thirty by three at 320px, on paper", async () => {
  await inViewport(320, 3000, () =>
    looksRightOnPaper(questionAndMask.ListThirtyByThree, "dense-ask-list-thirty")
  );
});

test("dense: ask list, desktop", async () => {
  await inViewport(1024, 1500, () => looksRight(questionAndMask.ListWide, "dense-ask-list-wide"));
});

/** The image resolves the unbundled mono stack differently before and after
 * earlier subjects (the host label measured 57.75px alone and 69.31px after
 * them). Pin the same local 0.6em stand-in used by the receipt budget tests
 * for these new baselines, then remove it so existing subjects keep their
 * incumbent environment. No network or product font override is involved. */
async function rankLooksRight(story: unknown, name: string, light: boolean) {
  const face = new FontFace("JetBrains Mono", 'local("Liberation Mono"), local("LiberationMono")', { weight: "400 600" });
  document.fonts.add(await face.load());
  try {
    await (light ? looksRightOnPaper(story, name) : looksRight(story, name));
  } finally {
    document.fonts.delete(face);
  }
}

for (const light of [false, true]) {
  test(`dense: rank fifteen, phone${light ? ", on paper" : ""}`, async () => {
    await inViewport(320, 2000, () => rankLooksRight(rankedQuestion.RankFifteenCutoff, "dense-rank-fifteen", light));
  });
  test(`dense: rank five, desktop${light ? ", on paper" : ""}`, async () => {
    await inViewport(1024, 1000, () => rankLooksRight(rankedQuestion.RankWide, "dense-rank-wide", light));
  });
}

// Capture the full card inside the browser frame, including its Submit row.
async function formBaseline(story: unknown, name: string, theme: "dark" | "light", desktop = false) {
  const width = desktop ? 960 : 320;
  const frameBefore = { width: innerWidth, height: innerHeight };
  const outerBefore = await commands.formViewport(width, 2400);
  // The same deterministic local mono stand-in as rankLooksRight above.
  const face = new FontFace("JetBrains Mono", 'local("Liberation Mono"), local("LiberationMono")', { weight: "400 600" });
  document.fonts.add(await face.load());
  try {
    await page.viewport(width, 2400);
    await (story as ComposedStory).run({ globals: { theme } });
    expect(document.documentElement.dataset.theme).toBe(theme);
    const card = document.querySelector<HTMLElement>(".bk-askform")!;
    expect(card.getBoundingClientRect().bottom).toBeLessThan(window.innerHeight);
    expect(card.getBoundingClientRect().width).toBe(width);
    if (card.dataset.state === "pending") expect(card.querySelector("[data-form-submit]")).not.toBeNull();
    console.info(`form layout ${name} ${theme}: ${card.getBoundingClientRect().width}×${card.getBoundingClientRect().height} CSS px`);
    await expect(card).toMatchScreenshot(`${name}-${theme}`, TOLERANCE);
  } finally {
    document.fonts.delete(face);
    await page.viewport(frameBefore.width, frameBefore.height);
    await commands.formViewport(outerBefore.width - 100, outerBefore.height - 120);
  }
}

test("form: FormThreeLevels", async () => { await formBaseline(conditionalForm.FormThreeLevels, "formthreelevels", "dark"); await formBaseline(conditionalForm.FormThreeLevels, "formthreelevels", "light"); });

test("form: FormFourLevels", async () => { await formBaseline(conditionalForm.FormFourLevels, "formfourlevels", "dark"); await formBaseline(conditionalForm.FormFourLevels, "formfourlevels", "light"); });

test("form: FormSwitchSetAside", async () => { await formBaseline(conditionalForm.FormSwitchSetAside, "formswitchsetaside", "dark"); await formBaseline(conditionalForm.FormSwitchSetAside, "formswitchsetaside", "light"); });

test("form: FormAnsweredGames", async () => { await formBaseline(conditionalForm.FormAnsweredGames, "formansweredgames", "dark"); await formBaseline(conditionalForm.FormAnsweredGames, "formansweredgames", "light"); });

test("form: desktop three levels", async () => { await formBaseline(conditionalForm.FormThreeLevelsWide, "formthreelevels-wide", "dark", true); await formBaseline(conditionalForm.FormThreeLevelsWide, "formthreelevels-wide", "light", true); });

test("form: six-option scale at depth three", async () => { await formBaseline(conditionalForm.FormSixOptionScale, "formsixoptionscale", "dark"); await formBaseline(conditionalForm.FormSixOptionScale, "formsixoptionscale", "light"); });
test("form: twelve nodes", async () => { await formBaseline(conditionalForm.FormNodeLimit, "formnodelimit", "dark"); await formBaseline(conditionalForm.FormNodeLimit, "formnodelimit", "light"); });

// The overlay discs (#945, D52 §7) are paint over a transcript: an opaque
// disc, a pill that opens leftward and pushes its neighbour, and a gold cost
// with a printed reason on a disabled chip. Geometry and hits are asserted in
// `overlay-targets.visual.tsx`; these baselines catch a lost fill, edge or
// expansion that a rectangle cannot.
for (const light of [false, true]) {
  const paper = light ? ", on paper" : "";
  test(`chrome: discs over scrolled text, phone${paper}`, async () => {
    await inViewport(320, 260, () => light
      ? looksRightOnPaper(discButton.OverScrolledText, "chrome-discs-scrolled")
      : looksRight(discButton.OverScrolledText, "chrome-discs-scrolled"));
  });
  test(`chrome: New chat expanded beside Search, phone${paper}`, async () => {
    await inViewport(320, 120, () => light
      ? looksRightOnPaper(discButton.PairNewChatExpanded, "chrome-discs-expanded")
      : looksRight(discButton.PairNewChatExpanded, "chrome-discs-expanded"));
  });
  test(`conversation: chips with cost and a disabled reason, phone${paper}`, async () => {
    await inViewport(320, 160, () => light
      ? looksRightOnPaper(suggestionChips.Disabled, "conversation-chips-disabled")
      : looksRight(suggestionChips.Disabled, "conversation-chips-disabled"));
  });
}
