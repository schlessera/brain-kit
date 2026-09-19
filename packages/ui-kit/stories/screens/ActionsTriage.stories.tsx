import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import {
  actionPolicies,
  actionThreads,
  actionsCap,
  actionsFyiStrip,
  actionsHeaderMeta,
  approval,
  queueItems,
} from "../../fixtures/actions.js";
import { tabs } from "../../fixtures/files.js";
import { ScreenBody } from "../../src/chrome/ScreenBody.js";
import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { TabBar } from "../../src/chrome/TabBar.js";
import { ActionCard } from "../../src/decisions/ActionCard.js";
import { ApprovalCard } from "../../src/decisions/ApprovalCard.js";
import { Label } from "../../src/primitives/Label.js";
import { Meter } from "../../src/primitives/Meter.js";
import { ListRow } from "../../src/rows/ListRow.js";
import { QueueItemRow } from "../../src/rows/QueueItemRow.js";
import { phone } from "../_phone.js";
import { overflowing, unreachable } from "../_stage.js";

/**
 * ACTIONS TRIAGE, PHONE. The fifth assembled screen and the first past the
 * acceptance set — the design's sixth-pass ruling (§12) names it next, in
 * order, as *"the only screen that exercises `QueueItemRow` states and
 * `ApprovalCard`'s inline actions together"*.
 *
 * The source screen is `2a` (Actions — the list): *"Grouped by thread, ordered
 * by priority score, cap pressure shown as a quiet meter rather than an error.
 * FYIs sit in their own non-decision strip."* Its composition is a title
 * header with a teal count line, the cap meter, a thread label over three
 * cards, a "Policies" label over the quarantined one, and a hairline strip for
 * the FYIs above the tab bar. That is what this renders, from the Odyssey's
 * own night of escalations (`actions.ts`).
 *
 * ## Departures from the source, each with its reason
 *
 * **The approval is an `ApprovalCard`, not a collapsed `ActionCard`.** `2a`
 * draws the approval collapsed and pushes to `2b` to decide it. The ruling
 * makes THIS screen the one where the approval's inline actions are
 * exercised, so the decision is taken in place: tool, target, the real diff,
 * the blast radius, and two buttons whose accessible names carry their
 * effects. The cost is the collapsed card's kind header ("Approval · blocks a
 * queue item") and its footer ("escalated 4m ago · run #4c1"), neither of
 * which `ApprovalCard` has a slot for. The `blocked` queue item directly under
 * it carries the "4m" and names what the approval is holding, which is the
 * fact the footer existed to state.
 *
 * **Two `QueueItemRow`s sit between the cards.** The source's list has none —
 * the queue is screen `2f`. They are here because the ruling asks for the
 * queue's states beside the decisions that hold them: the `blocked` edit under
 * the approval that blocks it, and the `failed` fetch under the dead letter
 * that is its post-mortem. Both are the rows `queueItems` already carries, so
 * the triage screen and the queue screen cannot disagree about them.
 *
 * **The meter is the body's first child, not part of the header.** The source
 * draws the cap meter inside the header block; `ScreenHeader` has no slot for
 * one, and a slot is a component change. It reads `actionsCap.pct`, which is
 * derived from the same two numbers as the `6 / 60 open` text beside it.
 *
 * **The counts are derived, not typed.** The source says `6 waiting · 2
 * snoozed`; this header says `5 waiting · 2 snoozed`, because five is how many
 * of the seven cards in `actions.ts` ask for a decision — the FYI is its own
 * strip and the suggestion belongs to the weekly review. The thread labels
 * count their own groups, and the FYI strip counts the FYIs. The invariant
 * test holds the meter's `open` to the sum of the two.
 *
 * **The suggestion is not on the list.** `2a` shows four kinds — approval,
 * choose, dead letter, quarantined — plus the FYI strip. The standing-rule
 * suggestion `actions.ts` carries is the weekly review's card (§11.3), and a
 * list that offered it here too would offer the same rule from two screens.
 * The `unverified` premise IS on the list, under its thread, because a stale
 * premise is a decision — close it or re-check it — and it is one the source
 * simply had no example of that night.
 *
 * ## Nothing new
 *
 * Every element is a component the kit already ships. The three `Label`s, the
 * `Meter`, the `ApprovalCard`, the four `ActionCard`s, the two
 * `QueueItemRow`s, the `ListRow` strip and the `TabBar` all appear in their own
 * stories; this file adds no markup beyond `ScreenBody`'s column.
 */
const on = {
  allow: fn(),
  deny: fn(),
  blocked: fn(),
  failed: fn(),
  deadLetter: fn(),
  unverified: fn(),
  choose: fn(),
  quarantined: fn(),
  fyi: fn(),
};

const route = actionThreads[0]!;
const hall = actionThreads[1]!;
const deadLetter = route.items.find((a) => a.kind === "dead-letter")!;
const unverified = route.items.find((a) => a.kind === "unverified")!;
const choose = hall.items.find((a) => a.kind === "choose")!;
const quarantined = actionPolicies[0]!;
const blocked = queueItems.find((q) => q.state === "blocked")!;
const failed = queueItems.find((q) => q.state === "failed")!;

const meta = preview.meta({
  title: "Screens/Actions triage",
  component: ScreenBody,
  decorators: [phone()],
  parameters: { layout: "centered" },
});

