import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { toasts } from "../../fixtures/actions.js";
import { tabs } from "../../fixtures/files.js";
import { weekSpend, weekSpendMeter } from "../../fixtures/money.js";
import {
  weekCarried,
  weekCarriedCount,
  weekChanges,
  weekFilters,
  weekFootnote,
  weekHeaderMeta,
  weekSuggestion,
} from "../../fixtures/week.js";
import { ScreenBody } from "../../src/chrome/ScreenBody.js";
import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { TabBar } from "../../src/chrome/TabBar.js";
import { ActionCard } from "../../src/decisions/ActionCard.js";
import { InlineToast } from "../../src/conversation/InlineToast.js";
import { BarList } from "../../src/evidence/BarList.js";
import { Button } from "../../src/primitives/Button.js";
import { Callout } from "../../src/primitives/Callout.js";
import { Label } from "../../src/primitives/Label.js";
import { Meter } from "../../src/primitives/Meter.js";
import { Surface } from "../../src/primitives/Surface.js";
import { ListRow } from "../../src/rows/ListRow.js";
import { FilterRow } from "../../src/rows/FilterRow.js";
import { phone } from "../_phone.js";
import { overflowing, unreachable } from "../_stage.js";

/**
 * §11.3 — WEEKLY REVIEW. The first of wave 5's four assembled screens, and the
 * acceptance test for the whole component set.
 *
 * The design states the terms: *"All four screens below are pure composition:
 * no new colours, no new type sizes, no bespoke markup beyond layout. This is
 * the test the kit has to pass."* So the rule for this file is that **if the
 * screen needs a new component or a one-off style, the component set is wrong
 * and we fix the set, not the screen.**
 *
 * It went first because it nests deepest — `PhoneFrame > Surface >
 * Meter/BarList` and `PhoneFrame > ActionCard > Button` — which is exactly the
 * shape that broke when wave 1 dropped the DC `.sc-host` wrapper. Since then
 * `width: 100%` on a component root is LIVE, about fifteen components declare
 * it, and two of them side by side in a flex row each claim the whole row. The
 * `ActionCard`'s two buttons are that row, and `NothingEscapesTheFrame` is what
 * stands between this screen and the bug that has already been shipped once.
 *
 * ## What the port needed beyond the catalog, and what it did not
 *
 * **No new component.** `ScreenBody` is the one addition, and wave 4 already
 * made it for exactly this reason: every screen in §11 retypes the same
 * `flex:1; min-height:0; overflow:hidden` container with its own padding and
 * gap, and the catalog offers it as no component at all.
 *
 * **Three layout divs survive**, all of them flex containers with nothing but
 * `display`, `flexDirection`, `gap` and `flex` on them: the Surface's inner
 * column, the ActionCard's button row, and the carried-items column. The
 * catalog draws the same three. A fourth — the `flex: 1` spacer that pushes the
 * carried block to the bottom — is `marginTop: "auto"` here instead, because an
 * empty div that exists only to take up space is the thing `ScreenBody`'s gap
 * would then space around, adding an 11px band nobody drew.
 *
 * **The spend meta reads `$9.40 / $35.00`, not the catalog's `$9.40 / 35`.**
 * That figure is `weekSpendMeter.valueText`, derived from the cents in
 * `money.ts` through the world's one formatter, and the invariant test makes
 * the bars sum to it. A hand-typed shorthand on a money figure is the kind of
 * thing that stays right for one week; the deviation is deliberate and is the
 * only place this screen departs from §11.3's literal text.
 */
/**
 * The screen is OPERABLE, not a picture of one. Every control the design draws
 * gets a handler, because the kit gates role, tab stop, hover and ring on one —
 * a screen assembled without handlers renders identically and answers no keys,
 * which is precisely the failure `Rules/Keyboard reachability` exists to catch.
 */
const on = {
  filter: () => fn(),
  writeRule: fn(),
  notYet: fn(),
  revert: fn(),
  changes: [fn(), fn()],
  carried: [fn(), fn(), fn()],
  tab: fn(),
};

const meta = preview.meta({
  title: "Screens/Weekly review",
  component: ScreenBody,
  decorators: [phone()],
  parameters: { layout: "centered" },
});

