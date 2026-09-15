import preview from "#.storybook/preview";

import { researcherTrace, watcherTrace } from "../../fixtures/runs.js";
import { TraceSteps } from "../../src/evidence/TraceSteps.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Evidence/TraceSteps",
  component: TraceSteps,
  decorators: [stage],
  args: { variant: "rail", steps: researcherTrace },
  argTypes: { variant: { control: "inline-radio", options: ["rail", "list"] } },
});

/**
 * `rail` is the evidence behind a decision — why it stopped — drawn against a
 * left rule with a glyph per step. Never colour alone: the glyph carries the
 * state, so a monochrome screenshot still parses.
 */
export const Rail = meta.story({});

/** `list` is the live tool timeline: status dots, durations, and the tool
 * output under each step. */
export const List = Rail.extend({ args: { variant: "list" } });

/** The failed run behind the dead-letter card. Two steps, and the second one
 * names the host and the attempt count rather than saying "an error occurred". */
export const Failed = Rail.extend({ args: { steps: watcherTrace, variant: "list" } });

/** The `active` step is the one thing here that moves, and it moves because the
 * run is moving. */
export const Running = Rail.extend({
  args: {
    variant: "list",
    steps: [
      { state: "done", tool: "brain_search", text: "sailing directions scylla", time: "0.4s" },
      { state: "active", tool: "Read", text: "knowledge/teiresias-forecast.md", time: "0.1s" },
      { state: "skipped", tool: "Edit", text: "voyage/_index.md", time: "--" },
    ],
  },
});

/** Output blocks are SIBLINGS of their step rather than children, so the rail's
 * gap applies to both — a wrapper would collapse the spacing between them. */
export const WithOutput = Rail.extend({ args: { variant: "list", steps: researcherTrace } });

export const Wide = Rail.extend({ parameters: wide });
