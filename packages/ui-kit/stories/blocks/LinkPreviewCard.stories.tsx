import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import {
  linkDestination,
  linkInternational,
  linkLong,
  linkLongestLabel,
  linkPreview,
  linkWithheldCredentials,
  linkWithheldScheme,
} from "../../fixtures/files.js";
import { LinkPreviewCard } from "../../src/blocks/LinkPreviewCard.js";
import { overflowing, ROW_RING, ring, stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Blocks/LinkPreviewCard",
  component: LinkPreviewCard,
  decorators: [stage],
  args: { ...linkPreview, onClick: fn() },
});

/**
 * Something that arrived from outside the corpus. The hatched thumb is
 * deliberate — Brain does not render remote images inline — and the purple
 * provenance line is what makes the card's own border purple, so a monochrome
 * screenshot still says "untrusted".
 */
export const Default = meta.story({});

/** No provenance line: the card falls back to the plain card edge, because
 * there is nothing to warn about. */
export const Trusted = Default.extend({ args: { trust: "" } });

/** A long title over two lines, for a headline the single line would eat. */
export const Unclamped = Default.extend({
  args: { clamp: false, title: "What the hall is saying about the succession, and who is saying it" },
});

export const Wide = Default.extend({ parameters: wide });

/** The card is one target and opening it is navigation, never an effect. */
export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    // Click the title, so the assertion is that the handler is on the CARD and
    // the event reaches it from inside — querying a bare `div > div` finds the
    // stage decorator, and clicking a parent never reaches its child.
    await userEvent.click(await canvas.findByText(/succession/));
    await expect(args.onClick).toHaveBeenCalled();
  },
});

/**
 * THE CONTRACT, wave 1b. Opening a preview is navigation, so the whole card is
 * one `role="button"` — one target, one name, no effect chip — and it takes
 * `.bk-row` rather than `.bk-control` because a ring at +2 on a full-width card
 * is drawn outside the first `overflow: hidden` ancestor and clipped away.
 *
 * The accessible name is the card's own contents, which is what a card that is
 * a single target should sound like: title, meta and provenance read as one
 * thing rather than as three.
 */
export const Operable = meta.story({
  play: async ({ canvas, canvasElement, userEvent, args }) => {
    const card = await canvas.findByRole("button");
    await expect(card).toHaveAttribute("tabindex", "0");
    await expect(card.className).toBe("bk-row");

    // Reached by Tab, and ringed once it is there. The ring is drawn INSIDE:
    // a +2 offset on a full-width card is clipped by the first overflow:hidden
    // ancestor, which in this kit is every Surface.
    await userEvent.tab();
    await expect(document.activeElement).toBe(card);
    await expect(ring(card)).toEqual(ROW_RING);

    // Keyboard activation is part of porting a role: both keys, as the design's
    // own table says, and a role that only answers the mouse is worse than none.
    await userEvent.keyboard("{Enter}");
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(2);

    // Hover has somewhere to go, and it is a colour rather than a reset.
    await expect(canvasElement.querySelector<HTMLElement>(".bk-row")!.style.getPropertyValue("--hv-bg")).toBe(
      "var(--bk-color-raised)",
    );
  },
});

/** THE GATE. No handler, no class, no role, no tab stop — a static preview does
 * not pretend to be openable. */
export const Static = meta.story({
  args: { onClick: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row, .bk-control")).toBeNull();
  },
});

// ---------------------------------------------------------------------------
// Link mode (#43): a destination the model chose
// ---------------------------------------------------------------------------

/**
 * Passing `url` switches the card to link mode. The host is the first line,
 * derived by the kit from the address, so no caller can state one that
 * disagrees with where the link goes. The title and description are the
 * brain's words and say so on every card; the page was never opened.
 */
export const Destination = meta.story({
  args: { ...linkDestination, meta: undefined, trust: undefined, onClick: undefined, onCopy: fn() },
  play: async ({ canvas, canvasElement }) => {
    const card = await canvas.findByRole("region", { name: "Link to ithaca-harbour.example" });
    // The host is the first text in the card, and the card is not itself a target.
    await expect(card.textContent!.startsWith("ithaca-harbour.example")).toBe(true);
    await expect(canvasElement.querySelector('[role="button"], [tabindex="0"]')).toBeNull();
    await expect(canvas.getByText("Title and summary by the brain · page not opened or checked")).toBeVisible();
    const open = canvas.getByRole("link", { name: "Open ithaca-harbour.example in a new tab" });
    await expect(open).toHaveAttribute("href", linkDestination.url);
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("referrerpolicy", "no-referrer");
  },
});

