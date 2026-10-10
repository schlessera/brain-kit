import preview from "#.storybook/preview";
import { fn } from "storybook/test";
import { HygieneEnd } from "../../src/decisions/HygieneCard.js";
import { stage } from "../_stage.js";
const click = fn();
const meta = preview.meta({
  title: "Decisions/HygieneEnd",
  component: HygieneEnd,
  decorators: [stage],
  args: {
    empty: false,
    fixed: 4,
    dismissed: 1,
    snoozed: 2,
    due: "13 Jul",
    informational: 3,
    dismissedErrors: 1,
    onShowSnoozed: click,
  },
});
export const Complete = meta.story({});
export const NoOpenFindings = meta.story({ args: { empty: true, fixed: 0 } });
