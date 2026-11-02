import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useExpansion } from "../internal/expansion.js";
import { Icon } from "../primitives/Icon.js";
import { IconButton } from "../primitives/IconButton.js";
import { accent, color, font, token, z } from "../tokens.js";

/**
 * One repeated, editable record in a form: a module's scoring group, a feed, a
 * crew member (#3253, pattern "Editable item").
 *
 * Three things stay discoverable while the card is collapsed, and they are why
 * this is not a `Disclosure`:
 *
 *   1. **The title** — what the record is. Wraps to two lines, then ellipsis,
 *      with the whole title on hover.
 *   2. **Validation.** `errorCount > 0` replaces the meta with `■ {n} to fix`
 *      in red and draws the border red, so an error in a closed card is never
 *      hidden from the person about to save.
 *   3. **Actions.** Move and Remove live in a separate `⋯` menu at every screen
 *      size (maintainer ruling): no hover-only or desktop-only inline actions.
 *      The menu is its own target, never part of the expansion toggle.
 *
 * Removal confirmation stays inline: the host renders it in `notice`, which
 * shows in both states, directly under the header.
 *
 * The closed body unmounts, like `Disclosure`'s: the record's values live in
 * the host's form state, not in the fields. Focus rules for add, failed save,
 * remove and disappearance are the host list's (they need the list); the card
 * forwards its toggle as the ref so the host can return focus to a header.
 * The toggle is a `role="button"` element with Enter and Space, so it stays
 * operable inside a disabled `<fieldset>`; see the note at the toggle.
 */
export interface ItemCardAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Drawn in the danger ink. Use it for Remove. */
  danger?: boolean;
}

export interface ItemCardProps {
  title: string;
  /** A short mono summary of one or two key values. Replaced by the error
   *  count while `errorCount > 0`. */
  meta?: string;
  /** A line under the title, such as a computed note. */
  note?: string;
  errorCount?: number;
  /** Seeds alone; with `onOpenChange` it is the live value. See `Disclosure`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The `⋯` menu. Omit, or pass none, for a read-only record. */
  actions?: readonly ItemCardAction[];
  /** Shown in both states under the header: the inline remove confirmation. */
  notice?: ReactNode;
  children?: ReactNode;
}

