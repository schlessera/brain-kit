import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { emptyStates } from "../../fixtures/actions.js";
import { firstRunHint, installPrompt, launchers } from "../../fixtures/files.js";
import { Composer } from "../../src/chrome/Composer.js";
import { ScreenBody } from "../../src/chrome/ScreenBody.js";
import { EmptyState } from "../../src/conversation/EmptyState.js";
import { Button } from "../../src/primitives/Button.js";
import { Callout } from "../../src/primitives/Callout.js";
import { ListRow } from "../../src/rows/ListRow.js";
import { phone } from "../_phone.js";
import { overflowing, unreachable } from "../_stage.js";

/**
 * FIRST RUN. The seventh assembled screen and the last the design's
 * sixth-pass ruling (§12) asks for: *"`EmptyState first-run` and the voice
 * Composer, neither of which any current story renders."*
 *
 * The source screen is `1h`: *"First run / empty state. The install prompt is
 * the last thing, not the first — you earn it after one useful answer."* A
 * breathing brain mark, "What do you need to know?", the reassurance line,
 * three launcher rows, a mono hint, and — last — the install prompt above the
 * composer. The order IS the screen: everything that helps comes before the
 * one thing that asks.
 *
 * ## Departures from the source, each with its reason
 *
 * **The empty state has no button.** `emptyStates` carries an "Ask something"
 * primary for the `first-run` variant, and the component's own story renders
 * it. On this screen the composer IS the ask, and a button above three
 * launchers that says the same thing as the field below them is a fourth
 * launcher pretending to be a call to action. The source draws none either.
 *
 * **The hint moved into the composer.** The source draws `/ for commands ·
 * hold ⏺ to dictate` as a free mono line in the body. `Composer` owns a hint
 * row under its field for exactly this sentence, and a hint about the field
 * belongs to the field — so it is `Composer`'s `hint`, and the body has one
 * less thing that is not a component.
 *
 * **The install prompt is a `Callout` with the button inside it.** The source
 * draws icon, a two-line title and a filled "Install" pinned right, in one
 * amber box. `Callout variant="boxed"` is the kit's amber box with an icon,
 * and the button rides in its children slot after the sentence rather than
 * pinned to the edge — `Callout`'s only right-edge slot is a chip, and a chip
 * is not a control. One sentence instead of a title and a subtitle, because
 * the prompt earns one line, not two.
 *
 * **The composer is the `voice` variant.** The source's field draws the small
 * mic inside it; the ruling names the voice composer, whose big disc is the
 * primary control and whose field is secondary — which is what first run
 * wants: the fastest useful answer, and speaking is faster than typing.
 *
 * **The body does not scroll.** Everything fits, and the source centres the
 * column vertically; `ScreenBody`'s `style` seam takes the one layout
 * property that does it. `NothingEscapesTheFrame` is what proves "fits".
 */
const first = emptyStates.find((e) => e.variant === "first-run")!;

const on = {
  launchers: launchers.map(() => fn()),
  install: fn(),
  attach: fn(),
  mic: fn(),
};

const meta = preview.meta({
  title: "Screens/First run",
  component: ScreenBody,
  decorators: [phone({ showHome: true })],
  parameters: { layout: "centered" },
});

/** The screen as `1h` draws it. */
export const FirstRun = meta.story({
  render: () => (
    <>
      <ScreenBody padding="0 26px" gap={14} overflow="hidden" style={{ justifyContent: "center" }}>
        <EmptyState
          variant="first-run"
          title={first.title}
          body={first.body}
          meta={first.meta}
          icon={first.icon}
          tone={first.tone}
          pad={0}
          titleSize={29}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {launchers.map((l, i) => (
            <ListRow
              key={l.title}
              variant="launcher"
              icon={l.icon}
              iconTone={l.tone}
              title={l.title}
              subtitle={l.subtitle}
              chevron
              onClick={on.launchers[i]}
            />
          ))}
        </div>
      </ScreenBody>
      {/* Last, not first. The prompt sits below everything that helps and
       * above the field, which is where the source puts it. */}
      <div style={{ padding: "0 16px 6px", flex: "none" }}>
        <Callout variant="boxed" tone="amber" icon="install" text={installPrompt.text}>
          <Button label={installPrompt.label} tone="primary" size="sm" block={false} onClick={on.install} />
        </Callout>
      </div>
      <Composer variant="voice" hint={firstRunHint} onAttach={on.attach} onMic={on.mic} />
    </>
  ),
});

