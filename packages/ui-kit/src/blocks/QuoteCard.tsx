import type { CSSProperties } from "react";

import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { QuoteTone } from "../types.js";

/**
 * Verbatim evidence pulled out of the corpus, with its citation attached.
 *
 * The quote is the user's own words, or a source's, so it is never restyled as
 * model prose: a rail in the provenance colour, a real path and a real
 * locator. `note` is the agent's one-line reason for showing it.
 *
 * The tone set is provenance rather than severity — teal the corpus, amber
 * something of the user's own that matters, purple an outside source, blue a
 * counterparty, neutral unremarkable. There is no red, because a quote is not
 * a failure; whatever it proves is.
 */
export interface QuoteCardProps {
  quote?: string;
  source?: string;
  /** Line or section, so the reader can check it. */
  locator?: string;
  /** The agent's reason for surfacing this. */
  note?: string;
  tone?: QuoteTone;
  /** On by default. */
  italic?: boolean;
  /** Display serif instead of body sans. Off by default. */
  serif?: boolean;
  icon?: IconName;
}

const INKS: Record<QuoteTone, string> = {
  teal: accent.teal.ink,
  amber: accent.amber.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  neutral: accent.neutral.ink,
};

const TINTS: Record<QuoteTone, string> = {
  teal: token("quote-tint-teal"),
  amber: token("quote-tint-amber"),
  purple: token("quote-tint-purple"),
  blue: token("quote-tint-blue"),
  neutral: token("quote-tint-neutral"),
};

export function QuoteCard(p: QuoteCardProps) {
  const tone = p.tone || "teal";
  // `locator` and `note` carry a fallback AND a presence test in the source:
  // the component cannot be understood without them, but a caller may still
  // clear one by passing an empty string.
  const quote =
    p.quote ??
    "“Do not touch the cattle of Helios. Touch them, and you lose the ship and every man on it.”";
  const source = p.source ?? "knowledge/teiresias-forecast.md";
  const locator = p.locator ?? "line 12";
  const note =
    p.note ?? "The crew had sworn to this sentence, in writing, thirty days before they broke it.";
  const ink = INKS[tone] || INKS.teal;
  const tint = TINTS[tone] || TINTS.teal;

  const box: CSSProperties = {
    borderLeft: `3px solid ${ink}`,
    background: tint,
    borderRadius: "0 12px 12px 0",
    padding: "11px 13px",
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 9,
  };
  const quoteStyle: CSSProperties = {
    font: `400 13px/1.7 ${p.serif ? font.display : font.body}`,
    fontStyle: p.italic !== false ? "italic" : "normal",
    color: color.ink,
    // A quote is the record, so a URL or any other run with no break
    // opportunity wraps rather than escaping the card. `anywhere` rather than
    // `break-word` because it also shrinks the min-content width, which is
    // what keeps a flex parent from being pushed open by the same run.
    overflowWrap: "anywhere",
  };
  const sourceRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 7,
    font: `500 10.5px/1.3 ${font.mono}`,
    color: ink,
  };

  return (
    <div style={box}>
      <div style={quoteStyle}>{quote}</div>
      <div style={sourceRow}>
        <Icon icon={p.icon || "file"} size={12} color={ink} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {source}
        </span>
        {locator ? <span style={{ flex: "none", color: accent.neutral.ink }}>{locator}</span> : null}
      </div>
      {note ? (
        <div style={{ font: `400 11px/1.6 ${font.body}`, color: accent.neutral.ink, overflowWrap: "anywhere" }}>
          {note}
        </div>
      ) : null}
    </div>
  );
}
