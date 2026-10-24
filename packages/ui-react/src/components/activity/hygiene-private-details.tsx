import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { HygieneWorktreeDetails, InboxActionItem } from "@schlessera/brain-ui-sdk/protocol";
import { hygieneWorktreeDetailsReadSchema } from "@schlessera/brain-ui-sdk/schemas";
import { Callout, Placeholder, TextButton, color, font } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { useInboxStore } from "../../stores/inbox-store.js";
import { formatWhen } from "./inbox-model.js";
import type { HygieneController } from "./hygiene-review.js";

type View =
  | { state: "closed" }
  | { state: "loading" }
  | { state: "loaded"; details: HygieneWorktreeDetails }
  | { state: "changed" | "gone" | "offline" | "failed" };

const MESSAGES = {
  changed: "This worktree changed since the card was shown. Refresh the finding to see current details.",
  gone: "This finding is no longer open. There's nothing to show.",
  offline: "Can't reach your brain right now.",
  failed: "Couldn't load the details. Nothing was changed.",
} as const;
const label: CSSProperties = { margin: 0, font: `500 10px/1.5 ${font.mono}`, color: color.inkMute, letterSpacing: "0.04em" };
const value: CSSProperties = { margin: 0, minWidth: 0, font: `400 12px/1.5 ${font.body}`, color: color.ink, overflowWrap: "anywhere" };
const mono: CSSProperties = { ...value, font: `400 11.5px/1.5 ${font.mono}` };

/** Focus the card's title, or the strip when the card itself is gone. */
function focusAfterInvalidation(itemId: string) {
  requestAnimationFrame(() => {
    const card = [...document.querySelectorAll<HTMLElement>("[data-hygiene-id]")].find((el) => el.dataset.hygieneId === itemId);
    const target =
      card?.querySelector<HTMLElement>("[data-hygiene-title]") ??
      document.querySelector<HTMLElement>("[data-hygiene-strip] button, [data-hygiene-limit] button");
    if (target && (document.activeElement === document.body || document.activeElement === null)) target.focus();
  });
}

function Rows({ details: d }: { details: HygieneWorktreeDetails }) {
  const total = d.changedPaths;
  const count =
    total === null
      ? "Not established yet"
      : total === 0
      ? "None"
      : d.sample.length < total
      ? `${total} in total · first ${d.sample.length} shown`
      : `${total} in total`;
  return (
    <>
      <dl data-hygiene-private-rows="" className="grid grid-cols-1 gap-x-4 gap-y-1 @[480px]/hygiene-details:grid-cols-[max-content_minmax(0,1fr)] @[480px]/hygiene-details:gap-y-2">
        <dt style={label}>OWNED BY</dt>
        <dd style={value}>{d.owner ? `${d.owner.label} (${d.owner.kind})` : "Removed principal"}</dd>
        <dt style={label}>REPOSITORY</dt>
        <dd style={mono}>{d.repository ?? "Not recorded"}</dd>
        <dt style={label}>REVISION</dt>
        <dd style={mono}>{d.revision ?? "Not recorded"}</dd>
        <dt style={label}>STARTING COMMIT</dt>
        <dd style={{ ...mono, wordBreak: "break-all" }}>{d.commit ?? "Not recorded"}</dd>
        <dt style={label}>CHANGED PATHS</dt>
        <dd style={value}>
          {count}
          {total !== null && total > 0 && d.sample.length ? (
            <ul className="m-0 list-none p-0">
              {d.sample.map((path, i) => (
                <li key={i} style={mono}>
                  {path}
                </li>
              ))}
            </ul>
          ) : null}
          {d.unverifiedPaths ? (
            <span className="block" style={{ color: color.inkDim }}>
              {d.unverifiedPaths} {d.unverifiedPaths === 1 ? "path" : "paths"} couldn't be compared.
            </span>
          ) : null}
        </dd>
      </dl>
      <p style={{ ...label, letterSpacing: 0 }}>
        {d.assessedAt === null ? "Assessment time unknown." : `As recorded ${formatWhen(d.assessedAt)}.`}
      </p>
    </>
  );
}

/**
 * The owner-only private details of a managed-worktree card (#2734). The host
 * says per request whether this reader may see them; they are fetched only when
 * opened, kept in this component's memory only and dropped on every collapse,
 * card change, disconnect or refusal.
 */
