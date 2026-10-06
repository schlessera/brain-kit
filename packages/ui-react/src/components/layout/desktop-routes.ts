import type { IconName, PaletteItem } from "@schlessera/brain-ui-kit";
import { useUIStore } from "../../stores/ui-store.js";
import type { DestinationPressHow } from "../../stores/ui-state.js";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useChatCommands } from "../chat/use-chat-commands.js";

/** The palette's row tone, which the rail does not draw. */
type Tone = NonNullable<PaletteItem["tone"]>;

export interface DesktopDestination {
  icon: IconName;
  label: string;
  tone: Tone;
  /** The destination's own chord, e.g. `⌘2`, bound by the rail. */
  key: string;
  /** Pressed; `{ keyboard: true }` from its chord (D52 N3). */
  go: (how?: DestinationPressHow) => void;
}

/**
 * What the desktop's destinations and acts DO, read once so the rail and the
 * ⌘K palette cannot drift apart: the same handler, key and unavailable reason
 * wherever a route is drawn (D52 §1). Not a command registry — the rail and
 * the palette still decide what they draw and in what order.
 *
 * Destinations are D52's five, in rail order with their ⌘1–⌘5: Chat,
 * Sessions, Actions, Files, Settings. Graph is no longer one of them, so it
 * has no chord and is reached through the palette's Jump to. Sessions opens
 * the existing drawer in Chat until the ≥1280 pane is installed.
 *
 * Every destination goes through `pressDestination` (D52 §2, N1 and N3), as
 * the phone bar does. Sessions, Files and Settings are panels: each replaces
 * any other open panel and lands in Chat when the current view does not draw
 * it (Actions has no Files). Pressing the destination already shown leaves
 * it open and changes nothing but its scroll and focus, which the mounted
 * destination answers (N3). Settings' leave guard is asked only when
 * Settings is actually being left.
 *
 * The acts land in Chat first, as the palette always has, and keep their
 * dispatch in `useChatCommands`. Search and Add talk to the CLI over REST, so
 * they have no reason to be unavailable; the briefing needs a live socket and
 * a quiet turn, and spends.
 */
export function useDesktopRoutes() {
  const setActiveView = useUIStore((s) => s.setActiveView);
  const press = useUIStore((s) => s.pressDestination);
  const afterLeavingSettings = useUIStore((s) => s.afterLeavingSettings);
  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const runCommand = useChatCommands();

  // Lands in Chat, then runs. Both wait for unsaved Settings to be left, so
  // a guarded leave never opens a panel over Settings or starts a job early.
  function inChat(fn: () => void) {
    return () => afterLeavingSettings(() => {
      setActiveView("chat");
      fn();
    });
  }

  const destinations: DesktopDestination[] = [
    { icon: "brain", label: "Chat", tone: "amber", key: "⌘1", go: (how) => press("chat", how) },
    { icon: "history", label: "Sessions", tone: "blue", key: "⌘2", go: (how) => press("sessions", how) },
    { icon: "resolved", label: "Actions", tone: "amber", key: "⌘3", go: (how) => press("activity", how) },
    { icon: "files", label: "Files", tone: "teal", key: "⌘4", go: (how) => press("files", how) },
    { icon: "settings", label: "Settings", tone: "neutral", key: "⌘5", go: (how) => press("settings", how) },
  ];

  // The reason a socket-bound command cannot run right now, printed beside it
  // rather than hiding it. Sync and the briefing need a live connection and a
  // quiet turn.
  const why = !connected ? "needs the host" : isStreaming ? "a turn is running" : undefined;

  return {
    destinations,
    inChat,
    why,
    isStreaming,
    graph: () => setActiveView("graph"),
    search: inChat(() => runCommand("search")),
    add: inChat(() => runCommand("add")),
    briefing: inChat(() => runCommand("whatsup")),
    sync: inChat(() => runCommand("sync")),
    stats: inChat(() => runCommand("stats")),
  };
}
