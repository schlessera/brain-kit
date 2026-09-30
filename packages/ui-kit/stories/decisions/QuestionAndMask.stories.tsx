import preview from "#.storybook/preview";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";

import {
  askOptions,
  groupedQuestions,
  askUser,
  followAnswers,
  followOptions,
  followQuestion,
  listEight,
  listRating,
  listTriage,
  listTriageAnswers,
  receiptDiff,
} from "../../fixtures/actions.js";
import { AskUserCard } from "../../src/decisions/AskUserCard.js";
import { AskUserGroupCard, type AskUserGroupCardProps } from "../../src/decisions/AskUserGroupCard.js";
import { AskUserListCard } from "../../src/decisions/AskUserListCard.js";
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

/* ── One scale over many items (#583) ──────────────────────────────────────
 *
 * `ask_user_list`: the agent proposes a list and wants each item placed on one
 * scale. One header, one scale, one action row and one record per exchange,
 * whatever the item count — #541's lesson applied to rows. The plays below are
 * the issue's acceptance criteria at 320px; the `Wide` stories are the same
 * cards on desktop, where up to six options sit beside the label.
 */

const at320 = { stageWidth: 320 };

/** Every chip, measured: painted ≥44 tall and ≥60 wide, and no border. */
async function chipsAreTargets(root: HTMLElement) {
  const chips = [...root.querySelectorAll<HTMLElement>('[role="radio"]')];
  await expect(chips.length).toBeGreaterThan(0);
  for (const chip of chips) {
    const rect = chip.getBoundingClientRect();
    await expect(rect.height).toBeGreaterThanOrEqual(44);
    await expect(rect.width).toBeGreaterThanOrEqual(60);
    await expect(getComputedStyle(chip).borderTopWidth).toBe("0px");
  }
}

/** One dialog header and one action row, however many rows. */
async function oneHeaderOneActionRow(root: HTMLElement) {
  await expect(root.querySelectorAll("[data-list-head]")).toHaveLength(1);
  await expect(root.querySelectorAll("[data-list-foot]")).toHaveLength(1);
  await expect(root.querySelectorAll("[data-submit]")).toHaveLength(1);
}

const listSubmit = fn();