export function HygienePrivateDetails({ item, controller: c }: { item: InboxActionItem; controller: HygieneController }) {
  const root = useBrainUiRoot();
  const online = useInboxStore((s) => s.online);
  const [view, setView] = useState<View>({ state: "closed" });
  const [announcement, setAnnouncement] = useState("");
  const request = useRef(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const regionId = useId();
  const open = view.state !== "closed";

  /** Drop everything held, and discard any reply still in flight. */
  function clear(refocus: boolean) {
    request.current++;
    const inside = !!region.current?.contains(document.activeElement);
    setView({ state: "closed" });
    setAnnouncement("");
    if (refocus && inside) focusAfterInvalidation(item.id);
  }
  async function load() {
    const token = ++request.current;
    setView({ state: "loading" });
    setAnnouncement("");
    let next: View;
    try {
      const reply = hygieneWorktreeDetailsReadSchema.safeParse(await root.api.hygieneDetails(item.id));
      if (token !== request.current) return;
      next = !reply.success ? { state: "failed" } : reply.data.status === "details" ? { state: "loaded", details: reply.data.details } : { state: reply.data.status };
    } catch (error) {
      if (token !== request.current) return;
      const status = error instanceof Error && "status" in error ? (error as { status: unknown }).status : undefined;
      // The account changed or locked: the existing sign-in flow takes over.
      if ((error instanceof Error && error.name === "AbortError") || status === 401) return clear(false);
      if (status === 403) {
        // Refused: collapse, let the next review read remove the toggle, and return to the card.
        clear(false);
        focusAfterInvalidation(item.id);
        void c.refresh();
        return;
      }
      next = { state: status === undefined || !root.stores.inbox.getState().online ? "offline" : "failed" };
    }
    setView(next);
    setAnnouncement(next.state === "loaded" ? "Private details shown" : next.state in MESSAGES ? MESSAGES[next.state as keyof typeof MESSAGES] : "");
  }
  // A dropped connection may come back as another principal.
  useEffect(() => {
    if (!online) clear(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);
  // Unmounting (another card, version, pause, completion or sign-out) discards
  // the reply and, if focus was inside, hands it to the card or the strip.
  useLayoutEffect(() => {
    const id = item.id, node = wrapper.current;
    return () => {
      request.current++;
      if (node?.contains(document.activeElement)) focusAfterInvalidation(id);
    };
  }, [item.id]);

  const body =
    view.state === "loading" ? (
      <div role="group" aria-label="Loading private details">
        <Placeholder variant="loading" lines={5} bordered={false} pad={0} />
      </div>
    ) : view.state === "loaded" ? (
      <Rows details={view.details} />
    ) : view.state === "changed" ? (
      <>
        <Callout tone="gold" text={MESSAGES.changed} />
        <TextButton label="Refresh finding" onClick={() => void c.command("refresh")} />
      </>
    ) : view.state === "gone" ? (
      <Callout tone="neutral" text={MESSAGES.gone} />
    ) : view.state === "offline" || view.state === "failed" ? (
      <>
        <Callout tone={view.state === "failed" ? "red" : "neutral"} text={MESSAGES[view.state]} />
        <TextButton label="Try again" onClick={() => void load()} />
      </>
    ) : null;
  return (
    <div ref={wrapper} data-hygiene-private-details="" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-2">
        <TextButton
          tone="meta"
          icon={open ? "collapse" : "next"}
          label="Private details"
          expanded={open}
          controls={regionId}
          onClick={() => (open ? clear(false) : void load())}
        />
        <span style={{ font: `400 10.5px/1.5 ${font.mono}`, color: color.inkMute, overflowWrap: "anywhere" }}>
          Owner only · not sent to other devices or agents
        </span>
      </div>
      <div
        ref={region}
        id={regionId}
        role="region"
        aria-label="Private details"
        aria-busy={view.state === "loading" || undefined}
        hidden={!open}
        className="@container/hygiene-details min-w-0"
        style={{ display: open ? "flex" : "none", flexDirection: "column", gap: 8, borderLeft: `2px solid ${color.line}`, paddingLeft: 12 }}
      >
        {body}
      </div>
      <p role="status" className="bk-sr-only">
        {announcement}
      </p>
    </div>
  );
}
