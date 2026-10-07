import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { actions } from "../../fixtures/actions.js";
import { fetchReceipt, researcherTrace } from "../../fixtures/runs.js";
import { Button } from "../../src/primitives/Button.js";
import { ActionCard } from "../../src/decisions/ActionCard.js";
import { Receipt } from "../../src/evidence/Receipt.js";
import { TraceSteps } from "../../src/evidence/TraceSteps.js";
import type { ActionEmphasis, ActionKind } from "../../src/types.js";
import { overflowing, stage, wide } from "../_stage.js";
import { Handoff, playHandoff } from "../_ghost.js";

const KINDS: ActionKind[] = [
  "approval",
  "choose",
  "dead-letter",
  "quarantined",
  "unverified",
  "fyi",
  "suggestion",
];
const EMPHASES: ActionEmphasis[] = ["bold", "tinted", "dashed", "plain"];

const first = actions[0];

const meta = preview.meta({
  title: "Decisions/ActionCard",
  component: ActionCard,
  decorators: [stage],
  args: {
    state: "ready",
    kind: first.kind,
    title: first.title,
    body: first.body,
    rightMeta: first.rightMeta,
    rightMetaTone: first.rightMetaTone,
    footMeta: first.footMeta,
    footDot: first.footDot,
    footPulse: first.footPulse,
    chevron: true,
    onClick: fn(),
  },
  argTypes: {
    state: { control: "select", options: ["ready", "loading", "empty", "error"] },
    kind: { control: "select", options: KINDS },
    emphasis: { control: "select", options: EMPHASES },
    rightChipTone: { control: "select", options: ["purple", "teal", "amber", "red"] },
    rightMetaTone: { control: "inline-radio", options: ["neutral", "red"] },
    icon: { control: "text" },
  },
});

/**
 * `kind` decides icon, accent, border weight and kind label TOGETHER, so
 * "decide this" never looks like "something broke". The approval carries the
 * heavy border because it blocks a queue item.
 */
export const Default = meta.story({});

/** All seven kinds, one night's escalations. Each brings its own default
 * emphasis, which is why the list reads as a hierarchy rather than a stack. */
export const Kinds = meta.story({
  parameters: wide,
  render: (args) => (
    <>
      {actions.map((a) => (
        <ActionCard
          {...args}
          key={a.kind}
          kind={a.kind}
          title={a.title}
          body={a.body}
          rightChip={a.rightChip}
          rightChipTone={a.rightChipTone}
          rightMeta={a.rightMeta}
          rightMetaTone={a.rightMetaTone}
          footMeta={a.footMeta}
          footDot={a.footDot}
          footPulse={a.footPulse}
          struck={a.struck}
        />
      ))}
    </>
  ),
});

/** The four border weights on one kind, which is what `emphasis` overrides. */
export const Emphases = meta.story({
  render: (args) => (
    <>
      {EMPHASES.map((emphasis) => (
        <ActionCard {...args} key={emphasis} emphasis={emphasis} kindLabel={emphasis} body={undefined} />
      ))}
    </>
  ),
});

/** Provenance is a chip; machine facts are mono text. The design keeps them
 * apart because one says where the material came from and the other says what
 * it will cost you. */
export const Provenance = Default.extend({
  args: {
    kind: "choose",
    title: actions[1].title,
    body: actions[1].body,
    rightChip: actions[1].rightChip,
    rightChipTone: actions[1].rightChipTone,
    rightMeta: undefined,
  },
});

/** A premise that has gone stale strikes the title through — the claim is
 * still shown, because deleting it would hide what the brain believed. */
export const Struck = Default.extend({
  args: { kind: "unverified", title: actions[4].title, body: actions[4].body, struck: true, footDot: undefined },
});

/* ── The children slot ─────────────────────────────────────────────────── */

/** The evidence slot takes a `Receipt`: exactly what the tap would grant,
 * scoped to one host and one run. This is the deepest composition in the wave
 * and one of the four run through the DC parity harness. */