export const DestinationWide = Destination.extend({ parameters: wide });

/**
 * The long address on a 320px phone, revealed. The host wraps only between its
 * labels, so the right-hand labels (the part that decides the destination)
 * are on screen; the path previews on one line, and the full address wraps
 * anywhere, with the host in it drawn heavier.
 */
export const LongAddress = meta.story({
  args: { ...linkLong, meta: undefined, trust: undefined, onClick: undefined, onCopy: fn(), expanded: true },
  parameters: { stageWidth: 320 },
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector<HTMLElement>("[data-link-card]")!;
    await expect(overflowing(card)).toEqual([]);
    const notes = [...card.querySelectorAll("[data-link-note]")].map((n) => n.textContent);
    await expect(notes).toEqual(["not encrypted (http)"]);
    await expect(card.querySelector("[data-link-full]")!.textContent).toBe(new URL(linkLong.url).href);
  },
});

/**
 * THE HOST WRAPS ONLY BETWEEN LABELS. Each label is one line box: none of them
 * broke inside, even at a hyphen, and every line starts at the start of a
 * label.
 */
export const HostBreaksAtDots = meta.story({
  args: { ...linkLong, meta: undefined, trust: undefined, onClick: undefined },
  parameters: { stageWidth: 320 },
  play: async ({ canvasElement }) => {
    const host = canvasElement.querySelector<HTMLElement>("[data-link-host]")!;
    const labels = [...host.children] as HTMLElement[];
    const lineHeight = parseFloat(getComputedStyle(host).lineHeight);
    // It did wrap, so the assertion below is about something.
    await expect(host.getBoundingClientRect().height).toBeGreaterThan(lineHeight * 1.5);
    for (const label of labels) {
      await expect(`${label.textContent}: ${label.getClientRects().length} line(s)`).toBe(
        `${label.textContent}: 1 line(s)`,
      );
    }
    await expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
  },
});

/**
 * 12. The longest label DNS allows, on a phone. It cannot fit on one line, so
 * it wraps inside itself rather than being ellipsised or leaving the card.
 */
export const LongestLabel = meta.story({
  args: { ...linkLongestLabel, meta: undefined, trust: undefined, onClick: undefined },
  parameters: { stageWidth: 320 },
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector<HTMLElement>("[data-link-card]")!;
    const host = card.querySelector<HTMLElement>("[data-link-host]")!;
    await expect(host.textContent).toBe(new URL(linkLongestLabel.url).host);
    await expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
    await expect(getComputedStyle(host).textOverflow).not.toBe("ellipsis");
    await expect(overflowing(card)).toEqual([]);
  },
});

/**
 * An internationalised name. The ASCII form is the headline because it is
 * what the browser resolves; the decoded form rides beside it as "reads as".
 */
export const Internationalised = meta.story({
  args: { ...linkInternational, meta: undefined, trust: undefined, onClick: undefined },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-link-host]")!.textContent).toBe("xn--bcher-kva.example");
    await expect(canvasElement.querySelector("[data-link-note]")!.textContent).toBe("reads as bücher.example");
  },
});

/**
 * 15, 20. Keyboard order is Full address, Copy (once open), Open. Clicking the
 * host, the words or the card's padding reaches no anchor, so selecting text
 * never navigates, and Copy hands the embedder the exact href.
 */
