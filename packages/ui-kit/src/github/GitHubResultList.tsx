import { useId, useLayoutEffect, useRef, useState } from "react";
import { UntrustedText } from "../evidence/UntrustedText.js";
import { Button } from "../primitives/Button.js";
import { Icon } from "../primitives/Icon.js";
import { Surface } from "../primitives/Surface.js";
import { accent, color, font } from "../tokens.js";
import { count } from "./object-parts.js";
import { Field, GitHubLink, META, STATES, githubHref } from "./shared.js";

/**
 * `GitHubResultList` — the issues and pull requests a search returned
 * (#3800, design #3795 §1 and §6).
 *
 * One hairline row per result, in GitHub's order, with no cards inside the
 * card. Eight rows show, then "Show n more" up to what the tool returned. A
 * row opens in place to the summary the search returned and its `GitHub ↗`;
 * it never turns into a full object, which would need another read.
 *
 * Under the rows, GitHub's total is stated honestly: "GitHub has n more. Ask
 * Brain to narrow the search.", and with `searchUrl` a "Search on GitHub ↗"
 * link (D2). The host constructs and validates that URL; the kit renders it
 * only on https://github.com.
 */
export interface GitHubResult {
  kind: "pr" | "issue";
  number: number;
  state: "open" | "draft" | "merged" | "closed" | "completed" | "not-planned";
  title: string;
  /** What else the payload carries, in order: "± changes", "12 comments", "1 d ago". */
  facts?: string[];
  /** The bounded excerpt the search returned. */
  summary?: string | null;
  htmlUrl?: string | null;
}

export interface GitHubResultListProps {
  repo: string;
  query: string;
  /** GitHub's total match count, which may exceed what was returned. */
  total: number;
  results: GitHubResult[];
  /** GitHub flagged the search as possibly incomplete. */
  incomplete?: boolean;
  /** A host-constructed GitHub search URL (D2). */
  searchUrl?: string | null;
  /** Rows shown before "Show more". Defaults to 8. */
  initial?: number;
}

/** The state word a result row's meta line uses. */
const ROW_STATE: Record<GitHubResult["state"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed · not merged",
  completed: "Closed · completed",
  "not-planned": "Closed · not planned",
};

function Row({ result }: { result: GitHubResult }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const look = STATES[result.state];
  const icon = result.state === "open" && result.kind === "pr" ? "pr-open" : look.icon!;
  const ink = look.tone === "neutral" ? (look.quiet ? color.inkMute : color.inkDim) : accent[look.tone].ink;
  const ref = `${result.kind === "pr" ? "PR" : "Issue"} #${result.number}`;
  return (
    <li style={{ borderTop: `1px solid ${color.line}` }} data-github-result="">
      <button
        type="button"
        className="bk-row"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        style={{ display: "flex", alignItems: "flex-start", gap: 10, width: "100%", minHeight: 44, padding: "10px 14px", background: "transparent", border: "none", textAlign: "start", cursor: "pointer" }}
      >
        <span aria-hidden="true" style={{ display: "inline-flex", paddingTop: 3, color: ink }}>
          <Icon icon={icon} size={12} />
        </span>
        <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ font: `500 12.5px/1.4 ${font.body}`, color: color.ink, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
            <Field>{result.title}</Field>
          </span>
          <span style={META}>
            {ref} · {ROW_STATE[result.state]}
            {(result.facts ?? []).map((fact, i) => (
              <span key={i}>
                {" · "}
                <Field>{fact}</Field>
              </span>
            ))}
          </span>
        </span>
        <span aria-hidden="true" style={{ display: "inline-flex", paddingTop: 2, color: color.inkMute }}>
          <Icon icon={open ? "collapse" : "next"} size={14} />
        </span>
      </button>
      {open ? (
        <div id={panel} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "0 14px 12px 36px" }}>
          {result.summary ? (
            <UntrustedText text={result.summary} source="GitHub" frame="rule" caption={false} lines={3} expandLabel="Show the whole summary" />
          ) : (
            <span style={{ font: `400 12px/1.5 ${font.body}`, color: color.inkMute }}>— The search returned no summary.</span>
          )}
          <GitHubLink href={result.htmlUrl} name={ref} style={{ alignSelf: "flex-start" }} />
        </div>
      ) : null}
    </li>
  );
}

export function GitHubResultList(p: GitHubResultListProps) {
  const initial = p.initial ?? 8;
  const [all, setAll] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const focusFrom = useRef<number | null>(null);
  const shown = all ? p.results : p.results.slice(0, initial);
  const hidden = p.results.length - shown.length;
  const beyond = Math.max(0, p.total - p.results.length);

  useLayoutEffect(() => {
    if (focusFrom.current === null) return;
    const row = list.current?.children[focusFrom.current]?.querySelector("button");
    focusFrom.current = null;
    row?.focus();
  }, [all]);

  return (
    // The card fills its column: in a start-aligned flex parent a Surface
    // alone would shrink to its content.
    <div style={{ width: "100%", minWidth: 0 }}>
    <Surface pad={0}>
      <section aria-label={`GitHub search results in ${p.repo}`} data-github-results="" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
          <h3 style={{ margin: 0, font: `650 13.5px/1.35 ${font.body}`, color: color.ink }}>
            {count(p.results.length)} {p.results.length === 1 ? "result" : "results"} in <Field>{p.repo}</Field>
          </h3>
          <span style={META}>
            “<Field>{p.query}</Field>” · {count(p.total)} match on GitHub · newest first
          </span>
        </header>
        {p.incomplete ? (
          <div style={{ ...META, padding: "0 14px 10px", color: accent.gold.ink }} data-github-incomplete="">
            GitHub says these results may be incomplete.
          </div>
        ) : null}
        {p.results.length === 0 ? (
          <p style={{ margin: 0, padding: "10px 14px 14px", borderTop: `1px solid ${color.line}`, font: `400 12px/1.5 ${font.body}`, color: color.inkMute }}>— GitHub found nothing for this search.</p>
        ) : (
          <ul ref={list} style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {shown.map((result) => (
              <Row key={`${result.kind}-${result.number}`} result={result} />
            ))}
          </ul>
        )}
        {hidden > 0 || beyond > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 14px 12px", borderTop: `1px solid ${color.line}` }}>
            {hidden > 0 ? (
              <Button
                label={`Show ${hidden} more · ${shown.length} of ${p.results.length} shown`}
                tone="ghost"
                size="md"
                onClick={() => {
                  focusFrom.current = shown.length;
                  setAll(true);
                }}
              />
            ) : null}
            {beyond > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0 }} data-github-footnote="">
                <span style={META}>GitHub has {count(beyond)} more. Ask Brain to narrow the search.</span>
                {githubHref(p.searchUrl) ? <GitHubLink href={p.searchUrl} label="Search on GitHub" name="This search" /> : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </Surface>
    </div>
  );
}
