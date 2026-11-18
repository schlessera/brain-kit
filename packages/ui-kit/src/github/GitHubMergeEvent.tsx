import { Icon } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import { Field, type GitHubPerson } from "./shared.js";

/**
 * `GitHubMergeEvent` — "Merged by @penelope into main · a3f9c21 · 1 d ago"
 * (#3800, design #3795 §1). A banner under a merged PR's header, and the
 * terminal event of its Conversation tab.
 *
 * It states only what the payload carries: who, into which branch, the merge
 * commit and when. The payload has no merge method, so neither does this.
 * No direct link: the D3 slots are comments, reviews and commits.
 */
export interface GitHubMergeEventProps {
  /** `null` when the payload names no one. */
  by: GitHubPerson | null;
  into: string;
  /** The merge commit's short sha. */
  sha?: string | null;
  time?: string;
  variant?: "banner" | "event";
}

export function GitHubMergeEvent(p: GitHubMergeEventProps) {
  const banner = (p.variant ?? "banner") === "banner";
  const who = p.by === null ? null : p.by.login === null ? "@ghost" : `@${p.by.login}`;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        padding: banner ? "8px 14px" : "2px 0",
        background: banner ? token("chip-tint-purple") : "transparent",
        borderTop: banner ? `1px solid ${color.line}` : undefined,
        borderBottom: banner ? `1px solid ${color.line}` : undefined,
        font: `400 11.5px/1.5 ${font.body}`,
        color: color.ink,
      }}
      data-github-merge=""
    >
      <span style={{ display: "inline-flex", paddingTop: 2, color: accent.purple.ink }}>
        <Icon icon="pr-merged" size={12} />
      </span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        Merged{who ? <> by <span style={{ font: `600 11px/1.5 ${font.mono}` }}><Field>{who}</Field></span></> : null} into{" "}
        <span style={{ font: `500 11px/1.5 ${font.mono}` }}><Field>{p.into}</Field></span>
        {p.sha ? <span style={{ font: `400 11px/1.5 ${font.mono}`, color: color.inkDim }}> · {p.sha}</span> : null}
        {p.time ? <span style={{ color: color.inkMute }}> · {p.time}</span> : null}
      </span>
    </div>
  );
}
