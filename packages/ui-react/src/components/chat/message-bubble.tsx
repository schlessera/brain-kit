import { AttachmentRow } from "@schlessera/brain-ui-kit";
import { trackRowProps } from "../../lib/track-attachment.js";
import { HandoffCard } from "./handoff-links.js";
import { AskUserFormExchangeCard } from "./ask-user-form-card.js";
import type { AskUserFormAnswers } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { memo, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type {
  ChatMessage,
  ToolCall,
  MessagePart,
  AskUserExchange,
} from "../../stores/chat-store.js";
import type { AskUserAnnotation } from "@schlessera/brain-ui-sdk/protocol";
import { ToolCallTimeline } from "./tool-call-timeline.js";
import { MarkdownContent } from "./markdown-content.js";
import { linkifyPaths } from "./brain-markdown.js";
import { AskUserCard } from "./ask-user-card.js";
import { AskUserRankExchangeCard } from "./ask-user-rank-card.js";
import { AskUserListExchangeCard } from "./ask-user-list-card.js";
import { isAskExchangeTool, isShowBlockTool } from "../../lib/tool-names.js";
import { StatsAnswer } from "./stats/stats-answer.js";
import { LocalExchangeNote } from "./local-exchange-note.js";
import { BlockCard } from "./tool-cards/block-card.js";
import { AnswerSuggestions } from "./answer-suggestions.js";
import { SHOW_BLOCK_CONTRACT, parseToolPayload, type ShowBlockPayload } from "@schlessera/brain-ui-sdk/client";
import { motion, useReducedMotion } from "framer-motion";
import { buildMessageShareOptions } from "./message-share.js";
import { ShareMenu } from "../share/share-menu.js";
import { ZoomableImage } from "../images/zoomable-image.js";
import {
  AttachmentCount,
  RetryIndicator,
  ThinkingBlock,
  ThinkingIndicator,
  TurnHeader,
  UserTurn,
} from "./transcript-turn.js";
import { TurnError } from "./turn-error.js";
import { AnswerDeliveryStatus } from "./answer-delivery-status.js";
import { answerAsMessage, UNCONFIRMED_RECORD, withSubmittedAnswer } from "./answer-text.js";
import { isRefusedAdmission } from "../../lib/answer-delivery/types.js";
import { useChatStore } from "../../stores/chat-store.js";

/**
 * One message in the transcript.
 *
 * Memoized, and the memo is load-bearing rather than a micro-optimisation: the
 * chat store replaces only the message it touches, so every OTHER message keeps
 * its object identity across a store write. Without the memo, one streamed
 * token re-rendered — and re-parsed the markdown of — the whole conversation.
 *
 * The contract that keeps it working: every callback prop must be stable.
 * ChatPage wraps all three in useCallback for exactly this reason.
 *
 * This is the container (S7): it reads the message, groups its parts and
 * routes the tool timelines, ask cards and markdown; the frame — header,
 * user bubble, thinking disclosure, the streaming dot — is
 * `transcript-turn.tsx`, on the kit.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  onToolApproval,
  onAskUserSubmit,
  onAskUserCancel,
  onAskUserReask,
  onAskUserListSubmit,
  onAskUserRankSubmit,
  onAskUserFormSubmit,
  closing = false,
  anchor,
}: {
  message: ChatMessage;
  /** Its place in the transcript, which a reload keeps (#1014): where the reader was is restored by it. */
  anchor?: string;
  onToolApproval: (toolUseId: string, approved: boolean) => void;
  onAskUserSubmit: (
    requestId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserAnnotation>
  ) => void;
  onAskUserCancel: (requestId: string) => void;
  /** A dismissed question asked again answers by composer message. */
  onAskUserReask?: (text: string) => void;
  /** An `ask_user_rank` answered: every item id in order. */
  onAskUserFormSubmit?: (requestId: string, answers: AskUserFormAnswers, visibleNodes: string[]) => void;
  onAskUserRankSubmit?: (requestId: string, order: string[], unchanged: boolean) => void;
  /** An `ask_user_list` answered: answers and notes keyed by item id. */
  onAskUserListSubmit: (
    requestId: string,
    answers: Record<string, string>,
    notes?: Record<string, string>
  ) => void;
  /**
   * This is the session's last message, so it may carry the answer's
   * closing row (#40). False for every other message, so the memo holds.
   */
  closing?: boolean;
}) {
  const root = useBrainUiRoot();
  const isUser = message.role === "user";
  const reducedMotion = useReducedMotion();
  const shellStartedAt = useShellStartedAt(message);

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="py-4"
      data-transcript-anchor={anchor}
    >
      <TurnHeader
        who={isUser ? "You" : root.config.assistantName}
        when={message.turnShell ? (shellStartedAt !== null ? formatTime(shellStartedAt) : undefined) : formatTime(message.timestamp)}
        voice={isUser && (message.source === "voice-dictate" || message.source === "voice-conversation") ? message.source : undefined}
        effort={isUser && message.thinkingLevel !== undefined ? (
          message.effectiveThinkingLevel === undefined ? `effort ${message.thinkingLevel} requested` :
          message.effectiveThinkingLevel === message.thinkingLevel ? `effort ${message.thinkingLevel}` :
          `effort ${message.thinkingLevel} → ${message.effectiveThinkingLevel} (backend)`
        ) : undefined}
        tone={isUser ? "user" : "brain"}
      />

      {/* Content */}
      {isUser && message.source === "handoff" ? (
        <HandoffCard content={message.content} />
      ) : isUser ? (
        <UserTurn>
          <UserAttachments message={message} />
          {!!message.files?.length && <div className="grid gap-2">{message.files.map(file => <AttachmentRow key={file.path} {...trackRowProps(file)} />)}</div>}
          {message.content && (
            <div className="chat-message-body text-sm leading-relaxed text-foreground whitespace-pre-wrap">
              {linkifyPaths(message.content)}
            </div>
          )}
        </UserTurn>
      ) : (
        <AssistantContent
          message={message}
          onToolApproval={onToolApproval}
          onAskUserSubmit={onAskUserSubmit}
          onAskUserCancel={onAskUserCancel}
          onAskUserReask={onAskUserReask}
          onAskUserListSubmit={onAskUserListSubmit}
          onAskUserRankSubmit={onAskUserRankSubmit}
          onAskUserFormSubmit={onAskUserFormSubmit}
          closing={closing}
        />
      )}
    </motion.div>
  );
});

