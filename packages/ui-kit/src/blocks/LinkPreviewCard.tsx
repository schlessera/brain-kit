import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useId, useState } from "react";

import { classifyLink, refusalSentence } from "../links.js";
import { Icon } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";

/**
 * An external thing that arrived from outside the corpus — a shared article, a
 * fetched page, something relayed second-hand.
 *
 * The hatched thumb is a deliberate placeholder: Brain does not render remote
 * images inline. When the origin is untrusted the purple provenance line is
 * not optional, and passing `trust` also turns the card's own border purple —
 * so a monochrome screenshot still parses, which is the design's first
 * non-negotiable rule.
 *
 * Opening one is NAVIGATION, never an effect, which is why the whole card is
 * one target and carries no effect chip.
 *
 * **Interaction states landed in wave 1b**, which is the wave D17 named for
 * them. The design still ships none for this component, so the states are the
 * SYSTEM'S rather than this component's invention: `.bk-row`, not
 * `.bk-control`, because a preview card is a full-width block and a ring at
 * +2 would be clipped by the first `overflow: hidden` ancestor. Opening one is
 * navigation, so the whole card is a single `role="button"` with one accessible
 * name — its title, meta and provenance line, read as one thing, which is what
 * a card that is one target should sound like.
 *
 * Gated on the handler like everything else: no `onClick`, no class, no role,
 * no tab stop, no ring.
 *
 * ── Link mode: a destination the model chose (#43) ─────────────────────────
 *
 * Passing `url` switches the card to a different contract, because the thing
 * it draws is different: not something relayed into the corpus, but an
 * address a model picked, maybe after reading untrusted content, under a
 * title and a description it also wrote. The card then states WHERE THE LINK
 * GOES as a fact the kit derived, and WHAT IT IS SAID TO BE as the brain's
 * words, and nothing on it says or looks like it says that the page was
 * checked.
 *
 *   - The kit parses `url` itself with `classifyLink` (`../links.ts`). The
 *     host on screen and the anchor's `href` come out of that one parse, so no
 *     caller, not only the block renderer, can pass a host that disagrees with
 *     where the link goes. There is deliberately no `host` prop.
 *   - The host is the first line and is never ellipsised: it wraps only
 *     between labels (unless one label alone is wider than the card), so the
 *     right-hand labels, the part that decides the destination, stay on
 *     screen. The ASCII (`xn--`) form is the headline because it is what the
 *     browser resolves; the decoded form is a secondary "reads as" line.
 *   - Title and description render as text and wrap in full, followed by a
 *     purple provenance line on every card. `meta`, `trust`, `clamp`,
 *     `thumbSize` and `onClick` are ignored: there is no thumb, the
 *     provenance sentence is fixed, and the card body is not a target.
 *   - Two controls: a `Full address` disclosure (with `Copy` beside it when
 *     `onCopy` is passed) and `Open ↗`, a real anchor opening a new tab with no
 *     opener and no referrer. Clicking the host or the words navigates nowhere,
 *     so selecting text is safe.
 *   - A refused address draws a "Link withheld" card instead: the reason in
 *     one sentence, the model's claimed title, and what was sent behind a
 *     disclosure as plain, redacted text. No anchor, no Open, no Copy.
 *
 * Nothing is fetched: no favicon, no preview image, no title. The ruling on
 * #43 and `docs/decisions/design-kit.md` D48 record why.
 */
export interface LinkPreviewCardProps {
  /**
   * An address the model chose. Its presence switches the card to link mode
   * (see above); the kit derives everything it shows from it.
   */
  url?: string;
  /** Link mode: why the page is relevant, in the model's words. Plain text. */
  description?: string;
  /**
   * Link mode: whether the full address (or, on a withheld card, what was
   * sent) is revealed. A seed on its own; with `onExpandedChange` the parent
   * owns it, like `Disclosure` (D27).
   */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /**
   * Link mode: the embedder's clipboard write, handed the exact `href`. The
   * Copy control is drawn only when this is passed; the kit touches no
   * clipboard itself.
   */
  onCopy?: (href: string) => void;
  title?: string;
  /** Source, reading time, when it was staged. Mono. */
  meta?: string;
  /** The provenance line. Its PRESENCE is what makes the card purple. */
  trust?: string;
  /** Title on one line with an ellipsis. On by default. */
  clamp?: boolean;
  thumbSize?: number;
  onClick?: () => void;
}

