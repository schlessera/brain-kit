import preview from "#.storybook/preview";
import { useState } from "react";
import { expect, fn } from "storybook/test";

import { answerTrace } from "../../fixtures/search.js";
import { Disclosure } from "../../src/blocks/Disclosure.js";
import { RelatedFiles } from "../../src/conversation/RelatedFiles.js";
import { backlinks } from "../../fixtures/files.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/Disclosure",
  component: Disclosure,
  decorators: [stage],
  args: {
    label: answerTrace,
    icon: "steps",
    children: <RelatedFiles label="" meta="" items={backlinks} />,
  },
});

/**
 * Collapsed detail inside an answer. The summary always states WHAT is hidden
 * and HOW MUCH of it, so collapsing never hides the existence of evidence —
 * "6 steps · 4 files touched" is the contract, not "Details".
 */
export const Default = meta.story({});

export const OpenOnMount = Default.extend({ args: { open: true } });

export const WithMeta = Default.extend({ args: { meta: "$0.02" } });

export const Wide = Default.extend({ parameters: wide });

/**
 * MODE 1 — UNCONTROLLED. Neither prop. Starts closed and toggles itself, which
 * is what every call site that just wants a collapsible block gets.
 */
export const Uncontrolled = meta.story({
  args: { onOpenChange: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const summary = await canvas.findByRole("button");
    await expect(summary).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(summary);
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    // `onOpenChange` fires even with nobody controlling, so a parent can WATCH
    // without taking ownership. It reports the value being moved to.
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(true);

    await userEvent.click(summary);
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(false);
  },
});

/**
 * MODE 2 — SEEDED, AND UNCHANGED FROM THE DESIGN.
 *
 * `open` on its own seeds the initial value and is ignored from the first
 * toggle onward — the source reads
 * `state.open === null ? p.open === true : state.open`, and
 * `useState(p.open === true)` reproduces it exactly.
 *
 * **So flipping the `open` control in the Storybook toolbar after clicking the
 * summary does nothing, and that is correct rather than broken.** This story
 * asserts it, and it is the reason `onOpenChange` gates the controlled mode
 * rather than `open` doing it alone: every existing call site passes only
 * `open`, and every one of them behaves exactly as it always has.
 */
export const OpenPropIsSeedOnly = meta.story({
  args: { open: true },
  play: async ({ canvas, userEvent }) => {
    const summary = await canvas.findByRole("button");
    await expect(summary).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(summary);
    await expect(summary).toHaveAttribute("aria-expanded", "false");

    // A re-render with `open` still true does NOT reopen it.
    await userEvent.click(document.body);
    await expect(summary).toHaveAttribute("aria-expanded", "false");
  },
});

/**
 * MODE 3 — CONTROLLED. `open` AND `onOpenChange` together.
 *
 * Internal state steps aside entirely: the summary reflects whatever the parent
 * says, and a parent that IGNORES the callback gets a disclosure that cannot be
 * opened. That is the correct behaviour for a controlled component and it is
 * asserted here, because the failure mode of getting it wrong — state held in
 * two places that disagree — is invisible until a parent refuses a change.
 */
export const Controlled = meta.story({
  args: { open: false, onOpenChange: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const summary = await canvas.findByRole("button");
    await expect(summary).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(summary);
    await expect(args.onOpenChange).toHaveBeenCalledWith(true);
    // The parent did not move `open`, so nothing opened. No second source of
    // truth quietly opened it anyway.
    await expect(summary).toHaveAttribute("aria-expanded", "false");
  },
});

/**
 * THE CASE THE CHANGE EXISTS FOR.
 *
 * Three disclosures where opening one collapses the others — impossible before,
 * because each held its own state and no parent could reach in. The Run-detail
 * screen is the real instance of this, and a server-driven "expand the trace"
 * is the other.
 *
 * Note what the parent has to do: own one `openId`, pass `open` to each child,
 * and reduce `onOpenChange` into it. That is the whole reason the parent needs
 * both props rather than an imperative handle.
 */
export const Accordion = meta.story({
  render: () => {
    const sections = [
      { id: "trace", label: "6 steps · 4 files touched · 2.4s", icon: "steps" as const },
      { id: "files", label: "4 files read · 3 of them cited", icon: "file" as const },
      { id: "cost", label: "1,840 tokens · $0.02 · 2 tools", icon: "wallet" as const },
    ];
    const [openId, setOpenId] = useState<string | null>("trace");
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%" }}>
        {sections.map((s) => (
          <Disclosure
            key={s.id}
            label={s.label}
            icon={s.icon}
            open={openId === s.id}
            onOpenChange={(next) => setOpenId(next ? s.id : null)}
          >
            <RelatedFiles label="" meta="" items={backlinks.slice(0, 2)} />
          </Disclosure>
        ))}
      </div>
    );
  },
  play: async ({ canvas, userEvent }) => {
    const [trace, files, cost] = await canvas.findAllByRole("button");
    await expect(trace).toHaveAttribute("aria-expanded", "true");
    await expect(files).toHaveAttribute("aria-expanded", "false");

    // Opening the second closes the first — the whole point.
    await userEvent.click(files);
    await expect(trace).toHaveAttribute("aria-expanded", "false");
    await expect(files).toHaveAttribute("aria-expanded", "true");
    await expect(cost).toHaveAttribute("aria-expanded", "false");

    // And clicking the open one closes it, leaving all three shut.
    await userEvent.click(files);
    for (const el of [trace, files, cost]) {
      await expect(el).toHaveAttribute("aria-expanded", "false");
    }
  },
});

/** Enter and Space both toggle, because a `role="button"` that cannot be
 * operated from the keyboard is worse than no role at all. */
export const Keyboard = meta.story({
  play: async ({ canvas, userEvent }) => {
    const summary = await canvas.findByRole("button");
    summary.focus();

    await userEvent.keyboard("{Enter}");
    await expect(summary).toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard(" ");
    await expect(summary).toHaveAttribute("aria-expanded", "false");
  },
});
