import { useLayoutEffect, useRef, useState } from "react";
import { shownLabels, type GmailLabel } from "./shared.js";

/**
 * `GmailLabels` — a thread's or message's labels (#4209, ruling G5).
 *
 * - System labels are words ("Inbox", "Promotions"), never raw ids, and come
 *   first; the owner's labels follow in the payload's order.
 * - UNREAD and STARRED are not labels here: the row says them as flags.
 * - Every label is the same neutral chip. The payload carries no Gmail
 *   colour, and a colour could not carry the meaning anyway.
 * - Three chips, then "+N", which expands the list in place and moves focus
 *   to the first label it revealed.
 *
 * The owner's label names arrive escaped by the host (ruling 5 of #4207):
 * structured, not untrusted, so a hidden character in one already reads as a
 * visible `\u{…}` escape. A user label whose name the host withheld shows its
 * id in mono, which is what the payload carries.
 *
 * `static` draws the same chips as phrasing content with "+N" as a count, for
 * a row that is itself a button: a button may hold neither a list nor
 * another control. Opening that row shows every label.
 */
export interface GmailLabelsProps {
  labels: readonly GmailLabel[];
  /** Chips before "+N". Defaults to 3. */
  limit?: number;
  /** No list and no "+N" control: the overflow is a count, for a row that is a button. */
  static?: boolean;
}

const noun = (n: number) => (n === 1 ? "label" : "labels");

export function GmailLabels(p: GmailLabelsProps) {
  const labels = shownLabels(p.labels);
  const limit = p.limit ?? 3;
  const [all, setAll] = useState(false);
  const focusNext = useRef(false);
  const firstRevealed = useRef<HTMLLIElement | null>(null);

  useLayoutEffect(() => {
    if (!all || !focusNext.current) return;
    focusNext.current = false;
    const el = firstRevealed.current;
    if (!el) return;
    el.tabIndex = -1;
    el.focus();
  }, [all]);

  if (labels.length === 0) return null;
  const shown = all || labels.length <= limit ? labels : labels.slice(0, limit);
  const hidden = labels.length - shown.length;

  if (p.static) {
    return (
      <span className="bk-gm-labels" data-gmail-labels="static">
        <span className="bk-sr-only">{`${labels.length === 1 ? "Label" : "Labels"}: `}</span>
        {shown.map((label) => (
          <span key={label.id} className="bk-gm-label" data-gmail-label={label.id} data-id-only={label.idOnly ? "" : undefined}>
            <bdi>{label.text}</bdi>
          </span>
        ))}
        {hidden > 0 ? (
          <span className="bk-gm-label-count">
            <span aria-hidden="true">+{hidden}</span>
            <span className="bk-sr-only">{`and ${hidden} more ${noun(hidden)}`}</span>
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <ul className="bk-gm-labels" aria-label={labels.length === 1 ? "Label" : "Labels"} data-gmail-labels="">
      {shown.map((label, i) => (
        <li
          key={label.id}
          ref={i === limit ? (el) => void (firstRevealed.current = el) : undefined}
          className="bk-gm-label"
          data-gmail-label={label.id}
          data-id-only={label.idOnly ? "" : undefined}
        >
          <bdi>{label.text}</bdi>
        </li>
      ))}
      {hidden > 0 ? (
        <li className="bk-gm-label-more">
          <button
            type="button"
            className="bk-text-btn"
            data-tone="meta"
            data-inline="true"
            aria-label={`Show ${hidden} more ${noun(hidden)}`}
            onClick={() => {
              focusNext.current = true;
              setAll(true);
            }}
          >
            +{hidden}
          </button>
        </li>
      ) : null}
    </ul>
  );
}