export const ItemCard = forwardRef<HTMLDivElement, ItemCardProps>(function ItemCard(
  { title, meta, note, errorCount = 0, open: seed, onOpenChange, actions = [], notice, children },
  ref,
) {
  const expansion = useExpansion({ open: seed, onOpenChange });
  const open = expansion.open;
  const ids = useId();
  const titleId = `${ids}-title`;
  const metaId = `${ids}-meta`;
  const noteId = `${ids}-note`;
  const invalid = errorCount > 0;
  const status = invalid ? `${errorCount} to fix` : meta;

  return (
    <div
      data-item-card=""
      data-invalid={invalid ? "" : undefined}
      style={{
        boxSizing: "border-box",
        position: "relative",
        width: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        borderRadius: 12,
        background: color.surface,
        // 1.5px red reads as a state, not a heavier card; the box-shadow keeps
        // the layout from shifting by half a pixel when an error arrives.
        border: `1px solid ${invalid ? accent.red.ink : color.line}`,
        boxShadow: invalid ? `0 0 0 0.5px ${accent.red.ink}` : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: 4 }}>
        {/* A `role="button"` element, like Disclosure's summary, and not a
            native button: an item card lives in forms, and a disabled
            <fieldset> disables every native button inside it. Reading a
            read-only record (a migration preview) must still open it; the
            actions menu, a native button, is disabled with the form. */}
        <div
          ref={ref}
          className="bk-row"
          data-item-card-toggle=""
          aria-labelledby={status ? `${titleId} ${metaId}` : titleId}
          aria-describedby={note ? noteId : undefined}
          {...expansion.roleButtonProps({ bodyMounted: open })}
          style={{
            boxSizing: "border-box",
            flex: 1,
            minWidth: 0,
            minHeight: 44,
            padding: "8px 8px",
            borderRadius: 9,
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            textAlign: "start",
            color: color.ink,
            cursor: "pointer",
            userSelect: "none",
            ...({ "--hv-bg": "var(--bk-hover-veil-strong)" } as CSSProperties),
          }}
        >
          <span style={{ flex: "none", display: "inline-flex", paddingTop: 2 }}>
            <Icon icon={open ? "collapse" : "next"} size={14} color={accent.neutral.ink} />
          </span>
          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <span
              id={titleId}
              title={title}
              style={{
                font: `600 13.5px/1.4 ${font.body}`,
                overflowWrap: "anywhere",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {title}
            </span>
            {status ? (
              <span
                data-item-card-status=""
                style={{
                  font: `500 11px/1.4 ${font.mono}`,
                  color: invalid ? accent.red.ink : color.inkMute,
                  overflowWrap: "anywhere",
                }}
              >
                {invalid ? <span aria-hidden="true">{"■ "}</span> : null}
                {/* The labelled span is the text alone, so the toggle's name
                    is "{title} {n} to fix" without the decorative square. */}
                <span id={metaId}>{status}</span>
              </span>
            ) : null}
            {note ? (
              <span id={noteId} style={{ font: `400 12px/1.45 ${font.body}`, color: color.inkMute, overflowWrap: "anywhere" }}>
                {note}
              </span>
            ) : null}
          </span>
        </div>
        {actions.length ? <ActionsMenu title={title} actions={actions} /> : null}
      </div>
      {notice ? <div style={{ padding: "0 12px 12px" }}>{notice}</div> : null}
      {open ? (
        <div
          id={expansion.bodyId}
          data-item-card-body=""
          style={{ minWidth: 0, padding: "4px 12px 12px", display: "flex", flexDirection: "column", gap: 12 }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
});

/**
 * The card's `⋯` menu. Opening it focuses the first item; the arrows, Home and
 * End move inside it; Escape and Tab close it and return focus to the trigger;
 * focus leaving it closes it. A disabled item stays focusable and announced as
 * dimmed, as the menu pattern expects, and does nothing when chosen.
 */
function ActionsMenu({ title, actions }: { title: string; actions: readonly ItemCardAction[] }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  items.current.length = actions.length;
  useEffect(() => { if (open) items.current[0]?.focus(); }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const at = items.current.indexOf(event.target as HTMLButtonElement);
    const last = actions.length - 1;
    const move = (to: number) => { event.preventDefault(); items.current[to]?.focus(); };
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "ArrowDown") move(at >= last ? 0 : at + 1);
    else if (event.key === "ArrowUp") move(at <= 0 ? last : at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(last);
  }

  return (
    <span style={{ position: "relative", flex: "none", display: "flex" }}>
      <IconButton
        ref={trigger}
        icon="more"
        name={`Actions for ${title}`}
        haspopup="menu"
        expanded={open}
        controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={`Actions for ${title}`}
          className="bk-focus-clip"
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            const next = event.relatedTarget as Node | null;
            if (!event.currentTarget.contains(next) && next !== trigger.current) setOpen(false);
          }}
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            zIndex: z.popover,
            marginTop: 4,
            minWidth: 192,
            maxWidth: "calc(100vw - 32px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            border: `1px solid ${color.line}`,
            borderRadius: 12,
            background: color.raised,
            // The palette's themed shadow: a raised menu over the form, in both themes.
            boxShadow: `0 12px 32px ${token("palette-shadow")}`,
          }}
        >
          {actions.map((action, index) => (
            <button
              key={action.label}
              ref={(node) => { items.current[index] = node; }}
              type="button"
              role="menuitem"
              className="bk-row"
              aria-disabled={action.disabled || undefined}
              onClick={() => {
                if (action.disabled) return;
                close();
                action.onSelect();
              }}
              style={{
                appearance: "none",
                boxSizing: "border-box",
                width: "100%",
                minHeight: 44,
                margin: 0,
                padding: "10px 12px",
                border: "none",
                background: "transparent",
                textAlign: "start",
                font: `500 13px/1.4 ${font.body}`,
                color: action.disabled ? color.inkMute : action.danger ? accent.red.ink : color.ink,
                cursor: action.disabled ? "not-allowed" : "pointer",
                ...({ "--hv-bg": action.disabled ? "transparent" : "var(--bk-hover-veil-strong)" } as CSSProperties),
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
