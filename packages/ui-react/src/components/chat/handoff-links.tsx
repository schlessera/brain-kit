import { useState } from "react";
import { Label, TextButton } from "@schlessera/brain-ui-kit";
import { parseHandoffText } from "@schlessera/brain-ui-sdk/protocol";
import { useChatStore } from "../../stores/chat-store.js";
import { useHandoffStore } from "../../stores/handoff-store.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { useOpenSession } from "../../hooks/use-open-session.js";
import { linkifyPaths } from "./brain-markdown-links.js";

/**
 * A backend's id as a reader sees it: the first runnable profile label it
 * serves, else the first configured one that cannot run (#1090), else the id.
 */
export function useBackendName(): (backendId: string | undefined) => string {
  const available = useProviderStore((s) => s.available);
  const unavailable = useProviderStore((s) => s.unavailable);
  return (backendId) => {
    if (!backendId) return "another backend";
    return available.find((profile) => profile.backendId === backendId)?.label
      ?? unavailable.find((profile) => profile.backendId === backendId)?.label
      ?? backendId;
  };
}

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
          <TextButton tone="link" label="Open" iconEnd="next"
            style={{ marginRight: -8, marginTop: -8, flexShrink: 0 }}
            ariaLabel={`Open source chat: ${title}`} onClick={() => openSession(source.sessionId)} />
        ) : null}
      </div>

      <div
        className={`chat-message-body mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground ${long && !expanded ? "line-clamp-3" : ""}`}
      >
        {linkifyPaths(summary)}
      </div>
      {long ? (
        <TextButton tone="link" label={expanded ? "Show less" : "Show all"}
          style={{ marginLeft: -8 }} expanded={expanded} onClick={() => setExpanded((v) => !v)} />
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
      <span title={title ?? undefined}>
        <TextButton tone="link" label={`Continued in a new chat on ${where}`} iconEnd="next"
          ariaLabel={`Continued in a new chat on ${where}: open`} onClick={() => openSession(sessionId)} />
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
