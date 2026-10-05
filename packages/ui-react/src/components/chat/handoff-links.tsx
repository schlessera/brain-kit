import { useState } from "react";
import { Icon, Label } from "@schlessera/brain-ui-kit";
import { parseHandoffText } from "@schlessera/brain-ui-sdk/protocol";
import { useChatStore } from "../../stores/chat-store.js";
import { useHandoffStore } from "../../stores/handoff-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useOpenSession } from "../../hooks/use-open-session.js";
import { linkifyPaths } from "./brain-markdown-links.js";

/** A backend's id as a reader sees it: the first profile label it serves, else the id. */
export function useBackendName(): (backendId: string | undefined) => string {
  const available = useProviderStore((s) => s.available);
  return (backendId) => {
    if (!backendId) return "another backend";
    return available.find((profile) => profile.backendId === backendId)?.label ?? backendId;
  };
}

const LINK =
  "inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50";

/**
 * A handoff destination's first user message (#61), drawn as a card rather
 * than a bubble: where it came from with a way back, the reviewed summary,
 * the references it was given, and the one sentence that keeps the
 * provenance honest — this chat knows only what the card says.
 */
export function HandoffCard({ content }: { content: string }) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const source = useHandoffStore((s) => (sessionId ? s.from[sessionId] : undefined));
  const backendName = useBackendName();
  const openSession = useOpenSession();
  const [expanded, setExpanded] = useState(false);
  const { summary, references } = parseHandoffText(content);
  const long = summary.split("\n").length > 3 || summary.length > 280;
  const title = source?.title || "the earlier chat";

  return (
    <section
      aria-label="Handoff"
      data-handoff-card=""
      className="w-full max-w-xl rounded-xl border border-border bg-surface p-4 text-left shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label text="Handoff from" icon="history" />
          <div className="mt-1 truncate text-sm text-foreground">
            {title}
            {source?.backendId ? <span className="text-muted-foreground"> · {backendName(source.backendId)}</span> : null}
          </div>
        </div>
        {source ? (
          <button
            type="button"
            className={`${LINK} -mr-2 -mt-2 shrink-0`}
            aria-label={`Open source chat: ${title}`}
            onClick={() => openSession(source.sessionId)}
          >
            Open <Icon icon="next" size={14} />
          </button>
        ) : null}
      </div>

      <div
        className={`chat-message-body mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground ${long && !expanded ? "line-clamp-3" : ""}`}
      >
        {linkifyPaths(summary)}
      </div>
      {long ? (
        <button type="button" className={`${LINK} -ml-2`} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show all"}
        </button>
      ) : null}

      {references.length > 0 ? (
        <ul aria-label="References" className="mt-2 flex flex-wrap gap-1.5">
          {references.map((path) => (
            <li key={path} className="rounded-md border border-border px-2 py-1 font-mono text-[11px] text-foreground">
              {linkifyPaths(path)}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-3 text-xs text-muted-foreground">This chat only knows what is in this card.</p>
    </section>
  );
}

/**
 * The source's forward marker (#61): a row where the conversation was
 * continued elsewhere, linking to the new chat. The source stays usable;
 * the row keeps its place when the conversation goes on.
 */
export function HandoffMarker({ sessionId, backendId, title }: { sessionId: string; backendId?: string; title: string | null }) {
  const openSession = useOpenSession();
  const backendName = useBackendName();
  const where = backendName(backendId);
  return (
    <div role="note" data-handoff-marker="" className="my-2 flex items-center gap-3 text-xs text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <button
        type="button"
        className={LINK}
        aria-label={`Continued in a new chat on ${where}: open`}
        title={title ?? undefined}
        onClick={() => openSession(sessionId)}
      >
        Continued in a new chat on {where} <Icon icon="next" size={14} />
      </button>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