/** Ten landfalls on a six-option scale, nothing answered yet. */
export const ListEmpty = meta.story({
  parameters: at320,
  render: () => (
    <AskUserListCard
      id="list-empty"
      question={listRating.question}
      noun={listRating.noun}
      scale={listRating.scale}
      items={listRating.items}
      onSubmit={listSubmit}
      onDismiss={fn()}
    />
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(overflowing(canvasElement)).toEqual([]);
    await oneHeaderOneActionRow(canvasElement);
    await chipsAreTargets(canvasElement);
    await expect(canvas.getAllByRole("radiogroup")).toHaveLength(10);
    // Every chip's name starts with the option and carries the item.
    await expect(canvas.getByRole("radio", { name: "sail again, Ismaros" })).toBeInTheDocument();
    await expect(canvas.getByRole("radiogroup", { name: "Aeolia" })).toBeInTheDocument();
    await expect(canvas.getByText("0 of 10")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Submit · skip 10" })).toBeInTheDocument();
    // The host alone, from the kit's own parse of the link.
    await expect(canvas.getByRole("link", { name: "Ismaros on example.org (example.org), new tab" })).toBeInTheDocument();
    // The grid keeps positions: row one's third chip sits over row two's.
    const [a, b] = canvas.getAllByRole("radiogroup");
    const third = (g: HTMLElement) => g.querySelectorAll<HTMLElement>('[role="radio"]')[2]!.getBoundingClientRect().left;
    await expect(third(a!)).toBe(third(b!));
  },
});

/** Half answered: the fill touches only the open rows, and Undo restores. */
export const ListBulkFill = meta.story({
  parameters: at320,
  render: () => (
    <AskUserListCard
      id="list-fill"
      question={listRating.question}
      noun={listRating.noun}
      scale={listRating.scale}
      items={listRating.items}
      answers={listRating.partial}
      onSubmit={fn()}
      onDismiss={fn()}
    />
  ),
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByText("5 of 10")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Set the 5 unanswered landfalls to…" }));
    await userEvent.click(canvas.getByRole("button", { name: "Set 5 to not landed" }));
    // Filled rows took the fill; answered rows kept their own answers.
    await expect(canvas.getByRole("radio", { name: "not landed, Land of the Lotus-eaters" })).toBeChecked();
    await expect(canvas.getByRole("radio", { name: "once was enough, Ismaros" })).toBeChecked();
    await expect(canvas.getByRole("radio", { name: "not landed, Ismaros" })).not.toBeChecked();
    await expect(canvas.getByText("10 of 10")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Submit 10" })).toBeInTheDocument();
    // The receipt carries Undo, and Undo puts back exactly what was open.
    await userEvent.click(canvas.getByRole("button", { name: "Undo" }));
    await expect(canvas.getByText("5 of 10")).toBeInTheDocument();
    await expect(canvas.getByRole("radio", { name: "not landed, Land of the Lotus-eaters" })).not.toBeChecked();
    await expect(canvas.getByRole("radio", { name: "sail again, Aeaea" })).toBeChecked();
  },
});

const noSkipSubmit = fn();

/** Skipping off: Submit says how many remain, and a tap flags them. */
export const ListNoSkipFlags = meta.story({
  parameters: at320,
  render: () => (
    <AskUserListCard
      id="list-noskip"
      question={listRating.question}
      noun={listRating.noun}
      scale={listRating.scale}
      items={listRating.items}
      answers={listRating.partial}
      allowSkip={false}
      notes
      onSubmit={noSkipSubmit}
      onDismiss={fn()}
    />
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const submit = canvas.getByRole("button", { name: "5 left to answer" });
    // Dimmed in meaning, not in the DOM: announced, focusable, tappable.
    await expect(submit).toHaveAttribute("aria-disabled", "true");
    await expect(submit).toHaveAttribute("tabindex", "0");
    await expect(getComputedStyle(submit).opacity).toBe("1");
    await userEvent.click(submit);
    // Never a silent no-op: it sent nothing, and it said why.
    await expect(noSkipSubmit).not.toHaveBeenCalled();
    await expect(canvasElement.querySelectorAll('[role="radiogroup"][aria-invalid="true"]')).toHaveLength(5);
    await expect(canvas.getByText("5 need an answer")).toBeInTheDocument();
    await expect(canvasElement.querySelector("[data-live]")!.textContent).toBe(
      "5 landfalls still need an answer. Moved to Land of the Lotus-eaters."
    );
    await expect(canvas.getAllByText("needs an answer")).toHaveLength(5);
    // Focus moved to the first flagged row.
    await expect(document.activeElement?.closest('[role="radiogroup"]')).toHaveAccessibleName(
      "Land of the Lotus-eaters"
    );
    // A flag clears on its own row the moment the row is answered.
    await userEvent.click(canvas.getByRole("radio", { name: "never again, Land of the Lotus-eaters" }));
    await expect(canvasElement.querySelectorAll('[role="radiogroup"][aria-invalid="true"]')).toHaveLength(4);
    await expect(canvas.getByRole("button", { name: "4 left to answer" })).toBeInTheDocument();
    // Nothing fades here either.
    for (const el of canvasElement.querySelectorAll<HTMLElement>("*")) {
      await expect(getComputedStyle(el).opacity).toBe("1");
    }
  },
});

const skipSubmit = fn();

/** Skipping on (the default): Submit states the skip, and sends the rest. */
export const ListSkip = meta.story({
  parameters: at320,
  render: () => (
    <AskUserListCard
      id="list-skip"
      question={listRating.question}
      noun={listRating.noun}
      scale={listRating.scale}
      items={listRating.items}
      answers={listRating.partial}
      notes
      onSubmit={skipSubmit}
      onDismiss={fn()}
    />
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: "Add note, Scheria" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Note on Scheria" }), "after the games");
    await userEvent.click(canvas.getByRole("button", { name: "Submit 5 · skip 5" }));
    await expect(skipSubmit).toHaveBeenCalledTimes(1);
    const [submission] = skipSubmit.mock.calls[0]! as [{ answers: Record<string, string>; notes: Record<string, string> }];
    // A skipped item is absent, never "".
    await expect(submission.answers).toEqual(listRating.partial);
    // A note on a skipped item still travels.
    await expect(submission.notes).toEqual({ scheria: "after the games" });
  },
});

const keySubmit = fn();

/** Digits pick inside the focused row and hand focus to the next open one. */
export const ListKeyboard = meta.story({
  parameters: at320,
  render: () => (
    <AskUserListCard
      id="list-keys"
      question={listRating.question}
      noun={listRating.noun}
      scale={listRating.scale}
      items={listRating.items.slice(0, 3)}
      onSubmit={keySubmit}
      onDismiss={fn()}
    />
  ),
  play: async ({ canvas, userEvent }) => {
    canvas.getByRole("radio", { name: "sail again, Ismaros" }).focus();
    await userEvent.keyboard("3");
    await expect(canvas.getByRole("radio", { name: "once was enough, Ismaros" })).toBeChecked();
    await expect(document.activeElement?.closest('[role="radiogroup"]')).toHaveAccessibleName(
      "Land of the Lotus-eaters"
    );
    await userEvent.keyboard("{ArrowRight}{Enter}");
    await expect(canvas.getByRole("radio", { name: "glad I went, Land of the Lotus-eaters" })).toBeChecked();
    // Enter is a pick like any other; it does not advance. j moves on.
    await userEvent.keyboard("j4");
    await expect(canvas.getByRole("radio", { name: "never again, Island of the Cyclopes" })).toBeChecked();
    // The last open row answered: focus goes to Submit.
    await expect(document.activeElement).toHaveAccessibleName("Submit 3");
    await userEvent.keyboard("{Enter}");
    await expect(keySubmit).toHaveBeenCalledTimes(1);
  },
});

/** The record: grouped by option, in scale order, nothing faded. */
export const ListAnswered = meta.story({
  parameters: at320,
  render: () => (
    <AskUserListCard
      state="answered"
      question={listRating.question}
      scale={listRating.scale}
      items={listRating.items}
      answers={Object.fromEntries(Object.entries(listRating.answered).filter(([id]) => id !== "scheria"))}
      itemNotes={{ aeaea: "a year was the right length" }}
      answerMeta="you answered 9 · 2m ago"
    />
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(overflowing(canvasElement)).toEqual([]);
    const groups = [...canvasElement.querySelectorAll<HTMLElement>("[data-group]")].map((g) => g.dataset.group);
    // Scale order, empty options left out, skipped last.
    await expect(groups).toEqual(["sail again", "glad I went", "once was enough", "never again", "skipped"]);
    await expect(canvas.getByText("never again (4)")).toBeInTheDocument();
    await expect(canvas.getByText(/a year was the right length/)).toBeInTheDocument();
    await expect(canvas.queryAllByRole("radio")).toHaveLength(0);
    for (const el of canvasElement.querySelectorAll<HTMLElement>("*")) {
      await expect(getComputedStyle(el).opacity).toBe("1");
    }
  },
});

/** Thirty items on three options, pending: still one header, one action row. */
export const ListThirtyByThree = meta.story({
  parameters: at320,
  render: () => (
    <AskUserListCard
      id="list-thirty"
      question={listTriage.question}
      noun={listTriage.noun}
      scale={listTriage.scale}
      items={listTriage.items}
      answers={Object.fromEntries(Object.entries(listTriageAnswers).slice(0, 12))}
      onSubmit={fn()}
      onDismiss={fn()}
    />
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(overflowing(canvasElement)).toEqual([]);
    await oneHeaderOneActionRow(canvasElement);
    await chipsAreTargets(canvasElement);
    await expect(canvas.getAllByRole("radiogroup")).toHaveLength(30);
    await expect(canvas.getByText("12 of 30")).toBeInTheDocument();
    // Long paths wrap; they never truncate.
    for (const group of canvas.getAllByRole("radiogroup")) {
      const label = document.getElementById(group.getAttribute("aria-labelledby")!)!;
      await expect(getComputedStyle(label).textOverflow).not.toBe("ellipsis");
    }
  },
});

/** Thirty answered: the groups collapse under one count line. */
export const ListThirtyAnswered = meta.story({
  parameters: at320,
  render: () => (
    <AskUserListCard
      state="answered"
      question={listTriage.question}
      scale={listTriage.scale}
      items={listTriage.items}
      answers={listTriageAnswers}
      answerMeta="you sorted 30 · 1m ago"
    />
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expect(overflowing(canvasElement)).toEqual([]);
    await expect(canvasElement.querySelector("[data-count-line]")!.textContent).toBe("keep 6 · archive 20 · delete 4");
    const archive = canvas.getByRole("button", { name: /archive \(20\)/ });
    await expect(archive).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(archive);
    await expect(archive).toHaveAttribute("aria-expanded", "true");
    await expect(canvasElement.querySelectorAll('[data-group="archive"] li')).toHaveLength(20);
  },
});

/** Five items on eight options: two balanced rows of four at 320px. */
export const ListFiveByEight = meta.story({
  parameters: at320,
  render: () => (
    <AskUserListCard
      id="list-eight"
      question={listEight.question}
      noun={listEight.noun}
      scale={listEight.scale}
      items={listEight.items}
      onSubmit={fn()}
      onDismiss={fn()}
    />
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(overflowing(canvasElement)).toEqual([]);
    await chipsAreTargets(canvasElement);
    const first = canvas.getAllByRole("radiogroup")[0]!;
    const tops = new Set(
      [...first.querySelectorAll<HTMLElement>('[role="radio"]')].map((c) => Math.round(c.getBoundingClientRect().top))
    );
    await expect(tops.size).toBe(2);
    // The legend: shown once, because two options carry a description.
    await expect(canvas.getByText(/visited on an earlier voyage/)).toBeInTheDocument();
  },
});

/** The same three shapes on desktop. */
export const ListWide = meta.story({
  parameters: wide,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 680 }}>
      <AskUserListCard
        id="wide-ten"
        question={listRating.question}
        noun={listRating.noun}
        scale={listRating.scale}
        items={listRating.items.slice(0, 4)}
        answers={{ ismaros: "once was enough" }}
        onSubmit={fn()}
        onDismiss={fn()}
      />
      <AskUserListCard
        id="wide-eight"
        question={listEight.question}
        noun={listEight.noun}
        scale={listEight.scale}
        items={listEight.items.slice(0, 2)}
        onSubmit={fn()}
        onDismiss={fn()}
      />
      <AskUserListCard
        state="answered"
        question={listRating.question}
        scale={listRating.scale}
        items={listRating.items}
        answers={listRating.answered}
        answerMeta="you answered 10 · 2m ago"
      />
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    await expect(overflowing(canvasElement)).toEqual([]);
    await chipsAreTargets(canvasElement);
    // Six options beside the label: one line of chips per row.
    const six = canvas.getAllByRole("radiogroup", { name: "Ismaros" })[0]!;
    const sixTops = new Set(
      [...six.querySelectorAll<HTMLElement>('[role="radio"]')].map((c) => Math.round(c.getBoundingClientRect().top))
    );
    await expect(sixTops.size).toBe(1);
    // Eight options: one line under the label.
    const eight = canvas.getByRole("radiogroup", { name: "Palace of Alcinous" });
    const eightTops = new Set(
      [...eight.querySelectorAll<HTMLElement>('[role="radio"]')].map((c) => Math.round(c.getBoundingClientRect().top))
    );
    await expect(eightTops.size).toBe(1);
  },
});

