import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { Button } from "../../src/primitives/Button.js";
import { Chip } from "../../src/primitives/Chip.js";
import { StatusDot } from "../../src/primitives/StatusDot.js";
import { InlineToast } from "../../src/conversation/InlineToast.js";
import { LinkPreviewCard } from "../../src/conversation/../blocks/LinkPreviewCard.js";
import { StreamingAnswer } from "../../src/conversation/StreamingAnswer.js";
import { ActionCard } from "../../src/decisions/ActionCard.js";
import { QueueItemRow } from "../../src/rows/QueueItemRow.js";
import type { ActionKind, QueueState } from "../../src/types.js";
import { knownContrastGap, stage } from "../_stage.js";

/**
 * The design's five non-negotiable rules, checked AS RULES.
 *
 * Every one of them was already true of some component somewhere. What was
 * missing is the thing that makes a rule a rule: a check that fails when the
 * next component forgets, rather than a paragraph in a README and a habit.
 *
 * Rule 5 — hit targets — is deliberately not here. It is measured where it
 * happens, with `elementFromPoint` at each target's EDGES, in `Toggle`,
 * `FeedbackRow`, `InlineToast` and `TabBar`; a copy of those numbers in this
 * file would be a second place for them to drift.
 */
const meta = preview.meta({
  title: "Rules/Non-negotiables",
  component: StatusDot,
  decorators: [stage],
  parameters: { stageWidth: "none" },
});

const QUEUE_STATES: QueueState[] = ["claimed", "blocked", "ready", "scheduled", "failed", "superseded"];
const ACTION_KINDS: ActionKind[] = [
  "approval",
  "choose",
  "dead-letter",
  "quarantined",
  "unverified",
  "fyi",
  "suggestion",
];

/**
 * RULE 1 — NEVER COLOUR ALONE.
 *
 * "Queue state, action kind and provenance each pair colour with a label or an
 * icon — amber alone never means 'needs you'. A monochrome screenshot of this
 * kit still parses."
 *
 * The render is wrapped in `grayscale(1)`, which is not decoration: it removes
 * the only channel the rule says must not be load-bearing, so anything that was
 * relying on hue is now saying nothing at all. The ASSERTION is then on words,
 * because that is what survives — reading a screenshot is exactly what this
 * check exists to replace.
 *
 * Every state and every kind, not a sample: a rule that holds for five of six
 * states is not a rule, and the sixth is the one that ships.
 */
