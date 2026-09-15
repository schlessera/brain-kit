import type { CSSProperties, ReactNode } from "react";

import { Icon, type IconName } from "../primitives/Icon.js";
import { color, font } from "../tokens.js";
import type { MessageRole } from "../types.js";

/**
 * A turn in the transcript, and the two roles are not two styles of the same
 * thing.
 *
 * `user` is a tucked bubble, right-aligned, with one corner cut so it points
 * back at the person who typed it. `brain` has **no bubble at all** — the answer
 * is the page. What wraps it instead is provenance: a collapsed tool trace above
 * ("4 steps · 3 files touched · 2.1s") and the response actions below.
 *
 * That asymmetry is the design's argument, not a shortcut. A bubble says "a
 * message"; an answer that fills the column says "this is the document you
 * asked for", and the trace line above it is what makes the claim checkable.
 *
 * `children` is how the in-chat blocks land inside a turn — a `StepList`, a
 * `MapView`, a `ComparisonTable`. They render inside the bubble for a user turn
 * and inside the prose for a brain turn, which is the same slot either way.
 */
export interface MessageBubbleProps {
  role?: MessageRole;
  text?: string;
  /** The collapsed tool trace. `brain` turns only; a user turn has none. */
  trace?: string;
  /** The copy/share/upvote/retry row. `brain` turns only, on by default. */
  actions?: boolean;
  children?: ReactNode;
}

const TOOL_ICONS: IconName[] = ["copy", "share", "up", "retry"];

/** The source's fallback quotes a plausible real person. Replaced per D19 with
 * the Odyssey's own question, which the fixtures ask on the search screen. */
const TEXT = "What did I promise Penelope about the loom?";

export function MessageBubble(p: MessageBubbleProps) {
  const user = (p.role || "user") === "user";
  const text = p.text ?? TEXT;
  const trace = user ? null : p.trace;
  const showTools = !user && p.actions !== false;

  const bubble: CSSProperties = user
    ? {
        maxWidth: "82%",
        background: color.raised,
        border: `1px solid ${color.edge}`,
        borderRadius: "16px 16px 5px 16px",
        padding: "10px 13px",
        font: `400 13.5px/1.55 ${font.body}`,
      }
    : { font: `400 13.5px/1.7 ${font.body}`, color: color.ink };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: user ? "flex-end" : "stretch",
        width: "100%",
      }}
    >
      {trace ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            font: `500 11px/1 ${font.mono}`,
            color: color.inkMute,
          }}
        >
          <Icon icon="steps" size={13} />
          {trace}
          <Icon icon="next" size={12} />
        </div>
      ) : null}
      <div style={bubble}>
        {text}
        {p.children ?? null}
      </div>
      {showTools ? (
        <div style={{ display: "flex", gap: 14, paddingTop: 2, color: color.inkMute }}>
          {TOOL_ICONS.map((icon) => (
            <Icon key={icon} icon={icon} size={15} color={color.inkMute} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
