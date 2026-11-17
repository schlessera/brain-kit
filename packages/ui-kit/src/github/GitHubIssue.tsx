import { useState, type ReactNode } from "react";
import { UntrustedText } from "../evidence/UntrustedText.js";
import { Icon } from "../primitives/Icon.js";
import { Surface } from "../primitives/Surface.js";
import { FilterRow } from "../rows/FilterRow.js";
import { accent, color, font } from "../tokens.js";
import { GitHubIdentity, GitHubParticipants, type GitHubParticipantsProps } from "./GitHubIdentity.js";
import { Body, DRAFT_SOURCE, Header, Labels, Part } from "./object-parts.js";
import { BrainRead, META, type GitHubPerson } from "./shared.js";

/**
 * `GitHubIssue` — an issue as the tool returned it, then its thread (#3800,
 * design #3795 §1). The same header as a pull request, without facts or
 * branches, plus how many people take part.
 *
 * The write approvals use the same component (§ "Write tools"):
 *
 * - `posting.status: "preview"` (W1): not posted yet. The body has an
 *   **As shown / Exact text** switch; Exact text is the raw string that will
 *   be sent. No canonical link: there is no object yet.
 * - `posting.status: "posted"` (W2): the real object GitHub returned, with
 *   "✓ Posted by you via Brain" and its canonical link.
 *
 * A write that did not happen (W3) is `GitHubWriteNotice`, not this.
 */
export interface GitHubIssueProps {
  state: "open" | "completed" | "not-planned";
  repo: string;
  /** Absent while not posted. */
  number?: number | null;
  htmlUrl?: string | null;
  title: string;
  author?: GitHubPerson | null;
  /** "opened 6 d ago". */
  opened?: string;
  participants?: GitHubParticipantsProps;
  locked?: boolean;
  labels?: string[];
  body?: string | null;
  bodyLength?: number;
  bodyTruncated?: boolean;
  /** The thread: a `GitHubThread`. */
  children?: ReactNode;
  brainRead?: string;
  posting?: { status: "preview" | "posted"; time?: string; note?: string };
}

export function GitHubIssue(p: GitHubIssueProps) {
  const preview = p.posting?.status === "preview";
  const [exact, setExact] = useState(false);
  const author = p.author ? (p.author.login === null ? "@ghost" : `@${p.author.login}`) : null;
  return (
    // The card fills its column: in a start-aligned flex parent a Surface
    // alone would shrink to its content.
    <div style={{ width: "100%", minWidth: 0 }}>
    <Surface pad={0}>
      <article aria-label={preview ? `Issue not posted in ${p.repo}` : `Issue ${p.repo}${p.number ? ` #${p.number}` : ""}`} data-github-issue="" style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Header state={preview ? "not-posted" : p.state} kind="issue" repo={p.repo} number={preview ? null : p.number} htmlUrl={preview ? null : p.htmlUrl} title={p.title}>
          {p.posting?.status === "posted" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }} data-github-posted="">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, font: `500 12px/1.4 ${font.body}`, color: accent.teal.ink }}>
                <Icon icon="confirm" size={12} />
                Posted by you via Brain{p.posting.time ? ` · ${p.posting.time}` : ""}
              </span>
              {p.posting.note ? <span style={META}>{p.posting.note}</span> : null}
            </div>
          ) : null}
          {!preview && (p.author || p.participants) ? (
            <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 8px" }}>
              {p.author ? <GitHubIdentity {...p.author} meta={p.opened} /> : null}
              {p.participants ? <GitHubParticipants {...p.participants} /> : null}
            </div>
          ) : null}
          {p.locked ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, font: `400 11.5px/1.4 ${font.body}`, color: color.inkDim }} data-github-locked="">
              <Icon icon="scope" size={12} />
              Locked · only collaborators can comment
            </span>
          ) : null}
          <Labels labels={p.labels ?? []} />
        </Header>

        {preview ? (
          <Part>
            <div style={{ width: 0, minWidth: "100%" }}>
              <FilterRow mono={false} active={exact ? 1 : 0} items={[{ label: "As shown", onClick: () => setExact(false) }, { label: "Exact text", onClick: () => setExact(true) }]} />
            </div>
            <div role="tabpanel" aria-label={exact ? "Exact text" : "As shown"}>
              {exact ? (
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: `400 11.5px/1.55 ${font.mono}`, color: color.ink }} data-github-exact="">
                  <bdi>{p.body ?? ""}</bdi>
                </pre>
              ) : p.body ? (
                <UntrustedText text={p.body} {...DRAFT_SOURCE} frame="none" />
              ) : (
                <p style={{ margin: 0, font: `400 12px/1.5 ${font.body}`, color: color.inkMute }}>— No description.</p>
              )}
            </div>
          </Part>
        ) : p.posting?.status === "posted" ? null : (
          <Part>
            <Body body={p.body} author={author ?? "an unknown author"} bodyLength={p.bodyLength} bodyTruncated={p.bodyTruncated} htmlUrl={p.htmlUrl} />
          </Part>
        )}

        {p.children ? <Part>{p.children}</Part> : null}
        {p.brainRead ? <BrainRead text={p.brainRead} /> : null}
      </article>
    </Surface>
    </div>
  );
}

/**
 * `GitHubWriteNotice` — a write that did not happen (W3, design #3795 § "Write
 * tools"). Nothing was sent, except for `unknown`, where GitHub did not answer
 * and the reader must check before asking again.
 */
export interface GitHubWriteNoticeProps {
  outcome: "declined" | "changed" | "unknown";
}

export function GitHubWriteNotice(p: GitHubWriteNoticeProps) {
  const look =
    p.outcome === "declined"
      ? { glyph: <Icon icon="not-planned" size={12} />, lead: "Not posted.", text: "You chose Don't post. Nothing was sent to GitHub.", tone: null }
      : p.outcome === "changed"
        ? { glyph: "!", lead: "Not posted.", text: "The text changed after you approved it. Nothing was sent.", tone: "gold" as const }
        : { glyph: "?", lead: "Outcome unknown.", text: "GitHub didn't answer. Check the repository before asking again.", tone: "gold" as const };
  return (
    <div
      role="status"
      data-github-write={p.outcome}
      style={{
        padding: "9px 12px",
        borderRadius: 10,
        border: `1px solid ${look.tone ? accent[look.tone].ink : color.edge}`,
        background: color.surface,
        font: `400 12px/1.5 ${font.body}`,
        color: color.ink,
      }}
    >
      <span style={{ fontWeight: 650, color: look.tone ? accent[look.tone].ink : color.inkDim }}>
        <span aria-hidden="true" style={{ display: "inline-flex", verticalAlign: "-1px", marginInlineEnd: 4 }}>{look.glyph}</span>
        {look.lead}
      </span>{" "}
      {look.text}
    </div>
  );
}
