import preview from "#.storybook/preview";
import { fn } from "storybook/test";
import { HygieneBlocker } from "../../src/decisions/HygieneCard.js";
import { stage } from "../_stage.js";
const meta = preview.meta({
  title: "Decisions/HygieneBlocker",
  component: HygieneBlocker,
  decorators: [stage],
  args: { reason: 'unknown key "schemaa" (line 3)', onOpen: fn(), onRetry: fn() },
});
export const Configuration = meta.story({});
