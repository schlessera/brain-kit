import { useEffect, useRef } from "react";
import { useRootStore } from "../../root-context.js";
import { useUIStore } from "../../stores/ui-store.js";
import { SessionList } from "./session-list.js";
import { useSessionListProps } from "./session-drawer.js";
import { focusFirst, scrollToStart } from "../../lib/destination-start.js";

/**
 * Sessions at ≥1280 (D52 §1, §8): a 280px pane beside the transcript in
 * Chat, where the drawer is below 1280. Working pins the trackers above the
 * date groups, and the pills above the composer are not drawn at this
 * width. `New conversation` is the pane's one primary action; there is no
 * New chat disc and no rail row. In an empty chat it is `aria-disabled`,
 * printing `already a new chat`.
 *
 * Sessions is not a destination of its own here: pressing it (rail, ⌘2,
 * the palette) lands in Chat, which stays the amber destination, and moves
 * focus into the pane at the selected row (D52 §2's 1280 row; the N3
 * addendum keeps that row). The press arrives as `sessionsPaneFocus`, so a
 * press from Actions, Files or Settings is answered when Chat has mounted.
 *
 * Tab order is rail → pane → transcript → composer: the pane comes first
 * in Chat's DOM. It is two tab stops, `New conversation` and the list.
 */
export function SessionsPane({ empty, onResume, onOpenTracker }: {
  /** The chat in view has no messages: New conversation has nothing to leave. */
  empty: boolean;
  onResume: (sessionId: string) => void;
  onOpenTracker: (sessionId: string) => void;
}) {
  const props = useSessionListProps({ visible: true, onResume, onOpenTracker });
  const paneRef = useRef<HTMLElement>(null);
  const request = useUIStore((s) => s.sessionsPaneFocus);
  const take = useUIStore((s) => s.takeSessionsPaneFocus);
  // Redrawn when a list arrives, so a waiting request can be answered.
  const answered = useRootStore("sessions", (s) => !s.loading && (s.loaded || s.warning !== null));

  useEffect(() => {
    const pane = paneRef.current;
    if (!request || !pane) return;
    // Wait for rows while the list has not arrived yet, so focus lands on
    // the selected row rather than on New conversation.
    const rows = pane.querySelector('[data-session-item] [role="button"]');
    if (!rows && !answered) return;
    take();
    scrollToStart(pane);
    const row = (sel: string) => pane.querySelector<HTMLElement>(sel);
    focusFirst([
      row('[data-session-item] [role="button"][aria-current="true"]'),
      row('[data-working-row] [role="button"]'),
      row('[data-session-item] [role="button"]'),
      row("[data-new-conversation] [data-bk-button]"),
    ], request.keyboard);
  });

  return (
    <section
      ref={paneRef}
      aria-label="Sessions"
      data-sessions-pane=""
      className="flex w-[280px] shrink-0 flex-col overflow-hidden border-r border-border bg-surface"
    >
      <SessionList {...props} newWhy={empty ? "already a new chat" : undefined} />
    </section>
  );
}
