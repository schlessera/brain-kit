import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { askOptions, askUser, followAnswers, followOptions, followQuestion, receiptDiff } from "../../fixtures/actions.js";
import { AskUserCard } from "../../src/decisions/AskUserCard.js";
import { Receipt } from "../../src/evidence/Receipt.js";
import { Callout } from "../../src/primitives/Callout.js";
import { DiffBlock } from "../../src/primitives/DiffBlock.js";
import { Surface } from "../../src/primitives/Surface.js";
import { accent, color, font, token } from "../../src/tokens.js";
import { overflowing, stage, wide } from "../_stage.js";

/**
 * CATALOG §13 — A QUESTION IS AN EXCHANGE · A MASK IS A RECEIPT.
 *
 * Two tool results that are not tool cards. `ask_user` is a turn in the
 * conversation, so it has an answered state that stays in the transcript at
 * full contrast — nothing fades, because a past question is not
 * lower-contrast, it is answered. `request_image_mask` returns a region, and a
 * path is not a region: what the user drew has to be visible next to what it
 * was drawn on, or the next answer is arguing from evidence nobody can check.
 *
 * The seventh drop added to the section: the multi-select shape (pending and
 * answered), the `dismissed` fourth state, the ruling that an absent region
 * is STATED absent on the receipt, and the tinted `DiffBlock` for the diff
 * that is itself the decision.
 *
 * The mask receipt is COMPOSITION — `Surface`, `Receipt`, `Callout` and a
 * hatched thumb drawn from tokens — which is the catalog's own test that a new
 * surface is assembly work, not design work. The thumb is the same hatch
 * `AttachmentRow` draws for an image: no remote image is ever loaded inline.
 */
const meta = preview.meta({
  title: "Decisions/Question and mask",
  component: AskUserCard,
  decorators: [stage],
  parameters: { stageWidth: 390 },
});

const options = askOptions.map((o) => ({ ...o, onClick: fn() }));
const multiOptions = followOptions.map((o) => ({ ...o, onClick: fn() }));
// The fixture's `tone` is the wide `Tone`; the card takes the three it draws.
const ask = { prompt: askUser.prompt, question: askUser.question, tag: askUser.tag, tone: "purple" as const };

const rule = { height: 1, background: color.line, width: "100%" } as const;

/** Four states, single and multi, stacked the way the catalog draws them. */
function TheCards() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
      <AskUserCard {...ask} id="pending" options={options} otherOpen onOtherSubmit={fn()} onPrimary={fn()} onSecondary={fn()} />
      <div style={rule} />
      <AskUserCard
        id="multi-pending"
        multi
        tag={followQuestion.tag}
        question={followQuestion.question}
        options={multiOptions}
        primaryLabel="Keep 2"
        onPrimary={fn()}
        onSecondary={fn()}
      />
      <div style={rule} />
      <AskUserCard {...ask} id="answered" state="answered" answer={askOptions[0].title} answerMeta="you chose this · 2m ago" />
      <AskUserCard
        id="multi-answered"
        state="answered"
        multi
        tag={followQuestion.tag}
        question={followQuestion.question}
        answers={followAnswers}
      />
      <AskUserCard
        {...ask}
        id="typed"
        state="typed"
        answer="“file it with the omens, and tell Eumaeus”"
        answerMeta="taken from your next message · 2m ago"
      />
      <AskUserCard {...ask} id="dismissed" state="dismissed" prompt={undefined} onAskAgain={fn()} />
    </div>
  );
}

const maskRows = [
  { k: "region", v: "0.18,0.26 → 0.64,0.78", tone: "teal" as const },
  { k: "covers", v: "24% of the image" },
  { k: "source", v: "ionian-approach.png", tone: "teal" as const },
  { k: "mask", v: "masks/ionian-approach-1.png", tone: "neutral" as const },
];

/** The mask over its source, stacked above the facts a later answer may cite. */
function MaskReceipt() {
  return (
    <Surface label="Mask drawn" labelIcon="confirm" meta="by you · 06:12">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div
          style={{
            position: "relative",
            width: "100%",
            height: 132,
            flex: "none",
            borderRadius: 9,
            overflow: "hidden",
            border: `1px solid ${color.edge}`,
            background: `repeating-linear-gradient(135deg,${color.raised} 0 6px,${token("hatch-stripe")} 6px 12px)`,
          }}
        >
          <div
            data-testid="mask-region"
            style={{
              position: "absolute",
              left: "18%",
              top: "26%",
              width: "46%",
              height: "52%",
              borderRadius: 6,
              background: token("mask-region-fill"),
              border: `1px dashed ${accent.teal.ink}`,
            }}
          />
          <span
            style={{
              position: "absolute",
              left: 6,
              bottom: 5,
              font: `500 8.5px/1 ${font.mono}`,
              color: color.inkMute,
              background: token("inset-well-bg"),
              borderRadius: 3,
              padding: "2px 4px",
            }}
          >
            1512×1134
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Receipt title="" rows={maskRows} keyWidth={58} />
        </div>
      </div>
    </Surface>
  );
}

