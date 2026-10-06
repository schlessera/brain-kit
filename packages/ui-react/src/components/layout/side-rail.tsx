import { SideRail as KitSideRail, type RailAct, type RailItem } from "@schlessera/brain-ui-kit";
import { useEffect } from "react";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useInboxStore, pendingDecisionCount } from "../../stores/inbox-store.js";
import { useChatStore, pendingApprovals } from "../../stores/chat-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";
import { useDesktopRoutes } from "./desktop-routes.js";

/**
 * The desktop navigation, on the kit's `SideRail`. The kit owns the rail —
 * the roving tab stops, the amber destination, the badge, the collapsed and
 * expanded widths; this file owns which destination is "here", the ⌘1–⌘5
 * keys the design prints beside them (D36: anything global takes a
 * modifier) and which acts sit under them. What each one DOES comes from
 * `useDesktopRoutes`, which the palette shares.
 *
 * The five destinations are D52's: Chat · Sessions · Actions · Files ·
 * Settings, on ⌘1–⌘5. Graph is no longer a destination: it is reached
 * through All commands and has no key. Activity is not among them — "what
 * needs me" and "what has been happening" are two lenses on one queue, so
 * the Actions pane carries a filter and the badge counts what needs you:
 * live approvals plus open durable decisions.
 *
 * Under them sit the acts (D52 §1): Search, Add a note and the Daily
 * briefing, printing `spends`. Collapsed, the kit draws only the two that
 * need no words, and the briefing is reached through All commands. The
 * footer is the `All commands` button, which opens this root's palette.
 *
 * Widths follow D22's ladder: the phone bar to 479px, this rail collapsed
 * to 60px from 480 (`tablet:`), expanded to 208px from 900 (`laptop:`). The
 * rail appears at the breakpoint the phone bar disappears at, so the two
 * never show together. Width is not a keyboard, though: a tablet in
 * landscape crosses `tablet:` with nothing to press ⌘ on, so the caps are
 * printed only while a fine pointer is present (#86). The bindings below
 * stay registered either way — a paired keyboard fires them even if the
 * query stays coarse. All commands prints ⌘K at every width and on every
 * pointer, which is the kit's (D36 addendum).
 *
 * The connection status takes the wordmark's line: teal while live, amber
 * while reconnecting, red when the socket is gone. No spend meter — the app
 * tracks no spend.
 */
export function SideRail() {
  const wsStatus = useConnectionStore((s) => s.wsStatus);
  const activeView = useUIStore((s) => s.activeView);
  const filePanelOpen = useUIStore((s) => s.filePanelOpen);
  const settingsPanelOpen = useUIStore((s) => s.settingsPanelOpen);
  const sessionPanelOpen = useUIStore((s) => s.sessionPanelOpen);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  // Open, non-FYI durable decisions (#684). Run notices have their own count
  // in the Actions list and no longer badge: a notice is a fact, not a question.
  const decisionCount = useInboxStore(pendingDecisionCount);
  const approvalCount = useChatStore((s) => pendingApprovals(s).length);
  const needsYou = decisionCount + approvalCount;
  const expanded = useMediaQuery("(min-width: 900px)");
  const finePointer = useFinePointer();
  const routes = useDesktopRoutes();

  const items: RailItem[] = routes.destinations.map((d) => ({
    icon: d.icon,
    label: d.label,
    shortcut: finePointer ? d.key : undefined,
    badge: d.label === "Actions" && needsYou > 0 ? (needsYou > 9 ? "9+" : String(needsYou)) : undefined,
    onClick: () => d.go(),
  }));

  // The palette's own routes, so availability and cost cannot drift: Search
  // and Add are REST and always run; the briefing spends and says why not.
  const acts: RailAct[] = [
    { icon: "search", label: "Search", name: "Search the brain", onClick: routes.search },
    { icon: "add", label: "Add a note", onClick: routes.add },
    { icon: "sunrise", label: "Daily briefing", cost: "spends", why: routes.why, onClick: routes.briefing },
  ];

  // A panel over the view is "here" while it is open; otherwise the view is.
  // Graph is no destination, so while it shows no row is amber.
  const active = sessionPanelOpen ? 1 : filePanelOpen ? 3 : settingsPanelOpen ? 4
    : activeView === "chat" ? 0 : activeView === "activity" ? 2 : -1;

  useEffect(() => {
    if (typeof window === "undefined") return;
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > items.length) return;
      e.preventDefault();
      routes.destinations[n - 1]!.go({ keyboard: true });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <nav aria-label="Primary" className="hidden tablet:flex shrink-0">
      <KitSideRail
        items={items}
        acts={acts}
        active={active}
        expanded={expanded}
        status={wsStatus === "connected" ? "live" : wsStatus === "connecting" ? "reconnecting" : "offline"}
        statusTone={wsStatus === "connected" ? "teal" : wsStatus === "connecting" ? "amber" : "red"}
        spendPct={null}
        onOpenPalette={() => setPaletteOpen(true)}
      />
    </nav>
  );
}