/**
 * User-message image attachments. Live messages render real thumbnails from
 * their local object URLs; resumed-from-history messages carry only a count,
 * so they get a neutral "N image(s)" chip instead.
 */
function UserAttachments({ message }: { message: ChatMessage }) {
  if (message.attachments && message.attachments.length > 0) {
    return (
      <div className="flex flex-wrap gap-2">
        {message.attachments.map((a, i) => (
          // Zoomable: the thumbnail is an object-cover crop, so the full frame
          // is not even visible until it opens.
          <ZoomableImage
            key={i}
            src={a.previewUrl}
            alt="Attached image"
            toolbar={false}
            className="h-20 w-20 cursor-zoom-in rounded-lg border border-border/60 object-cover"
          />
        ))}
      </div>
    );
  }

  if (message.attachmentCount && message.attachmentCount > 0) {
    return <AttachmentCount count={message.attachmentCount} />;
  }

  return null;
}

/**
 * Render groups: consecutive `tool` parts collapse into one timeline run so
 * back-to-back tool calls share a single visual timeline, while thinking and
 * text stay interleaved in true chronological order.
 */
type PartGroup =
  | { kind: "thinking"; text: string; isLast: boolean }
  | { kind: "text"; text: string; isLast: boolean; isLastText: boolean; textIndex: number }
  | { kind: "tools"; toolCalls: ToolCall[]; isLast: boolean }
  | { kind: "askUser"; exchange: AskUserExchange; isLast: boolean }
  | { kind: "block"; payload: ShowBlockPayload; isLast: boolean };

/**
 * Pair each ask tool part with its exchange. By request id first: the
 * exchange's id IS the tool call's id on both backends (#910), and matching by
 * position put a live card under the wrong call whenever the order differed.
 * By position only for an exchange whose id names no tool call here (an
 * older host's minted id), so nothing that has a call is taken out of turn.
 * Whatever is left renders trailing, so a prompt is never lost.
 */
export function matchAskExchanges(
  parts: MessagePart[],
  toolCalls: ToolCall[],
  askUserExchanges: AskUserExchange[] | undefined
): { byPart: Map<number, AskUserExchange>; unmatched: AskUserExchange[] } {
  const exchanges = askUserExchanges ?? [];
  const byPart = new Map<number, AskUserExchange>();
  const askParts: Array<{ index: number; id: string }> = [];
  parts.forEach((part, index) => {
    if (part.kind !== "tool") return;
    const tool = toolCalls[part.toolIndex];
    if (tool && isAskExchangeTool(tool.name)) askParts.push({ index, id: tool.id });
  });
  const callIds = new Set(askParts.map((p) => p.id));
  const used = new Set<AskUserExchange>();
  for (const { index, id } of askParts) {
    const exchange = exchanges.find((e) => !used.has(e) && e.requestId === id);
    if (exchange) {
      used.add(exchange);
      byPart.set(index, exchange);
    }
  }
  for (const { index } of askParts) {
    if (byPart.has(index)) continue;
    const exchange = exchanges.find((e) => !used.has(e) && !callIds.has(e.requestId));
    if (!exchange) continue;
    used.add(exchange);
    byPart.set(index, exchange);
  }
  return { byPart, unmatched: exchanges.filter((e) => !used.has(e)) };
}