/** The exchange the turn outlived: gold, no chips, and one "Ask again". */
export const ListDismissed = meta.story({
  parameters: at320,
  render: () => (
    <AskUserListCard
      state="dismissed"
      question={listRating.question}
      noun={listRating.noun}
      scale={listRating.scale}
      items={listRating.items}
      onAskAgain={fn()}
    />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.queryAllByRole("radio")).toHaveLength(0);
    await expect(canvas.getAllByRole("button", { name: "Ask again" })).toHaveLength(1);
  },
});


/* Multi-question ask_user (#541): one exchange, in both themes and widths. */
function GroupHarness(p: {
  state?: AskUserGroupCardProps["state"];
  all?: boolean;
  firstAnswered?: boolean;
  onSubmit?: AskUserGroupCardProps["onSubmit"];
  onAskAgain?: () => void;
}) {
  const questions = p.all
    ? groupedQuestions.map((q, i) => ({ ...q, header: ["Homeward leg", "Voyage notes", "Set sail now", "Return route"][i]! }))
    : groupedQuestions.slice(0, 3);
  const [values, setValues] = useState(() => questions.map((_q, i) => ({
    selected: p.firstAnswered && i === 0 ? [questions[0]!.options[0]!.label] : [] as string[],
    text: "", open: false, focused: "",
  })));
  function pick(i: number, label: string) {
    setValues((prev) => prev.map((v, j) => {
      if (i !== j) return v;
      const selected = questions[i]!.multiSelect
        ? v.selected.includes(label) ? v.selected.filter((s) => s !== label) : [...v.selected, label]
        : v.selected[0] === label ? [] : [label];
      return { ...v, selected, open: selected.includes("Other") };
    }));
  }
  function update(i: number, patch: Partial<(typeof values)[number]>) {
    setValues((prev) => prev.map((v, j) => i === j ? { ...v, ...patch } : v));
  }
  const records = ["Along the coast", "The crew · The wind", "“after the watch changes, before nightfall”", "All the way home, with each uncertainty stated beside the passage it affects"];
  return <AskUserGroupCard id="group-story" state={p.state} onSubmit={p.onSubmit ?? fn()} onDismiss={fn()} onAskAgain={p.onAskAgain} answerMeta="you answered · 2m ago"
    questions={questions.map((q, i) => {
      const value = values[i]!;
      const preview = q.options.find((o) => o.label === value.focused)?.preview
        ?? (value.selected.length === 1 ? q.options.find((o) => o.label === value.selected[0])?.preview : undefined);
      return { header: q.header, question: q.question, multi: q.multiSelect,
        answer: p.state === "answered" ? records[i] : value.selected.flatMap((s) => s === "Other" ? value.text.trim() ? [value.text.trim()] : [] : [s]).join(", "),
        annotation: value.selected.length === 1 && value.selected[0] === q.options[0]!.label && q.options[0]!.preview ? { preview: q.options[0]!.preview } : undefined,
        options: [...q.options.map((o) => ({ title: o.label, subtitle: o.description, selected: value.selected.includes(o.label), onClick: () => pick(i, o.label), onFocus: () => update(i, { focused: o.label }) })),
          { title: "Other", subtitle: value.text || "Provide a custom answer.", selected: value.selected.includes("Other"), onClick: () => pick(i, "Other"), onFocus: () => update(i, { focused: "Other" }) }],
        otherOpen: value.open, otherText: value.text, onOtherChange: (text) => update(i, { text }), onOtherSubmit: (text) => update(i, { text: text.trim(), open: false }),
        preview: preview ? <Surface label="Preview" labelIcon="file" pad={10}>{preview}</Surface> : undefined,
      };
    })} />;
}

