import type { CSSProperties, ReactNode } from "react";
import { useId, useState } from "react";

import { classifyLink, refusalSentence, type LinkRefusal } from "../links.js";
import { accent, color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * Changes an agent made to an issue tracker, one tappable line each (#1001).
 *
 * The design is the approved one-line pill on #1001; D48's link rules
 * (`docs/decisions/design-kit.md`) are what it is built on:
 *
 *   - **Everything that says WHERE is derived from `url`**, by the kit, from
 *     one `classifyLink` parse. For a GitHub-shaped address
 *     (`https://github.com/<owner>/<name>/(issues|pull)/<n>`) that is the
 *     repository, number and item type as well as the host; any other address
 *     yields its host alone, and its pill shows only the action and the title.
 *     There are no identity props: no caller can label a pill with a
 *     repository it does not open.
 *   - **The host and repository live in a run header**, not in each pill:
 *     consecutive events with the same host and repository share one header,
 *     and a change starts the next. Events keep the order they were given in.
 *     The header never truncates; the host wraps only after a `.` and the
 *     repository only after a `/`.
 *   - **A pill is one line at every width**: `● action [qualifier] · number ·
 *     title ↗`. The action, the type and the number never truncate; the
 *     qualifier is cut at 16 characters (whole in the accessible name); the
 *     title takes what is left, down to nothing but its ellipsis. Only when
 *     the title is down to nothing does the qualifier give way too, so the
 *     open glyph never leaves the pill.
 *   - **The action is a printed word.** Its tone and mark back it up, never
 *     replace it (`trackerTone`). Red and purple are not used: no tracker act
 *     here is a failure, and purple is provenance.
 *   - **The words are the model's.** Every action and title is a report of
 *     what the agent says it did, and the foot says so on every list:
 *     `Changes as reported by the brain · tracker not checked`. Nothing is
 *     fetched to draw it.
 *   - **A refused address is withheld**: a dashed pill with `withheld` in place
 *     of the action, the model's title, no anchor, no `↗`, no tab stop, and
 *     its reason once in the foot.
 *   - **Past 6 events, 5 show** with a `Show all N changes` control after
 *     them. Expanding reveals the rest below the control, so focus stays on it
 *     and Tab walks on into the newly shown pills.
 *
 * A pill is a real anchor opening a new tab with no opener and no referrer,
 * as the link card's Open is. Its paint is 36px tall in a 44px row; the
 * `.bk-tracker-pill` class's transparent `::before` reaches the 4px above and
 * below, so the target is the whole row (D34) and two targets never overlap.
 */

export type TrackerAction = "opened" | "closed" | "reopened" | "merged" | "labeled" | "commented" | "reviewed";

export interface TrackerEvent {
  /** The item's address. Host, repository, number and type are derived from it. */
  url: string;
  action: TrackerAction;
  /** The close reason, the label name or the review verdict. */
  qualifier?: string;
  /** The item's title, in the model's words. */
  title: string;
}

export interface TrackerPillListProps {
  events: readonly TrackerEvent[];
  /**
   * Whether a list longer than 6 shows every event. A seed on its own; with
   * `onExpandedChange` the parent owns it, like `Disclosure` (D27).
   */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

/** What the kit read from an accepted address. */
export interface TrackerItem {
  ok: true;
  href: string;
  /** ASCII (`xn--`) host with any non-default port, as `classifyLink` gives it. */
  host: string;
  /** Present only for a GitHub-shaped address. */
  github?: { repo: string; number: number; type: "issue" | "pull" };
}

/** A list longer than this collapses. */
export const TRACKER_COLLAPSE_AFTER = 6;
/** How many events a collapsed list shows. */
export const TRACKER_COLLAPSED_VISIBLE = 5;
/** The longest qualifier drawn whole; the accessible name always has all of it. */
export const TRACKER_QUALIFIER_MAX = 16;

/** GitHub owners are alphanumerics and single hyphens; repositories add `.` and `_`. */
const GITHUB_ITEM = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/(issues|pull)\/([1-9][0-9]{0,9})(?:[/?#]|$)/;

/**
 * Reads an item's address. A refused one is the policy's refusal; an accepted
 * one has its host, and its repository, number and type only when it is a
 * github.com issue or pull request address.
 */
export function trackerItem(url: string): TrackerItem | LinkRefusal {
  const verdict = classifyLink(url);
  if (!verdict.ok) return verdict;
  const item: TrackerItem = { ok: true, href: verdict.href, host: verdict.host };
  if (verdict.host !== "github.com") return item;
  const match = GITHUB_ITEM.exec(verdict.path);
  if (!match) return item;
  const [, owner, name, kind, number] = match as unknown as [string, string, string, string, string];
  if (name === "." || name === "..") return item;
  return { ...item, github: { repo: `${owner}/${name}`, number: Number(number), type: kind === "pull" ? "pull" : "issue" } };
}

/** `closed`, `Not_Planned`, `CHANGES_REQUESTED` → the words a reader would say. */
function words(qualifier: string | undefined): string {
  return (qualifier ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/** The tone an action draws in, from the approved table on #1001. */
export function trackerTone(action: TrackerAction, qualifier?: string): Tone {
  const q = words(qualifier);
  switch (action) {
    case "merged":
      return "teal";
    case "closed":
      return q === "completed" ? "teal" : "neutral";
    case "opened":
      return "amber";
    case "reopened":
      return "gold";
    case "reviewed":
      return q === "approved" ? "teal" : q === "changes requested" ? "gold" : "neutral";
    case "labeled":
    case "commented":
      return "neutral";
  }
}

/** The qualifier as drawn: whole up to 16 characters, then cut with an ellipsis. */
export function shortQualifier(qualifier: string): string {
  const chars = Array.from(qualifier.trim());
  return chars.length > TRACKER_QUALIFIER_MAX ? `${chars.slice(0, TRACKER_QUALIFIER_MAX).join("")}…` : chars.join("");
}

/** The pill's accessible name, built only from what the kit derived plus the action. */
export function trackerPillName(item: TrackerItem, event: Pick<TrackerEvent, "action" | "qualifier">): string {
  const what = event.qualifier?.trim() ? `${event.action}, ${event.qualifier.trim()}` : event.action;
  if (!item.github) return `Open ${item.host}, ${what}`;
  const kind = item.github.type === "pull" ? "pull request" : "issue";
  return `Open ${kind} ${item.github.repo} ${item.github.number} on ${item.host}, ${what}`;
}

/** One event, with what the kit read from its address. */
export interface TrackerRow {
  index: number;
  event: TrackerEvent;
  item: TrackerItem | LinkRefusal;
}

/** Consecutive events under one header. */
export interface TrackerRun {
  /** `null` for a run of withheld events before any accepted one. */
  header: { host: string; repo?: string } | null;
  key: string | null;
  rows: TrackerRow[];
}

/** Consecutive events with one host and repository share a run; a withheld event joins the run it follows. */
export function trackerRuns(events: readonly TrackerEvent[]): TrackerRun[] {
  const runs: TrackerRun[] = [];
  events.forEach((event, index) => {
    const item = trackerItem(event.url);
    const row = { index, event, item };
    const last = runs.at(-1);
    if (!item.ok) {
      if (last) last.rows.push(row);
      else runs.push({ header: null, key: null, rows: [row] });
      return;
    }
    const key = `${item.host}\n${item.github?.repo ?? ""}`;
    if (last && last.key === key) {
      last.rows.push(row);
      return;
    }
    runs.push({ header: { host: item.host, ...(item.github ? { repo: item.github.repo } : {}) }, key, rows: [row] });
  });
  return runs;
}

/** Inline-block pieces that each keep their separator, so a line breaks only after one. */
function Breakable({ text, after }: { text: string; after: string }) {
  const parts = text.split(after);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i} style={{ display: "inline-block", maxWidth: "100%", overflowWrap: "anywhere", verticalAlign: "top" }}>
          {i < parts.length - 1 ? `${part}${after}` : part}
        </span>
      ))}
    </>
  );
}

const mono11: CSSProperties = { font: `600 11px/1.35 ${font.mono}`, whiteSpace: "nowrap", flex: "none" };

const pillBox: CSSProperties = {
  boxSizing: "border-box",
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  minWidth: 0,
  height: 36,
  padding: "0 10px",
  borderRadius: 9,
  textDecoration: "none",
  color: color.ink,
  overflow: "visible",
};

/** `width: 0` as well as the 0 basis: it takes the title out of the list's
 * min-content width, so a parent that sizes the list to its content (a flex
 * column without `min-width: 0`) still gets a list that fits its column
 * instead of one as wide as the longest title. */
const titleStyle: CSSProperties = {
  flex: "1 1 0",
  width: 0,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  font: `500 12.5px/1.35 ${font.body}`,
};

function Pill({ row, item }: { row: TrackerRow; item: TrackerItem }) {
  const { event } = row;
  const tone = trackerTone(event.action, event.qualifier);
  const tint = token(`chip-tint-${tone}`);
  const border = token(`chip-border-${tone}`);
  const veil = token("hover-veil-firm");
  const descId = `${useId()}-title`;
  const qualifier = event.qualifier?.trim();
  return (
    <li style={{ listStyle: "none", padding: "4px 0", margin: 0, minWidth: 0 }}>
      <a
        className="bk-control bk-tracker-pill"
        data-tracker-pill=""
        data-tone={tone}
        href={item.href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        referrerPolicy="no-referrer"
        aria-label={trackerPillName(item, event)}
        aria-describedby={descId}
        style={{
          ...pillBox,
          border: `1px solid ${border}`,
          background: tint,
          ...({
            "--hv-bg": `linear-gradient(${veil}, ${veil}), ${tint}`,
            "--hv-bd": border,
            "--hv-fg": color.ink,
          } as CSSProperties),
        }}
      >
        <span aria-hidden="true" style={{ flex: "none", width: 6, height: 6, borderRadius: "50%", background: accent[tone].mark }} />
        {/* The qualifier shrinks only once the title is down to nothing: the
            title's basis is 0, so it gives way first, and the qualifier's
            ellipsis is the last resort that keeps `↗` inside the pill when a
            16-character qualifier and a four-digit PR fill a 288px line. */}
        <span data-tracker-action="" style={{ ...mono11, flex: "0 1 auto", minWidth: 0, display: "flex", gap: "1ch", color: accent[tone].ink }}>
          <span style={{ flex: "none" }}>{event.action}</span>
          {qualifier ? " " : null}
          {qualifier ? (
            <span data-tracker-qualifier="" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              {shortQualifier(qualifier)}
            </span>
          ) : null}
        </span>
        {item.github ? (
          <span data-tracker-number="" style={{ ...mono11, color: color.inkDim }}>
            {item.github.type === "pull" ? `PR ${item.github.number}` : `#${item.github.number}`}
          </span>
        ) : null}
        <span data-tracker-title="" style={titleStyle}>
          {event.title}
        </span>
        <span aria-hidden="true" data-tracker-open="" style={{ flex: "none", font: `500 12px/1 ${font.body}`, color: color.inkMute }}>
          ↗
        </span>
        <span id={descId} hidden>
          {`Title by the brain: ${event.title}`}
        </span>
      </a>
    </li>
  );
}

function WithheldPill({ row }: { row: TrackerRow }) {
  return (
    <li data-tracker-withheld="" style={{ listStyle: "none", padding: "4px 0", margin: 0, minWidth: 0 }}>
      <div
        aria-hidden="true"
        style={{
          ...pillBox,
          border: `1px dashed ${token("chip-border-neutral")}`,
          background: token("chip-tint-neutral"),
          color: color.inkDim,
        }}
      >
        <span data-tracker-action="" style={{ ...mono11, color: accent.neutral.ink }}>
          ⊘ withheld
        </span>
        <span data-tracker-title="" style={titleStyle}>
          {row.event.title}
        </span>
      </div>
      <span className="bk-sr-only">{`Withheld link, address refused. Title by the brain: ${row.event.title}`}</span>
    </li>
  );
}

function RunList({ rows, labelledBy }: { rows: TrackerRow[]; labelledBy?: string }) {
  return (
    <ul aria-labelledby={labelledBy} style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", minWidth: 0 }}>
      {rows.map((row) =>
        row.item.ok ? <Pill key={row.index} row={row} item={row.item} /> : <WithheldPill key={row.index} row={row} />
      )}
    </ul>
  );
}

function RunHeader({ header, id }: { header: NonNullable<TrackerRun["header"]>; id: string }) {
  return (
    <h4
      id={id}
      data-tracker-run=""
      style={{ margin: "6px 0 2px", font: `600 11px/1.4 ${font.mono}`, color: color.ink, whiteSpace: "normal" }}
    >
      <span data-tracker-host="">
        <Breakable text={header.host} after="." />
      </span>
      {header.repo ? (
        <>
          {" · "}
          <span data-tracker-repo="">
            <Breakable text={header.repo} after="/" />
          </span>
        </>
      ) : null}
    </h4>
  );
}

const footNote: CSSProperties = {
  margin: 0,
  font: `400 11px/1.45 ${font.body}`,
  color: color.inkMute,
  overflowWrap: "anywhere",
};

export function TrackerPillList(p: TrackerPillListProps) {
  const controlled = p.expanded !== undefined && p.onExpandedChange !== undefined;
  const [internal, setInternal] = useState(p.expanded === true);
  const expanded = controlled ? p.expanded === true : internal;
  const ids = useId();

  const events = p.events;
  const total = events.length;
  const collapsible = total > TRACKER_COLLAPSE_AFTER;
  const runs = trackerRuns(events);

  function toggle() {
    const next = !expanded;
    if (!controlled) setInternal(next);
    p.onExpandedChange?.(next);
  }

  // A collapsible list splits every run at the fifth event: the part above
  // the control keeps its headers, and a run that continues below it is the
  // same run, labelled by the same header, so it draws none twice.
  const split = collapsible ? TRACKER_COLLAPSED_VISIBLE : total;
  const above: ReactNode[] = [];
  const below: ReactNode[] = [];
  runs.forEach((run, n) => {
    const headerId = `${ids}-run-${n}`;
    const head = run.rows.filter((row) => row.index < split);
    const tail = run.rows.filter((row) => row.index >= split);
    const header = run.header ? <RunHeader header={run.header} id={headerId} /> : null;
    const labelledBy = run.header ? headerId : undefined;
    if (head.length > 0) {
      above.push(
        <div key={n} style={{ minWidth: 0 }}>
          {header}
          <RunList rows={head} labelledBy={labelledBy} />
        </div>
      );
    }
    if (tail.length > 0) {
      below.push(
        <div key={n} style={{ minWidth: 0 }}>
          {head.length > 0 ? null : header}
          <RunList rows={tail} labelledBy={labelledBy} />
        </div>
      );
    }
  });

  const refusals = new Map<string, { count: number; sentence: string }>();
  for (const event of events) {
    const item = trackerItem(event.url);
    if (item.ok) continue;
    const sentence = refusalSentence(item);
    const seen = refusals.get(sentence);
    if (seen) seen.count += 1;
    else refusals.set(sentence, { count: 1, sentence });
  }

  return (
    <section
      aria-label={`Tracker changes, ${total}`}
      data-tracker-list=""
      style={{ boxSizing: "border-box", width: "100%", minWidth: 0, display: "flex", flexDirection: "column" }}
    >
      <div
        style={{
          font: `600 10px/1.4 ${font.mono}`,
          color: color.inkMute,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
        }}
      >
        {`Tracker · ${total} ${total === 1 ? "change" : "changes"}`}
      </div>
      {above}
      {collapsible ? (
        <button
          type="button"
          className="bk-control"
          data-tracker-more=""
          aria-expanded={expanded}
          onClick={toggle}
          style={{
            boxSizing: "border-box",
            width: "100%",
            minHeight: 44,
            margin: 0,
            padding: "0 10px",
            border: "none",
            borderRadius: 9,
            background: "transparent",
            color: color.inkDim,
            font: `600 11px/1 ${font.mono}`,
            cursor: "pointer",
            ...({
              "--hv-bg": token("hover-veil-firm"),
              "--hv-bd": "transparent",
              "--hv-fg": color.ink,
            } as CSSProperties),
          }}
        >
          {expanded ? "Show fewer" : `Show all ${total} changes`}
        </button>
      ) : null}
      {collapsible && expanded ? below : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 6 }}>
        <p data-tracker-honesty="" style={footNote}>
          Changes as reported by the brain · tracker not checked
        </p>
        {[...refusals.values()].map(({ count, sentence }) => (
          <p key={sentence} data-tracker-refusal="" style={footNote}>
            {`${count === 1 ? "1 address" : `${count} addresses`} withheld: ${sentence}.`}
          </p>
        ))}
      </div>
    </section>
  );
}
