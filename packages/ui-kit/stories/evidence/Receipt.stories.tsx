import preview from "#.storybook/preview";

import { quarantine } from "../../fixtures/actions.js";
import { fetchReceipt, forecastDiff } from "../../fixtures/runs.js";
import { Receipt } from "../../src/evidence/Receipt.js";
import type { Tone } from "../../src/types.js";
import { stage, wide } from "../_stage.js";

const TONES: Tone[] = ["amber", "teal", "red", "purple", "gold", "blue", "neutral"];

const meta = preview.meta({
  title: "Evidence/Receipt",
  component: Receipt,
  decorators: [stage],
  args: {
    title: "Capability you'd grant",
    titleIcon: "capability",
    titleTone: "amber",
    rows: fetchReceipt.rows,
    footnote: fetchReceipt.footnote,
    footIcon: "scope",
    footTone: "teal",
    keyWidth: 56,
  },
  argTypes: {
    titleTone: { control: "select", options: TONES },
    footTone: { control: "select", options: TONES },
    keyWidth: { control: { type: "number", min: 40, max: 90, step: 1 } },
    titleIcon: { control: "text" },
    footIcon: { control: "text" },
  },
});

/**
 * The footnote is the load-bearing line: it is where the SCOPE of the grant is
 * stated, and the design's rule is that a capability without a stated scope is
 * a standing grant however it was labelled.
 */
export const Default = meta.story({});

/** A diff belongs inside the receipt when the fact being attested IS the
 * change: the reader should not have to hold two cards in their head. */
export const WithDiff = Default.extend({ args: { diff: forecastDiff } });

/** The hash mismatch, which is what `quarantined` escalates on. `neutral` here
 * is dim ink rather than the muted accent — Receipt's tone table is its own,
 * because an unremarkable value is still a value to read. */
export const HashMismatch = Default.extend({
  args: {
    title: "What changed",
    titleIcon: "quarantined",
    titleTone: "red",
    rows: quarantine.rows,
    diff: quarantine.diff,
    footnote: quarantine.escalation,
    footIcon: "policy",
    footTone: "red",
    keyWidth: 68,
  },
});

/** Where the material came in from, which is a different question from what it
 * says — the design keeps provenance on its own card for that reason. */
export const Provenance = Default.extend({
  args: {
    title: "Provenance",
    titleIcon: "trust",
    titleTone: "purple",
    rows: quarantine.provenance,
    footnote: "relayed material is never trusted on arrival",
    footIcon: "scope",
    footTone: "purple",
  },
});

/** No title, no footnote: the bare key/value block, for a receipt embedded in
 * a card that has already said what it is. */
export const RowsOnly = Default.extend({ args: { title: "", footnote: "" } });

export const Wide = Default.extend({ parameters: wide });