async function groupFits(root: HTMLElement) {
  await expect(overflowing(root)).toEqual([]);
  await expect(root.querySelectorAll("[data-group-head]")).toHaveLength(1);
  for (const el of root.querySelectorAll<HTMLElement>("*")) await expect(getComputedStyle(el).opacity).toBe("1");
}

export const MultiQuestion = meta.story({
  parameters: at320,
  render: () => <GroupHarness />,
  play: async ({ canvas, canvasElement }) => {
    await groupFits(canvasElement);
    await expect(canvas.getAllByRole("button", { name: "Dismiss" })).toHaveLength(1);
    await expect(canvasElement.querySelectorAll("[data-group-actions]")).toHaveLength(1);
    for (const q of groupedQuestions.slice(0, 3)) await expect(canvas.getByRole(q.multiSelect ? "group" : "radiogroup", { name: q.question })).toBeInTheDocument();
  },
});

const groupIncompleteSubmit = fn();
export const MultiQuestionIncomplete = meta.story({
  parameters: at320,
  render: () => <GroupHarness firstAnswered onSubmit={groupIncompleteSubmit} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const primary = canvas.getByRole("button", { name: "Go to unanswered" });
    await expect(primary).not.toHaveAttribute("disabled");
    await expect(primary).not.toHaveAttribute("aria-disabled");
    await expect(canvas.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
    const live = canvasElement.querySelector("[data-group-live]")!;
    let announcements = 0;
    const observer = new MutationObserver(() => announcements++);
    observer.observe(live, { childList: true, subtree: true, characterData: true });
    await userEvent.click(primary);
    await expect(groupIncompleteSubmit).not.toHaveBeenCalled();
    await expect(canvasElement.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2);
    await expect(document.activeElement?.closest('[role="group"]')).toHaveAccessibleName(groupedQuestions[1]!.question);
    await expect(live.textContent).toBe("2 questions still need an answer. Moved to Voyage notes.");
    await expect(announcements).toBe(1);
    await userEvent.click(primary);
    await expect(announcements).toBe(2);
    await expect(groupIncompleteSubmit).not.toHaveBeenCalled();
    observer.disconnect();
    await userEvent.click(canvas.getByRole("checkbox", { name: /The crew/ }));
    await expect(canvasElement.querySelectorAll('[aria-invalid="true"]')).toHaveLength(1);
    await expect(live.textContent).toBe("2 questions still need an answer. Moved to Voyage notes.");
    await userEvent.click(canvas.getByRole("radio", { name: /At dawn/ }));
    await expect(live.textContent).toBe("All 3 answered. Submit is ready.");
    await expect(canvas.getByRole("button", { name: "Submit" })).toBeInTheDocument();
    await groupFits(canvasElement);
  },
});

