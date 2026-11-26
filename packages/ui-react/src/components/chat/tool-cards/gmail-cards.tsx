// The host Gmail tools' read results as the ui-kit Gmail components (#4210).
//
// The components are #4209's, used unchanged. This file maps payloads onto
// them (through `../renderers/gmail-mapping.ts`) and owns the one fetch they
// trigger: a cut message's full body from #4207's display-only route, only
// after the reader presses "Show the rest". What loads is this card's own
// state: nothing here reaches the chat store, the socket or the model.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Callout,
  GmailLabels,
  GmailMessage,
  GmailResultList,
  GmailThread,
  type GmailBodyDetail,
  type GmailContentMessage,
  type GmailDetailState,
} from "@schlessera/brain-ui-kit";
import { GMAIL_TOOL_NAMES, type GmailContentMessagePayload, type GoogleToolError, type GoogleToolResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import { useBrainUiRoot, useRootStore } from "../../../root-context.js";
import { fetchGmailMessageBody } from "../../../lib/gmail-details.js";
import { contentMessage, contentThread, detailErrorState, gmailDate, restOfBody, structuredMessage, structuredThread, type DateFor } from "../renderers/gmail-mapping.js";

/** A search row shows the day; a message shows the day and the time. */
const dayOnly: DateFor = (iso) => gmailDate(iso, { time: false });
const withTime: DateFor = (iso) => gmailDate(iso, { time: true });

// ---------------------------------------------------------------------------
// The rest of a cut body (#4207's display-only route)
// ---------------------------------------------------------------------------

interface BodyDetail {
  state: GmailDetailState;
  /** The text after what Brain read, once loaded. */
  rest?: string;
  restTruncated?: boolean;
}

/**
 * The on-demand rest of each cut message in one card, keyed by message id.
 * Nothing is fetched until the reader presses Load; a retry repeats the
 * request. The rest is shown only when the full body begins with exactly the
 * text the tool result carried (`restOfBody`); otherwise the message reads
 * as unavailable and nothing is spliced. With no chat to scope the request
 * to, a cut body offers no rest at all.
 */
function useBodyDetails(): (message: GmailContentMessagePayload) => GmailBodyDetail | undefined {
  const root = useBrainUiRoot();
  const sessionId = useRootStore("chat", (s) => s.activeSessionId);
  const [details, setDetails] = useState<Readonly<Record<string, BodyDetail>>>({});
  // Only the latest request per message may answer, and none after unmount.
  const tickets = useRef(new Map<string, number>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);

  const load = useCallback(
    async (message: GmailContentMessagePayload) => {
      if (!sessionId) return;
      const id = message.message_id;
      const ticket = (tickets.current.get(id) ?? 0) + 1;
      tickets.current.set(id, ticket);
      setDetails((d) => ({ ...d, [id]: { state: "loading" } }));
      const answer = await fetchGmailMessageBody(root, { sessionId, messageId: id });
      if (!mounted.current || tickets.current.get(id) !== ticket) return;
      let next: BodyDetail;
      if (!answer.ok) next = { state: detailErrorState(answer.error.code) };
      else {
        const rest = restOfBody(message.untrusted.body_text, answer.body);
        next = rest ? { state: "loaded", rest: rest.rest, restTruncated: rest.truncated } : { state: "unavailable" };
      }
      setDetails((d) => ({ ...d, [id]: next }));
    },
    [root, sessionId],
  );

  return (message) => {
    if (!message.untrusted.body_truncated || !sessionId) return undefined;
    const detail = details[message.message_id] ?? { state: "idle" };
    return { ...detail, onLoad: () => void load(message), onRetry: () => void load(message) };
  };
}

function withDetail(message: GmailContentMessagePayload, detailFor: ReturnType<typeof useBodyDetails>): GmailContentMessage {
  const detail = detailFor(message);
  return { ...contentMessage(message, withTime), ...(detail ? { detail } : {}) };
}

function ContentThread({ messages }: { messages: readonly GmailContentMessagePayload[] }) {
  const detailFor = useBodyDetails();
  return <GmailThread view="content" messages={messages.map((m) => withDetail(m, detailFor))} />;
}

function ContentMessage({ message }: { message: GmailContentMessagePayload }) {
  const detailFor = useBodyDetails();
  return <GmailMessage view="content" message={withDetail(message, detailFor)} />;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A tool refusal in the result's own words, as GitHub's are drawn. */
function GmailRefusal({ error }: { error: GoogleToolError }) {
  return <Callout tone={error.code === "rate_limited" ? "gold" : "red"} variant="boxed" icon="failed" text={error.message} />;
}

/**
 * `brain_google_gmail_search`'s result. The page carries no query, so the
 * query is the tool call's own input.
 */
export function GmailSearchCard({ result, query }: { result: GoogleToolResult; query: string | null }) {
  if (!result.ok) return <GmailRefusal error={result.error} />;
  if (result.tool !== GMAIL_TOOL_NAMES.search) return null;
  const page = result.result;
  const nextPage = page.next_cursor !== null;
  return page.view === "structured" ? (
    <GmailResultList view="structured" query={query} nextPage={nextPage} threads={page.threads.map((hit) => structuredThread(hit, dayOnly))} />
  ) : (
    <GmailResultList view="content" query={query} nextPage={nextPage} threads={page.threads.map((hit) => contentThread(hit, dayOnly))} />
  );
}

/**
 * `brain_google_gmail_read`'s result: a thread or a message in its view, or
 * the account's labels. A draft has no kit component yet, so it keeps the
 * caller's fallback.
 */
export function GmailReadCard({ result, fallback }: { result: GoogleToolResult; fallback: ReactNode }) {
  if (!result.ok) return <GmailRefusal error={result.error} />;
  if (result.tool !== GMAIL_TOOL_NAMES.read) return null;
  const read = result.result;
  switch (read.kind) {
    case "thread":
      return read.view === "structured" ? (
        <GmailThread view="structured" messages={read.messages.map((m) => structuredMessage(m, withTime))} />
      ) : (
        <ContentThread messages={read.messages} />
      );
    case "message":
      return read.view === "structured" ? <GmailMessage view="structured" message={structuredMessage(read.message, withTime)} /> : <ContentMessage message={read.message} />;
    case "labels":
      return <GmailLabels labels={read.labels.map(({ id, name }) => ({ id, name }))} />;
    case "draft":
      return <>{fallback}</>;
  }
}
