import preview from "#.storybook/preview";
import { expect, fn, userEvent } from "storybook/test";
import {
  AskUserFormCard,
  type FormNode,
} from "../../src/decisions/AskUserFormCard.js";
import { rankingJourneys } from "../../fixtures/ranking.js";
import { overflowing, stage, wide } from "../_stage.js";
const meta = preview.meta({
  title: "Decisions/Conditional form",
  component: AskUserFormCard,
  decorators: [stage],
  parameters: { stageWidth: 320 },
});
const items = rankingJourneys.slice(0, 5);
const nodes: FormNode[] = [
  {
    id: "evening",
    kind: "single",
    header: "Evening",
    prompt: "An evening at the harbor?",
    options: [
      { label: "Tales", description: "Share stories by the fire" },
      { label: "Games", description: "A contest with the crew" },
      { label: "Walk", description: "Follow the shore" },
    ],
  },
  {
    id: "tales",
    kind: "multi",
    header: "Tales",
    prompt: "Which tales?",
    showIf: { node: "evening", anyOf: ["Tales"] },
    options: [{ label: "Journeys" }, { label: "Homecomings" }],
  },
  {
    id: "games",
    kind: "rank",
    header: "Games",
    prompt: "Which crossing first?",
    showIf: { node: "evening", anyOf: ["Games"] },
    items,
  },
  {
    id: "walk",
    kind: "single",
    header: "Distance",
    prompt: "How far along the shore?",
    showIf: { node: "evening", anyOf: ["Walk"] },
    options: [{ label: "Near" }, { label: "Far" }],
  },
];
const args = {
  question: "Plan the evening",
  nodes,
  onSubmit: fn(),
  onDismiss: fn(),
};
async function geometry(root: HTMLElement) {
  await expect(overflowing(root)).toEqual([]);
  const card = root.querySelector<HTMLElement>(".bk-askform")!;
  await expect(card.getBoundingClientRect().width).toBeGreaterThan(200);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
    document.documentElement.clientWidth,
  );
  await expect(root.querySelectorAll("[data-form-head]").length).toBe(1);
  await expect(root.querySelectorAll("[data-form-actions]").length).toBe(1);
  await expect(
    root.querySelectorAll(
      "[data-rank-head],.bk-rank-actions,[data-list-head],[data-list-foot]",
    ).length,
  ).toBe(0);
}
export const FormSingle = meta.story({
  args: { ...args, answers: { evening: { value: "Walk" } } },
  play: async ({ canvasElement }) => geometry(canvasElement),
});
export const FormMulti = meta.story({
  args: { ...args, answers: { evening: { value: "Tales" } } },
  play: async ({ canvasElement }) => geometry(canvasElement),
});
export const FormRank = meta.story({
  args: { ...args, answers: { evening: { value: "Games" } } },
  play: async ({ canvasElement }) => geometry(canvasElement),
});
export const FormScale = meta.story({
  args: {
    ...args,
    answers: { evening: { value: "Tales" } },
    nodes: [
      nodes[0]!,
      {
        id: "scale",
        kind: "scale",
        prompt: "Which journeys would you tell again?",
        header: "Journeys",
        showIf: { node: "evening", anyOf: ["Tales"] },
        items,
        scale: [{ label: "Again" }, { label: "Perhaps" }, { label: "Pass" }],
        notes: true,
      },
    ],
  },
  play: async ({ canvasElement }) => geometry(canvasElement),
});
export const FormText = meta.story({
  args: {
    ...args,
    answers: { evening: { value: "Tales" } },
    nodes: [
      nodes[0]!,
      {
        id: "text",
        kind: "text",
        prompt: "What should the crew remember?",
        showIf: { node: "evening", anyOf: ["Tales"] },
      },
    ],
  },
  play: async ({ canvas, canvasElement, args }) => {
    const input = canvas.getByRole("textbox", {
      name: "What should the crew remember?",
    });
    await userEvent.type(input, "Remember the harbor.");
    await userEvent.click(canvas.getByRole("button", { name: "Submit" }));
    await expect(args.onSubmit).toHaveBeenCalledWith({
      answers: { evening: { value: "Tales" }, text: "Remember the harbor." },
      visibleNodes: ["evening", "text"],
    });
    await geometry(canvasElement);
  },
});
export const FormSwitchSetAside = meta.story({
  args,
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(
      canvas.getByRole("radio", { name: "Tales Share stories by the fire" }),
    );
    await userEvent.click(canvas.getByRole("checkbox", { name: "Journeys" }));
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Homecomings" }),
    );
    const parent = canvas.getByRole("radio", {
      name: "Games A contest with the crew",
    });
    // Storybook recentres the whole card as the branch changes its height.
    // The invariant is the options' positions within their card.
    const card = canvasElement.querySelector<HTMLElement>(".bk-askform")!;
    const tops = [
      ...canvasElement.querySelectorAll<HTMLElement>(
        '[data-form-node="evening"] > .bk-form-options > [role]',
      ),
    ].map((node) => node.getBoundingClientRect().top - card.getBoundingClientRect().top);
    await expect(tops).toHaveLength(4);
    await userEvent.click(parent);
    await expect(document.activeElement).toBe(parent);
    await expect(
      canvasElement.querySelector('[data-form-node="tales"]'),
    ).toBeNull();
    await expect(
      canvasElement.querySelector("[data-form-live]")?.textContent,
    ).toContain("2 answers set aside");
    await expect(
      [
        ...canvasElement.querySelectorAll<HTMLElement>(
          '[data-form-node="evening"] > .bk-form-options > [role]',
        ),
      ].map((node) => node.getBoundingClientRect().top - card.getBoundingClientRect().top),
    ).toEqual(tops);
    await userEvent.tab();
    await expect(document.activeElement).toBe(
      canvas.getByRole("button", {
        name: `${items[0]!.label}, position 1 of 5`,
      }),
    );
    await expect(
      canvasElement.querySelector("[data-form-actions] .bk-form-keys")
        ?.textContent,
    ).toContain("space pick up");
    await geometry(canvasElement);
  },
});
const three: FormNode[] = [
  nodes[0]!,
  {
    id: "gameKind",
    kind: "single",
    header: "Games",
    prompt: "Which kind of contest?",
    showIf: { node: "evening", anyOf: ["Games"] },
    options: [{ label: "Journeys" }, { label: "Riddles" }],
  },
  {
    id: "rank",
    kind: "rank",
    header: "Journeys",
    prompt: "Which crossing first?",
    showIf: { node: "gameKind", anyOf: ["Journeys"] },
    items,
  },
];
export const FormThreeLevels = meta.story({
  args: {
    ...args,
    nodes: three,
    answers: { evening: { value: "Games" }, gameKind: { value: "Journeys" } },
  },
  play: async ({ canvasElement }) => geometry(canvasElement),
});
const deep: FormNode[] = [
  three[0]!,
  three[1]!,
  {
    id: "location",
    kind: "single",
    header: "Harbor",
    prompt: "Where shall we gather?",
    showIf: { node: "gameKind", anyOf: ["Journeys"] },
    options: [{ label: "Harbor" }, { label: "Hall" }],
  },
  { ...three[2]!, showIf: { node: "location", anyOf: ["Harbor"] } },
];
export const FormFourLevels = meta.story({
  args: {
    ...args,
    nodes: deep,
    answers: {
      evening: { value: "Games" },
      gameKind: { value: "Journeys" },
      location: { value: "Harbor" },
    },
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(
      canvas.getByRole("button", { name: "Show full path to Journeys" }),
    ).toBeVisible();
    await geometry(canvasElement);
  },
});
export const FormFlagged = meta.story({
  args,
  play: async ({ canvas, canvasElement }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: "1 left to answer" }),
    );
    await expect(
      canvasElement.querySelector('[aria-invalid="true"]'),
    ).not.toBeNull();
    await geometry(canvasElement);
  },
});
export const FormAnsweredTales = meta.story({
  args: {
    ...args,
    state: "answered",
    answers: {
      evening: { value: "Tales" },
      tales: { values: ["Journeys", "Homecomings"] },
    },
  },
});
export const FormAnsweredGames = meta.story({
  args: {
    ...args,
    state: "answered",
    answers: {
      evening: { value: "Games" },
      games: { order: items.map((item) => item.id), unchanged: true },
    },
  },
});
export const FormAnsweredWalk = meta.story({
  args: {
    ...args,
    state: "answered",
    answers: { evening: { value: "Walk" }, walk: { value: "Near" } },
  },
});
export const FormSingleWide = FormSingle.extend({ parameters: wide });
export const FormMultiWide = FormMulti.extend({ parameters: wide });
export const FormRankWide = FormRank.extend({ parameters: wide });
export const FormScaleWide = FormScale.extend({ parameters: wide });
export const FormTextWide = FormText.extend({ parameters: wide });
export const FormSwitchSetAsideWide = FormSwitchSetAside.extend({
  parameters: wide,
});
export const FormThreeLevelsWide = FormThreeLevels.extend({ parameters: wide });
export const FormFourLevelsWide = FormFourLevels.extend({ parameters: wide });
export const FormFlaggedWide = FormFlagged.extend({ parameters: wide });
export const FormAnsweredTalesWide = FormAnsweredTales.extend({
  parameters: wide,
});
export const FormAnsweredGamesWide = FormAnsweredGames.extend({
  parameters: wide,
});
export const FormAnsweredWalkWide = FormAnsweredWalk.extend({
  parameters: wide,
});

export const FormSixOptionScale = meta.story({
  args: {
    ...args,
    nodes: [
      nodes[0]!,
      nodes[3]!,
      {
        id: "route",
        kind: "scale",
        header: "Route",
        prompt: "Which route?",
        showIf: { node: "walk", anyOf: ["Far"] },
        items,
        scale: ["Eager", "Glad", "Perhaps", "Unsure", "Later", "Pass"].map(
          (label) => ({ label }),
        ),
      },
    ],
    answers: { evening: { value: "Walk" }, walk: { value: "Far" } },
  },
  play: async ({ canvasElement }) => geometry(canvasElement),
});
export const FormNodeLimit = meta.story({
  args: {
    ...args,
    nodes: Array.from({ length: 12 }, (_, i) => ({
      id: `note-${i}`,
      kind: "text" as const,
      prompt: `Crew recollection ${i + 1}`,
      required: false,
    })),
  },
  play: async ({ canvasElement }) => geometry(canvasElement),
});
export const FormSixOptionScaleWide = FormSixOptionScale.extend({
  parameters: wide,
});
export const FormNodeLimitWide = FormNodeLimit.extend({ parameters: wide });
