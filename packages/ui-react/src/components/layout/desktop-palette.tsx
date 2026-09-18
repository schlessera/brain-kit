import { CommandPalette, type PaletteGroup, type PaletteItem } from "@schlessera/brain-ui-kit";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useUIStore } from "../../stores/ui-store.js";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useChatCommands } from "../chat/use-chat-commands.js";

/**
 * The ⌘K palette, on the kit's `CommandPalette` (D22: "SideRail + ⌘K
 * palette" is the desktop's navigation). The kit draws the box, the groups,
 * the selected row and its key, and owns ↑↓, Home/End, ⏎ and esc on the
 * rows; this file owns opening it, the query, and what the rows do.
 *
 * Two groups. "Go to" is the rail's five destinations with their ⌘ keys
 * printed, so the palette teaches the rail. "Chat" is everything the old
 * rail carried that is an action rather than a place — New chat, Sessions,
 * Sync, Briefing, Search, Add a note, Stats — routed through the same
 * `useChatCommands` the composer's slash palette uses, so the guards are
 * one set: Sync and Briefing need the socket and a quiet turn, and are left
 * out of the list rather than listed dead. Sync writes the brain repository
 * and says so in its effect chip; the rest read.
 *
 * The kit's query is display text with a drawn caret, by the design's own
 * choice, so typing is captured on the overlay: a printable key appends,
 * Backspace trims, and either resets the selection to the first match and
 * puts focus back on it. Focus lives on the selected row the whole time,
 * which is what makes the kit's own keys work.
 */
export function DesktopPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const setActiveView = useUIStore((s) => s.setActiveView);
  const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);
  const toggleSettingsPanel = useUIStore((s) => s.toggleSettingsPanel);
  const setSessionPanelOpen = useUIStore((s) => s.setSessionPanelOpen);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const runCommand = useChatCommands();

  useEffect(() => {
    if (typeof window === "undefined") return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function close() {
    setOpen(false);
    setQuery("");
    setSelected(0);
  }
  function run(fn: () => void) {
    return () => {
      close();
      fn();
    };
  }

  const quiet = connected && !isStreaming;
  const goTo: PaletteItem[] = [
    { icon: "brain", label: "Chat", tone: "amber", shortcut: "⌘1", onClick: run(() => setActiveView("chat")) },
    { icon: "activity", label: "Activity", tone: "teal", shortcut: "⌘2", onClick: run(() => setActiveView("activity")) },
    { icon: "files", label: "Files", tone: "teal", shortcut: "⌘3", onClick: run(toggleFilePanel) },
    { icon: "graph", label: "Graph", tone: "purple", shortcut: "⌘4", onClick: run(() => setActiveView("graph")) },
    { icon: "settings", label: "Settings", tone: "neutral", shortcut: "⌘5", onClick: run(toggleSettingsPanel) },
  ];
  const chat: PaletteItem[] = [
    { icon: "compose", label: "New chat", tone: "amber", onClick: run(() => { setActiveView("chat"); clearMessages(); }) },
    { icon: "history", label: "Sessions", tone: "blue", onClick: run(() => { setActiveView("chat"); setSessionPanelOpen(true); }) },
    ...(quiet
      ? [
          { icon: "repeat", label: "Sync the brain", tone: "amber", effect: "sync", onClick: run(() => { setActiveView("chat"); runCommand("sync"); }) } as PaletteItem,
          { icon: "sunrise", label: "Daily briefing", tone: "gold", onClick: run(() => { setActiveView("chat"); runCommand("whatsup"); }) } as PaletteItem,
        ]
      : []),
    { icon: "search", label: "Search the brain", tone: "teal", onClick: run(() => { setActiveView("chat"); runCommand("search"); }) },
    { icon: "add", label: "Add a note", tone: "teal", onClick: run(() => { setActiveView("chat"); runCommand("add"); }) },
    ...(quiet ? [{ icon: "ledger", label: "Brain statistics", tone: "neutral", onClick: run(() => { setActiveView("chat"); runCommand("stats"); }) } as PaletteItem] : []),
  ];
  const q = query.trim().toLowerCase();
  const groups: PaletteGroup[] = [
    { label: "Go to", items: goTo },
    { label: "Chat", items: chat },
  ]
    .map((g) => ({ ...g, items: q ? g.items.filter((it) => it.label.toLowerCase().includes(q)) : g.items }))
    .filter((g) => g.items.length > 0);
  const count = groups.reduce((n, g) => n + g.items.length, 0);

  // Focus follows the selection whenever the list changes under it, so the
  // kit's row keys keep working after a keystroke reshapes the rows.
  useEffect(() => {
    if (!open) return;
    const rows = boxRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    rows?.[Math.min(selected, rows.length - 1)]?.focus();
  }, [open, query, selected]);

  if (!open) return null;

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Backspace") {
      e.preventDefault();
      setQuery((v) => v.slice(0, -1));
      setSelected(0);
    } else if (e.key.length === 1) {
      e.preventDefault();
      setQuery((v) => v + e.key);
      setSelected(0);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 hidden md:block bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div ref={boxRef} className="mx-auto mt-[110px] w-[560px] max-w-[calc(100vw-2rem)]" onKeyDown={onKeyDown}>
        <CommandPalette
          query={query}
          groups={groups}
          selected={Math.min(selected, Math.max(0, count - 1))}
          footHint="↑↓ move · ⏎ run · esc close"
          footMeta={count === 1 ? "1 command" : `${count} commands`}
          onSelect={setSelected}
          onClose={close}
        />
      </div>
    </div>
  );
}
