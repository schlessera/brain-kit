import { useId, useState } from "react";
import { color, font } from "../tokens.js";
import { Field, GitHubLink, META, type GitHubPerson } from "./shared.js";

/**
 * `GitHubCommitRow` — a commit: the subject, then `sha · @author · time`
 * (#3800, design #3795 §1). When the message says more than its subject,
 * the row is a button that expands the full message in place.
 *
 * `htmlUrl` adds the commit's own direct `GitHub ↗` (D3), beside the row,
 * never inside the toggle.
 */
export interface GitHubCommitRowProps {
  /** Short sha. */
  sha: string;
  /** The message's first line. Shown to 120 characters. */
  subject: string;
  /** The full message. Shown to 2,000 characters when the row expands. */
  message?: string | null;
  /** `null`: the commit names no GitHub account. */
  author: GitHubPerson | null;
  time?: string;
  /** The commit's canonical URL (D3). */
  htmlUrl?: string | null;
}

export const COMMIT_SUBJECT_MAX = 120;
export const COMMIT_MESSAGE_MAX = 2_000;

function bound(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

export function GitHubCommitRow(p: GitHubCommitRowProps) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const first = p.subject.split("\n")[0] ?? "";
  const subject = bound(first, COMMIT_SUBJECT_MAX);
  const message = p.message ?? first;
  const newline = message.indexOf("\n");
  // The panel shows what the row does not: the body after the subject, or
  // the whole message when the subject itself was cut.
  const rest = subject !== first ? message : newline === -1 ? "" : message.slice(newline).trim();
  const expandable = rest !== "";
  const who = p.author === null ? "unknown author" : p.author.login === null ? "@ghost" : `@${p.author.login}`;

  const lines = (
    <>
      <span style={{ display: "block", font: `500 12.5px/1.4 ${font.body}`, color: color.ink, overflowWrap: "anywhere" }}>
        <Field>{subject}</Field>
      </span>
      <span style={{ ...META, display: "block" }}>
        {p.sha} · <Field>{who}</Field>
        {p.time ? ` · ${p.time}` : ""}
      </span>
    </>
  );

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }} data-github-commit="">
      <div style={{ flex: 1, minWidth: 0 }}>
        {expandable ? (
          <button
            type="button"
            className="bk-row"
            aria-expanded={open}
            aria-controls={panel}
            onClick={() => setOpen(!open)}
            style={{ display: "block", width: "100%", minHeight: 44, padding: "4px 0", textAlign: "start", background: "transparent", border: "none", cursor: "pointer", borderRadius: 6 }}
          >
            {lines}
          </button>
        ) : (
          <div style={{ padding: "4px 0" }}>{lines}</div>
        )}
        {expandable && open ? (
          <pre id={panel} style={{ margin: "4px 0 6px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: `400 11.5px/1.55 ${font.mono}`, color: color.inkDim }}>
            <bdi>{bound(rest, COMMIT_MESSAGE_MAX)}</bdi>
          </pre>
        ) : null}
      </div>
      <GitHubLink href={p.htmlUrl} name={`Commit ${p.sha}`} style={{ marginTop: 4 }} />
    </div>
  );
}
