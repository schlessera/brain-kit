import { CommandPalette, Overlay, type PaletteGroup, type PaletteItem } from "@schlessera/brain-ui-kit";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useUIStore } from "../../stores/ui-store.js";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";
import { HANDOFF_ENTRY_LABEL, useHandoffEntry } from "../../hooks/use-handoff-entry.js";
import { useBrainUiRoot } from "../../root-context.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { openModal } from "../../lib/destination-start.js";
import { useDesktopRoutes } from "./desktop-routes.js";

/**
 * The ⌘K palette, on the kit's `CommandPalette` (D22: "SideRail + ⌘K
 * palette" is the desktop's navigation). The kit draws the box, the real
 * query input, the groups, the selected row and its key, and owns ↑↓,
 * Home/End, ⏎ and esc on the rows; this file owns the query and what the
 * rows do. Whether it is open is the root's `paletteOpen`, which ⌘K and the
 * rail's `All commands` button both set, so one root's button never opens
 * another mounted root's palette (D52 §1). Closing without running a row
 * (esc, a click on the scrim) hands focus back to what held it on opening.
 *
 * Groups are what ⏎ DOES (D37), not the app's feature areas. **Jump to**:
 * the five destinations with their ⌘ keys, then Graph (no key: it is no
 * longer a destination, D52 §1) and New chat — they move you. Sessions is a
 * destination now and appears once. **Ask**: Search the brain and Brain
 * statistics — they answer something. **Run**: Sync (`effect: sync`, it
 * writes the repository), the Daily briefing (a cost chip: spending is an
 * effect even when nothing is written) and Add a note (bare — opening a form
 * is not an effect; its submit carries the write). With a chat in view,
 * Continue on another backend (#61) joins Run with a cost chip: its review
 * drafts a summary with a model the moment it opens. A command the host
 * cannot serve right now is shown DISABLED with its reason, never omitted:
 * dropping rows while the socket is down would teach that the palette's
 * contents are a guess. A row that is also on the rail stays here.
 *
 * The destination keys print only under a fine pointer, as on the rail
 * (D36 addendum): the palette is tappable now, and a key printed to a
 * finger is a lie. The keys stay bound either way.
 *
 * The app has no cost estimate for the briefing, so its chip says `spends`
 * rather than an invented figure — the design's `~$0.12` is an example.
 */
export function DesktopPalette() {
  const open = useUIStore((s) => s.paletteOpen);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const root = useBrainUiRoot();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // What held focus when the palette opened, for a close that runs nothing.
  const eligible = useMediaQuery("(min-width: 480px)");
  const [restoreFocus, setRestoreFocus] = useState(true);
  const afterClose = useRef<(() => void) | undefined>(undefined);

  const clearMessages = useChatStore((s) => s.clearMessages);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const hasSettledTurn = useChatStore((s) => activeChat(s).messages.some((m) => m.role === "assistant" && !m.isStreaming));
  const handoff = useHandoffEntry(activeSessionId, hasSettledTurn);
  const finePointer = useFinePointer();
  const routes = useDesktopRoutes();

  // ⌘K opens it, and closes it as a dismissal does. Read at the keypress,
  // so the listener is registered once.
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (root.stores.ui.getState().paletteOpen) dismissRef.current();
        else if (window.matchMedia("(min-width: 480px)").matches && !openModal()) root.stores.ui.getState().setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [root]);

  // However it closed, the next opening starts from an empty query.
  useEffect(() => {
    if (open) return;
    setQuery("");
    setSelected(0);
  }, [open]);

  function dismiss() {
    setRestoreFocus(true);
    afterClose.current = undefined;
    setPaletteOpen(false);
  }
  function run(fn: () => void) {
    return () => {
      setRestoreFocus(false);
      afterClose.current = fn;
      setPaletteOpen(false);
    };
  }
  function onAfterClose() {
    const next = afterClose.current;
    afterClose.current = undefined;
    next?.();
  }

  const jumpTo: PaletteItem[] = [
    ...routes.destinations.map((d) => ({
      icon: d.icon,
      label: d.label,
      tone: d.tone,
      ...(finePointer ? { shortcut: d.key } : {}),
      onClick: run(d.go),
    })),
    { icon: "graph", label: "Graph", tone: "purple", onClick: run(routes.graph) },
    { icon: "compose", label: "New chat", tone: "amber", onClick: run(routes.inChat(clearMessages)) },
  ];
  const ask: PaletteItem[] = [
    { icon: "search", label: "Search the brain", tone: "teal", onClick: run(routes.search) },
    // Stats uses REST and can show the loaded client identity offline.
    { icon: "ledger", label: "Brain statistics", tone: "neutral", why: routes.isStreaming ? "a turn is running" : undefined, onClick: run(routes.stats) },
  ];
  const runGroup: PaletteItem[] = [
    { icon: "repeat", label: "Sync the brain", tone: "amber", effect: "sync", why: routes.why, onClick: run(routes.sync) },
    { icon: "sunrise", label: "Daily briefing", tone: "gold", cost: "spends", why: routes.why, onClick: run(routes.briefing) },
    { icon: "add", label: "Add a note", tone: "teal", onClick: run(routes.add) },
    // A chat with a selected session can continue on another backend (#61).
    // Opening its review drafts a summary with a model, so it spends.
    ...(handoff.shown
      ? [{ icon: "share" as const, label: HANDOFF_ENTRY_LABEL, tone: "teal" as const, cost: "spends",
          ...(handoff.why ? { why: handoff.why } : {}), onClick: run(routes.inChat(handoff.open)) }]
      : []),
  ];
  const q = query.trim().toLowerCase();
  const groups: PaletteGroup[] = [
    { label: "Jump to", items: jumpTo },
    { label: "Ask", items: ask },
    { label: "Run", items: runGroup },
  ]
    .map((g) => ({ ...g, items: q ? g.items.filter((it) => it.label.toLowerCase().includes(q)) : g.items }))
    .filter((g) => g.items.length > 0);
  const count = groups.reduce((n, g) => n + g.items.length, 0);

  useEffect(() => {
    if (open && !eligible) dismissRef.current();
  }, [open, eligible]);

  function onKeyDown(e: ReactKeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName !== "INPUT") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      boxRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      boxRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.click();
    }
  }

  return (
    <Overlay open={open && eligible} variant="dialog" placement="top" size="lg" label="Command palette" data-palette=""
      onClose={dismiss} returnFocus={restoreFocus} onAfterClose={onAfterClose}>
      <div ref={boxRef} onKeyDown={onKeyDown}>
        <CommandPalette
          query={query}
          onQueryChange={(value) => {
            setQuery(value);
            setSelected(0);
          }}
          groups={groups}
          selected={Math.min(selected, Math.max(0, count - 1))}
          footHint="↑↓ move · ⏎ run · esc close"
          footMeta={count === 1 ? "1 command" : `${count} commands`}
          onSelect={setSelected}
          onClose={dismiss}
        />
      </div>
    </Overlay>
  );
}
