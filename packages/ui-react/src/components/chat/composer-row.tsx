import { ComposerRow, PendingFollowUps, type PendingFollowUp } from "@schlessera/brain-ui-kit";
import { useChatStore } from "../../stores/chat-store.js";
import { useFollowUpStore, type PendingFollowUp as StoredFollowUp } from "../../stores/follow-up-store.js";
import { useSoftKeyboard } from "../../hooks/use-soft-keyboard.js";

const NONE: readonly StoredFollowUp[] = [];

/** What a message with no words carries, so its pill and popover still say something. */
function carried(f: StoredFollowUp): string {
  const parts = [
    f.attachmentCount ? `${f.attachmentCount} ${f.attachmentCount === 1 ? "image" : "images"}` : "",
    f.fileCount ? `${f.fileCount} ${f.fileCount === 1 ? "file" : "files"}` : "",
  ].filter(Boolean);
  return parts.join(", ");
}

/**
 * The kit's view of one stored follow-up. Until #1004 supplies a few-word
 * label, the kit prints the start of the text.
 */
export function pendingView(f: StoredFollowUp): PendingFollowUp {
  return { id: f.id, text: f.text.trim() ? f.text : carried(f) || f.text };
}

/**
 * The shared row between the transcript and the composer (D52 §3). This
 * fills its right half: the open session's follow-ups that the agent has not
 * received yet (#1002). The left half, working sessions, is #950's; the kit
 * row keeps the right half in its column when the left is empty, which is
 * also the ≥1280 arrangement, where the trackers live in the Sessions pane.
 *
 * With the soft keyboard up the half collapses to one summary, and once the
 * composer passes three lines the row hides first (R4), so the transcript
 * keeps its height; the summary returns as the composer shrinks.
 */
export function ChatComposerRow() {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const pending = useFollowUpStore((s) => (sessionId ? s.pending[sessionId] : undefined)) ?? NONE;
  const announcement = useFollowUpStore((s) => s.announcement);
  const keyboard = useSoftKeyboard();
  const hidden = keyboard.open && keyboard.composerLines > 3;
  const followUps = hidden ? [] : pending.map(pendingView);
  const mine = announcement && announcement.sessionId === sessionId ? announcement : null;
  return (
    <div className="px-4 md:px-6">
      <ComposerRow
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