/** The failure, as a fact about the evidence rather than an error dialog. */
function NoMask() {
  return (
    <Callout
      text="no mask drawn · dismissed after 2 prompts — the agent continued on the whole image and said so"
      icon="failed"
      tone="red"
      variant="boxed"
      mono
      italic={false}
    />
  );
}

/**
 * Pending keeps one focus stop and stays reachable. Answered keeps the decision
 * and drops the alternatives — they were never the record. Typed is the one the
 * app has to handle: the user answered in the composer instead of picking.
 * Dismissed is the question the turn outlived — gold, because an unanswered
 * premise may have rotted, and it offers to ask again.
 */
export const FourStates = meta.story({
  render: () => <TheCards />,
  play: async ({ canvas, canvasElement }) => {
    // One radiogroup and one checkbox group: the closed exchanges render no
    // options at all.
    await expect(canvas.getAllByRole("radiogroup")).toHaveLength(1);
    await expect(canvas.getAllByRole("radio")).toHaveLength(3);
    const group = canvas.getByRole("group");
    await expect(group).toHaveAccessibleName(followQuestion.question);
    await expect(canvas.getAllByRole("checkbox")).toHaveLength(3);
    await expect(canvas.getByRole("textbox", { name: "Your own answer" })).toBeInTheDocument();
    await expect(canvas.getByText("Answered · 2 chosen")).toBeInTheDocument();
    await expect(canvas.getByText("Unanswered — the turn ended")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Ask again" })).toBeInTheDocument();
    // Nothing fades: a past question is not lower-contrast, it is answered.
    for (const el of canvasElement.querySelectorAll<HTMLElement>("*")) {
      await expect(getComputedStyle(el).opacity).toBe("1");
    }
  },
});

/**
 * TINTED is for the one case where the diff is the decision — a tool receipt
 * whose approval turns on these exact lines. Removed red, added teal, at the
 * tint rule on the fill hue; the sign column is a mark and takes the tone at
 * full weight, never 70% alpha. The long context line wraps with a hanging
 * indent: a diff row is the record, and an ellipsis in evidence is not
 * evidence.
 */
export const TintedDiff = meta.story({
  render: () => <DiffBlock tinted text={receiptDiff} />,
  play: async ({ canvasElement }) => {
    const block = canvasElement.querySelector<HTMLElement>("[data-tinted]")!;
    await expect(overflowing(block)).toEqual([]);
    await expect(block.querySelectorAll('[data-sign="-"]')).toHaveLength(2);
    await expect(block.querySelectorAll('[data-sign="+"]')).toHaveLength(2);
  },
});

/**
 * The mask over its source, at thumbnail size, plus the facts a later answer
 * may cite. The drawn region sits on the hatched thumb in teal, because the
 * region is the user's own answer.
 *
 * THE THUMB IS STACKED ABOVE THE RECEIPT, not beside it. In the design's words:
 * "side by side left an 86px value column, and `word-break: break-all`
 * shattered `masks/whiteboard-pricing-1.png` mid-word. When a value column
 * falls under ~160px, change the layout, not the break rule." A Receipt's
 * value IS the record, so it may never truncate — the layout has to give it
 * the room.
 */
export const MaskDrawn = meta.story({
  render: () => <MaskReceipt />,
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("Mask drawn")).toBeInTheDocument();
    await expect(canvas.getByText("1512×1134")).toBeInTheDocument();
    // The mask path is one unbroken word on its own line: nothing shattered.
    const mask = canvas.getByText("masks/ionian-approach-1.png");
    await expect(overflowing(canvasElement)).toEqual([]);
    await expect(mask.getBoundingClientRect().width).toBeGreaterThan(160);
    // The region is drawn over the thumb, not described beside it.
    await expect(canvasElement.querySelector('[data-testid="mask-region"]')).not.toBeNull();
  },
});

/**
 * Failure is a fact about the evidence, not an error dialog: the run did not
 * stop, so the card states what the agent fell back to. A dismissed mask that
 * silently became "whole image" is how an answer ends up citing the wrong half
 * of a whiteboard.
 */
export const NoMaskDrawn = meta.story({ render: () => <NoMask /> });

/** The whole section, as the catalog lays it out. */
export const TheSection = meta.story({
  parameters: wide,
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 34, alignItems: "flex-start", width: "100%" }}>
      <div style={{ flex: "0 0 390px", display: "flex" }}>
        <TheCards />
      </div>
      <div style={{ flex: "0 0 390px", display: "flex", flexDirection: "column", gap: 12 }}>
        <MaskReceipt />
        <NoMask />
        <div style={{ ...rule, margin: "2px 0" }} />
        <DiffBlock tinted text={receiptDiff} />
      </div>
    </div>
  ),
});