function groupParts(
  parts: MessagePart[],
  toolCalls: ToolCall[],
  askUserExchanges: AskUserExchange[] | undefined
): PartGroup[] {
  const groups: PartGroup[] = [];
  // ask_user tool parts don't join the tool timeline — each maps to its
  // exchange and renders as its own AskUserCard at that chronological spot,
  // so it collapses and scrolls away like the surrounding events.
  const { byPart } = matchAskExchanges(parts, toolCalls, askUserExchanges);
  let partIndex = -1;
  // Ordinal among TEXT parts: classified blocks (D42) are anchored to it.
  let textSeen = 0;
  for (const part of parts) {
    partIndex++;
    if (part.kind === "tool") {
      const tool = toolCalls[part.toolIndex];
      if (!tool) continue;
      if (isAskExchangeTool(tool.name)) {
        const exchange = byPart.get(partIndex);
        // The exchange may not have arrived yet mid-stream — skip until it does.
        if (exchange) {
          groups.push({ kind: "askUser", exchange, isLast: false });
        }
        continue;
      }
      if (isShowBlockTool(tool.name)) {
        // A block is part of the answer, not a step in the trace (D41): it
        // renders inline where it was called. Until the echo arrives, and
        // when it does not parse (a rejected call, an older server), the
        // call stays in the timeline, where its bound fallback states why.
        const payload = parseToolPayload(SHOW_BLOCK_CONTRACT, tool.output);
        // Suggestions are the one exception (D50): not part of the answer
        // but an offer after it, drawn in the closing row, so their call
        // position draws nothing — neither a block nor a trace step.
        if (payload?.block.kind === "suggestions") continue;
        if (payload) {
          groups.push({ kind: "block", payload, isLast: false });
          continue;
        }
      }
      const last = groups[groups.length - 1];
      if (last?.kind === "tools") {
        last.toolCalls.push(tool);
      } else {
        groups.push({ kind: "tools", toolCalls: [tool], isLast: false });
      }
    } else if (part.text.trim()) {
      if (part.kind === "text") {
        groups.push({ kind: "text", text: part.text, isLast: false, isLastText: false, textIndex: textSeen++ });
      } else {
        groups.push({ kind: "thinking", text: part.text, isLast: false });
      }
    } else if (part.kind === "text") {
      // An all-whitespace text part still counts toward the ordinal.
      textSeen++;
    }
  }
  const last = groups[groups.length - 1];
  if (last) last.isLast = true;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.kind === "text") {
      g.isLastText = true;
      break;
    }
  }
  return groups;
}

/** The classified blocks anchored to the n-th text part, or nothing. */
function blocksFor(message: ChatMessage, textIndex: number) {
  if (!message.blocks || message.blocks.length === 0) return undefined;
  const own = message.blocks.filter((b) => b.partIndex === textIndex);
  return own.length ? own : undefined;
}