const groupKeepSubmit = fn();
export const MultiQuestionKeepsAnswers = meta.story({
  parameters: at320,
  render: () => <GroupHarness onSubmit={groupKeepSubmit} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole("radio", { name: /Along the coast/ }));
    const departure = within(canvas.getByRole("radiogroup", { name: groupedQuestions[2]!.question }));
    await userEvent.click(departure.getByRole("radio", { name: /Other/ }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Your own answer, Departure" }), "after landfall");
    await userEvent.tab();
    await userEvent.click(canvas.getByRole("checkbox", { name: /The crew/ }));
    await userEvent.click(canvas.getByRole("checkbox", { name: /The wind/ }));
    await expect(canvas.getByRole("textbox")).toHaveValue("after landfall");
    await userEvent.click(canvas.getByRole("button", { name: "Submit" }));
    await expect(groupKeepSubmit).toHaveBeenCalledTimes(1);
    await expect(groupKeepSubmit).toHaveBeenCalledWith({
      [groupedQuestions[0]!.question]: "Along the coast", [groupedQuestions[1]!.question]: "The crew, The wind", [groupedQuestions[2]!.question]: "after landfall",
    }, { [groupedQuestions[0]!.question]: { preview: groupedQuestions[0]!.options[0]!.preview } });
    await groupFits(canvasElement);
  },
});