export function LinkPreviewCard(p: LinkPreviewCardProps) {
  if (p.url !== undefined) return <LinkCard {...p} url={p.url} />;
  return <PreviewCard {...p} />;
}

function PreviewCard(p: LinkPreviewCardProps) {
  const act = Boolean(p.onClick);
  const size = Number(p.thumbSize) || 44;

  const box: CSSProperties = {
    border: `1px solid ${p.trust ? token("provenance-border") : color.edge}`,
    background: color.surface,
    borderRadius: 13,
    padding: 11,
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 9,
    cursor: act ? "pointer" : "default",
    // A card's rest ground is `surface`; hover is the design's one step up.
    ...({ "--hv-bg": act ? color.raised : color.surface } as CSSProperties),
  };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    p.onClick?.();
  }

  return (
    <div
      style={box}
      className={act ? "bk-row" : undefined}
      role={act ? "button" : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={p.onClick}
      onKeyDown={act ? onKeyDown : undefined}
    >
      <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
        <span
          style={{
            width: size,
            height: size,
            borderRadius: 9,
            flex: "none",
            background: `repeating-linear-gradient(135deg,${color.raised} 0 6px,${token("hatch-stripe")} 6px 12px)`,
          }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <b
            style={{
              display: "block",
              font: `600 12.5px/1.35 ${font.body}`,
              color: color.ink,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: p.clamp === false ? "normal" : "nowrap",
            }}
          >
            {p.title ?? "What the hall is saying about the succession"}
          </b>
          <span
            style={{
              display: "block",
              marginTop: 3,
              font: `400 10px/1.4 ${font.mono}`,
              color: accent.neutral.ink,
            }}
          >
            {p.meta ?? "relayed second-hand · 4 min · staged 01:40"}
          </span>
        </div>
      </div>
      {p.trust ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            paddingTop: 9,
            borderTop: `1px solid ${color.line}`,
            font: `500 9.5px/1.4 ${font.mono}`,
            color: accent.purple.ink,
          }}
        >
          <Icon icon="trust" size={12} color={accent.purple.ink} />
          {p.trust}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Link mode
// ---------------------------------------------------------------------------

/** The fixed provenance sentence: names what the brain wrote, and says the page was not opened. */
function attribution(title: string | undefined, description: string | undefined, checked: boolean): string {
  const words =
    title && description
      ? "Title and summary by the brain"
      : title
        ? "Title by the brain"
        : description
          ? "Summary by the brain"
          : "Link shown by the brain";
  return checked ? `${words} · page not opened or checked` : words;
}

/**
 * A host that wraps only between labels. Each label and its trailing dot is an
 * `inline-block`, which shrinks to its own width while it fits on a line and
 * so never breaks inside; only a label wider than the card itself wraps
 * within (`overflow-wrap: anywhere`), which keeps it inside the box instead of
 * ellipsising or overflowing it.
 */
function Host({ host, id }: { host: string; id?: string }) {
  const labels = host.split(".");
  return (
    <span
      id={id}
      data-link-host=""
      style={{
        display: "block",
        minWidth: 0,
        font: `600 13px/1.4 ${font.mono}`,
        color: color.ink,
        whiteSpace: "normal",
      }}
    >
      {labels.map((label, i) => (
        <span
          key={i}
          style={{ display: "inline-block", maxWidth: "100%", overflowWrap: "anywhere", verticalAlign: "top" }}
        >
          {i < labels.length - 1 ? `${label}.` : label}
        </span>
      ))}
    </span>
  );
}

const note: CSSProperties = {
  display: "block",
  font: `400 10.5px/1.45 ${font.mono}`,
  color: accent.neutral.ink,
  overflowWrap: "anywhere",
};

/** A text control: a native element, a 44px target (D34), the ghost button's skin. */
const control: CSSProperties = {
  boxSizing: "border-box",
  minHeight: 44,
  minWidth: 44,
  padding: "0 13px",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "none",
  boxShadow: `inset 0 0 0 1px ${color.edge}`,
  borderRadius: 9,
  background: "transparent",
  color: color.inkDim,
  font: `500 11.5px/1 ${font.mono}`,
  textDecoration: "none",
  cursor: "pointer",
  ...({
    "--hv-bg": token("button-hover-bg-ghost"),
    "--hv-bd": token("button-hover-border-ghost"),
    "--hv-fg": token("button-hover-fg-ghost"),
  } as CSSProperties),
};

function Provenance({ children }: { children: ReactNode }) {
  return (
    <div
      data-link-attribution=""
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 7,
        paddingTop: 9,
        borderTop: `1px solid ${color.line}`,
        font: `500 9.5px/1.4 ${font.mono}`,
        color: accent.purple.ink,
      }}
    >
      <Icon icon="trust" size={12} color={accent.purple.ink} />
      <span>{children}</span>
    </div>
  );
}

