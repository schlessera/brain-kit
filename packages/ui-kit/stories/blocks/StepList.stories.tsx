import preview from "#.storybook/preview";

import { straitSteps } from "../../fixtures/notes.js";
import { launchChecklist, voyageSteps } from "../../fixtures/projects.js";
import { StepList } from "../../src/blocks/StepList.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/StepList",
  component: StepList,
  decorators: [stage],
  args: { steps: straitSteps, variant: "numbered" },
});

/** A recipe you follow. Every step is numbered until it is done, and a done
 * step swaps its number for a tick — the ordinal has served its purpose. */
export const Default = meta.story({});

/** Things to tick off. No numbers at all, because a checklist has no order,
 * and a completed line is struck through. */
export const Checklist = Default.extend({
  args: { variant: "checklist", steps: launchChecklist },
});

/** Something being executed for you. Exactly one step is `current` — amber and
 * breathing — everything above it is teal, everything below is grey. */
export const Progress = Default.extend({ args: { variant: "progress", steps: voyageSteps } });

/** `pulse: false` for the reduced-motion case the a11y wave will make
 * automatic. The current step keeps its amber; it just stops breathing. */
export const NoPulse = Progress.extend({ args: { pulse: false } });

/** A step can carry a mono line of its own — a command, a bearing. */
export const WithCode = Default.extend({
  args: {
    steps: [
      { title: "Hold the Calabrian shore", code: "bearing 012", state: "current" },
      { title: "Row through", detail: "Nobody stops rowing.", state: "todo" },
    ],
  },
});

/** An EMPTY array is not a missing one: the source's `p.steps || fallback`
 * treats `[]` as a deliberate choice, so nothing renders rather than the
 * stand-in list. */
export const EmptyList = Default.extend({ args: { steps: [] } });

export const Wide = Default.extend({ parameters: wide });
