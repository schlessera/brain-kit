import { useRef, useState } from "react";
import { Overlay, ListRow, TabBar, type TabItem } from "@schlessera/brain-ui-kit";
import { useUIStore } from "../../stores/ui-store.js";
import { useChatStore, activeChat, pendingApprovals } from "../../stores/chat-store.js";
import { useInboxStore, pendingDecisionCount } from "../../stores/inbox-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useChatCommands } from "../chat/use-chat-commands.js";

/**
 * The phone's bottom navigation, on the kit's `TabBar` (D52 §1): Chat ·
 * Sessions · Actions · Files · More. Sessions is a place, a list you go to
 * and choose from, so it takes a slot; Graph is used too rarely to keep one
 * and is a More row. New chat and Search are not slots: a tab is a place and
 * those are acts, so they are discs over occupied Chat and chips on the
 * empty one.
 *
 * Every slot replaces whatever panel is open, with no separate close step,
 * and pressing the slot that is already "here" never closes it (D52 §2, N1
 * and N3): it scrolls that destination to its start and moves focus, which
 * the mounted destination answers. On a phone, Chat keeps focus on its tab
 * unless a card is waiting, so the soft keyboard does not open (the N3
 * addendum). Sessions and Files are panels: they open over a view that
 * mounts them and land in Chat otherwise (`pressDestination`).
 *
 * More is the kit `BottomSheet`, docked over a scrim, holding Settings and
 * Graph, then the acts that have no control of their own at this width: Add
 * a note, the Daily briefing, Sync and Brain statistics. Each row prints its
 * effect at rest (`spends` on the briefing, `sync` on Sync) and keeps it when
 * the row cannot run, with the actual reason as its subtitle (D52 §2). The
 * sheet is a sibling of the bar rather than a child of the More slot,
 * because a kit tab is a leaf and cannot host it.
 */
export function MobileTabBar() {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const press = useUIStore((s) => s.pressDestination);
  const afterLeavingSettings = useUIStore((s) => s.afterLeavingSettings);
  const sessionPanelOpen = useUIStore((s) => s.sessionPanelOpen);
  const filePanelOpen = useUIStore((s) => s.filePanelOpen);
  const settingsPanelOpen = useUIStore((s) => s.settingsPanelOpen);
  // Open, non-FYI durable decisions (#684). Run notices have their own count
  // in the Actions list and no longer badge: a notice is a fact, not a question.
  const decisionCount = useInboxStore(pendingDecisionCount);
  const approvalCount = useChatStore((s) => pendingApprovals(s).length);
  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);
  const connected = useConnectionStore((s) => s.wsStatus === "connected");
  const runCommand = useChatCommands();
  const needsYou = decisionCount + approvalCount;

  const [moreOpen, setMoreOpen] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState(true);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const firstRow = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  /** The closing render owns focus; acts run once the background is live. */
  function closeMore(restore: boolean, next?: () => void) {
    setRestoreFocus(restore);
    afterClose.current = next;
    setMoreOpen(false);
  }
  function lastTab() {
    const tabs = barRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    return tabs?.[tabs.length - 1] ?? null;
  }
  function onAfterClose() {
    const next = afterClose.current;
    afterClose.current = undefined;
    next?.();
  }

  /**
   * An act from the sheet: close it, land on chat, run. The act waits for
   * the Settings leave guard, so a dirty Settings page that refuses to be
   * left is not answered with a job started behind it.
   */
  function act(fn: () => void) {
    return () => {
      closeMore(false, () => afterLeavingSettings(() => {
        setActiveView("chat");
        fn();
      }));
    };
  }
  /** A place from the sheet: close it and go there. */
  function go(fn: () => void) {
    return () => {
      closeMore(false, fn);
    };
  }

  const items: TabItem[] = [
    { icon: "brain", label: "Chat", onClick: () => press("chat") },
    { icon: "history", label: "Sessions", onClick: () => press("sessions") },
    {
      icon: "resolved",
      label: "Actions",
      badge: needsYou > 0 ? (needsYou > 9 ? "9+" : String(needsYou)) : undefined,
      onClick: () => press("activity"),
    },
    { icon: "files", label: "Files", onClick: () => press("files") },
    { icon: "more", label: "More", onClick: () => setMoreOpen((v) => !v) },
  ];
  // The amber slot: an open panel is "here" while it is open, then the view.
  // Settings and Graph are reached through More, so More is amber while
  // either one is shown.
  const active = moreOpen ? 4
    : sessionPanelOpen ? 1
    : filePanelOpen ? 3
    : settingsPanelOpen ? 4
    : activeView === "chat" ? 0
    : activeView === "activity" ? 2
    : 4;
  // Sync and the briefing need a live socket and a quiet turn; statistics
  // needs only a quiet turn, because it is answered over REST. The reason
  // printed is the one that applies: offline wins over a running turn.
  const hostWhy = !connected ? "needs the host" : isStreaming ? "a turn is running" : undefined;
  const statsWhy = isStreaming ? "a turn is running" : undefined;

  return (
    <>
    <nav
      aria-label="Primary"
      data-bk-keep-live=""
      className="tablet:hidden fixed bottom-0 inset-x-0 z-nav pb-[env(safe-area-inset-bottom)]"
      // The safe-area strip below the bar takes the bar's own ground, from the
      // kit's token so it follows the theme.
      style={{ background: "var(--bk-color-surface)" }}
    >
      <div ref={barRef}>
        <TabBar items={items} active={active} />
      </div>
    </nav>
      <Overlay open={moreOpen} variant="sheet" title="More" data-overlay-site="more" subtitle="Settings, and the things you run rather than visit."
        onClose={() => closeMore(true)} initialFocus={firstRow} returnFocus={restoreFocus ? lastTab : false} onAfterClose={onAfterClose}>
              {/* A title-only row is 42px in the kit; every row here is a
                  thumb target, so each is at least 44px. */}
              <div ref={node => { firstRow.current = node?.querySelector<HTMLElement>('[role="button"]') ?? null; }} className="flex flex-col [&>*]:min-h-11">
                <ListRow variant="group" icon="settings" iconTone="neutral" title="Settings" chevron onClick={go(() => press("settings"))} />
                <ListRow variant="group" icon="graph" iconTone="purple" title="Graph" chevron onClick={go(() => setActiveView("graph"))} />
                <ListRow variant="group" icon="add" iconTone="teal" title="Add a note" subtitle="Write it down in the brain" onClick={act(() => runCommand("add"))} />
                <ListRow variant="group" icon="sunrise" iconTone="gold" title="Daily briefing" subtitle={hostWhy ?? "What happened since you looked"} value="spends" valueTone="gold" onClick={hostWhy ? undefined : act(() => runCommand("whatsup"))} />
                <ListRow variant="group" icon="repeat" iconTone="amber" title="Sync the brain" subtitle={hostWhy ?? "Pull and push the repository"} value="sync" valueTone="amber" onClick={hostWhy ? undefined : act(() => runCommand("sync"))} />
                <ListRow variant="group" icon="ledger" iconTone="neutral" title="Brain statistics" subtitle={statsWhy ?? "Documents and software versions"} last onClick={statsWhy ? undefined : act(() => runCommand("stats"))} />
              </div>
      </Overlay>
    </>
  );
}