export const NeverColourAlone = meta.story({
  // Shows all six queue states, which means it shows the superseded one — and
  // `grayscale(1)` does not change that arithmetic, it only removes the hue.
  // See design-feedback §4.
  parameters: knownContrastGap(
    "Renders every queue state, including superseded (opacity .7). The monochrome filter does not cause this; it is §4 seen without colour.",
  ),
  render: () => (
    <div style={{ filter: "grayscale(1)", display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
      {QUEUE_STATES.map((state) => (
        <QueueItemRow key={state} state={state} subject={`edit · ${state}/_index.md`} meta="6h" />
      ))}
      {ACTION_KINDS.map((kind) => (
        <ActionCard key={kind} kind={kind} title={`A card of kind ${kind}`} />
      ))}
      <LinkPreviewCard title="A page from outside the corpus" meta="example.invalid · 4 min" trust="relayed · unverified" />
      <Chip label="relayed · second-hand" variant="soft" tone="purple" icon="link" />
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    // Queue state: the state's own word is on the row.
    for (const state of QUEUE_STATES) {
      await expect(await canvas.findByText(state)).toBeVisible();
    }

    // Action kind: a kind label AND a glyph, on every card. Both are checked,
    // because the design pairs colour with "a label OR an icon" and these cards
    // carry both — losing either quietly leaves the rule technically met and the
    // card materially harder to read.
    //
    // The words are the DOM's, not the screen's: the label is uppercased by
    // `text-transform`, so a test written against the rendered capitals would
    // pass today and break the day the transform moves, for no real reason.
    const KIND_LABELS = ["Approval", "Choose", "Dead letter", "Quarantined", "Premise unverified", "FYI", "Suggestion"];
    for (const label of KIND_LABELS) {
      await expect(await canvas.findByText(label)).toBeVisible();
    }
    await expect(canvasElement.querySelectorAll("svg").length).toBeGreaterThanOrEqual(ACTION_KINDS.length);

    // Provenance: the purple border is never the only thing saying "untrusted".
    await expect(await canvas.findByText(/relayed · unverified/)).toBeVisible();

    // And the negative: nothing in that monochrome render is a bare coloured
    // mark with no text anywhere near it. A StatusDot is the one component that
    // IS pure colour, which is why it never appears alone in this kit — it is a
    // mark beside a word, and the rows above are where that is proven.
    await expect(canvasElement.querySelector(".bk-colour-only")).toBeNull();
  },
});

/**
 * RULE 2 — ANNOUNCE THE EFFECT.
 *
 * "A control that writes exposes its effect chip as part of its accessible
 * name: *'Approve this edit, enqueue'*."
 *
 * The kit satisfies this structurally rather than by wiring: the effect chip is
 * a CHILD of the button, and a `role="button"` takes its name from its contents,
 * so the chip is in the name by construction. That is worth asserting anyway —
 * the day someone moves the chip out to a sibling for layout reasons, the name
 * silently loses the half that says what the tap DOES, and nothing else in the
 * suite would notice.
 */
export const AnnounceTheEffect = meta.story({
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Button label="Approve this edit" effect="enqueue" tone="affirm" onClick={fn()} />
      <Button label="Deny" effect="no write" tone="danger" onClick={fn()} />
      <Button label="Open the file" onClick={fn()} />
    </div>
  ),
  play: async ({ canvas }) => {
    // The name is the label AND the effect, in that order.
    await expect(await canvas.findByRole("button", { name: "Approve this edit enqueue" })).toBeVisible();
    await expect(await canvas.findByRole("button", { name: "Deny no write" })).toBeVisible();

    // A control that does not write has no chip and no second half — the rule
    // is about writes, and a navigation button announcing an effect would be
    // the same lie in the other direction.
    await expect(await canvas.findByRole("button", { name: "Open the file" })).toBeVisible();
  },
});

/**
 * RULE 3 — LIVE REGIONS.
 *
 * "StreamingAnswer's phase line and InlineToast are `aria-live="polite"`;
 * background escalations announce ONCE, not per item."
 *
 * The "once" is the part worth a test. A live region per item is the classic
 * way to get this wrong: three toasts become three announcements, a list that
 * re-renders becomes a queue of them, and a screen reader user gets the same
 * sentence three times while the answer they were reading is interrupted.
 */
export const LiveRegionsAnnounceOnce = meta.story({
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
      <StreamingAnswer phase="searching" target="scylla charybdis · 3 of 4 tools done" elapsed="1.4s" />
      <InlineToast text="Queued" target="3 edits" effect="enqueue" undoLabel="Undo" onUndo={fn()} />
      <InlineToast text="Snoozed" target="until tomorrow" tone="teal" undoLabel="" />
      <InlineToast text="Filed" target="omens/" tone="teal" undoLabel="" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const live = canvasElement.querySelectorAll('[aria-live="polite"]');

    // One per announcing THING — a streaming answer and three toasts — and not
    // one per item inside any of them.
    await expect(live).toHaveLength(4);

    // `polite`, never `assertive`: a phase change must not cut across the answer
    // being read. Nothing in this kit is allowed to interrupt.
    await expect(canvasElement.querySelectorAll('[aria-live="assertive"]')).toHaveLength(0);
    await expect(canvasElement.querySelectorAll("[role=alert]")).toHaveLength(0);

    // A live region must not CONTAIN another one, which is how a single change
    // gets announced twice.
    for (const region of live) {
      await expect(region.querySelectorAll("[aria-live]")).toHaveLength(0);
    }

    // The phase line announces the agent's own word, not a euphemism.
    await expect(live[0]!.textContent).toContain("brain_search");
  },
});

/**
 * RULE 4 — REDUCED MOTION.
 *
 * "`prefers-reduced-motion` drops `breathe` to a static dot and skeletons to
 * still bars. NOTHING CONVEYS MEANING THROUGH MOTION ALONE, so nothing is lost."
 * Since #1116 the skeleton is ghost text, and reduced motion shows it as plain
 * blurred text in the base colour: no sweep, no spectrum, an instant handoff,
 * no settling tail.
 *
 * Two halves, and both are checked here against the STYLESHEET THE BROWSER
 * ACTUALLY LOADED rather than against the source file — a rule that is present
 * in `theme.css` and dropped by the build is the failure mode that a source
 * grep cannot see.
 *
 * The first half is that the override exists, is inside the media query, and
 * settles at the REST state: a dot that reduced motion left at `opacity: .6`
 * would read as disabled, which is meaning lost rather than motion removed.
 *
 * The second half is that nothing needed the motion in the first place. Each
 * breathing thing is checked for a signal that survives the animation being
 * switched off — a word, a glyph, or a shape.
 */