export const WithReceipt = Default.extend({
  args: {
    children: (
      <div style={{ marginTop: 9 }}>
        <Receipt rows={fetchReceipt.rows} footnote={fetchReceipt.footnote} title="Capability you'd grant" />
      </div>
    ),
  },
});

/** Or a trace rail, when the question is why the run stopped. */
export const WithTrace = Default.extend({
  args: {
    children: (
      <div style={{ marginTop: 9 }}>
        <TraceSteps steps={researcherTrace} />
      </div>
    ),
  },
});

/**
 * Or the buttons themselves. Two things here are load-bearing.
 *
 * The card has NO handler of its own: two hit targets inside one is how a row
 * records the wrong answer.
 *
 * And the buttons pass `block={false}`, which is the design's own
 * content-sized action row — `AskUserCard` does exactly this. An earlier
 * revision of this story left `block` at its default and the second button
 * rendered outside the card, because `block` means `width: 100%` AND
 * `flex: none`. The other legitimate shape, an even split, is what
 * `ApprovalCard` uses; see its `ButtonsFitTheCard` story.
 */
export const WithButtons = Default.extend({
  args: {
    onClick: undefined,
    chevron: false,
    children: (
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <Button label="Fetch once" tone="primary" size="sm" block={false} effect="enqueue" onClick={fn()} />
        <Button label="Skip it" tone="danger" size="sm" block={false} onClick={fn()} />
      </div>
    ),
  },
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector("div > div") as HTMLElement;
    await expect(overflowing(card)).toEqual([]);
  },
});

/* ── The Placeholder delegation, all four states ───────────────────────── */

export const Loading = Default.extend({ args: { state: "loading" } });

export const Empty = Default.extend({ args: { state: "empty" } });

export const ErrorState = Default.extend({ args: { state: "error", onStateAction: fn() } });

export const EmptyOverridden = Default.extend({
  args: { state: "empty", stateMessage: "Nothing is waiting on you", stateDetail: "41 resolved this week." },
});

export const Retried = ErrorState.extend({
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByText("Retry"));
    await expect(args.onStateAction).toHaveBeenCalled();
  },
});

export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const card = await canvas.findByRole("button");
    await userEvent.click(card);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    card.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(3);
  },
});

/** THE CONTRACT. An FYI is not pressable — nothing needs you — so it carries
 * no role, no tab stop and no hover. */
export const Static = meta.story({
  args: { onClick: undefined, kind: "fyi", title: actions[5].title, body: actions[5].body },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});

/**
 * `footLink` is the one real link in the foot — "blocks queue item ▸" — kept
 * apart from the card's own handler. A card that is a container of controls
 * (no `onClick`) still offers it, and tapping it never opens the card.
 */
export const FootLink = Default.extend({
  args: {
    onClick: undefined,
    chevron: false,
    title: "File the harbour-fee notice into the port ledger?",
    footMeta: "parked 2h",
    footLink: { label: "blocks queue item ▸", name: "Open the blocked queue item", onClick: fn() },
  },
  play: async ({ canvas, userEvent, args }) => {
    const link = await canvas.findByRole("button", { name: "Open the blocked queue item" });
    await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(link);
    await expect(args.footLink!.onClick).toHaveBeenCalledTimes(1);
    // The chevron would claim the card itself opens; the link replaces it.
    await expect(canvas.getAllByRole("button")).toHaveLength(1);
  },
});

/**
 * Loading → ready (#1116). A plain 1px frame with ghost lines in each line's
 * own role — kind, title, body, foot — and an outline slot for the icon. The
 * approval's 2px amber border is data, so it arrives with the data; the plain
 * frame pads a pixel more meanwhile, so the text does not move when it does.
 */
export const LoadingToReady = meta.story({
  parameters: wide,
  render: () => {
    const { thread: _thread, ...card } = actions[0]!;
    return <Handoff render={(loading) => <ActionCard state={loading ? "loading" : "ready"} {...card} />} />;
  },
  play: playHandoff,
});
