import type { IconName, PaletteItem } from "@schlessera/brain-ui-kit";
import { useUIStore } from "../../stores/ui-store.js";
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
  go: () => void;
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
 * The acts land in Chat first, as the palette always has, and keep their
 * dispatch in `useChatCommands`. Search and Add talk to the CLI over REST, so
 * they have no reason to be unavailable; the briefing needs a live socket and
 * a quiet turn, and spends.
 */
export function useDesktopRoutes() {
  const setActiveView = useUIStore((s) => s.setActiveView);
  const toggleFilePanel = useUIStore((s) => s.toggleFilePanel);
  const toggleSettingsPanel = useUIStore((s) => s.toggleSettingsPanel);
  const setSessionPanelOpen = useUIStore((s) => s.setSessionPanelOpen);
  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const runCommand = useChatCommands();

  function inChat(fn: () => void) {
    return () => {
      setActiveView("chat");
      fn();
    };
  }

  const destinations: DesktopDestination[] = [
    { icon: "brain", label: "Chat", tone: "amber", key: "⌘1", go: () => setActiveView("chat") },
    { icon: "history", label: "Sessions", tone: "blue", key: "⌘2", go: inChat(() => setSessionPanelOpen(true)) },
    { icon: "resolved", label: "Actions", tone: "amber", key: "⌘3", go: () => setActiveView("activity") },
    { icon: "files", label: "Files", tone: "teal", key: "⌘4", go: toggleFilePanel },
    { icon: "settings", label: "Settings", tone: "neutral", key: "⌘5", go: toggleSettingsPanel },
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