function LinkCard(p: LinkPreviewCardProps & { url: string }) {
  const verdict = classifyLink(p.url);
  const controlled = p.expanded !== undefined && p.onExpandedChange !== undefined;
  const [internal, setInternal] = useState(p.expanded === true);
  const expanded = controlled ? p.expanded === true : internal;
  const [copied, setCopied] = useState(false);
  const ids = useId();
  const hostId = `${ids}-host`;
  const panelId = `${ids}-panel`;
  const wordsId = `${ids}-words`;
  const reasonId = `${ids}-reason`;

  function toggle() {
    const next = !expanded;
    if (!controlled) setInternal(next);
    p.onExpandedChange?.(next);
  }

  const title = p.title || undefined;
  const description = p.description || undefined;

  const box: CSSProperties = {
    border: `1px solid ${verdict.ok ? token("provenance-border") : color.edge}`,
    background: color.surface,
    borderRadius: 13,
    padding: 11,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 9,
  };

  const titleStyle: CSSProperties = {
    display: "block",
    font: `600 12.5px/1.35 ${font.body}`,
    color: color.ink,
    overflowWrap: "anywhere",
  };
  const descriptionStyle: CSSProperties = {
    display: "block",
    marginTop: 3,
    font: `400 11.5px/1.45 ${font.body}`,
    color: color.inkDim,
    overflowWrap: "anywhere",
  };

  if (!verdict.ok) {
    return (
      <section aria-label="Link withheld" aria-describedby={reasonId} data-link-card="withheld" style={box}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            font: `600 11px/1.4 ${font.mono}`,
            color: accent.neutral.ink,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          <Icon icon="trust" size={12} color={accent.neutral.ink} />
          Link withheld
        </div>
        <span id={reasonId} style={{ ...note, font: `400 11.5px/1.45 ${font.body}`, color: color.inkDim }}>
          {refusalSentence(verdict)}
        </span>
        {title || description ? (
          <>
            <div>
              {title ? <b style={titleStyle}>{title}</b> : null}
              {description ? <span style={descriptionStyle}>{description}</span> : null}
            </div>
            <Provenance>{attribution(title, description, false)}</Provenance>
          </>
        ) : null}
        <div>
          <button
            type="button"
            className="bk-control"
            style={control}
            aria-expanded={expanded}
            aria-controls={expanded ? panelId : undefined}
            onClick={toggle}
          >
            Show what was sent
            <Icon icon={expanded ? "collapse" : "next"} size={12} color={color.inkDim} />
          </button>
          {expanded ? (
            <div
              id={panelId}
              data-link-sent=""
              style={{ ...note, marginTop: 8, userSelect: "text", whiteSpace: "pre-wrap" }}
            >
              {verdict.shown}
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  const notes: string[] = [];
  if (verdict.hostUnicode) notes.push(`reads as ${verdict.hostUnicode}`);
  if (verdict.ip) notes.push("IP address · no name");
  if (verdict.insecure) notes.push("not encrypted (http)");

  // The host substring of the full address, drawn heavier so the eye finds it.
  const hostAt = verdict.href.indexOf(verdict.host);

  return (
    <section aria-label={`Link to ${verdict.host}`} data-link-card="destination" style={box}>
      <div style={{ display: "flex", gap: 7, alignItems: "flex-start", minWidth: 0 }}>
        <span style={{ flex: "none", paddingTop: 3 }}>
          <Icon icon="link" size={13} color={color.inkDim} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Host host={verdict.host} id={hostId} />
          {notes.map((text) => (
            <span key={text} data-link-note="" style={note}>
              {text}
            </span>
          ))}
          {verdict.path ? (
            <span
              data-link-path=""
              style={{ ...note, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {verdict.path}
            </span>
          ) : null}
        </div>
      </div>
      <div id={wordsId}>
        {title ? <b style={titleStyle}>{title}</b> : null}
        {description ? (
          <span style={title ? descriptionStyle : { ...descriptionStyle, marginTop: 0 }}>{description}</span>
        ) : null}
        {/* The host alone carries a card the brain wrote no words for. */}
        {title || description ? null : (
          <span style={{ ...descriptionStyle, marginTop: 0 }}>No description given</span>
        )}
        <Provenance>{attribution(title, description, true)}</Provenance>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
        <button
          type="button"
          className="bk-control"
          style={control}
          aria-expanded={expanded}
          aria-controls={expanded ? panelId : undefined}
          onClick={toggle}
        >
          Full address
          <Icon icon={expanded ? "collapse" : "next"} size={12} color={color.inkDim} />
        </button>
        {expanded && p.onCopy ? (
          <button
            type="button"
            className="bk-control"
            style={control}
            onClick={() => {
              p.onCopy?.(verdict.href);
              setCopied(true);
            }}
          >
            <Icon icon="copy" size={12} color={color.inkDim} />
            Copy
          </button>
        ) : null}
        <a
          className="bk-control"
          style={{ ...control, marginLeft: "auto" }}
          href={verdict.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          referrerPolicy="no-referrer"
          aria-label={`Open ${verdict.host} in a new tab`}
          aria-describedby={wordsId}
        >
          Open <span aria-hidden="true">↗</span>
        </a>
      </div>
      {expanded ? (
        <div
          id={panelId}
          role="region"
          aria-label="Full address"
          tabIndex={0}
          data-link-full=""
          style={{
            ...note,
            color: color.inkDim,
            padding: "8px 10px",
            borderRadius: 9,
            boxShadow: `inset 0 0 0 1px ${color.line}`,
            maxHeight: "calc(10 * 1.45em + 16px)",
            overflowY: "auto",
            userSelect: "text",
          }}
        >
          {hostAt === -1 ? (
            verdict.href
          ) : (
            <>
              {verdict.href.slice(0, hostAt)}
              <b style={{ fontWeight: 600, color: color.ink }}>{verdict.host}</b>
              {verdict.href.slice(hostAt + verdict.host.length)}
            </>
          )}
        </div>
      ) : null}
      {/* Always mounted, so the announcement lands in a live region that
          already existed when its text changed. */}
      <span aria-live="polite" data-link-copied="" style={copied ? note : { display: "block", height: 0, overflow: "hidden" }}>
        {copied ? "Address copied" : ""}
      </span>
    </section>
  );
}
