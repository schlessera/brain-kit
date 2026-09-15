import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { Disclosure } from "../../src/blocks/Disclosure.js";
import { Composer } from "../../src/chrome/Composer.js";
import { TabBar } from "../../src/chrome/TabBar.js";
import { ActionCard } from "../../src/decisions/ActionCard.js";
import { SideRail } from "../../src/desktop/SideRail.js";
import { Button } from "../../src/primitives/Button.js";
import type { IconName } from "../../src/primitives/Icon.js";
import { Toggle } from "../../src/primitives/Toggle.js";
import { ChoiceOption } from "../../src/rows/ChoiceOption.js";
import { FileRow } from "../../src/rows/FileRow.js";
import { FilterRow } from "../../src/rows/FilterRow.js";
import { ListRow } from "../../src/rows/ListRow.js";
import { CONTROL_RING, ROW_RING, ring, stage } from "../_stage.js";

/**
 * KEYBOARD REACHABILITY, END TO END.
 *
 * The design's role-and-keys table names nine component groups. Each one is
 * already asserted to answer its own keys where it lives — `Button` takes ⏎ and
 * space in `Button.stories`, `ChoiceOption` takes ↑↓ in its own, and so on.
 * What none of those can see is the thing this file is for: **what happens when
 * you put them on one screen and press Tab.**
 *
 * Three claims, and they fail independently:
 *
 *   1. Every group is REACHED. A component can pass every one of its own key
 *      tests and still be unreachable, because its tab stop was gated on a prop
 *      the screen does not pass.
 *   2. The order is DOCUMENT ORDER. Nothing in this kit sets a positive
 *      `tabIndex`, and one that did would reorder the whole page, not just
 *      itself — a failure no single component's stories can detect.
 *   3. The ring is VISIBLE AT EVERY STOP, at the offset its class specifies.
 *      The +2 / −2 split is the reason the design states two offsets: an
 *      outline at +2 on a full-width row is drawn outside the row and clipped
 *      by the first `overflow: hidden` ancestor, which in this kit is every
 *      `Surface`. The wrong offset gives a ring that is present in the
 *      stylesheet, correct in the computed style, and invisible on screen.
 *
 * `CommandPalette` is not in the walk. It is a `role="dialog"` that traps its
 * own focus and closes on Escape, so it belongs to a different tab order by
 * construction; `CommandPalette.stories` is where that is asserted.
 */
const meta = preview.meta({
  title: "Rules/Keyboard reachability",
  component: Button,
  decorators: [stage],
  parameters: { stageWidth: "none" },
});

const NAV: { label: string; icon: IconName }[] = [
  { label: "Chat", icon: "chat" },
  { label: "Actions", icon: "approval" },
  { label: "Files", icon: "folder" },
  { label: "Activity", icon: "activity" },
  { label: "Settings", icon: "settings" },
];

/**
 * One of each group, in one column, walked from the top.
 *
 * The expectation below is written as a LIST OF NAMES rather than as a count,
 * because a count tells you that something changed and a list tells you what.
 */
