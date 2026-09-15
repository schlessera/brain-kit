import preview from "#.storybook/preview";

import { straitChoice } from "../../fixtures/projects.js";
import { ComparisonTable } from "../../src/conversation/ComparisonTable.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Conversation/ComparisonTable",
  component: ComparisonTable,
  decorators: [stage],
  args: {
    ...straitChoice,
    footnote: "Six men is the price of the ship. The other column has no price, only a chance.",
  },
  argTypes: { labelWidth: { control: { type: "number", min: 60, max: 130, step: 1 } } },
});

/**
 * Candidates side by side — the other axis from `DataTable`, for when the
 * question is "which one" rather than "how much". The recommended column is
 * tinted and the footnote says WHY, stated as a cost rather than a preference.
 */
export const Default = meta.story({});

/** Three columns is the limit at a phone width; D22 allows a fourth past
 * 1100px and never at 390px. */
export const ThreeColumns = Default.extend({
  args: {
    columns: [
      { label: "Straight home", note: "no stop", tone: "blue" },
      { label: "Via Scheria", note: "Circe's route", tone: "amber", recommended: true },
      { label: "Winter on Ogygia", note: "wait it out", tone: "purple" },
    ],
    rows: [
      { label: "Days", cells: ["17", "17", "120+"] },
      { label: "Water", cells: [{ v: "one skin", tone: "red" }, { v: "one skin", tone: "red" }, "ample"] },
      { label: "Ship", cells: ["raft", "raft, then theirs", "—"] },
    ],
    footnote: "Only one of these ends with you in the hall before the stores run out.",
  },
});

/**
 * A MISSING VALUE IS AN EXPLICIT EM DASH, because a blank cell in a comparison
 * reads as zero. Passing `""`, `null` or nothing all render "—".
 */
export const MissingValues = Default.extend({
  args: {
    columns: [{ label: "Scylla", tone: "amber" }, { label: "Charybdis", tone: "red" }],
    rows: [
      { label: "Used before", cells: ["", ""] },
      { label: "Escapable", cells: ["no", "no"] },
    ],
    footnote: "",
  },
});

/** No recommendation: nothing is tinted, and the table is then a comparison
 * rather than an argument. */
export const NoRecommendation = Default.extend({
  args: {
    columns: straitChoice.columns.map((c) => ({ ...c, recommended: false })),
    footnote: "",
  },
});

export const WithCorner = Default.extend({ args: { corner: "strait" } });

export const Wide = Default.extend({ parameters: wide });