export const MultiQuestionHandOn = meta.story({
  parameters: at320,
  render: () => <GroupHarness />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const first = canvas.getByRole("radio", { name: /Along the coast/ });
    first.focus();
    await userEvent.keyboard("{Enter}");
    const crew = canvas.getByRole("checkbox", { name: /The crew/ });
    await expect(document.activeElement).toBe(crew);
    await userEvent.keyboard(" ");
    await expect(document.activeElement).toBe(crew);
    const across = canvas.getByRole("radio", { name: /Across open water/ });
    across.focus();
    await userEvent.click(across);
    await expect(document.activeElement).toBe(across);
    const departure = within(canvas.getByRole("radiogroup", { name: groupedQuestions[2]!.question }));
    departure.getByRole("radio", { name: /Other/ }).focus();
    await userEvent.keyboard("{Enter}{Tab}");
    await userEvent.type(canvas.getByRole("textbox"), "after landfall{Enter}");
    await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument();
    await expect(document.activeElement).toHaveAccessibleName("Submit");
    await groupFits(canvasElement);
  },
});

export const MultiQuestionLongest = meta.story({
  parameters: at320,
  render: () => <GroupHarness all />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const departure = within(canvas.getByRole("radiogroup", { name: groupedQuestions[2]!.question }));
    await userEvent.click(departure.getByRole("radio", { name: /Other/ }));
    await expect(canvas.getByRole("textbox").getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await groupFits(canvasElement);
    const controls = canvasElement.querySelectorAll<HTMLElement>('[role="radio"], [role="checkbox"], [role="button"]');
    await expect(controls).toHaveLength(22);
    for (const control of controls) await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  },
});

