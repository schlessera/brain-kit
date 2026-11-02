import preview from "#.storybook/preview";
import { useEffect, useRef, useState } from "react";
import { expect, fn, waitFor } from "storybook/test";

import { Button } from "../../src/primitives/Button.js";
import { ItemCard, type ItemCardAction } from "../../src/rows/ItemCard.js";
import { accent, color, font } from "../../src/tokens.js";
import { stage, wide } from "../_stage.js";

/** A field as the module settings form draws it, with the kit's tokens. */
function Field({ label, value, error }: { label: string; value: string; error?: string }) {
  return (
    <label style={{ display: "grid", gap: 4, font: `600 13px/1.4 ${font.body}`, color: color.ink }}>
      {label}
      <input
        defaultValue={value}
        aria-invalid={error ? true : undefined}
        style={{
          boxSizing: "border-box",
          minHeight: 44,
          width: "100%",
          padding: "8px 12px",
          borderRadius: 8,
          border: `1px solid ${error ? accent.red.ink : color.line}`,
          background: color.surface,
          color: color.ink,
          font: `400 13px ${font.body}`,
        }}
      />
      {error ? <span role="alert" style={{ font: `400 12px/1.4 ${font.body}`, color: accent.red.ink }}>{error}</span> : null}
    </label>
  );
}

const actions: ItemCardAction[] = [
  { label: "Move up", onSelect: fn(), disabled: true },
  { label: "Move down", onSelect: fn() },
  { label: "Remove…", onSelect: fn(), danger: true },
];

const meta = preview.meta({
  title: "Rows/ItemCard",
  component: ItemCard,
  decorators: [stage],
  parameters: { stageWidth: 320 },
  args: {
    title: "Ithaca, Vathy harbor",
    meta: "every 6 h · notices + weather",
    actions,
    children: (
      <>
        <Field label="Port" value="Ithaca, Vathy harbor" />
        <Field label="Check every" value="6" />
      </>
    ),
  },
});

