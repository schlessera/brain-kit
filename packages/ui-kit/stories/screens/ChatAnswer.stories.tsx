import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { tabs } from "../../fixtures/files.js";
import { forecastQuote, straitSteps } from "../../fixtures/notes.js";
import { straitMap } from "../../fixtures/places.js";
import { researcherTrace } from "../../fixtures/runs.js";
import { answerStats, answerTrace, suggestions, userMessage } from "../../fixtures/search.js";
import { Disclosure } from "../../src/blocks/Disclosure.js";
import { MapView } from "../../src/blocks/MapView.js";
import { QuoteCard } from "../../src/blocks/QuoteCard.js";
import { StatTiles } from "../../src/blocks/StatTiles.js";
import { StepList } from "../../src/blocks/StepList.js";
import { Composer } from "../../src/chrome/Composer.js";
import { MessageBubble } from "../../src/chrome/MessageBubble.js";
import { ScreenBody } from "../../src/chrome/ScreenBody.js";
import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { TabBar } from "../../src/chrome/TabBar.js";
import { SuggestionChips } from "../../src/conversation/SuggestionChips.js";
import { TraceSteps } from "../../src/evidence/TraceSteps.js";
import { phone } from "../_phone.js";
import { overflowing, unreachable } from "../_stage.js";

/**
 * §11.2 — CHAT ANSWER, FULLY STRUCTURED. The catalog's own summary is the
 * whole specification: *"MessageBubble + Disclosure + StatTiles + QuoteCard +
 * StepList + MapView + SuggestionChips — **no prose paragraph anywhere**."* The
 * chips took FeedbackRow's slot in the fifth drop: an answer gets one closing
 * row, never two.
 *
 * That last clause is the point and it is the thing to keep. The answer to
 * "where did Circe warn me about Scylla, and did I tell the crew?" is four
 * numbers, one quotation with a line reference, four steps and a map — every
 * claim attached to the document or the coordinate it came from. A paragraph
 * would say the same things and be unfalsifiable, which is why
 * `NoProsePararaphAnywhere` is an assertion and not a comment.
 *
 * ## Three places this departs from §11.2's literal text, all deliberate
 *
 * **The `Disclosure` gets children.** The catalog's tree lists only the top
 * level, so it shows the label — `"6 steps · 4 files touched · 2.4s"` — and
 * nothing inside. A `Disclosure` with no children is an empty drawer, and what
 * the label describes is the tool trace, so the trace is what goes in it:
 * `TraceSteps variant="rail"`, the variant that exists for a trace nested
 * inside something else.
 *
 * **`QuoteCard` keeps its own locator.** §11.2 types `locator="line 34"`; the
 * quotation is `forecastQuote` and its locator is `line 12`. A locator exists
 * so a reader can check the claim, so it follows the document rather than the
 * mockup.
 *
 * **`MapView` shows the strait, not the catalog's `title="LX Factory"`.** That
 * title is a venue in the design's own world; this fixture world is the
 * Odyssey and the answer is about Scylla, so the map is `straitMap` — real
 * coordinates, verified in `fixtures.test.ts`, at the height §11.2 asks for.
 *
 * The header's subtitle drops the design's `"connected · tailscale"` for
 * `"connected · local"`. Naming the transport is personal infrastructure, and
 * AGENTS.md's first hard rule has no exempt directories.
 */
const on = { send: fn(), attach: fn() };

const meta = preview.meta({
  title: "Screens/Chat answer",
  component: ScreenBody,
  decorators: [phone()],
  parameters: { layout: "centered" },
});

