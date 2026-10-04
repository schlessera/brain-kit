import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { penelopeActions, penelopeFacts, poseidonActions, poseidonFacts } from "../../fixtures/people.js";
import { ContactCard } from "../../src/blocks/ContactCard.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/ContactCard",
  component: ContactCard,
  decorators: [stage],
  args: {
    label: "Penelope",
    role: "Wife · holding Ithaca",
    kind: "person",
    facts: penelopeFacts,
  },
});

/**
 * An entity the corpus knows about. Facts are things the corpus can PROVE —
 * where they are, when you last spoke, what they are holding — never
 * enrichment fetched from the web, which is why they are mono and key-aligned
 * rather than prose.
 */
export const Default = meta.story({});

/** The other side of a ten-year grievance. Same component, and the tones do
 * all the work of saying so. */
export const Hostile = Default.extend({
  args: {
    label: "Poseidon",
    role: "Grievance · unresolved",
    tone: "purple",
    badge: "hostile",
    facts: poseidonFacts,
  },
});

/** A company is a rounded square in blue, a project a rounded square in
 * purple. Only a person is a circle. */
export const Company = Default.extend({
  args: { kind: "company", label: "The council", role: "Olympos · decided in your favour", facts: [] },
});

export const Project = Default.extend({
  args: { kind: "project", label: "Get home after Troy", role: "Active · day 3,652", facts: [] },
});

/** Initials are derived from the label when none is given, and a one-word name
 * yields one letter rather than two. */
export const DerivedInitials = Default.extend({
  args: { label: "Telemachus", role: "Son · travelling for news", facts: [] },
});

export const Wide = Default.extend({ parameters: wide });

/** Complete machine fact keys wrap after separators in one aligned column. */
export const LongFactKey = Default.extend({
  parameters: { stageWidth: 288 },
  args: {
    facts: [
      ...penelopeFacts,
      { k: "communication_preference", v: "letters via Eumaeus" },
      { k: "home", v: "Ithaca" },
    ],
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("communication_preference")).toBeVisible();
    await expect(canvas.getByText("letters via Eumaeus")).toBeVisible();
  },
});

/**
 * THE ONE PLACE THIS PORT WIDENS THE API. The source draws these buttons and
 * gives no way to operate them — in the design's editor they are wired by hand,
 * and in React they would be dead pixels. `ContactAction.onClick` is optional
 * and absent by default, so the render with no callbacks is the source's.
 */
export const WithActions = meta.story({
  args: {
    actions: penelopeActions.map((a) => ({ ...a, onClick: fn() })),
  },
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByText("Call"));
    await expect(args.actions?.[0].onClick).toHaveBeenCalled();
  },
});

/** Without a callback the button is decorative, and D20's gating rule gives it
 * no role and no tab stop. */
export const DecorativeActions = meta.story({
  args: { actions: poseidonActions },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
  },
});
