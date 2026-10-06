import preview from "#.storybook/preview";
import { expect, fn, userEvent } from "storybook/test";

import { notes } from "../../fixtures/notes.js";
import { DiscButton, DiscRow } from "../../src/chrome/DiscButton.js";
import { stage } from "../_stage.js";

const meta = preview.meta({
  title: "Chrome/DiscButton",
  component: DiscButton,
  decorators: [stage],
  args: { name: "New chat", icon: "compose" as const, tone: "ink" as const, label: "New chat", onClick: fn() },
});

const rect = (el: Element) => el.getBoundingClientRect();
const intersects = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Every corner of the 44px box hits the button, and the paint is 32px. */
async function assertTarget(button: HTMLElement) {
  const box = rect(button);
  await expect(box.width, "44px target width").toBeGreaterThanOrEqual(44);
  await expect(box.height, "44px target height").toBe(44);
  const paint = rect(button.firstElementChild!);
  await expect(paint.height, "32px paint").toBe(32);
  // Chromium hit-tests whole pixels, so a .5 inset rounds onto the neighbour.
  for (const x of [box.left + 1, box.right - 1]) for (const y of [box.top + 1, box.bottom - 1]) {
    await expect(document.elementFromPoint(x, y)?.closest("button"), `corner ${x},${y}`).toBe(button);
  }
}

/**
 * One disc. New chat is the primary act, so its icon is `ink` at rest; the
 * fill, edge and shadow are the family's. The 44px box reaches 12px left and
 * 6px up and down, and not right, so it never covers a scrollbar.
 */
export const Single = meta.story({
  play: async ({ canvas, args }) => {
    const button = canvas.getByRole("button", { name: "New chat" });
    await assertTarget(button);
    await expect(rect(button).width, "rest box is the paint plus 12px reach").toBe(44);
    await expect(rect(button).right - rect(button.firstElementChild!).right, "no reach to the right").toBe(0);
    await expect(button.getAttribute("title"), "a labelled disc prints its word, not a tooltip").toBeNull();
    await userEvent.click(button);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
  },
});

/** `mute` is the secondary act and the navigation aid. */
export const Mute = Single.extend({
  args: { name: "Search the brain", icon: "search", tone: "mute", label: "Search" },
  play: async ({ canvas }) => {
    await assertTarget(canvas.getByRole("button", { name: "Search the brain" }));
  },
});

/**
 * Scroll-to-latest: no label, so it never expands and keeps `title`. Its
 * paint is centred, reaching 6px on every side.
 */
export const ScrollToLatest = meta.story({
  args: { name: "Scroll to latest", icon: "latest", tone: "mute", label: undefined, anchor: "center", onClick: fn() },
  play: async ({ canvas }) => {
    const button = canvas.getByRole("button", { name: "Scroll to latest" });
    await assertTarget(button);
    await expect(rect(button).width).toBe(44);
    await expect(button.getAttribute("title")).toBe("Scroll to latest");
    button.focus();
    await expect(rect(button).width, "an unlabelled disc never expands").toBe(44);
  },
});

function Pair({ search, newChat }: { search: () => void; newChat: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}>
      <DiscRow label="Chat actions">
        <DiscButton name="Search the brain" icon="search" tone="mute" label="Search" onClick={search} />
        <DiscButton name="New chat" icon="compose" tone="ink" label="New chat" onClick={newChat} />
      </DiscRow>
    </div>
  );
}

/**
 * The phone pair: Search left of New chat in one right-anchored row, Search
 * first in tab order. Two end-anchored boxes sit edge to edge, so the paints
 * are 12px apart and neither box covers the other's paint.
 */
export const PairRow = meta.story({
  parameters: { stageWidth: 320 },
  render: () => <Pair search={fn()} newChat={fn()} />,
  play: async ({ canvas }) => {
    const search = canvas.getByRole("button", { name: "Search the brain" });
    const newChat = canvas.getByRole("button", { name: "New chat" });
    await expect(search.compareDocumentPosition(newChat) & Node.DOCUMENT_POSITION_FOLLOWING, "Search precedes New chat").toBeTruthy();
    await assertTarget(search);
    await assertTarget(newChat);
    await expect(intersects(rect(search), rect(newChat)), "boxes never overlap").toBe(false);
    await expect(rect(newChat.firstElementChild!).left - rect(search.firstElementChild!).right, "paint gap").toBe(12);
  },
});

/**
 * Keyboard focus on New chat opens its pill. The row grows leftward and
 * pushes Search, which keeps its full target: they still never overlap.
 */
