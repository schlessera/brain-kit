import { ComposerRow, PendingFollowUps, SessionStrip, type PendingFollowUp, type WorkingSession } from "@schlessera/brain-ui-kit";
import { useMemo } from "react";
import { useChatStore } from "../../stores/chat-store.js";
import { useFollowUpStore, type PendingFollowUp as StoredFollowUp } from "../../stores/follow-up-store.js";
import { useSoftKeyboard } from "../../hooks/use-soft-keyboard.js";
import { useNow } from "../../hooks/use-now.js";
import { useWorkingSessions } from "../../hooks/use-working-sessions.js";

const NONE: readonly StoredFollowUp[] = [];

/** How often the pills' ages (`running · 2m`) are redrawn. Nothing is announced by it. */
const AGE_TICK_MS = 30_000;

/** What a message with no words carries, so its pill and popover still say something. */
function carried(f: StoredFollowUp): string {
  const parts = [
    f.attachmentCount ? `${f.attachmentCount} ${f.attachmentCount === 1 ? "image" : "images"}` : "",
    f.fileCount ? `${f.fileCount} ${f.fileCount === 1 ? "file" : "files"}` : "",
  ].filter(Boolean);
  return parts.join(", ");
}

/**
 * The kit's view of one stored follow-up. The host's few-word label (#1004)
 * is passed through when it has one; without it the kit prints the start of
 * the text.
 */
export function pendingView(f: StoredFollowUp): PendingFollowUp {
  return {
    id: f.id,
    text: f.text.trim() ? f.text : carried(f) || f.text,
    ...(f.label?.trim() ? { label: f.label } : {}),
  };
}

/**
 * The shared row between the transcript and the composer (D52 §3).
 *
 * The left half is working sessions (#950): the root's trackers (#948) in
 * D52 §4's order, as the kit's `SessionStrip`. Activating one opens its
 * session through `onOpenTracker`, which reattaches it and moves focus as
 * §4 rules. At ≥1280 (`wide`) the trackers live in the Sessions pane, so
 * the left half is empty and keeps its column.
 *
 * The right half is the open session's follow-ups that the agent has not
 * received yet (#1002).
 *
 * With the soft keyboard up each half collapses to one summary, and once the
 * composer passes three lines the row hides first (R4), so the transcript
 * keeps its height; the summaries return as the composer shrinks.
 */
export function ChatComposerRow({ wide = false, onOpenTracker }: {
  wide?: boolean;
  onOpenTracker?: (sessionId: string) => void;
}) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const pending = useFollowUpStore((s) => (sessionId ? s.pending[sessionId] : undefined)) ?? NONE;
  const announcement = useFollowUpStore((s) => s.announcement);
  const keyboard = useSoftKeyboard();
  const tracked = useWorkingSessions();
  const now = useNow(AGE_TICK_MS);
  const hidden = keyboard.open && keyboard.composerLines > 3;
  const followUps = hidden ? [] : pending.map(pendingView);
  const mine = announcement && announcement.sessionId === sessionId ? announcement : null;
  const working: WorkingSession[] = useMemo(
    () => (hidden || wide || !onOpenTracker ? [] : tracked.shown.map((s) => ({ ...s, onOpen: () => onOpenTracker(s.id) }))),
    [hidden, wide, tracked, onOpenTracker],
  );
  return (
    <div className="px-4 md:px-6">
      <ComposerRow
        left={<SessionStrip sessions={working} now={now} keyboardOpen={keyboard.open} />}
        right={
          <PendingFollowUps
            followUps={followUps}
            keyboardOpen={keyboard.open}
            announcement={mine?.text}
            announcementKey={mine?.seq}
          />
        }
      />
    </div>
  );
}
