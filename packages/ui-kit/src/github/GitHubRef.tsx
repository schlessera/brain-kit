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
 *
 * `kind: null` is a target whose kind nobody verified (#4154): it reads
 * `ithaca/hall #412`, claiming neither issue nor pull request, with no state
 * chip and no link, whatever `htmlUrl` says.
 */
export interface GitHubRefProps {
  kind: "pr" | "issue" | null;
  /** "owner/name". */
  repo: string;
  /** Absent for an issue that is not posted yet. */
  number?: number | null;
  htmlUrl?: string | null;
  /** The compact target row: the object's title beside its ref. */
  title?: string;
  state?: GitHubState;
}

const KIND = { pr: "PR", issue: "Issue" } as const;

export function GitHubRef(p: GitHubRefProps) {
  const kind = p.kind ? KIND[p.kind] : null;
  const ref = `${p.repo}${p.number ? ` #${p.number}` : ""}`;
  const text = kind ? `${kind} · ${ref}` : ref;
  // An unverified kind has no verified link either.
  const href = p.kind ? p.htmlUrl : null;
  if (p.title !== undefined) {
    return (
      <div
        style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "2px 8px", padding: "6px 10px", borderRadius: 8, border: `1px solid ${color.line}`, minWidth: 0 }}
        data-github-ref=""
      >
        {p.state && p.kind ? <GitHubStateChip state={p.state} kind={p.kind} variant="inline" /> : null}
        <span style={META}>
          <Field>{p.repo}</Field>
          {p.number ? ` #${p.number}` : ""}
        </span>
        <span style={{ font: `500 12.5px/1.4 ${font.body}`, color: color.ink, minWidth: 0, flex: "1 1 10em" }}>
          <Field>{p.title}</Field>
        </span>
        <GitHubLink href={href} name={text} />
      </div>
    );
  }
  return (
    <>
      <span style={{ ...META, minWidth: 0 }} data-github-ref="" {...(kind ? {} : { "data-github-ref-kind": "unknown" })}>
        {kind ? `${kind} · ` : null}
        <Field>{p.repo}</Field>
        {p.number ? ` #${p.number}` : ""}
      </span>
      <GitHubLink href={href} name={text} style={{ marginInlineStart: "auto" }} />
    </>
  );
}