export const PairNewChatExpanded = meta.story({
  parameters: { stageWidth: 320 },
  render: () => <Pair search={fn()} newChat={fn()} />,
  play: async ({ canvas }) => {
    const search = canvas.getByRole("button", { name: "Search the brain" });
    const newChat = canvas.getByRole("button", { name: "New chat" });
    const before = rect(newChat);
    await userEvent.tab();
    await userEvent.tab();
    await expect(newChat).toHaveFocus();
    const label = newChat.querySelector(".bk-disc-label")!;
    // The rail projects pin reduced motion; this one runs with full motion.
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      await expect(getComputedStyle(label).transitionDuration, "the pill opens over 150ms").toContain("0.15s");
    }
    // 150ms under normal motion, none under reduced motion.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = rect(newChat);
    await expect(after.width, "the pill widens the box").toBeGreaterThan(before.width + 40);
    await expect(after.right, "it grows leftward").toBe(before.right);
    await expect(rect(label).width, "the word is printed").toBeGreaterThan(30);
    await expect(intersects(rect(search), after), "Search is pushed, not covered").toBe(false);
    await expect(rect(search).width).toBe(44);
    await expect(newChat).toHaveAccessibleName("New chat");
  },
});

/**
 * At 320 over scrolled text: the discs are opaque, so text passing under them
 * is covered cleanly, and the right-anchored row stays inside the area.
 */
export const OverScrolledText = meta.story({
  parameters: { stageWidth: 320 },
  render: () => (
    <div style={{ position: "relative", width: 320, height: 220, overflow: "hidden", background: "var(--bk-color-canvas)" }}>
      <div data-scroller tabIndex={0} aria-label="Transcript" style={{ height: "100%", overflowY: "auto", padding: "0 16px", boxSizing: "border-box", font: "400 13px/1.5 'Plus Jakarta Sans',system-ui,sans-serif", color: "var(--bk-color-ink-dim)" }}>
        {notes.slice(0, 8).map((note) => (
          <p key={note.id}>{note.excerpt}</p>
        ))}
      </div>
      <DiscRow label="Chat actions" style={{ position: "absolute", top: 10, right: 16 }}>
        <DiscButton name="Search the brain" icon="search" tone="mute" label="Search" onClick={fn()} />
        <DiscButton name="New chat" icon="compose" tone="ink" label="New chat" onClick={fn()} />
      </DiscRow>
      <DiscButton
        name="Scroll to latest"
        icon="latest"
        anchor="center"
        onClick={fn()}
        style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)" }}
      />
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    const scroller = canvasElement.querySelector<HTMLElement>("[data-scroller]")!;
    scroller.scrollTop = 120;
    const area = rect(scroller);
    const buttons = canvas.getAllByRole("button");
    await expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      await assertTarget(button);
      const box = rect(button);
      await expect(box.left >= area.left && box.right <= area.right, "inside the area").toBe(true);
    }
    for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
      await expect(intersects(rect(buttons[i]!), rect(buttons[j]!)), "no two boxes intersect").toBe(false);
    }
  },
});

/**
 * Desktop below 1280 (900, expanded rail): New chat alone, in the margin
 * right of the 720px reading column, which it never intersects.
 */
export const Desktop = meta.story({
  parameters: { stageWidth: "none" },
  render: () => (
    <div style={{ position: "relative", width: 900, height: 220, overflow: "hidden", background: "var(--bk-color-canvas)" }}>
      <div style={{ height: "100%", overflowY: "auto" }} tabIndex={0} aria-label="Transcript">
        <div data-column style={{ maxWidth: 720, margin: "0 auto", font: "400 13px/1.5 'Plus Jakarta Sans',system-ui,sans-serif", color: "var(--bk-color-ink-dim)" }}>
          {notes.slice(0, 8).map((note) => (
            <p key={note.id}>{note.excerpt}</p>
          ))}
        </div>
      </div>
      <DiscRow style={{ position: "absolute", top: 10, right: 16 }}>
        <DiscButton name="New chat" icon="compose" tone="ink" label="New chat" onClick={fn()} />
      </DiscRow>
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    const button = canvas.getByRole("button", { name: "New chat" });
    await assertTarget(button);
    const column = canvasElement.querySelector("[data-column]")!;
    await expect(rect(column).width).toBe(720);
    await expect(intersects(rect(column), rect(button)), "the column clears the disc").toBe(false);
  },
});