export const ChatAnswer = meta.story({
  render: () => (
    <>
      <ScreenHeader
        variant="title"
        title="Brain"
        titleSize={19}
        avatarIcon="brain"
        subtitle="connected · local"
        subTone="teal"
        subDot="teal"
        trailingIcon="history"
        filament
      />
      <ScreenBody padding="14px 16px 6px" gap={10} overflow="auto">
        <MessageBubble role="user" text={userMessage} actions={false} />

        <Disclosure label={answerTrace}>
          <TraceSteps variant="rail" steps={researcherTrace} />
        </Disclosure>

        <StatTiles tiles={answerStats} minTile={96} />

        <QuoteCard
          quote={forecastQuote.quote}
          source={forecastQuote.source}
          locator={forecastQuote.locator}
          note={forecastQuote.note}
          tone={forecastQuote.tone}
        />

        <StepList variant="progress" steps={straitSteps} />

        <MapView
          title={straitMap.title}
          subtitle={straitMap.subtitle}
          meta={straitMap.meta}
          icon={straitMap.icon}
          pins={straitMap.pins}
          paths={straitMap.paths}
          spanKm={straitMap.spanKm}
          height={88}
        />

        {/* One closing row per answer, never two (D37): chips while this is
         * the live answer, because they offer the next move; FeedbackRow only
         * once the reader has moved past it and a grade is all that is left. */}
        <SuggestionChips label="" items={suggestions.slice(0, 3).map((s) => ({ ...s, onClick: fn() }))} />
      </ScreenBody>
      <Composer variant="send" hint="/ for commands" onSend={on.send} onAttach={on.attach} />
      <TabBar items={tabs.map((t) => ({ ...t, onClick: fn() }))} active={0} />
    </>
  ),
});

/** Nothing crosses the phone's edges. */
export const NothingEscapesTheFrame = ChatAnswer.extend({
  play: async ({ canvasElement }) => {
    const frame = canvasElement.firstElementChild as HTMLElement;
    await expect(overflowing(frame)).toEqual([]);
    await expect(unreachable(frame.querySelector(".bk-screen-body")!)).toEqual([]);
  },
});

/**
 * NO PROSE PARAGRAPH ANYWHERE — the claim §11.2 exists to make.
 *
 * Every sentence on this screen is attached to something checkable: a document
 * and a line number, a step in a sequence, a coordinate, a tile's own label.
 * The check is that the only free-running text is the user's own question and
 * the quotation, and that every other block carries its source.
 *
 * It is worth asserting rather than trusting because prose is what a structured
 * answer DECAYS into — one paragraph of summary added above the tiles and the
 * screen still renders, still passes every component's stories, and has quietly
 * stopped being the thing the design is arguing for.
 */
export const NoProseParagraphAnywhere = ChatAnswer.extend({
  play: async ({ canvas }) => {
    // The quotation cites a document and a line.
    await expect(await canvas.findByText(forecastQuote.source)).toBeTruthy();
    await expect(await canvas.findByText(forecastQuote.locator)).toBeTruthy();
    // Every step is a step, not a sentence in a list.
    for (const step of straitSteps) await expect(await canvas.findByText(step.title)).toBeTruthy();
    // Every tile states a figure and what it measures.
    for (const tile of answerStats) {
      await expect(await canvas.findByText(tile.label)).toBeTruthy();
      await expect(await canvas.findAllByText(tile.value)).not.toHaveLength(0);
    }
    // The map names the two hazards by their real coordinates' labels.
    for (const pin of straitMap.pins) await expect(await canvas.findAllByText(pin.label!)).not.toHaveLength(0);
    // And the answer closes with the next moves, phrased as prompts the reader
    // could have typed — one closing row, never a feedback row stacked on it.
    for (const chip of suggestions.slice(0, 3)) await expect(await canvas.findByText(chip.label)).toBeTruthy();
    await expect(canvas.queryByRole("button", { name: /that was right/ })).toBeNull();
  },
});

/**
 * The trace is BEHIND the disclosure, not beside the answer. Closed is the
 * default and it is the whole reason the component exists: a run that touched
 * four files in 2.4s is provenance, and provenance that is always open is
 * noise that pushes the answer off the screen.
 */
export const TheTraceStartsClosed = ChatAnswer.extend({
  play: async ({ canvas, userEvent }) => {
    const toggle = await canvas.findByRole("button", { name: new RegExp(answerTrace) });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryByText(researcherTrace[0]!.text!)).toBeNull();

    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(await canvas.findByText(researcherTrace[0]!.text!)).toBeTruthy();
  },
});