/** One record, closed. Its title, summary and actions menu stay visible. */
export const Collapsed = meta.story({
  play: async ({ canvas }) => {
    const toggle = await canvas.findByRole("button", { name: "Ithaca, Vathy harbor every 6 h · notices + weather" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    // The menu is its own target, never part of the expansion toggle.
    const menu = canvas.getByRole("button", { name: "Actions for Ithaca, Vathy harbor" });
    await expect(toggle.contains(menu)).toBe(false);
    const a = toggle.getBoundingClientRect(), b = menu.getBoundingClientRect();
    await expect(b.width).toBeGreaterThanOrEqual(44);
    await expect(b.height).toBeGreaterThanOrEqual(44);
    await expect(b.left - a.right).toBeGreaterThanOrEqual(8);
  },
});

export const Open = meta.story({ args: { open: true } });

export const OpenWide = Open.extend({ parameters: wide });

/** An error in a closed card shows on its header: a count and a red border. */
export const ErrorCollapsed = meta.story({
  args: { errorCount: 2 },
  play: async ({ canvas, canvasElement }) => {
    const toggle = await canvas.findByRole("button", { name: "Ithaca, Vathy harbor 2 to fix" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(canvasElement.querySelector("[data-item-card]")).toHaveAttribute("data-invalid");
  },
});

export const ErrorOpen = meta.story({
  args: {
    errorCount: 1,
    open: true,
    children: (
      <>
        <Field label="Port" value="Ithaca, Vathy harbor" />
        <Field label="Check every" value="0" error="Use at least 1 hour" />
      </>
    ),
  },
});

export const ErrorOpenWide = ErrorOpen.extend({ parameters: wide });

/** Titles wrap to two lines, then ellipsis; the full title is on hover. */
export const LongTitle = meta.story({
  args: {
    title: "Aeaea, Circe's island, the western anchorage below the oak wood where the crew drew the ship up the beach",
    meta: "daily · weather",
  },
  play: async ({ canvasElement }) => {
    const title = canvasElement.querySelector<HTMLElement>("[data-item-card-toggle] [title]")!;
    const line = parseFloat(getComputedStyle(title).lineHeight);
    await expect(title.getBoundingClientRect().height).toBeLessThanOrEqual(line * 2 + 1);
    await expect(title.scrollHeight).toBeGreaterThan(title.clientHeight);
  },
});

/** A note keeps its line under the title and describes the toggle. */
export const WithNote = meta.story({ args: { note: "up to 25 pts · 2 tiers · 3 keywords" } });

/** Read-only, as in a migration preview: no actions, still expandable. */
export const ReadOnly = meta.story({
  args: { actions: [] },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("button", { name: /Actions for/ })).toBeNull();
    await expect(canvas.getByRole("button", { name: /Ithaca/ })).toBeEnabled();
  },
});

/**
 * The actions menu by keyboard: opening it focuses the first item, the arrows
 * move, a disabled item does nothing, Escape returns focus to the trigger.
 */
export const ActionsMenu = meta.story({
  args: {
    actions: [
      { label: "Move up", onSelect: fn(), disabled: true },
      { label: "Move down", onSelect: fn() },
      { label: "Remove…", onSelect: fn(), danger: true },
    ],
  },
  play: async ({ canvas, userEvent, args }) => {
    const trigger = await canvas.findByRole("button", { name: "Actions for Ithaca, Vathy harbor" });
    await userEvent.click(trigger);
    const menu = canvas.getByRole("menu", { name: "Actions for Ithaca, Vathy harbor" });
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toHaveAttribute("aria-controls", menu.id);
    const [up, down, remove] = canvas.getAllByRole("menuitem");
    await waitFor(() => expect(up).toHaveFocus());
    await expect(up).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    await expect(args.actions![0]!.onSelect).not.toHaveBeenCalled();
    await userEvent.keyboard("{ArrowDown}");
    await expect(down).toHaveFocus();
    await userEvent.keyboard("{End}");
    await expect(remove).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(up).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("menu")).toBeNull();
    await expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.click(canvas.getAllByRole("menuitem")[1]!);
    await expect(args.actions![1]!.onSelect).toHaveBeenCalledTimes(1);
    await expect(canvas.queryByRole("menu")).toBeNull();
  },
});

/** Enter and Space toggle; the body appears without animation. */
export const Keyboard = meta.story({
  args: { onOpenChange: fn() },
  play: async ({ canvas, canvasElement, userEvent, args }) => {
    const toggle = await canvas.findByRole("button", { name: /^Ithaca/ });
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(true);
    const body = canvasElement.querySelector<HTMLElement>("[data-item-card-body]")!;
    await expect(toggle).toHaveAttribute("aria-controls", body.id);
    await userEvent.keyboard(" ");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The closed body unmounts, and aria-controls stops naming it.
    await expect(canvasElement.querySelector("[data-item-card-body]")).toBeNull();
    await expect(toggle).not.toHaveAttribute("aria-controls");
    await expect(toggle.matches(":focus-visible")).toBe(true);
    await expect(getComputedStyle(toggle).outlineStyle).toBe("solid");
  },
});

/**
 * A list of records the way a host composes one, with the focus rules a host
 * implements: Add opens the new record and focuses its first field; a
 * confirmed Remove sends focus to the next header, else the previous, else
 * Add; expansion follows the record, not its position, when it moves.
 */
export const ListFocus = meta.story({
  parameters: { stageWidth: 320 },
  render: () => {
    const next = useRef(3);
    const [items, setItems] = useState([
      { id: 1, title: "Ithaca, Vathy harbor" },
      { id: 2, title: "Aeaea, Circe's island" },
    ]);
    const [open, setOpen] = useState<Set<number>>(new Set());
    const [removing, setRemoving] = useState<number | null>(null);
    const toggles = useRef(new Map<number, HTMLDivElement | null>());
    const add = useRef<HTMLDivElement>(null);
    const firstField = useRef(new Map<number, HTMLInputElement | null>());
    const [focusAfter, setFocusAfter] = useState<{ id?: number; field?: number; add?: true } | null>(null);
    useEffect(() => {
      if (!focusAfter) return;
      if (focusAfter.field !== undefined) firstField.current.get(focusAfter.field)?.focus();
      else if (focusAfter.id !== undefined) toggles.current.get(focusAfter.id)?.focus();
      else add.current?.querySelector<HTMLElement>("[role=button]")?.focus();
      setFocusAfter(null);
    }, [focusAfter]);
    const move = (at: number, by: number) => setItems((list) => {
      const copy = [...list];
      [copy[at], copy[at + by]] = [copy[at + by]!, copy[at]!];
      return copy;
    });
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
        {items.map((item, at) => (
          <ItemCard
            key={item.id}
            ref={(node) => { toggles.current.set(item.id, node); }}
            title={item.title}
            meta={`record ${item.id}`}
            open={open.has(item.id)}
            onOpenChange={(value) => setOpen((set) => {
              const copy = new Set(set);
              if (value) copy.add(item.id); else copy.delete(item.id);
              return copy;
            })}
            actions={[
              { label: "Move up", disabled: at === 0, onSelect: () => move(at, -1) },
              { label: "Move down", disabled: at === items.length - 1, onSelect: () => move(at, 1) },
              { label: "Remove…", danger: true, onSelect: () => setRemoving(item.id) },
            ]}
            notice={removing === item.id ? (
              <div role="alert" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, font: `400 12px ${font.body}`, color: color.ink }}>
                Remove {item.title}?
                <Button label="Remove" tone="quiet" block={false} onClick={() => {
                  const target = items[at + 1]?.id ?? items[at - 1]?.id;
                  setItems((list) => list.filter((row) => row.id !== item.id));
                  setRemoving(null);
                  setFocusAfter(target === undefined ? { add: true } : { id: target });
                }} />
                <Button label="Keep" tone="quiet" block={false} onClick={() => setRemoving(null)} />
              </div>
            ) : undefined}
          >
            <label style={{ display: "grid", gap: 4, font: `600 13px ${font.body}`, color: color.ink }}>
              Port
              <input ref={(node) => { firstField.current.set(item.id, node); }} defaultValue={item.title} style={{ minHeight: 44 }} />
            </label>
          </ItemCard>
        ))}
        <div ref={add} style={{ display: "contents" }}>
          <Button label="Add port" icon="add" tone="quiet" onClick={() => {
            const id = next.current++;
            setItems((list) => [...list, { id, title: `Untitled port ${list.length + 1}` }]);
            setOpen((set) => new Set(set).add(id));
            setFocusAfter({ field: id });
          }} />
        </div>
      </div>
    );
  },
  play: async ({ canvas, userEvent }) => {
    // Add opens the new record and focuses its first field.
    await userEvent.click(canvas.getByRole("button", { name: "Add port" }));
    await waitFor(() => expect(canvas.getByDisplayValue("Untitled port 3")).toHaveFocus());
    await expect(canvas.getByRole("button", { name: /^Untitled port 3/ })).toHaveAttribute("aria-expanded", "true");

    // Expansion follows the record across a move.
    await userEvent.click(canvas.getByRole("button", { name: /^Ithaca/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Actions for Ithaca, Vathy harbor" }));
    await userEvent.click(canvas.getByRole("menuitem", { name: "Move down" }));
    await expect(canvas.getByRole("button", { name: /^Ithaca/ })).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByRole("button", { name: /^Aeaea/ })).toHaveAttribute("aria-expanded", "false");
    const order = canvas.getAllByRole("button", { name: /^(Ithaca|Aeaea|Untitled)/ }).map((b) => b.textContent);
    await expect(order[0]).toMatch(/^Aeaea/);

    // A confirmed Remove sends focus to the next header…
    await userEvent.click(canvas.getByRole("button", { name: "Actions for Ithaca, Vathy harbor" }));
    await userEvent.click(canvas.getByRole("menuitem", { name: "Remove…" }));
    await userEvent.click(canvas.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: /^Untitled port 3/ })).toHaveFocus());
    // …the previous one when it was last…
    await userEvent.click(canvas.getByRole("button", { name: "Actions for Untitled port 3" }));
    await userEvent.click(canvas.getByRole("menuitem", { name: "Remove…" }));
    await userEvent.click(canvas.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: /^Aeaea/ })).toHaveFocus());
    // …and Add when nothing is left.
    await userEvent.click(canvas.getByRole("button", { name: "Actions for Aeaea, Circe's island" }));
    await userEvent.click(canvas.getByRole("menuitem", { name: "Remove…" }));
    await userEvent.click(canvas.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Add port" })).toHaveFocus());
  },
});

/**
 * A read-only form: inside a disabled `<fieldset>` the record still opens,
 * because reading is not editing, while the actions menu (a native button)
 * is disabled with the form.
 */
export const InsideDisabledFieldset = meta.story({
  render: (args) => (
    <fieldset disabled style={{ margin: 0, padding: 0, border: "none", minWidth: 0, width: "100%" }}>
      <ItemCard {...args} />
    </fieldset>
  ),
  play: async ({ canvas }) => {
    const toggle = await canvas.findByRole("button", { name: /^Ithaca/ });
    // user-event treats every descendant of a disabled fieldset as disabled,
    // which the browser does not: drive the real activation paths instead.
    toggle.click();
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
    toggle.focus();
    await expect(toggle).toHaveFocus();
    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "false"));
    await expect(canvas.getByRole("button", { name: "Actions for Ithaca, Vathy harbor" })).toBeDisabled();
  },
});
