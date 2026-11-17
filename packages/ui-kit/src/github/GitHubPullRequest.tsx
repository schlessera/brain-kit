import type { CSSProperties, ReactNode } from "react";
import { Surface } from "../primitives/Surface.js";
import { FilterRow } from "../rows/FilterRow.js";
import { color, font } from "../tokens.js";
import { GitHubIdentity } from "./GitHubIdentity.js";
import {
  GitHubMergeEvent,
  type GitHubMergeEventProps,
} from "./GitHubMergeEvent.js";
import type { GitHubReviewState } from "./GitHubReview.js";
import { GitHubStateChip } from "./GitHubStateChip.js";
import { Body, Header, Labels, Part, count } from "./object-parts.js";
import { BrainRead, CAPS, Field, META, type GitHubPerson } from "./shared.js";

/**
 * `GitHubPullRequest` — a pull request as the tool returned it (#3800, design
 * #3795 §1).
 *
 * Above the tabs is everything the tool result carries: state, ref, title,
 * author, branches, labels, the four facts (reviews, checks, size, commits),
 * one row per reviewer and the body, clamped. The tabs are `FilterRow`'s,
 * whose interactive pills reach 44px by default (#4086); the active tab's
 * content is `children`, which the host fills with a `GitHubThread` or a
 * `GitHubDetailSection`.
 *
 * Absent is never passing: `checks: null` reads "— None reported" and
 * `reviews: null` (or a reviewer whose state is `null`) "— Not reported".
 * Neither is teal and neither shows ✓.
 *
 * `preview` is the not-posted mode the write approvals use.
 */
export interface GitHubPullRequestProps {
  state: "open" | "draft" | "merged" | "closed";
  repo: string;
  number: number;
  /** The canonical URL. The only direct link on the object itself. */
  htmlUrl?: string | null;
  title: string;
  author: GitHubPerson;
  /** "opened 3 d ago". */
  opened?: string;
  headRef: string;
  baseRef: string;
  labels?: string[];
  /** Review counts, or `null` when the payload does not report them. */
  reviews: { changesRequested: number; approved: number } | null;
  /** Check counts, or `null` when none are reported. `null` is not zero. */
  checks: {
    passed: number;
    failed: number;
    running: number;
    skipped?: number;
  } | null;
  size?: { files: number; additions: number; deletions: number } | null;
  commits?: number | null;
  /** One row per reviewer, latest state each. `state: null` is unknown. */
  reviewers?: {
    person: GitHubPerson;
    state: GitHubReviewState;
    time?: string;
  }[];
  body?: string | null;
  bodyLength?: number;
  bodyTruncated?: boolean;
  /** The merge, for a merged PR: the banner under the header. */
  merge?: GitHubMergeEventProps;
  /** Conversation, Commits, Files, Checks. */
  tabs?: {
    items: { label: string; count?: number }[];
    active: number;
    onSelect: (index: number) => void;
  };
  /** The active tab's content. */
  children?: ReactNode;
  /** What the tool returned, for "Brain read: …". */
  brainRead?: string;
  preview?: boolean;
}

const FACT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  padding: "9px 14px",
  background: color.surface,
  minWidth: 0,
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={FACT}
      role="group"
      aria-label={label}
      data-github-fact={label.toLowerCase()}
    >
      <span style={CAPS} aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  );
}

function Reviews({ reviews }: { reviews: GitHubPullRequestProps["reviews"] }) {
  if (reviews === null)
    return <GitHubStateChip state="not-reported" variant="inline" />;
  if (reviews.changesRequested === 0 && reviews.approved === 0)
    return (
      <span
        style={{ font: `400 11.5px/1.35 ${font.body}`, color: color.inkMute }}
      >
        No reviews yet
      </span>
    );
  return (
    <>
      {reviews.changesRequested > 0 ? (
        <GitHubStateChip
          state="changes-requested"
          count={reviews.changesRequested}
          variant="inline"
        />
      ) : null}
      {reviews.approved > 0 ? (
        <GitHubStateChip
          state="approved"
          count={reviews.approved}
          variant="inline"
        />
      ) : null}
    </>
  );
}