function AssistantContent({
  message,
  onToolApproval,
  onAskUserSubmit,
  onAskUserCancel,
  onAskUserReask,
  onAskUserListSubmit,
  onAskUserRankSubmit,
  onAskUserFormSubmit,
  closing,
}: {
  message: ChatMessage;
  onToolApproval: (toolUseId: string, approved: boolean) => void;
  onAskUserSubmit: (
    requestId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserAnnotation>
  ) => void;
  onAskUserCancel: (requestId: string) => void;
  /** A dismissed question asked again answers by composer message. */
  onAskUserReask?: (text: string) => void;
  /** An `ask_user_rank` answered: every item id in order. */
  onAskUserFormSubmit?: (requestId: string, answers: AskUserFormAnswers, visibleNodes: string[]) => void;
  onAskUserRankSubmit?: (requestId: string, order: string[], unchanged: boolean) => void;
  /** An `ask_user_list` answered: answers and notes keyed by item id. */
  onAskUserListSubmit: (
    requestId: string,
    answers: Record<string, string>,
    notes?: Record<string, string>
  ) => void;
  closing: boolean;
}) {
  const root = useBrainUiRoot();
  const contentRef = useRef<HTMLDivElement>(null);
  const showShare =
    !message.isStreaming && !!message.content && message.content.trim().length > 0;
  const shareOptions = showShare
    ? buildMessageShareOptions(root, {
        message,
        renderedRef: contentRef,
      })
    : [];

  const groups = groupParts(
    message.parts,
    message.toolCalls,
    message.askUserExchanges
  );

  // Safety net: an exchange without a matching tool part — e.g. a stream that
  // missed the tool_use_start — would otherwise vanish, stranding an
  // unanswerable prompt. Render those trailing so a prompt is never lost.
  const unmatchedExchanges = matchAskExchanges(
    message.parts,
    message.toolCalls,
    message.askUserExchanges
  ).unmatched;

  // One exchange, one card, selected by its requested answer shape, with the
  // delivery of a submitted answer under it (#910).
  const renderExchange = (ex: AskUserExchange, key: string | number) => (
    <DeliveredExchange
      key={key}
      exchange={ex}
      onAskUserSubmit={onAskUserSubmit}
      onAskUserCancel={onAskUserCancel}
      onAskUserReask={onAskUserReask}
      onAskUserListSubmit={onAskUserListSubmit}
      onAskUserRankSubmit={onAskUserRankSubmit}
      onAskUserFormSubmit={onAskUserFormSubmit}
    />
  );

  return (
    <div className="space-y-3">
      {message.statsAnswer ? <StatsAnswer sections={message.statsAnswer} /> : null}
      {message.localExchange ? <LocalExchangeNote exchange={message.localExchange} /> : null}
      {groups.map((group, i) => {
        switch (group.kind) {
          case "thinking":
            return (
              <ThinkingSection
                key={i}
                content={group.text}
                isStreaming={message.isStreaming && group.isLast}
              />
            );
          case "tools":
            return (
              <ToolCallTimeline
                key={i}
                toolCalls={group.toolCalls}
                onApproval={onToolApproval}
                live={message.isStreaming}
              />
            );
          case "block":
            return <BlockCard key={i} {...group.payload} />;
          case "askUser":
            return renderExchange(group.exchange, i);
          case "text":
            // The final text block carries the share affordance; text/markdown
            // share formats still use the full message content.
            return group.isLastText ? (
              <div key={i} className="group relative" ref={contentRef}>
                {/* The share menu is deliberately OUTSIDE the skip-render
                    wrapper: content-visibility implies paint containment,
                    which would clip a dropdown that opens past the box. */}
                <div className="chat-message-body">
                  <MarkdownContent
                    content={group.text}
                    blocks={blocksFor(message, group.textIndex)}
                    streaming={message.isStreaming && group.isLast}
                  />
                </div>
                {showShare && shareOptions.length > 0 && (
                  <div className="mt-1 flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <ShareMenu options={shareOptions} title="Share message" />
                  </div>
                )}
              </div>
            ) : (
              <div key={i} className="chat-message-body">
                <MarkdownContent
                  content={group.text}
                  blocks={blocksFor(message, group.textIndex)}
                  streaming={message.isStreaming && group.isLast}
                />
              </div>
            );
        }
      })}

      {unmatchedExchanges.map((ex) => renderExchange(ex, ex.requestId))}

      {/* The failure that ended the turn (#575), after whatever it answered
          first, live and on replay alike. */}
      {message.failure && !message.isStreaming ? <TurnError message={message} latest={closing} /> : null}

      {message.isStreaming && message.retry && <RetryIndicator retry={message.retry} />}

      {message.isStreaming &&
        !message.retry &&
        groups.length === 0 &&
        unmatchedExchanges.length === 0 && <ThinkingIndicator />}

      {/* One closing row per answer (D37 §8, D50): the follow-ups the model
          offered, after everything else, until the next user message. */}
      {closing && <AnswerSuggestions message={message} />}
    </div>
  );
}

