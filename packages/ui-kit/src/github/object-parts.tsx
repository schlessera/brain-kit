import { useState, type ReactNode } from "react";
import { UntrustedText } from "../evidence/UntrustedText.js";
import { Chip } from "../primitives/Chip.js";
import { color, font } from "../tokens.js";
import { GitHubRef } from "./GitHubRef.js";
import { GitHubStateChip } from "./GitHubStateChip.js";
import { Field, GitHubLink, githubHref, type GitHubState } from "./shared.js";

/** Internal pieces shared by `GitHubPullRequest` and `GitHubIssue`. */

/** A read or posted body's hard bound, from the design's truncation table. */
export const BODY_MAX_CHARS = 20_000;

/** "1,840": a count in the reader-facing format, the same in every locale the kit renders in. */
export function count(n: number): string {
  return n.toLocaleString("en-US");
}

export function Header(p: { state: GitHubState; kind: "pr" | "issue"; repo: string; number?: number | null; htmlUrl?: string | null; title: string; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 8px", minWidth: 0 }}>
        <GitHubStateChip state={p.state} kind={p.kind} />
        <GitHubRef kind={p.kind} repo={p.repo} number={p.number} htmlUrl={p.htmlUrl} />
      </div>
      <h3 style={{ margin: 0, font: `650 15px/1.35 ${font.body}`, color: color.ink, overflowWrap: "anywhere" }}>
        <Field>{p.title}</Field>
      </h3>
      {p.children}
    </div>
  );
}

/** The design's bound on one label: 50 characters, then an ellipsis. */
const LABEL_MAX = 50;
function boundLabel(label: string): string {
  const chars = Array.from(label);
  return chars.length > LABEL_MAX ? `${chars.slice(0, LABEL_MAX - 1).join("")}…` : label;
}

/** Labels: three, then `+n`, which shows the rest in place. Always neutral: their colours are GitHub's, and their contrast is unknown. */
export function Labels({ labels }: { labels: string[] }) {
  const [all, setAll] = useState(false);
  if (labels.length === 0) return null;
  const shown = all ? labels : labels.slice(0, 3);
  const rest = labels.length - shown.length;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }} data-github-labels="">
      {shown.map((label, i) => (
        <Chip key={`${label}-${i}`} label={boundLabel(label)} variant="pill" mono={false} />
      ))}
      {rest > 0 ? (
        <button
          type="button"
          className="bk-control bk-hit"
          aria-expanded={false}
          aria-label={`Show ${rest} more ${rest === 1 ? "label" : "labels"}`}
          onClick={() => setAll(true)}
          style={{ padding: "3px 9px", borderRadius: 999, border: `1px solid ${color.edge}`, background: "transparent", font: `500 10.5px/1.35 ${font.body}`, color: color.inkDim, cursor: "pointer" }}
        >
          +{rest}
        </button>
      ) : null}
    </div>
  );
}

/** Where a not-posted draft's links say they come from: it is not on GitHub yet. */
export const DRAFT_SOURCE = { source: "this draft", sourcePhrase: "in this draft" } as const;

/**
 * An issue or pull request body. A read or posted body keeps the design's
 * 20,000-character bound and its "Truncated" note. A draft (`draft`, a
 * not-posted preview) shows its whole text behind the same clamp: what is
 * approved is what is posted, up to 65,536 characters (#4197, as #4154 did
 * for the W4 comment preview).
 */
export function Body(p: { body?: string | null; author: string; bodyLength?: number; bodyTruncated?: boolean; htmlUrl?: string | null; draft?: boolean }) {
  if (!p.body) {
    return <p style={{ margin: 0, font: `400 12px/1.5 ${font.body}`, color: color.inkMute }}>— No description provided.</p>;
  }
  const length = p.bodyLength ?? Array.from(p.body).length;
  return (
    <UntrustedText
      text={p.body}
      {...(p.draft ? { ...DRAFT_SOURCE, author: null, caption: "Brain's draft · not posted" } : { source: "GitHub", author: p.author })}
      frame="box"
      lines={8}
      linesNarrow={10}
      expandLabel={`Show full description · ${count(length)} characters`}
      {...(p.draft ? {} : { maxChars: BODY_MAX_CHARS })}
      truncated={p.bodyTruncated}
      truncatedNote={
        !p.draft && githubHref(p.htmlUrl) ? (
          <>
            Truncated · rest on <GitHubLink href={p.htmlUrl} label="GitHub" name="The full description" />
          </>
        ) : (
          "Truncated · the rest is on GitHub"
        )
      }
    />
  );
}

/**
 * A tab strip that scrolls sideways when its tabs outgrow the card (the
 * design's 320px PR tabs). Out of the card's minimum width, it never widens
 * the card. FilterRow itself clips, so it sits in a max-content box inside a
 * scrolling one. Block padding keeps the pills' 44px coarse-pointer reach
 * inside the scroller, which would otherwise clip it vertically; the negative
 * margin keeps the layout where it was.
 */
export function TabStrip({ children }: { children: ReactNode }) {
  return (
    <div
      className="bk-gh-tabs"
      style={{ width: 0, minWidth: "100%", overflowX: "auto", padding: "12px 0", margin: "-12px 0" }}
      data-github-tabs=""
      // FilterRow's own row is the nearest scroll container and needs no
      // scroll, so focusing a tab does not reach this one: bring it into view.
      onFocus={(event) => (event.target as HTMLElement).scrollIntoView?.({ block: "nearest", inline: "nearest" })}
    >
      <div style={{ width: "max-content", minWidth: "100%" }}>{children}</div>
    </div>
  );
}

/** A divided section of the card. */
export function Part({ children, pad = "12px 14px", label }: { children: ReactNode; pad?: string; label?: string }) {
  return (
    <div style={{ padding: pad, borderTop: `1px solid ${color.line}`, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }} aria-label={label} role={label ? "group" : undefined}>
      {children}
    </div>
  );
}