/** The list as `2a` draws it, with the approval open for a decision. */
export const ActionsTriage = meta.story({
  render: () => (
    <>
      <ScreenHeader variant="title" title="Actions" meta={actionsHeaderMeta} metaTone="teal" trailingIcon="resolved" />
      <ScreenBody padding="0 14px 8px" gap={10} overflow="auto">
        <Meter variant="row" value={actionsCap.pct} valueText={actionsCap.valueText} height={3} tone="teal" />

        <Label text={`${route.label} · thread`} icon="thread" meta={`${route.items.length} items`} />
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
        <QueueItemRow {...blocked} onClick={on.blocked} />
        <ActionCard {...deadLetter} onClick={on.deadLetter} />
        <QueueItemRow {...failed} onClick={on.failed} />
        <ActionCard {...unverified} onClick={on.unverified} />

        <Label text={`${hall.label} · thread`} icon="thread" meta={`${hall.items.length} item`} />
        <ActionCard {...choose} onClick={on.choose} />

        <Label text="Policies" icon="policy" />
        <ActionCard {...quarantined} onClick={on.quarantined} />

        {/* The non-decision strip: one row, no card, because an FYI asks for
         * nothing and a card would say it does. */}
        <ListRow variant="plain" icon="fyi" title={actionsFyiStrip} chevron onClick={on.fyi} />
      </ScreenBody>
      <TabBar items={tabs.map((t) => ({ ...t, onClick: fn() }))} active={1} />
    </>
  ),
});

/** Nothing crosses the phone's edges — and this screen has both of the kit's
 * widest things on it, a real diff and a mono queue subject. See
 * `Screens/Weekly review` for why this is measured rather than inspected. */
export const NothingEscapesTheFrame = ActionsTriage.extend({
  play: async ({ canvasElement }) => {
    const frame = canvasElement.firstElementChild as HTMLElement;
    await expect(overflowing(frame)).toEqual([]);
    await expect(unreachable(frame.querySelector(".bk-screen-body")!)).toEqual([]);
  },
});

/**
 * DECISIONS ARE CARDS, FACTS ARE ROWS, AND THE FYI IS NEITHER.
 *
 * Three claims the design makes about this list, asserted rather than trusted:
 * the approval's allow button names its effect, so nobody taps "Fetch once"
 * without being told it enqueues; the queue rows state the queue's real words
 * (`blocked`, `failed`) and the blocked one names the approval it is waiting
 * on; and the FYI is not a card — there is no "FYI" kind label anywhere on the
 * screen, only the strip that counts them.
 */
export const DecisionsAreCardsAndTheFyiIsNot = ActionsTriage.extend({
  play: async ({ canvas }) => {
    const allow = await canvas.findByRole("button", { name: new RegExp(approval.allowLabel) });
    await expect(allow).toHaveAccessibleName(new RegExp(approval.allowEffect));
    await expect(await canvas.findByRole("button", { name: approval.denyLabel })).toBeTruthy();

    await expect(await canvas.findByText("blocked")).toBeTruthy();
    await expect(await canvas.findByText(blocked.link!)).toBeTruthy();
    await expect(await canvas.findByText("failed")).toBeTruthy();
    await expect(await canvas.findByText(failed.note!)).toBeTruthy();

    // The four decision kinds on the list, by their kind labels.
    for (const label of ["Dead letter", "Premise unverified", "Choose", "Quarantined"]) {
      await expect(await canvas.findByText(label)).toBeTruthy();
    }
    await expect(canvas.queryByText("FYI")).toBeNull();
    await expect(await canvas.findByText(actionsFyiStrip)).toBeTruthy();

    // The header, the meter and the thread label all count the same list.
    await expect(await canvas.findByText(actionsHeaderMeta)).toBeTruthy();
    await expect(await canvas.findByText(actionsCap.valueText)).toBeTruthy();
    await expect(await canvas.findByText(`${route.items.length} items`)).toBeTruthy();
  },
});

/**
 * THE WHOLE SCREEN BY KEYBOARD. A list of names rather than a count, for the
 * reason `Screens/Weekly review` gives: a count says something moved, a list
 * says what. The body is the first stop because it scrolls; the tab bar is the
 * last and is one stop, on the active destination.
 */
export const TheWholeScreenByKeyboard = ActionsTriage.extend({
  play: async ({ canvasElement, userEvent }) => {
    const stops: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      await userEvent.tab();
      const active = document.activeElement as HTMLElement | null;
      if (!active || !canvasElement.contains(active)) break;
      const shape = `${active.getAttribute("role") ?? active.tagName.toLowerCase()}:${(active.textContent ?? "").trim().split("\n")[0]!.slice(0, 20)}`;
      if (stops.includes(shape)) break;
      stops.push(shape);
    }
    await expect(stops).toEqual([
      // The scrolling body.
      "div:6 / 60 openRoute hom",
      // The approval's two inline actions. The first carries its effect chip
      // in its name, which is the design's rule, not decoration.
      "button:Fetch onceenqueue",
      "button:Skip it",
      // The blocked edit, then the dead letter and the fetch it dead-lettered.
      "button:blockededit · voyage",
      "button:Dead letter2 blocked",
      "button:failedfetch · winds.",
      // The stale premise, struck through.
      "button:Premise unverifiedpr",
      // The hall's one choice, and the policy under its own label.
      "button:Chooseuntrusted · re",
      "button:Quarantinedpolicyine",
      // The FYI strip.
      "button:1 FYI · no reply nee",
      // The tab bar: one stop, on Actions.
      "tab:Actions3",
    ]);
  },
});