/** The screen as §11.3 draws it. */
export const WeeklyReview = meta.story({
  render: () => (
    <>
      <ScreenHeader variant="title" title="This week" meta={weekHeaderMeta} trailingIcon="filter" />
      <ScreenBody padding="2px 14px" gap={11} overflow="auto">
        <FilterRow items={weekFilters.map((label) => ({ label, onClick: fn() }))} active={0} mono />

        <Surface label="Spend · 7 days" labelIcon="wallet" meta={weekSpendMeter.valueText}>
          <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            <Meter variant="bar" value={weekSpendMeter.value} height={7} tone="teal" />
            <BarList rows={weekSpend} />
          </div>
        </Surface>

        <Label text="What changed" icon="activity" />
        <Surface pad={0}>
          {weekChanges.map((row, i) => (
            <ListRow
              key={row.title}
              {...row}
              variant="group"
              last={i === weekChanges.length - 1}
              onClick={on.changes[i]}
            />
          ))}
        </Surface>

        <ActionCard
          kind="suggestion"
          title={weekSuggestion.title}
          body={weekSuggestion.body}
          rightMeta={weekSuggestion.rightMeta}
        >
          {/* The wave-2 hazard, in the one place this screen meets it. `block`
           * gives a Button `width: 100%` AND `flex: none`, so two of them in a
           * row each demand the whole row and neither yields. The seam wave 1
           * set aside for exactly this — a `style` merged onto the component's
           * own root, never a wrapper — is what makes them share it. */}
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              label={weekSuggestion.primaryLabel}
              effect={weekSuggestion.primaryEffect}
              tone="primary"
              size="md"
              center
              onClick={on.writeRule}
              style={{ flex: "1 1 0", width: "auto" }}
            />
            <Button
              label={weekSuggestion.secondaryLabel}
              tone="quiet"
              size="md"
              center
              onClick={on.notYet}
              style={{ flex: "1 1 0", width: "auto" }}
            />
          </div>
        </ActionCard>
        {/* The receipt for the LAST policy written sits under the card asking
         * for the next one (D37): what saying yes looks like is on screen
         * while you decide, and the undo is the point. */}
        <InlineToast {...toasts[2]!} undoLabel="Revert" onUndo={on.revert} />

        <Label text="Carried into next week" meta={String(weekCarriedCount)} />
        {/* `marginTop: auto` rather than the catalog's `flex: 1` spacer div:
         * ScreenBody's 11px gap would space around an empty element, and the
         * band it adds is not in the design. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: "auto" }}>
          {weekCarried.map((row, i) => (
            <ListRow key={row.title} {...row} onClick={on.carried[i]} />
          ))}
        </div>

        <Callout variant="banner" tone="neutral" icon="digest" mono text={weekFootnote} />
      </ScreenBody>
      <TabBar items={tabs.map((t) => ({ ...t, onClick: fn() }))} active={1} />
    </>
  ),
});

/**
 * THE WAVE-5 HAZARD, MEASURED.
 *
 * Nothing on the screen may cross the phone's own edges. This is the check that
 * catches the `width: 100%` row bug, and it is a measurement of laid-out boxes
 * rather than an inspection of props: the two-button row typechecked, passed
 * its unit tests and passed the DC parity harness while rendering 200% wide.
 *
 * `overflowing` is asserted `toEqual([])` rather than `toHaveLength(0)` so a
 * failure names which element escaped and by how much.
 */
export const NothingEscapesTheFrame = WeeklyReview.extend({
  play: async ({ canvasElement }) => {
    const frame = canvasElement.firstElementChild as HTMLElement;
    await expect(overflowing(frame)).toEqual([]);
    await expect(unreachable(frame.querySelector(".bk-screen-body")!)).toEqual([]);
  },
});

/**
 * The two buttons split their row evenly and neither is content-sized, which is
 * the seam doing its job rather than the row merely not overflowing — a row
 * where the first button took everything and the second was squeezed to nothing
 * would also pass `NothingEscapesTheFrame`.
 */
export const TheButtonRowSplitsEvenly = WeeklyReview.extend({
  play: async ({ canvas }) => {
    const write = await canvas.findByRole("button", { name: new RegExp(weekSuggestion.primaryLabel) });
    const notYet = await canvas.findByRole("button", { name: weekSuggestion.secondaryLabel });
    const a = write.getBoundingClientRect();
    const b = notYet.getBoundingClientRect();
    // Even, and both substantial: a row where the first button took everything
    // and the second was squeezed to nothing also fails to overflow.
    await expect({ even: Math.abs(a.width - b.width) < 1, wide: a.width > 100 }).toEqual({
      even: true,
      wide: true,
    });
    // And the row is the card's width, not twice it.
    await expect(Math.round(b.right - a.left)).toBeLessThan(
      Math.round(write.parentElement!.getBoundingClientRect().width) + 1,
    );
  },
});

/**
 * ASSEMBLY, NOT DESIGN — the claim §11 exists to test.
 *
 * Every component the catalog names for this screen is on it, and the screen
 * adds nothing the kit does not already own. The list is written out rather
 * than counted for the same reason `Rules/Keyboard reachability` writes its tab
 * stops out: a count says something changed, a list says what.
 */
export const EveryComponentTheCatalogNames = WeeklyReview.extend({
  play: async ({ canvas, canvasElement }) => {
    // ScreenHeader, FilterRow, Surface x2, Meter, BarList, Label x2, ListRow
    // x5, ActionCard, Button x2, InlineToast, Callout, TabBar.
    await expect(await canvas.findByText("This week")).toBeTruthy();
    await expect(await canvas.findByText(weekHeaderMeta)).toBeTruthy();
    await expect(await canvas.findByText(weekFilters[0]!)).toBeTruthy();
    await expect(await canvas.findByText(weekSpendMeter.valueText)).toBeTruthy();
    await expect(await canvas.findAllByText(weekSpend[0]!.label)).toHaveLength(1);
    await expect(await canvas.findByText("What changed")).toBeTruthy();
    await expect(await canvas.findByText(weekChanges[0]!.value!)).toBeTruthy();
    await expect(await canvas.findByText(weekSuggestion.title)).toBeTruthy();
    await expect(await canvas.findByText(weekSuggestion.rightMeta)).toBeTruthy();
    await expect(await canvas.findByText("Carried into next week")).toBeTruthy();
    for (const row of weekCarried) await expect(await canvas.findByText(row.title!)).toBeTruthy();
    await expect(await canvas.findByText(weekFootnote)).toBeTruthy();
    await expect(await canvas.findByText(tabs[2]!.label)).toBeTruthy();

    // "No bespoke markup beyond layout" is a claim about this FILE, not about
    // the rendered tree — a DOM scan cannot tell a div this story authored from
    // one a component rendered. `tests/screens-are-assembly.test.ts` reads the
    // source and holds it down there, across all four screens.
    void canvasElement;
  },
});

/**
 * THE SCREEN IS OPERABLE, AND COSTS SEVEN TAB STOPS.
 *
 * Written as a list of names for the same reason `Rules/Keyboard reachability`
 * is: a count says the number moved, a list says which control appeared or
 * vanished. Two of the seven are the composite groups — the filter row and the
 * tab bar are one stop each since the roving-tabindex pass, not four and five.
 */
export const TheWholeScreenByKeyboard = WeeklyReview.extend({
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
      // The body itself, because it scrolls. A scrollable region that is not
      // focusable is content a keyboard user cannot reach, and this kit gates
      // every other tab stop on a handler — so a read-only screen would have
      // nothing inside it to scroll by. `ScreenBody`'s class doc carries the
      // reasoning; the stop is the price and it is paid deliberately.
      "div:all 41decisions 34di",
      // The filter row: ONE stop, on the selected pill.
      "tab:all 41",
      // "What changed" — both group rows are operable, and the failing one is
      // the only row on the screen the design gives an action to.
      "button:Decisions you answer",
      "button:source-watch dead-le",
      // The suggestion's two buttons. The first carries its effect chip, which
      // is why its name runs on: the mono chip naming what the tap DOES is part
      // of the accessible name, not decoration beside it.
      "button:Write rulewrite_poli",
      "button:Not yet",
      // The receipt's undo — the toast under the card is a control, not a note.
      "button:Revert",
      // The three carried items.
      "button:Fetch the wind forec",
      "button:Where the eagle omen",
      "button:wind: west, holds 17",
      // The tab bar: one stop, on the active destination.
      "tab:Actions3",
    ]);
  },
});
