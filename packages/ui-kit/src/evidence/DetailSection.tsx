import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "../primitives/Button.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { Placeholder } from "../states/Placeholder.js";
import { accent, color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * `DetailSection` — a part of an object loaded only when the reader asks,
 * from the service the object came from (#3800, design #3795 §7; shared by
 * the Gmail components under ruling G2 of #4209). The host owns the client
 * and passes the section's `state`; the kit draws it. `GitHubDetailSection`
 * is this section with `source="GitHub"`.
 *
 * | state           | shows |
 * |-----------------|-------|
 * | `idle`          | the load button; "Loads from {source} when you ask. Brain won't see it." |
 * | `loading`       | ghost rows; static under reduced motion |
 * | `loaded`        | the rows, "Load more" while `moreLabel` is set, and "Loaded for you · Brain hasn't read these" |
 * | `empty`         | "{source} returned no {noun} for this {object}." |
 * | `error`         | the failure and its status, and Try again |
 * | `rate-limited`  | when the limit resets, and Try again after that time (enabled) |
 * | `no-credential` | no access to the source is set up |
 * | `unavailable`   | the source can't be reached from this brain right now (Gmail's `unavailable`) |
 * | `gone`          | the source no longer shows the object to this brain |
 *
 * Display-only honesty: what loads here is for the reader. The section says
 * so, and the "Brain read" line on the object never changes.
 *
 * Focus: Load more moves focus to the first new row once it arrives. A
 * failure, empty or unavailable state is announced politely, once, through
 * one live region that changes only when the state does.
 */
type DetailState = "idle" | "loading" | "loaded" | "empty" | "error" | "rate-limited" | "no-credential" | "unavailable" | "gone";

interface DetailSectionProps {
  state: DetailState;
  /** Where the part loads from, as the reader knows it: "GitHub", "Gmail". */
  source: string;
  /** What loads: "commits", "comments", "the rest of this message". Also the group's name. */
  noun: string;
  /** The object it belongs to: "pull request", "issue", "message". */
  object: string;
  /** The idle button: "Show commits · 4 of 112 in result". */
  idleLabel: string;
  /** The loaded state's Load more: "Load 30 more · 32 of 112 shown". Absent once everything has loaded. */
  moreLabel?: string;
  /** `error`: what the source answered, e.g. 502. Absent when there was no answer. */
  errorStatus?: number | string;
  /** `rate-limited`: the wall-clock time the limit resets ("14:32"), and how long until then ("12 min"). */
  resetAt?: string;
  resetIn?: string;
  /** How the loaded note names what loaded: "these" rows (the default) or "this" one text. */
  pronoun?: "these" | "this";
  /** Its buttons reach 44px under a coarse pointer (`Button`'s `reach`). Off by default, as GitHub's are. */
  reach?: boolean;
  /** The attribute that carries the state on the section, for the host's tests: `data-github-detail`. */
  attribute?: `data-${string}`;
  /** The loaded rows. */
  children?: ReactNode;
  onLoad?: () => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
}

/** Mono meta text under a control. */
const META: CSSProperties = {
  font: `400 10.5px/1.5 ${font.mono}`,
  color: color.inkMute,
};

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

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function DetailSection(p: DetailSectionProps) {
  const rows = useRef<HTMLDivElement>(null);
  const pending = useRef<number | null>(null);
  const source = p.source;

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
      ? `Couldn't load ${p.noun}.${p.errorStatus !== undefined ? ` ${source} answered ${p.errorStatus}.` : ""}`
      : p.state === "rate-limited"
        ? `${source}'s request limit is used up.${p.resetAt ? ` It resets at ${p.resetAt}.` : ""}`
        : p.state === "empty"
          ? `${source} returned no ${p.noun} for this ${p.object}.`
          : p.state === "no-credential"
            ? `Details can't load: this brain has no ${source} access set up.`
            : p.state === "unavailable"
              ? `${capitalise(p.noun)} can't load: ${source} isn't available to this brain right now.`
              : p.state === "gone"
                ? `${source} no longer shows this ${p.object} to this brain.`
                : "";

  const hasRows = p.children !== undefined && p.children !== null && p.children !== false;
  const showRows = hasRows && (p.state === "loaded" || p.state === "loading" || p.state === "error" || p.state === "rate-limited");
  const marker = { [p.attribute ?? "data-detail"]: p.state };

  return (
    <div role="group" style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }} aria-label={p.noun} aria-busy={p.state === "loading" || undefined} {...marker}>
      <div role="status" className="bk-sr-only">
        {announcement}
      </div>

      {p.state === "idle" ? (
        <>
          <Button label={p.idleLabel} tone="ghost" size="md" reach={p.reach} onClick={p.onLoad} />
          <div style={META}>{`Loads from ${source} when you ask. Brain won't see it.`}</div>
        </>
      ) : null}

      {showRows ? (
        <div ref={rows} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          {p.children}
        </div>
      ) : null}

      {p.state === "loading" ? (
        <Placeholder variant="loading" lines={3} bordered={false} seed={`${source.toLowerCase()}-${p.noun}`} message={`Loading ${p.noun} from ${source}…`} pad={0} />
      ) : null}

      {p.state === "loaded" ? (
        <>
          {p.moreLabel ? <Button label={p.moreLabel} tone="ghost" size="md" reach={p.reach} onClick={loadMore} /> : null}
          <div style={META}>{`Loaded for you · Brain hasn't read ${p.pronoun ?? "these"}`}</div>
        </>
      ) : null}

      {p.state === "empty" ? (
        <Notice tone="neutral" glyph="—">
          {`${source} returned no `}{p.noun} for this {p.object}.
        </Notice>
      ) : null}

      {p.state === "error" ? (
        <>
          <Notice tone="red" icon="deny">
            Couldn't load {p.noun}.{p.errorStatus !== undefined ? ` ${source} answered ${p.errorStatus}.` : ` ${source} didn't answer.`}
          </Notice>
          <Button label="Try again" tone="ghost" size="md" reach={p.reach} onClick={p.onRetry} />
        </>
      ) : null}

      {p.state === "rate-limited" ? (
        <>
          <Notice tone="gold" icon="later">
            {`${source}'s request limit is used up.`}
            {p.resetAt ? ` It resets at ${p.resetAt}${p.resetIn ? ` (in ${p.resetIn})` : ""}.` : ""}
          </Notice>
          {/* Enabled on purpose: a press before the reset shows the same notice. */}
          <Button label={p.resetAt ? `Try again after ${p.resetAt}` : "Try again later"} tone="ghost" size="md" reach={p.reach} onClick={p.onRetry} />
        </>
      ) : null}

      {p.state === "no-credential" ? (
        <Notice tone="neutral" icon="not-planned">
          {`Details can't load: this brain has no ${source} access set up. What the tool returned is still shown above.`}
        </Notice>
      ) : null}

      {p.state === "unavailable" ? (
        <Notice tone="neutral" icon="not-planned">
          {`${capitalise(p.noun)} can't load: ${source} isn't available to this brain right now. What the tool returned is still shown above.`}
        </Notice>
      ) : null}

      {p.state === "gone" ? (
        <Notice tone="neutral" icon="not-planned">
          {`${source} no longer shows this `}{p.object} to this brain (removed, or access changed).
        </Notice>
      ) : null}
    </div>
  );
}