export const ReducedMotion = meta.story({
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
      <QueueItemRow state="claimed" subject="index · omens/" meta="lease 40s" note="held by note-filer" />
      <StreamingAnswer phase="writing" target="drafting" elapsed="4.1s" />
      <StreamingAnswer phase="searching" target="omens · 1 of 3 tools" elapsed="0.8s" text="" />
      <InlineToast text="Queued" target="3 edits" pending undoLabel="Undo" onUndo={fn()} />
    </div>
  ),
  play: async ({ canvas }) => {
    /* ── Half one: the rule is in the stylesheet the browser loaded. ─────── */
    let override: CSSKeyframesRule | null = null;
    let ghostStill = false;
    let handoffInstant = false;
    let mediaRules = 0;
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // a cross-origin sheet; none of ours are.
      }
      for (const rule of rules) {
        if (!(rule instanceof CSSMediaRule)) continue;
        if (!rule.conditionText.includes("prefers-reduced-motion")) continue;
        mediaRules += 1;
        for (const inner of rule.cssRules) {
          if (inner instanceof CSSKeyframesRule && inner.name === "breathe") override = inner;
          if (inner instanceof CSSStyleRule && inner.selectorText === ".bk-ghost") {
            ghostStill =
              inner.style.animationName === "none" &&
              inner.style.backgroundImage === "none" &&
              inner.style.color === "var(--bk-ghost-base)";
          }
          if (inner instanceof CSSStyleRule && inner.selectorText.includes(".bk-ghost-out")) {
            handoffInstant = inner.style.animationDuration === "0s";
          }
        }
      }
    }

    await expect(mediaRules).toBe(1);
    await expect(override).not.toBeNull();

    // One stop, and it is the rest state. Two stops would still animate; a
    // single stop at the trough would leave everything looking disabled.
    await expect(override!.cssRules).toHaveLength(1);
    await expect(override!.cssRules[0]!.cssText).toContain("opacity: 1");

    // Ghost text, in the same block: still, and the handoff instant.
    await expect(ghostStill).toBe(true);
    await expect(handoffInstant).toBe(true);

    /* ── Half two: nothing conveyed meaning through the motion. ──────────── */
    // The breathing dot on a claimed row means "an agent holds a lease" — and
    // the row says so in words as well.
    await expect(await canvas.findByText("claimed")).toBeVisible();
    await expect(await canvas.findByText(/lease 40s/)).toBeVisible();

    // The ghost means "still arriving" — and the phase line says which phase,
    // in the agent's own vocabulary, while it does.
    await expect(await canvas.findByText("drafting answer")).toBeVisible();
    await expect(await canvas.findByText("brain_search")).toBeVisible();

    // The breathing toast means "not committed yet" — and it offers the Undo
    // that is the whole reason the pending state exists.
    await expect(await canvas.findByRole("button", { name: "Undo" })).toBeVisible();
  },
});

/**
 * LOADING IS NOT AMBIENT MOTION (#1116).
 *
 * "One ambient animation" still holds, word for word: `breathe` is the only
 * thing that moves on its own for as long as a state lasts. Ghost text moves
 * too, and it is not a second ambient animation — it is a loading state, and
 * it ends when the data does. That is the line: an ambient motion has no end
 * the user is waiting for; a loading state has exactly one.
 *
 * Checked as a rule rather than a sentence: a ghost is always inside a busy
 * container (the thing it is waiting for), and it is gone once that container
 * is no longer busy.
 */
export const LoadingIsNotAmbient = meta.story({
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
      <QueueItemRow view="loading" />
      <ActionCard state="loading" />
      <StreamingAnswer phase="searching" text="" />
      <div data-ready="">
        <QueueItemRow state="claimed" subject="index · omens/" />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const ghosts = [...canvasElement.querySelectorAll<HTMLElement>(".bk-ghost")];
    await expect(ghosts.length).toBeGreaterThan(0);
    for (const g of ghosts) {
      await expect(g.closest('[aria-busy="true"]')).not.toBeNull();
      await expect(getComputedStyle(g).animationName).not.toBe("breathe");
    }
    // The ready row carries no ghost: nothing loading, nothing sweeping.
    await expect(canvasElement.querySelectorAll("[data-ready] .bk-ghost")).toHaveLength(0);
  },
});
