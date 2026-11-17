import { color, font } from "../tokens.js";
import { GitHubStateChip } from "./GitHubStateChip.js";
import { Field, GitHubLink, META, type GitHubState } from "./shared.js";

/**
 * `GitHubRef` — which object this is: `PR · ithaca/hall #412`, and the
 * canonical `GitHub ↗` when `htmlUrl` is present and passes the github.com
 * check (#3800).
 *
 * With `title` (and usually `state`) it is the compact target row a comment
 * approval names its target with (W4): state, ref, title, `GitHub ↗`.
 * The kit never builds the URL; with no `htmlUrl` there is no link.
 */
export interface GitHubRefProps {
  kind: "pr" | "issue";
  /** "owner/name". */
  repo: string;
  /** Absent for an issue that is not posted yet. */
  number?: number | null;
  htmlUrl?: string | null;
  /** The compact target row: the object's title beside its ref. */
  title?: string;
  state?: GitHubState;
}

export function GitHubRef(p: GitHubRefProps) {
  const text = `${p.kind === "pr" ? "PR" : "Issue"} · ${p.repo}${p.number ? ` #${p.number}` : ""}`;
  if (p.title !== undefined) {
    return (
      <div
        style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "2px 8px", padding: "6px 10px", borderRadius: 8, border: `1px solid ${color.line}`, minWidth: 0 }}
        data-github-ref=""
      >
        {p.state ? <GitHubStateChip state={p.state} kind={p.kind} variant="inline" /> : null}
        <span style={META}>
          <Field>{p.repo}</Field>
          {p.number ? ` #${p.number}` : ""}
        </span>
        <span style={{ font: `500 12.5px/1.4 ${font.body}`, color: color.ink, minWidth: 0, flex: "1 1 10em" }}>
          <Field>{p.title}</Field>
        </span>
        <GitHubLink href={p.htmlUrl} name={text} />
      </div>
    );
  }
  return (
    <>
      <span style={{ ...META, minWidth: 0 }} data-github-ref="">
        {p.kind === "pr" ? "PR" : "Issue"} · <Field>{p.repo}</Field>
        {p.number ? ` #${p.number}` : ""}
      </span>
      <GitHubLink href={p.htmlUrl} name={text} style={{ marginInlineStart: "auto" }} />
    </>
  );
}