export const DestinationOperable = meta.story({
  args: { ...linkDestination, meta: undefined, trust: undefined, onClick: undefined, onCopy: fn() },
  play: async ({ canvas, canvasElement, userEvent, args }) => {
    const reached: (Element | null)[] = [];
    const record = (event: MouseEvent) => {
      reached.push((event.target as Element).closest("a"));
      event.preventDefault();
    };
    document.addEventListener("click", record, true);
    try {
      const card = canvasElement.querySelector<HTMLElement>("[data-link-card]")!;
      await userEvent.click(card.querySelector("[data-link-host]")!);
      await userEvent.click(canvas.getByText(linkDestination.title));
      await userEvent.click(canvas.getByText(linkDestination.description));
      const box = card.getBoundingClientRect();
      await userEvent.pointer({ keys: "[MouseLeft]", coords: { clientX: box.left + 3, clientY: box.top + 3 } });
      await expect(reached.length).toBeGreaterThan(0);
      await expect(reached.filter(Boolean)).toEqual([]);
    } finally {
      document.removeEventListener("click", record, true);
    }

    const toggle = canvas.getByRole("button", { name: "Full address" });
    await userEvent.tab();
    await expect(document.activeElement).toBe(toggle);
    await userEvent.keyboard("{Enter}");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.tab();
    const copy = canvas.getByRole("button", { name: "Copy" });
    await expect(document.activeElement).toBe(copy);
    await userEvent.keyboard("{Enter}");
    await expect(args.onCopy).toHaveBeenCalledWith(linkDestination.url);
    await expect(await canvas.findByText("Address copied")).toBeVisible();
    await userEvent.tab();
    await expect(document.activeElement).toBe(canvas.getByRole("link"));
  },
});

/**
 * 22. Each control is a 44px target at a phone's width and at a desktop's, and
 * a probe one pixel inside each edge lands on that control.
 */
export const DestinationTargets = meta.story({
  args: { ...linkDestination, meta: undefined, trust: undefined, onClick: undefined, onCopy: fn(), expanded: true },
  parameters: { stageWidth: 320 },
  render: (args) => (
    <div style={{ padding: 20, width: "100%", boxSizing: "border-box" }}>
      <LinkPreviewCard {...args} />
    </div>
  ),
  play: async ({ canvas }) => {
    const controls = [
      canvas.getByRole("button", { name: "Full address" }),
      canvas.getByRole("button", { name: "Copy" }),
      canvas.getByRole("link"),
    ];
    for (const el of controls) {
      const box = el.getBoundingClientRect();
      await expect(box.height).toBeGreaterThanOrEqual(44);
      await expect(box.width).toBeGreaterThanOrEqual(44);
      await expect(getComputedStyle(el).borderTopWidth).toBe("0px");
      const probes: [string, number, number][] = [
        ["left", box.left + 1, (box.top + box.bottom) / 2],
        ["right", box.right - 1, (box.top + box.bottom) / 2],
        ["top", (box.left + box.right) / 2, box.top + 1],
        ["bottom", (box.left + box.right) / 2, box.bottom - 1],
      ];
      for (const [edge, x, y] of probes) {
        const owner = document.elementFromPoint(x, y)?.closest("button, a");
        await expect(`${el.textContent} ${edge} -> ${owner === el ? "self" : "STOLEN"}`).toBe(
          `${el.textContent} ${edge} -> self`,
        );
      }
    }
  },
});

export const DestinationTargetsWide = DestinationTargets.extend({ parameters: wide });

/**
 * 17. A refused address is withheld: the reason in one sentence, the brain's
 * claimed title with its attribution, and what was sent as plain redacted text
 * behind a disclosure. No anchor, no Open, no Copy, and the plain card edge,
 * because withholding is Brain's own act, not second-hand content.
 */
export const Withheld = meta.story({
  args: { ...linkWithheldCredentials, meta: undefined, trust: undefined, onClick: undefined, onCopy: fn() },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const card = await canvas.findByRole("region", { name: "Link withheld" });
    await expect(card).toHaveAccessibleDescription("the address carries a sign-in name or password");
    await userEvent.click(canvas.getByRole("button", { name: "Show what was sent" }));
    await expect(canvasElement.querySelector("[data-link-sent]")!.textContent).toBe("https://•••@drive.example/roster");
    await expect(canvasElement.querySelector("a, [href], [role='link']")).toBeNull();
    await expect(canvas.queryByText(/Copy|Open/)).toBeNull();
  },
});

export const WithheldScheme = meta.story({
  args: { ...linkWithheldScheme, meta: undefined, trust: undefined, onClick: undefined },
  parameters: { stageWidth: 320 },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("only web addresses open from here · this one is javascript:")).toBeVisible();
    await expect(canvasElement.querySelector("a, [href]")).toBeNull();
  },
});