function Checks({ checks }: { checks: GitHubPullRequestProps["checks"] }) {
  if (checks === null)
    return <GitHubStateChip state="none-reported" variant="inline" />;
  if (checks.failed === 0 && checks.running === 0 && checks.passed === 0)
    return (
      <span
        style={{ font: `400 11.5px/1.35 ${font.body}`, color: color.inkMute }}
      >
        No checks ran
      </span>
    );
  return (
    <>
      {checks.failed > 0 ? (
        <GitHubStateChip
          state="failing"
          count={checks.failed}
          variant="inline"
        />
      ) : null}
      {checks.running > 0 ? (
        <GitHubStateChip
          state="running"
          count={checks.running}
          variant="inline"
        />
      ) : null}
      {checks.passed > 0 ? (
        <GitHubStateChip
          state="passed"
          count={checks.passed}
          variant="inline"
        />
      ) : null}
    </>
  );
}

export function GitHubPullRequest(p: GitHubPullRequestProps) {
  const author = p.author.login === null ? "@ghost" : `@${p.author.login}`;
  const fact = {
    font: `500 11.5px/1.35 ${font.body}`,
    color: color.ink,
  } as const;
  return (
    // The card fills its column: in a start-aligned flex parent a Surface
    // alone would shrink to its content.
    <div style={{ width: "100%", minWidth: 0 }}>
    <Surface pad={0}>
      <article
        aria-label={`Pull request ${p.repo} #${p.number}`}
        data-github-pr=""
        style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
      >
        <Header
          state={p.preview ? "not-posted" : p.state}
          kind="pr"
          repo={p.repo}
          number={p.number}
          htmlUrl={p.preview ? null : p.htmlUrl}
          title={p.title}
        >
          <GitHubIdentity {...p.author} meta={p.opened} />
          <div
            style={{ ...META, color: color.inkDim, overflowWrap: "anywhere" }}
          >
            <Field>{p.headRef}</Field> → <Field>{p.baseRef}</Field>
          </div>
          <Labels labels={p.labels ?? []} />
        </Header>

        {p.state === "merged" && p.merge ? (
          <GitHubMergeEvent {...p.merge} variant="banner" />
        ) : null}

        <div
          className="bk-gh-facts-frame"
          style={{
            borderTop:
              p.state === "merged" && p.merge
                ? undefined
                : `1px solid ${color.line}`,
          }}
        >
          <div className="bk-gh-facts">
            <Fact label="Reviews">
              <Reviews reviews={p.reviews} />
            </Fact>
            <Fact label="Checks">
              <Checks checks={p.checks} />
            </Fact>
            <Fact label="Size">
              {p.size ? (
                <span style={fact}>
                  {count(p.size.files)} {p.size.files === 1 ? "file" : "files"}{" "}
                  · +{count(p.size.additions)} −{count(p.size.deletions)}
                </span>
              ) : (
                <GitHubStateChip state="not-reported" variant="inline" />
              )}
            </Fact>
            <Fact label="Commits">
              {p.commits !== undefined && p.commits !== null ? (
                <span style={fact}>{count(p.commits)}</span>
              ) : (
                <GitHubStateChip state="not-reported" variant="inline" />
              )}
            </Fact>
          </div>
        </div>

        {p.reviewers && p.reviewers.length > 0 ? (
          <Part label="Reviewers">
            {p.reviewers.map((reviewer, i) => (
              <GitHubIdentity
                key={i}
                {...reviewer.person}
                meta={
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "0 8px",
                    }}
                  >
                    <GitHubStateChip
                      state={reviewer.state ?? "not-reported"}
                      variant="inline"
                    />
                    {reviewer.time ? <span>{reviewer.time}</span> : null}
                  </span>
                }
              />
            ))}
          </Part>
        ) : null}

        <Part>
          <Body
            body={p.body}
            author={author}
            bodyLength={p.bodyLength}
            bodyTruncated={p.bodyTruncated}
            htmlUrl={p.preview ? null : p.htmlUrl}
            draft={p.preview}
          />
        </Part>

        {p.tabs ? (
          <Part pad="4px 14px 12px">
            {/* Out of the card's minimum width: the strip clips at 320 instead of widening the card. */}
            <div style={{ width: 0, minWidth: "100%" }}>
              <FilterRow
                mono={false}
                active={p.tabs.active}
                items={p.tabs.items.map((tab, i) => ({
                  label:
                    tab.count !== undefined
                      ? `${tab.label} ${count(tab.count)}`
                      : tab.label,
                  onClick: () => p.tabs!.onSelect(i),
                }))}
              />
            </div>
            <div
              role="tabpanel"
              aria-label={p.tabs.items[p.tabs.active]?.label}
              style={{ minWidth: 0 }}
            >
              {p.children}
            </div>
          </Part>
        ) : p.children ? (
          <Part>{p.children}</Part>
        ) : null}

        {p.brainRead ? <BrainRead text={p.brainRead} /> : null}
      </article>
    </Surface>
    </div>
  );
}