/** Nothing crosses the phone's edges, and — because this body clips rather
 * than scrolls — nothing is below the fold. See `Screens/Weekly review` for
 * why this is measured rather than inspected. */
export const NothingEscapesTheFrame = FirstRun.extend({
  play: async ({ canvasElement }) => {
    const frame = canvasElement.firstElementChild as HTMLElement;
    await expect(overflowing(frame)).toEqual([]);
    await expect(unreachable(frame.querySelector(".bk-screen-body")!)).toEqual([]);
  },
});

/**
 * THE INSTALL PROMPT IS THE LAST THING, NOT THE FIRST — the sentence the
 * source screen exists to make, asserted as document order: the question,
 * then the reassurance, then the three launchers, then the prompt, then the
 * field. A screen that led with the prompt would still render and still pass
 * every component's own stories, and would be asking before it had helped.
 */
export const TheInstallPromptIsLast = FirstRun.extend({
  play: async ({ canvas }) => {
    const order = [
      await canvas.findByRole("heading", { name: first.title }),
      await canvas.findByText(first.body),
      await canvas.findByText(first.meta),
      ...(await Promise.all(launchers.map((l) => canvas.findByText(l.title)))),
      await canvas.findByText(installPrompt.text),
      await canvas.findByRole("button", { name: installPrompt.label }),
      await canvas.findByRole("textbox"),
    ];
    for (let i = 1; i < order.length; i += 1) {
      // eslint-disable-next-line no-bitwise -- Node.DOCUMENT_POSITION_FOLLOWING
      await expect(Boolean(order[i - 1]!.compareDocumentPosition(order[i]!) & 4)).toBe(true);
    }
  },
});

/**
 * THE VOICE COMPOSER, AND ONLY THE VOICE COMPOSER. The disc is a real "Hold to
 * talk" control; there is no send affordance, because a first run has nothing
 * typed yet to send; and the hint under the field is the one the source wrote
 * in the body.
 */
export const TheComposerIsVoice = FirstRun.extend({
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole("button", { name: "Hold to talk" })).toBeTruthy();
    await expect(canvas.queryByRole("button", { name: "Send" })).toBeNull();
    await expect(await canvas.findByText(firstRunHint)).toBeTruthy();
    // The empty state's heading is focusable by script, never a tab stop: the
    // moment to hand it focus is after a decision, and there are none here.
    await expect(await canvas.findByRole("heading", { name: first.title })).toHaveAttribute("tabindex", "-1");
  },
});

/**
 * THE WHOLE SCREEN BY KEYBOARD. Seven stops and no body stop, because the
 * body does not scroll: three launchers, the one thing that asks, and the
 * composer's three controls.
 */
export const TheWholeScreenByKeyboard = FirstRun.extend({
  play: async ({ canvasElement, userEvent }) => {
    const stops: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      await userEvent.tab();
      const active = document.activeElement as HTMLElement | null;
      if (!active || !canvasElement.contains(active)) break;
      // Two icon-only buttons (attach, the voice disc) have no text, and the
      // walk stops at the first repeated shape — so a nameless stop is named
      // by its aria-label instead, or the disc would look like the attach
      // button coming round again.
      const text = (active.textContent ?? "").trim().split("\n")[0] || active.getAttribute("aria-label") || "";
      const shape = `${active.getAttribute("role") ?? active.tagName.toLowerCase()}:${text.slice(0, 20)}`;
      if (stops.includes(shape)) break;
      stops.push(shape);
    }
    await expect(stops).toEqual([
      "button:What happened since ",
      "button:Process 3 loose omen",
      "button:Brain health4,812 do",
      "button:Install",
      "button:Attach — photo, came",
      "textarea:Ask your brain anyth",
      "button:Hold to talk",
    ]);
  },
});