export const TheWholeTable = meta.story({
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%", maxWidth: 420 }}>
      {/* Button — role=button, ⏎ / space */}
      <Button label="Approve this edit" effect="enqueue" tone="affirm" onClick={fn()} />

      {/* Toggle — role=switch, space */}
      <Toggle label="Watch this folder" onClick={fn()} />

      {/* ChoiceOption — role=radio inside a radiogroup, ↑↓ then space. The
          group is hand-rolled here, so the roving tabindex is hand-rolled too:
          `tabStop` is the caller's to set, because one option cannot see its
          siblings. `AskUserCard` is the component that does this for you. */}
      <div role="radiogroup" aria-label="Where should it go">
        <ChoiceOption title="omens/day-3651-eagle.md" selected mono mark tabStop onClick={fn()} />
        <ChoiceOption title="people/penelope.md" mono mark tabStop={false} onClick={fn()} />
      </div>

      {/* FilterRow — role=tab in a tablist, ←→ */}
      <FilterRow items={["All", "Waiting", "Failed"].map((label) => ({ label, onClick: fn() }))} active={0} mono />

      {/* ListRow — role=button, ⏎ */}
      <ListRow title="First light tomorrow" value="05:30" variant="card" onClick={fn()} />

      {/* FileRow — role=treeitem, inside the tree its role requires */}
      <div role="tree" aria-label="Corpus">
        <FileRow label="omens" kind="open" meta="86" onClick={fn()} />
      </div>

      {/* ActionCard — role=button */}
      <ActionCard kind="approval" title="Rename the eagle note" body="It is filed under the wrong day." onClick={fn()} />

      {/* Disclosure — role=button, ⏎ toggles */}
      <Disclosure label="Why this answer">
        <ListRow title="brain_search · omens" variant="group" />
      </Disclosure>

      {/* SideRail — role=tab, ↑↓ */}
      <div style={{ display: "flex", height: 200 }}>
        <SideRail items={NAV.map((item) => ({ ...item, onClick: fn() }))} active={1} expanded status="connected" />
      </div>

      {/* TabBar — role=tab, ←→ */}
      <TabBar items={NAV.map((item) => ({ ...item, onClick: fn() }))} active={1} />

      {/* Composer — role=textbox, ⏎ send / ⇧⏎ newline */}
      <Composer variant="send" hint="/ for commands" onSend={fn()} />
    </div>
  ),
  play: async ({ canvasElement, userEvent }) => {
    // Walk until we leave the story. The bound is generous but finite: a bug
    // that makes Tab cycle inside one component would otherwise hang the suite
    // rather than fail it.
    const stops: HTMLElement[] = [];
    for (let i = 0; i < 40; i += 1) {
      await userEvent.tab();
      const active = document.activeElement as HTMLElement | null;
      if (!active || !canvasElement.contains(active)) break;
      if (stops.includes(active)) break;
      stops.push(active);
    }

    /* ── 1. Every group is reached ───────────────────────────────────────── */
    const shape = (el: HTMLElement) =>
      `${el.getAttribute("role") ?? el.tagName.toLowerCase()}:${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().split("\n")[0]!.slice(0, 22)}`;

    const reached = stops.map(shape);
    await expect(reached).toEqual([
      "button:Approve this editenque",
      "switch:Watch this folder",
      // ONE radio, not two: a radiogroup is a single tab stop and ↑↓ move
      // inside it. `ChoiceOption.stories`' RovingGroup is where that is shown.
      "radio:omens/day-3651-eagle.m",
      // ONE tab, not three: same rule, and here the component owns its own
      // group so it holds the roving state itself.
      "tab:All",
      "button:First light tomorrow05",
      "treeitem:omens86",
      "button:ApprovalRename the eag",
      "button:Why this answer",
      // SideRail: ONE stop, on the active destination, and ↑↓ from there.
      "tab:Actions",
      // TabBar: one more. This pair is the whole point of the roving pass —
      // a screen carrying both nav components used to cost TEN tab presses
      // before any content, because every item was `tabIndex={0}` rather than
      // the roving tabindex a `tablist` is supposed to use, which made the
      // design's arrow keys redundant with Tab rather than the way you move.
      // Two presses now, and the list is what proves it: a count would have
      // said something changed, this says what. (`.plan/design-feedback.md`
      // §11; `useRoving` carries the reasoning and the hazard.)
      "tab:Actions",
      // Composer is two stops, not one: the field and its send button.
      "textarea:Ask your brain anythin",
      "button:Send",
    ]);

    /* ── 2. The order is document order ──────────────────────────────────── */
    // Nothing in the kit may set a positive tabIndex: one would reorder the
    // whole page rather than just itself, and the failure would look like a
    // bug in whatever component happened to come after it.
    await expect(canvasElement.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toHaveLength(0);

    for (let i = 1; i < stops.length; i += 1) {
      const order = stops[i - 1]!.compareDocumentPosition(stops[i]!);
      // eslint-disable-next-line no-bitwise -- Node.DOCUMENT_POSITION_FOLLOWING
      await expect(Boolean(order & 4)).toBe(true);
    }

    /* ── 3. The ring is visible at every stop ────────────────────────────── */
    // Walked a second time so each element is measured WHILE focused; reading
    // a ring off an element that has since lost focus measures nothing.
    document.body.focus();
    for (const stop of stops) {
      await userEvent.tab();
      if (document.activeElement !== stop) {
        // The composer's textarea rings its FIELD, not itself — the wrap is
        // what has the padding to show an outline — so it is checked below.
        continue;
      }
      const classes = stop.className;
      // `.bk-switch` shares `.bk-control`'s ring rule — the stylesheet lists
      // the two selectors together — because a switch is a small control that
      // has room around it. It carries its own class only because its HIT
      // EXPANSION differs, not its ring.
      if (classes.includes("bk-control") || classes.includes("bk-switch")) {
        await expect({ el: shape(stop), ...ring(stop) }).toEqual({ el: shape(stop), ...CONTROL_RING });
      } else if (classes.includes("bk-row")) {
        await expect({ el: shape(stop), ...ring(stop) }).toEqual({ el: shape(stop), ...ROW_RING });
      } else if (stop.tagName === "TEXTAREA") {
        const field = stop.closest(".bk-field")!;
        await expect(ring(field)).toEqual(CONTROL_RING);
      } else {
        // A stop that carries neither class has no ring rule at all, which is
        // the one outcome this walk exists to make impossible.
        await expect(`${shape(stop)} has no .bk-control / .bk-row / .bk-field class`).toBe("unreachable");
      }
    }
  },
});

/**
 * THE GATE, at screen scale.
 *
 * Every rule above is scoped to a class the component adds ONLY when it was
 * given a handler. The same screen with no handlers anywhere therefore has no
 * tab stops at all — not fewer, none — which is the property that lets a static
 * list, a replayed transcript or a read-only view be built out of the same
 * components without any of them pretending to be operable.
 */
export const NothingIsReachableWithoutAHandler = meta.story({
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%", maxWidth: 420 }}>
      <Button label="Approve this edit" effect="enqueue" tone="affirm" />
      <Toggle />
      <ChoiceOption title="omens/day-3651-eagle.md" selected mono mark />
      <FilterRow items={["All", "Waiting"].map((label) => ({ label }))} active={0} mono />
      <ListRow title="First light tomorrow" value="05:30" variant="card" />
      <FileRow label="omens" kind="open" meta="86" />
      <ActionCard kind="fyi" title="Rename the eagle note" body="It is filed under the wrong day." />
      <TabBar items={NAV} active={1} />
    </div>
  ),
  play: async ({ canvasElement, userEvent }) => {
    await expect(canvasElement.querySelectorAll("[tabindex]")).toHaveLength(0);
    await expect(canvasElement.querySelectorAll(".bk-control, .bk-row, .bk-switch")).toHaveLength(0);

    await userEvent.tab();
    await expect(canvasElement.contains(document.activeElement)).toBe(false);
  },
});
