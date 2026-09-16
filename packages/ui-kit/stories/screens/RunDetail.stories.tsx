import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { approval } from "../../fixtures/actions.js";
import {
  blockedQueue,
  researcherTools,
  researcherTrace,
  runDetailMeta,
  runScopeFootnote,
  runs,
} from "../../fixtures/runs.js";
import { AgentRunCard } from "../../src/agents/AgentRunCard.js";
import { Composer } from "../../src/chrome/Composer.js";
import { ScreenBody } from "../../src/chrome/ScreenBody.js";
import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { ApprovalCard } from "../../src/decisions/ApprovalCard.js";
import { TraceSteps } from "../../src/evidence/TraceSteps.js";
import { Callout } from "../../src/primitives/Callout.js";
import { Label } from "../../src/primitives/Label.js";
import { QueueItemRow } from "../../src/rows/QueueItemRow.js";
import { phone } from "../_phone.js";
import { overflowing, unreachable } from "../_stage.js";

/**
 * §11.4 — RUN DETAIL, STALLED MID-FLIGHT. A run that cannot continue until a
 * person answers, and a screen that says so four times over in four registers:
 * the amber dot in the header, the `active` tool on the card, the paused step
 * in the timeline, and the two queue items waiting behind the one decision.
 *
 * ## Two things make this screen structurally different from the other three
 *
 * **No `TabBar`.** It is a pushed detail screen rather than a destination, so
 * the frame shows the home indicator instead and the back affordance is the
 * header's `nav` variant. A tab bar here would say "you are somewhere", and you
 * are not — you are one level in.
 *
 * **The `Composer` is the `plain` variant.** No send affordance: this field is
 * for leaving a note on a run you are watching, not for talking to it. The
 * design draws observation and conversation as two different controls and this
 * is the observation one.
 *
 * Everything else is `runs.ts` and `actions.ts` verbatim. The header's second
 * line is derived from the run rather than typed — `run #4c1 · turn 12 ·
 * ~$0.14` is the run's own id, step count and cents through the world's one
 * money formatter — so the header cannot drift from the card underneath it,
 * which is the failure a screenshot cannot show you.
 *
 * `blockedQueue` carries three items and the screen shows two: the catalog's
 * `meta="2"` is the count of what THIS run is holding, and the third item is
 * the dead-lettered fetch, which is not being held by anything — it already
 * failed. The label reads the slice rather than the array.
 */
const on = { allow: fn(), deny: fn(), blocked: fn(), ready: fn() };

const run = runs[0]!;
const holding = blockedQueue.slice(0, 2);

const meta = preview.meta({
  title: "Screens/Run detail",
  component: ScreenBody,
  decorators: [phone({ showHome: true })],
  parameters: { layout: "centered" },
});

export const RunDetail = meta.story({
  render: () => (
    <>
      <ScreenHeader variant="nav" title={run.agent} subtitle={runDetailMeta} trailingDot="amber" />
      <ScreenBody padding="12px 16px 8px" gap={9} overflow="auto">
        <AgentRunCard
          agent={run.agent}
          state={run.state}
          task={run.task}
          progress={run.progress}
          meta={`${run.steps} steps · ${Math.round(run.tokens / 1000)}k tok · ${run.elapsed}`}
          tools={researcherTools}
        />

        <Label text="Tool timeline" meta={`${researcherTrace.length} steps`} />
        <TraceSteps variant="list" steps={researcherTrace} />

        <ApprovalCard
          tool={approval.tool}
          target={approval.target}
          toolIcon={approval.toolIcon}
          badge={approval.badge}
          diff={approval.diff}
          risk={approval.risk}
          allowLabel={approval.allowLabel}
          denyLabel={approval.denyLabel}
          allowEffect={approval.allowEffect}
          onAllow={on.allow}
          onDeny={on.deny}
        />

        <Label text="What this run is holding" icon="thread" meta={String(holding.length)} />
        <QueueItemRow {...holding[0]!} onClick={on.blocked} />
        <QueueItemRow {...holding[1]!} onClick={on.ready} />

        <Callout variant="banner" tone="neutral" icon="scope" mono text={runScopeFootnote} />
      </ScreenBody>
      <Composer variant="plain" placeholder="Send a note to this run…" />
    </>
  ),
});

/** Nothing crosses the phone's edges — and this screen has the widest content
 * in the kit, because `ApprovalCard` renders a real diff. */
export const NothingEscapesTheFrame = RunDetail.extend({
  play: async ({ canvasElement }) => {
    const frame = canvasElement.firstElementChild as HTMLElement;
    await expect(overflowing(frame)).toEqual([]);
    await expect(unreachable(frame.querySelector(".bk-screen-body")!)).toEqual([]);
  },
});

/**
 * A PUSHED SCREEN, NOT A DESTINATION.
 *
 * The two structural facts, asserted rather than described: no tab bar anywhere
 * on the screen, and the composer offers no way to send. Both are easy to
 * restore by accident — a screen assembled from the other three's shape would
 * carry a `TabBar` and a `send` composer without anyone noticing, and it would
 * then be claiming to be a destination you can talk to.
 */
export const NoTabBarAndNoSend = RunDetail.extend({
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("tablist")).toBeNull();
    await expect(canvas.queryByRole("tab")).toBeNull();
    // The field is there and is read-only; nothing offers to send it.
    const field = await canvas.findByRole("textbox", { name: /Send a note to this run/ });
    await expect(field).toHaveAttribute("readonly");
    await expect(canvas.queryByRole("button", { name: "Send" })).toBeNull();
  },
});

/**
 * STALLED, SAID FOUR WAYS, AND THEY HAVE TO AGREE.
 *
 * The header's dot, the card's active tool, the trace's paused step and the
 * blocked queue item are four independent renderings of one fact. A screen
 * where three of them say "waiting" and the fourth says "done" is worse than a
 * screen that says nothing, because it looks authoritative.
 */
export const EveryRegisterAgreesItIsStalled = RunDetail.extend({
  play: async ({ canvas }) => {
    // The tool the card shows as active is the tool the approval is about.
    const active = researcherTools.find((t) => t.state === "active")!;
    await expect(active.label).toBe(approval.tool);
    await expect(await canvas.findAllByText(approval.tool)).not.toHaveLength(0);

    // The queue item names what it is waiting on, and it is this fetch.
    await expect(await canvas.findByText(holding[0]!.link!)).toBeTruthy();
    await expect(holding[0]!.state).toBe("blocked");

    // And the header's derived meta is the run's own arithmetic, not a string.
    await expect(await canvas.findByText(runDetailMeta)).toBeTruthy();
    await expect(runDetailMeta).toContain(String(run.steps));
  },
});