function ThinkingSection({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  const [expanded, setExpanded] = useState(isStreaming);
  // Auto-collapse when the thinking finishes: the blurb is process, not
  // product — the answer below it is what the reader is waiting for. It stays
  // reopenable via the collapsed "Thought for ~N tokens" button.
  const prevStreaming = useRef(isStreaming);
  useEffect(() => {
    if (prevStreaming.current && !isStreaming) setExpanded(false);
    prevStreaming.current = isStreaming;
  }, [isStreaming]);

  return (
    <ThinkingBlock
      content={linkifyPaths(content)}
      chars={content.length}
      streaming={isStreaming}
      open={expanded}
      onOpenChange={setExpanded}
    />
  );
}

/**
 * A turn shell's header time (#1072, D52 §4): the host's `startedAt` for its
 * turn, when the recovery envelope's latest turn is that turn. Otherwise
 * none: the shell was drawn on this page's clock, which is not the turn's.
 */
function useShellStartedAt(message: ChatMessage): number | null {
  const root = useBrainUiRoot();
  const sessionId = useChatStore((s) => s.activeSessionId);
  return useStore(root.stores.trackers, (s) => {
    if (!message.turnShell || !message.turnId || sessionId === null || s.recoverySupported !== true) return null;
    const latest = s.evidence[sessionId]?.latest;
    return latest && latest.turnId === message.turnId ? latest.startedAt : null;
  });
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * One ask card and, once an answer was submitted, where that answer stands.
 *
 * The answer stays visible in every delivery state (design §3). A card
 * rebuilt from history after a reload knows only the question; the queue
 * still holds what the user submitted, so the card shows that, read-only.
 * When nothing was admitted (the queue was full, or this device could not
 * save it) the card stays editable, with its draft intact.
 */
function DeliveredExchange({
  exchange,
  onAskUserSubmit,
  onAskUserCancel,
  onAskUserReask,
  onAskUserListSubmit,
  onAskUserRankSubmit,
  onAskUserFormSubmit,
}: {
  exchange: AskUserExchange;
  onAskUserSubmit: (requestId: string, answers: Record<string, string>, annotations?: Record<string, AskUserAnnotation>) => void;
  onAskUserCancel: (requestId: string) => void;
  onAskUserReask?: (text: string) => void;
  onAskUserFormSubmit?: (requestId: string, answers: AskUserFormAnswers, visibleNodes: string[]) => void;
  onAskUserRankSubmit?: (requestId: string, order: string[], unchanged: boolean) => void;
  onAskUserListSubmit: (requestId: string, answers: Record<string, string>, notes?: Record<string, string>) => void;
}) {
  const delivery = useChatStore((s) => s.deliveries[exchange.requestId]);
  // While saving, or when nothing was admitted, the editable card stays
  // mounted with its draft; otherwise it shows the submitted answer.
  const shown = delivery && delivery.state !== "saving" && !isRefusedAdmission(delivery.state);
  const ex = shown ? withSubmittedAnswer(exchange, delivery) : exchange;
  // A recorded answer the host has not confirmed must not read "Answered".
  const record = shown && delivery.state !== "answered" ? UNCONFIRMED_RECORD : undefined;
  const card = (
      ex.form ? (
        <AskUserFormExchangeCard record={record} requestId={ex.requestId} form={ex.form} answers={ex.formAnswers} cancelled={ex.cancelled} answeredAt={ex.answeredAt} onSubmit={onAskUserFormSubmit} onCancel={onAskUserCancel} onReask={onAskUserReask} />
      ) : ex.rank ? (
        <AskUserRankExchangeCard record={record} requestId={ex.requestId} rank={ex.rank} order={ex.order} unchanged={ex.unchanged}
          cancelled={ex.cancelled} answeredAt={ex.answeredAt} onSubmit={onAskUserRankSubmit} onCancel={onAskUserCancel} onReask={onAskUserReask} />
      ) : ex.list ? (
        <AskUserListExchangeCard
          record={record}
          requestId={ex.requestId}
          list={ex.list}
          answered={ex.answers}
          notes={ex.notes}
          cancelled={ex.cancelled}
          answeredAt={ex.answeredAt}
          onSubmit={onAskUserListSubmit}
          onCancel={onAskUserCancel}
          onReask={onAskUserReask}
        />
      ) : (
        <AskUserCard
          record={record}
          requestId={ex.requestId}
          questions={ex.questions}
          answered={ex.answers}
          cancelled={ex.cancelled}
          typed={ex.typed}
          answeredAt={ex.answeredAt}
          onSubmit={onAskUserSubmit}
          onCancel={onAskUserCancel}
          onReask={onAskUserReask}
        />
      )
  );
  // A question still waiting for its answer: nothing submitted, or nothing
  // admitted, and not dismissed. A press of Chat focuses its first control
  // (D52 N3).
  const waiting = (!delivery || isRefusedAdmission(delivery.state)) && !exchange.cancelled
    && exchange.answers === undefined && exchange.order === undefined && exchange.formAnswers === undefined;
  // One wrapper whether or not a delivery exists: a card that moved into a
  // new parent when its footer appeared would remount, and a refused
  // answer's draft would be lost with it.
  return (
    <div data-ask-waiting={waiting ? "" : undefined}>
      {card}
      {delivery ? (
        <AnswerDeliveryStatus
          delivery={delivery}
          answerText={() => answerAsMessage(exchange, delivery.payload)}
          onSendAsMessage={onAskUserReask}
        />
      ) : null}
    </div>
  );
}
