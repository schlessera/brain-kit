import preview from "#.storybook/preview";

import { crewTable } from "../../fixtures/money.js";
import { DataTable } from "../../src/evidence/DataTable.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Evidence/DataTable",
  component: DataTable,
  decorators: [stage],
  args: { columns: crewTable.columns, rows: crewTable.rows },
});

/**
 * The crew ledger: six hundred men out of Troy, counted honestly.
 *
 * Numbers are mono and right-aligned; a cell tone is a JUDGEMENT — red for the
 * landfalls that cost more than a hundred, gold for the rest — never
 * decoration. The design's own defaults for this component invoice three real
 * companies, so nothing here comes from them.
 */
export const Default = meta.story({});

/** Columns with no `w` share the remaining space; columns with one hold it. A
 * two-column table is the shape most model answers actually want. */
export const TwoColumns = Default.extend({
  args: {
    columns: [{ label: "Landfall" }, { label: "Day", w: 54, align: "right" }],
    rows: [
      { cells: [{ v: "Ismarus", bold: true }, { v: "9", mono: true }] },
      { cells: [{ v: "Aeaea", bold: true }, { v: "611", mono: true }] },
      { cells: [{ v: "Thrinacia", bold: true }, { v: "1,047", mono: true, tone: "red" }] },
    ],
  },
});

/** One row, which is what a lookup answer looks like. The head rule still
 * reads at 2px because the label row and the data row are the same size. */
export const SingleRow = Default.extend({ args: { rows: crewTable.rows.slice(0, 1) } });

/** Untoned cells take ink, not the neutral accent: `ink` is the absence of a
 * judgement, and the neutral accent is a judgement that something is idle. */
export const Untoned = Default.extend({
  args: { rows: crewTable.rows.map((r) => ({ cells: r.cells.map((c) => ({ ...c, tone: undefined })) })) },
});

export const Wide = Default.extend({ parameters: wide });
