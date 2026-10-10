import type { CSSProperties } from "react";
import { useId } from "react";
import { Icon, color, font } from "@schlessera/brain-ui-kit";

import { useBrainUiRoot } from "../../root-context.js";
import type { ChatMessage } from "../../stores/chat-state.js";
import { activeChat, useChatStore } from "../../stores/chat-store.js";
import { useVoiceStore } from "../../voice/voice-store.js";
import {
  DEFAULT_SUGGESTIONS_LABEL,
  suggestionsOf,
  visibleSuggestions,
  type SuggestionsItem,
} from "../../lib/answer-suggestions.js";
import { kitIcon } from "./tool-cards/block-card.js";

/**
 * The answer's closing row: the follow-ups the model offered, as chips the
 * reader can take into the composer (#40, D50). A chip never sends — it puts
 * its words in the composer below the reader's draft, where they can be
 * edited or left unsent.
 *
 * Mounted for the session's last message only, so the stores it reads for
 * the suppression rules never re-render the rest of the transcript. Whether
 * it draws anything is `visibleSuggestions`, the one decision the live and
 * the replayed transcript share.
 *
 * Drawn here rather than by the kit's `SuggestionChips`: the welcome chips
 * stay exactly as they are, and these need a real button, a 44px target and
 * text that wraps instead of ellipsising, because the chip IS the prompt.
 */
export function AnswerSuggestions({ message }: { message: ChatMessage }) {
  const root = useBrainUiRoot();
  const describedBy = useId();
  const messages = useChatStore((s) => activeChat(s).messages);
  const running = useChatStore((s) => {
    const chat = activeChat(s);
    const runState = s.activeSessionId ? s.runStates[s.activeSessionId] : undefined;
    return chat.isStreaming || (runState !== undefined && runState !== "idle");
  });
  const voiceMode = useVoiceStore((s) => s.mode);
  const voiceReviewPending = useVoiceStore((s) => s.reviewText.trim().length > 0);

  const items = visibleSuggestions(message, { messages, running, voiceMode, voiceReviewPending });
  if (items.length === 0) return null;
  return (
    <AnswerSuggestionsView
      label={suggestionsOf(message)?.label ?? DEFAULT_SUGGESTIONS_LABEL}
      items={items}
      describedBy={describedBy}
      onTake={(text) => root.stores.chat.getState().requestComposerInsert(text)}
    />
  );
}

/**
 * The row itself, with no store behind it: what the decision above chose,
 * drawn. Its layout is inline rather than utility classes so the same markup
 * measures the same in a bare browser page, where the hit-target test runs.
 */
export function AnswerSuggestionsView({
  label,
  items,
  describedBy,
  onTake,
}: {
  label: string;
  items: ReadonlyArray<SuggestionsItem>;
  describedBy: string;
  onTake: (text: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Suggested follow-ups"
      data-answer-suggestions=""
      className="answer-suggestions"
      style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4 }}
    >
      <div
        aria-hidden="true"
        style={{
          font: `600 9.5px/1 ${font.mono}`,
          letterSpacing: ".09em",
          textTransform: "uppercase",
          color: "var(--bk-neutral-ink)",
        }}
      >
        {label}
      </div>
      <span id={describedBy} style={VISUALLY_HIDDEN}>
        Puts this in the composer to edit. Does not send.
      </span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: CHIP_GAP }}>
        {items.map((item) => {
          const icon = kitIcon(item.icon);
          return (
            <button
              // raw-button: kit — native wrapping answer chip with a 44px target; SuggestionChips cannot draw it
              key={item.label}
              type="button"
              className="answer-chip bk-control"
              aria-describedby={describedBy}
              // Past half a phone row a chip takes the row: two half-width
              // chips side by side would each wrap into a tall, narrow box.
              data-long={item.label.length > 40 ? "" : undefined}
              style={CHIP}
              onClick={() => onTake(item.label)}
            >
              {icon ? <Icon icon={icon} size={12} color={color.inkDim} /> : null}
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Both axes: D34 caps a target's reach per side at half the distance to the
 * nearest interactive neighbour, and each chip reaches 8px (theme.css).
 */
export const CHIP_GAP = 16;

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * The kit's untoned chip — dim ink, no fill, the card edge — with the edge as
 * an inset shadow so the target reaches from the paint (D34). Text wraps; the
 * schema's 80-character cap is what keeps it to two lines at 320px.
 */
const CHIP: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  maxWidth: "100%",
  minWidth: 0,
  border: 0,
  borderRadius: 999,
  background: "transparent",
  boxShadow: `inset 0 0 0 1px ${color.edge}`,
  padding: "7px 12px",
  font: `500 11.5px/1.3 ${font.body}`,
  color: color.inkDim,
  textAlign: "left",
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  cursor: "pointer",
  ...({
    "--hv-bg": "var(--bk-hover-veil-strong)",
    "--hv-bd": "var(--bk-hover-border)",
    "--hv-fg": color.inkDim,
  } as CSSProperties),
};
