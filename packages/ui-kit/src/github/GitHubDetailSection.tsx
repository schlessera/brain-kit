import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "../primitives/Button.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { Placeholder } from "../states/Placeholder.js";
import { accent, color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";
import { META } from "./shared.js";

/**
 * `GitHubDetailSection` — a part of a GitHub object loaded only when the
 * reader asks (#3800, design #3795 §7). ui-react owns the #3796 client and
 * passes the section's `state`; the kit draws it.
 *
 * | state           | design | shows |
 * |-----------------|--------|-------|
 * | `idle`          | S0     | the load button; "Loads from GitHub when you ask. Brain won't see it." |
 * | `loading`       | S1     | ghost rows; static under reduced motion |
 * | `loaded`        | S2     | the rows, "Load more" while `moreLabel` is set, and "Loaded for you · Brain hasn't read these" |
 * | `empty`         | S3     | "GitHub returned no {noun} for this {object}." |
 * | `error`         | S4     | the failure and its status, and Try again |
 * | `rate-limited`  | S5     | when the limit resets, and Try again after that time (enabled) |
 * | `no-credential` | S6     | no GitHub access is set up |
 * | `gone`          | S7     | GitHub no longer shows the object to this brain |
 *
 * Display-only honesty: what loads here is for the reader. The section says
 * so, and the "Brain read" line on the object never changes.
 *
 * Focus: Load more moves focus to the first new row once it arrives. A
 * failure, empty or unavailable state is announced politely, once, through
 * one live region that changes only when the state does.
 */
export type GitHubDetailState = "idle" | "loading" | "loaded" | "empty" | "error" | "rate-limited" | "no-credential" | "gone";

export interface GitHubDetailSectionProps {
  state: GitHubDetailState;
  /** What loads, plural: "commits", "comments", "files", "checks". */
  noun: string;
  /** The object it belongs to: "pull request", "issue". */
  object: string;
  /** S0's button: "Show commits · 4 of 112 in result". */
  idleLabel: string;
  /** S2's Load more: "Load 30 more · 32 of 112 shown". Absent once everything has loaded. */
  moreLabel?: string;
  /** S4: what GitHub answered, e.g. 502. Absent when there was no answer. */
  errorStatus?: number | string;
  /** S5: the wall-clock time the limit resets ("14:32"), and how long until then ("12 min"). */
  resetAt?: string;
  resetIn?: string;
  /** The rows: `GitHubCommitRow`s, `GitHubComment`s, file or check rows. */
  children?: ReactNode;
  onLoad?: () => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
}

function Notice({ tone, icon, glyph, children }: { tone: Tone; icon?: IconName; glyph?: string; children: ReactNode }) {
  const toned = tone !== "neutral";
  const box: CSSProperties = {
    display: "flex",
    gap: 6,
    alignItems: "flex-start",
    padding: "9px 11px",
    borderRadius: 8,
    border: `1px solid ${toned ? token(`chip-border-${tone}`) : color.line}`,
    background: toned ? token(`chip-tint-${tone}`) : "transparent",
    font: `400 12px/1.5 ${font.body}`,
    color: color.ink,
  };
  return (
    <div style={box}>
      <span aria-hidden="true" style={{ display: "inline-flex", paddingTop: 2, color: toned ? accent[tone].ink : color.inkMute }}>
        {icon ? <Icon icon={icon} size={12} /> : glyph}
      </span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

export function GitHubDetailSection(p: GitHubDetailSectionProps) {
  const rows = useRef<HTMLDivElement>(null);
  const pending = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = rows.current;
    if (pending.current === null || !el || p.state !== "loaded") return;
    const first = el.children[pending.current] as HTMLElement | undefined;
    if (!first) return;
    pending.current = null;
    if (!first.matches("a[href],button,input,select,textarea,[tabindex]")) first.tabIndex = -1;
    first.focus();
  }, [p.children, p.state]);

  const loadMore = () => {
    pending.current = rows.current?.children.length ?? null;
    p.onLoadMore?.();
  };

  const announcement =
    p.state === "error"
      ? `Couldn't load ${p.noun}.${p.errorStatus !== undefined ? ` GitHub answered ${p.errorStatus}.` : ""}`
      : p.state === "rate-limited"
        ? `GitHub's request limit is used up.${p.resetAt ? ` It resets at ${p.resetAt}.` : ""}`
        : p.state === "empty"
          ? `GitHub returned no ${p.noun} for this ${p.object}.`
          : p.state === "no-credential"
            ? "Details can't load: this brain has no GitHub access set up."
            : p.state === "gone"
              ? `GitHub no longer shows this ${p.object} to this brain.`
              : "";

  const hasRows = p.children !== undefined && p.children !== null && p.children !== false;
  const showRows = hasRows && (p.state === "loaded" || p.state === "loading" || p.state === "error" || p.state === "rate-limited");

  return (
    <div role="group" style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }} aria-label={p.noun} aria-busy={p.state === "loading" || undefined} data-github-detail={p.state}>
      <div role="status" className="bk-sr-only">
        {announcement}
      </div>

      {p.state === "idle" ? (
        <>
          <Button label={p.idleLabel} tone="ghost" size="md" onClick={p.onLoad} />
          <div style={META}>Loads from GitHub when you ask. Brain won't see it.</div>
        </>
      ) : null}

      {showRows ? (
        <div ref={rows} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          {p.children}
        </div>
      ) : null}

      {p.state === "loading" ? (
        <Placeholder variant="loading" lines={3} bordered={false} seed={`github-${p.noun}`} message={`Loading ${p.noun} from GitHub…`} pad={0} />
      ) : null}

      {p.state === "loaded" ? (
        <>
          {p.moreLabel ? <Button label={p.moreLabel} tone="ghost" size="md" onClick={loadMore} /> : null}
          <div style={META}>Loaded for you · Brain hasn't read these</div>
        </>
      ) : null}

      {p.state === "empty" ? (
        <Notice tone="neutral" glyph="—">
          GitHub returned no {p.noun} for this {p.object}.
        </Notice>
      ) : null}

      {p.state === "error" ? (
        <>
          <Notice tone="red" icon="deny">
            Couldn't load {p.noun}.{p.errorStatus !== undefined ? ` GitHub answered ${p.errorStatus}.` : " GitHub didn't answer."}
          </Notice>
          <Button label="Try again" tone="ghost" size="md" onClick={p.onRetry} />
        </>
      ) : null}

      {p.state === "rate-limited" ? (
        <>
          <Notice tone="gold" icon="later">
            GitHub's request limit is used up.
            {p.resetAt ? ` It resets at ${p.resetAt}${p.resetIn ? ` (in ${p.resetIn})` : ""}.` : ""}
          </Notice>
          {/* Enabled on purpose: a press before the reset shows the same notice. */}
          <Button label={p.resetAt ? `Try again after ${p.resetAt}` : "Try again later"} tone="ghost" size="md" onClick={p.onRetry} />
        </>
      ) : null}

      {p.state === "no-credential" ? (
        <Notice tone="neutral" icon="not-planned">
          Details can't load: this brain has no GitHub access set up. What the tool returned is still shown above.
        </Notice>
      ) : null}

      {p.state === "gone" ? (
        <Notice tone="neutral" icon="not-planned">
          GitHub no longer shows this {p.object} to this brain (removed, or access changed).
        </Notice>
      ) : null}
    </div>
  );
}
