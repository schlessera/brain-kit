import { CommandPalette, type PaletteGroup, type PaletteItem } from "@schlessera/brain-ui-kit";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useUIStore } from "../../stores/ui-store.js";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useChatCommands } from "../chat/use-chat-commands.js";

/**
 * The ⌘K palette, on the kit's `CommandPalette` (D22: "SideRail + ⌘K
 * palette" is the desktop's navigation). The kit draws the box, the real
 * query input, the groups, the selected row and its key, and owns ↑↓,
 * Home/End, ⏎ and esc on the rows; this file owns opening it, the query,
 * and what the rows do.
 *
 * Groups are what ⏎ DOES (D37), not the app's feature areas. **Jump to**:
 * the five destinations with their ⌘ keys printed, New chat and Sessions —
 * they move you. **Ask**: Search the brain and Brain statistics — they
 * answer something. **Run**: Sync (`effect: sync`, it writes the
 * repository), the Daily briefing (a cost chip: spending is an effect even
 * when nothing is written) and Add a note (bare — opening a form is not an
 * effect; its submit carries the write). A command the host cannot serve
 * right now is shown DISABLED with its reason, never omitted: dropping rows
 * while the socket is down would teach that the palette's contents are a
 * guess.
 *
 * The app has no cost estimate for the briefing, so its chip says `spends`
 * rather than an invented figure — the design's `~$0.12` is an example.
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
  function inChat(fn: () => void) {
    return run(() => {
      setActiveView("chat");
      fn();
    });
  }

  // The reason a row cannot run right now, printed in the row rather than
  // hiding it. Sync and the briefing need a live connection and a quiet turn.
  // Stats uses REST and can show the loaded client identity offline.
  const why = !connected ? "needs the host" : isStreaming ? "a turn is running" : undefined;
  const jumpTo: PaletteItem[] = [
    { icon: "brain", label: "Chat", tone: "amber", shortcut: "⌘1", onClick: run(() => setActiveView("chat")) },
    { icon: "resolved", label: "Actions", tone: "amber", shortcut: "⌘2", onClick: run(() => setActiveView("activity")) },
    { icon: "files", label: "Files", tone: "teal", shortcut: "⌘3", onClick: run(toggleFilePanel) },
    { icon: "graph", label: "Graph", tone: "purple", shortcut: "⌘4", onClick: run(() => setActiveView("graph")) },
    { icon: "settings", label: "Settings", tone: "neutral", shortcut: "⌘5", onClick: run(toggleSettingsPanel) },
    { icon: "compose", label: "New chat", tone: "amber", onClick: inChat(clearMessages) },
    { icon: "history", label: "Sessions", tone: "blue", onClick: inChat(() => setSessionPanelOpen(true)) },
  ];
  const ask: PaletteItem[] = [
    { icon: "search", label: "Search the brain", tone: "teal", onClick: inChat(() => runCommand("search")) },
    { icon: "ledger", label: "Brain statistics", tone: "neutral", why: isStreaming ? "a turn is running" : undefined, onClick: inChat(() => runCommand("stats")) },
  ];
  const runGroup: PaletteItem[] = [
    { icon: "repeat", label: "Sync the brain", tone: "amber", effect: "sync", why, onClick: inChat(() => runCommand("sync")) },
    { icon: "sunrise", label: "Daily briefing", tone: "gold", cost: "spends", why, onClick: inChat(() => runCommand("whatsup")) },
    { icon: "add", label: "Add a note", tone: "teal", onClick: inChat(() => runCommand("add")) },
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

  // The query input takes focus when the palette opens; ↓ from it lands on
  // the selected row, where the kit's own keys take over.
  useEffect(() => {
    if (!open) return;
    boxRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [open]);

  if (!open) return null;

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
    <div
      className="fixed inset-0 z-50 hidden tablet:block bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div ref={boxRef} className="mx-auto mt-[110px] w-[560px] max-w-[calc(100vw-2rem)]" onKeyDown={onKeyDown}>
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
          onClose={close}
        />
      </div>
    </div>
  );
}
