import type { CSSProperties, ReactNode } from "react";
import { classifyLink } from "../links.js";
import type { IconName } from "../primitives/Icon.js";
import { color, font } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * Shared pieces of the GitHub component family (#3800, design #3795).
 *
 * The family is presentational: props and callbacks only, no client, no
 * fetch, no stores. It never builds or repairs a GitHub URL. ui-react maps the
 * #3797 payload onto these props, and the host has already validated every
 * URL's shape; the kit re-checks the one thing it can, as defence in depth.
 */

/** A person named on GitHub. `login: null` is a deleted account, shown as `@ghost`. */
export interface GitHubPerson {
  login: string | null;
  /** GitHub's author association, as the reader should see it: "owner", "member", "none", "author". */
  association?: string | null;
  bot?: boolean;
  /**
   * A brain-origin proxy URL for the avatar (#3796). Any other origin is
   * refused and the initials stay; the kit never builds a GitHub URL.
   */
  avatarSrc?: string | null;
}

/**
 * A direct GitHub link's address, or `null` when it may not render.
 *
 * Only `https:` on host exactly `github.com`, with no userinfo and no port,
 * passes. The address must also pass `classifyLink`, which refuses hidden
 * and bidi characters. The kit does not validate the path or query shape
 * (#3797's validator does, applied by the host): it only refuses to render
 * a link anywhere else.
 */
export function githubHref(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  const verdict = classifyLink(raw);
  if (!verdict.ok || verdict.insecure || verdict.ip) return null;
  let url: URL;
  try {
    url = new URL(verdict.href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "" || url.username !== "" || url.password !== "") return null;
  return url.href;
}

/**
 * A direct link to GitHub: opens in a new tab with `noopener noreferrer`,
 * with no interstitial. Renders nothing unless `href` passes `githubHref`.
 * Used only in the slots the D2/D3 rulings allow.
 */
export function GitHubLink({ href, label = "GitHub", name, style }: { href: string | null | undefined; label?: string; name?: string; style?: CSSProperties }) {
  const safe = githubHref(href);
  if (!safe) return null;
  return (
    <a
      className="bk-text-btn"
      data-inline="true"
      data-github-link=""
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      aria-label={name ? `${name} on GitHub, opens in a new tab` : undefined}
      style={{ fontSize: 11.5, whiteSpace: "nowrap", ...style }}
    >
      {label}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

/** Every state the family shows, each as a glyph and a word; colour only reinforces. */
export type GitHubState =
  | "open"
  | "draft"
  | "merged"
  | "closed"
  | "completed"
  | "not-planned"
  | "approved"
  | "changes-requested"
  | "review-requested"
  | "commented"
  | "dismissed"
  | "failing"
  | "running"
  | "passed"
  | "none-reported"
  | "not-reported"
  | "not-posted"
  | "posted";

interface StateLook {
  word: string;
  /** Absent: the state draws a dash, the glyph for "nothing reported". */
  icon?: IconName;
  tone: Tone;
  dashed?: boolean;
  /** Text is dimmer than ink: closed issues, absent facts. */
  quiet?: boolean;
}

export const STATES: Record<GitHubState, StateLook> = {
  open: { word: "Open", icon: "issue-open", tone: "teal" },
  draft: { word: "Draft", icon: "draft", tone: "neutral", dashed: true },
  merged: { word: "Merged", icon: "pr-merged", tone: "purple" },
  closed: { word: "Closed · not merged", icon: "pr-closed", tone: "red" },
  completed: { word: "Closed · completed", icon: "issue-closed", tone: "neutral" },
  "not-planned": { word: "Closed · not planned", icon: "not-planned", tone: "neutral", quiet: true },
  approved: { word: "Approved", icon: "confirm", tone: "teal" },
  "changes-requested": { word: "Changes requested", icon: "changes-requested", tone: "red" },
  "review-requested": { word: "Requested · no review", icon: "review-pending", tone: "neutral", quiet: true },
  commented: { word: "Commented", icon: "chat", tone: "neutral" },
  dismissed: { word: "Dismissed", icon: "withdrawn", tone: "neutral", quiet: true },
  failing: { word: "failing", icon: "deny", tone: "red" },
  running: { word: "running", icon: "later", tone: "gold" },
  passed: { word: "passed", icon: "confirm", tone: "teal" },
  "none-reported": { word: "None reported", tone: "neutral", quiet: true },
  "not-reported": { word: "Not reported", tone: "neutral", quiet: true },
  "not-posted": { word: "Not posted", icon: "review-pending", tone: "neutral", dashed: true },
  posted: { word: "Posted", icon: "confirm", tone: "teal" },
};

/** The word for a state, with its count when one is given: "1 failing", "2 approved", "1 changes requested". */
export function stateWord(state: GitHubState, count?: number): string {
  const look = STATES[state];
  if (count === undefined) return look.word;
  if (state === "failing" || state === "running" || state === "passed") return `${count} ${look.word}`;
  if (state === "approved" || state === "changes-requested") return `${count} ${look.word.toLowerCase()}`;
  return look.word;
}

/** Two letters for an initials badge: "telemachus" → "TE", "ithaca-brain" → "IB". */
export function initials(login: string): string {
  const parts = login.split(/[-_.]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : Array.from(login).slice(0, 2).join("");
  return letters.toUpperCase();
}

/** Mono caps label over a fact or a section. */
export const CAPS: CSSProperties = {
  font: `500 9px/1.4 ${font.mono}`,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  color: color.inkMute,
};

/** Mono meta text: refs, shas, times. */
export const META: CSSProperties = {
  font: `400 10.5px/1.5 ${font.mono}`,
  color: color.inkMute,
};

/** A untrusted single-line field (title, branch, login): bidi-isolated, wraps anywhere. */
export function Field({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <bdi style={{ overflowWrap: "anywhere", ...style }} data-untrusted-field="">
      {children}
    </bdi>
  );
}

/** "Brain read: …", the line that says what the model saw. It never grows when the reader loads more. */
export function BrainRead({ text }: { text: string }) {
  return (
    <div style={{ ...META, padding: "8px 14px 10px", borderTop: `1px solid ${color.line}` }} data-brain-read="">
      Brain read: {text}
    </div>
  );
}