export const MultiQuestionAnswered = meta.story({
  parameters: at320,
  render: () => <GroupHarness all state="answered" />,
  play: async ({ canvas, canvasElement }) => {
    await groupFits(canvasElement);
    await expect(canvasElement.querySelectorAll("[data-group-record-row]")).toHaveLength(4);
    await expect(canvasElement.querySelectorAll("[data-group-meta]")).toHaveLength(1);
    await expect(canvas.getByText("The crew · The wind")).toBeInTheDocument();
    await expect(canvas.queryAllByRole("radio")).toHaveLength(0);
    for (const row of canvasElement.querySelectorAll<HTMLElement>("[data-group-record-row]")) await expect(getComputedStyle(row).textOverflow).not.toBe("ellipsis");
  },
});

export const MultiQuestionDismissed = meta.story({
  parameters: at320,
  render: () => <GroupHarness all state="dismissed" onAskAgain={fn()} />,
  play: async ({ canvas, canvasElement }) => {
    await groupFits(canvasElement);
    await expect(canvasElement.querySelectorAll("[data-group-lapsed]")).toHaveLength(1);
    await expect(canvasElement.querySelectorAll("[data-group-record-row]")).toHaveLength(4);
    await expect(canvas.getAllByRole("button", { name: "Ask again" })).toHaveLength(1);
    await expect(canvas.queryAllByRole("radio")).toHaveLength(0);
  },
});

const singleOtherSubmit = fn();
export const SingleQuestionUnchanged = meta.story({
  parameters: at320,
  render: () => <AskUserCard {...ask} options={options} otherOpen onOtherSubmit={singleOtherSubmit} onPrimary={fn()} onSecondary={fn()} />,
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getAllByRole("radiogroup")).toHaveLength(1);
    await expect(canvas.queryAllByRole("button")).toHaveLength(0);
    const field = canvas.getByRole("textbox", { name: "Your own answer" });
    await userEvent.type(field, "keep the omens{Enter}");
    await expect(singleOtherSubmit).toHaveBeenCalledTimes(1);
    await expect(singleOtherSubmit).toHaveBeenCalledWith("keep the omens");
  },
});

export const MultiQuestionWide = MultiQuestion.extend({ parameters: wide });
export const MultiQuestionIncompleteWide = MultiQuestionIncomplete.extend({ parameters: wide });
export const MultiQuestionKeepsAnswersWide = MultiQuestionKeepsAnswers.extend({ parameters: wide });
export const MultiQuestionHandOnWide = MultiQuestionHandOn.extend({ parameters: wide });
export const MultiQuestionLongestWide = MultiQuestionLongest.extend({ parameters: wide });
export const MultiQuestionAnsweredWide = MultiQuestionAnswered.extend({ parameters: wide });
export const MultiQuestionDismissedWide = MultiQuestionDismissed.extend({ parameters: wide });
export const SingleQuestionUnchangedWide = SingleQuestionUnchanged.extend({ parameters: wide });
