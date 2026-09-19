import { useBrainUiRoot } from "../../root-context.js";
import { memo, useEffect, useRef, useState } from "react";
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
import { isAskUserTool } from "../../lib/tool-names.js";
import { motion } from "framer-motion";
import { buildMessageShareOptions } from "./message-share.js";
import { ShareMenu } from "../share/share-menu.js";
import { ZoomableImage } from "../images/zoomable-image.js";
import { AttachmentCount, ThinkingBlock, ThinkingIndicator, TurnHeader, UserTurn } from "./transcript-turn.js";

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
}) {
  const root = useBrainUiRoot();
  const isUser = message.role === "user";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="py-4"
    >
      <TurnHeader
        who={isUser ? "You" : root.config.assistantName}
        when={formatTime(message.timestamp)}
        voice={isUser && message.source && message.source !== "typed" ? message.source : undefined}
        tone={isUser ? "user" : "brain"}
      />

      {/* Content */}
      {isUser ? (
        <UserTurn>
          <UserAttachments message={message} />
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
  | { kind: "text"; text: string; isLast: boolean; isLastText: boolean }
  | { kind: "tools"; toolCalls: ToolCall[]; isLast: boolean }
  | { kind: "askUser"; exchange: AskUserExchange; isLast: boolean };

function groupParts(
  parts: MessagePart[],
  toolCalls: ToolCall[],
  askUserExchanges: AskUserExchange[] | undefined
): PartGroup[] {
  const groups: PartGroup[] = [];
  // ask_user tool parts don't join the tool timeline — each maps (in order)
  // to its exchange and renders as its own AskUserCard at that chronological
  // spot, so it collapses and scrolls away like the surrounding events.
  let askUserSeen = 0;
  for (const part of parts) {
    if (part.kind === "tool") {
      const tool = toolCalls[part.toolIndex];
      if (!tool) continue;
      if (isAskUserTool(tool.name)) {
        const exchange = askUserExchanges?.[askUserSeen];
        askUserSeen++;
        // The exchange may not have arrived yet mid-stream — skip until it does.
        if (exchange) {
          groups.push({ kind: "askUser", exchange, isLast: false });
        }
        continue;
      }
      const last = groups[groups.length - 1];
      if (last?.kind === "tools") {
        last.toolCalls.push(tool);
      } else {
        groups.push({ kind: "tools", toolCalls: [tool], isLast: false });
      }
    } else if (part.text.trim()) {
      groups.push({ kind: part.kind, text: part.text, isLast: false, isLastText: false });
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

function AssistantContent({
  message,
  onToolApproval,
  onAskUserSubmit,
  onAskUserCancel,
  onAskUserReask,
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
}) {
  const root = useBrainUiRoot();
  const contentRef = useRef<HTMLDivElement>(null);
  const showShare =
    !message.isStreaming && !!message.content && message.content.trim().length > 0;
  const shareOptions = showShare
    ? buildMessageShareOptions(root, {
        content: message.content,
        renderedRef: contentRef,
      })
    : [];

  const groups = groupParts(
    message.parts,
    message.toolCalls,
    message.askUserExchanges
  );

  // Safety net: each ask_user tool part consumes one exchange (by order) into a
  // chronological group above. Any exchange without a matching tool part — e.g.
  // a stream that missed the tool_use_start — would otherwise vanish, stranding
  // an unanswerable prompt. Render those trailing so a prompt is never lost.
  const askUserSlots = message.parts.reduce(
    (n, p) =>
      p.kind === "tool" && isAskUserTool(message.toolCalls[p.toolIndex]?.name)
        ? n + 1
        : n,
    0
  );
  const unmatchedExchanges = (message.askUserExchanges ?? []).slice(askUserSlots);

  return (
    <div className="space-y-3">
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
          case "askUser":
            return (
              <AskUserCard
                key={i}
                requestId={group.exchange.requestId}
                questions={group.exchange.questions}
                answered={group.exchange.answers}
                cancelled={group.exchange.cancelled}
                typed={group.exchange.typed}
                answeredAt={group.exchange.answeredAt}
                onSubmit={onAskUserSubmit}
                onCancel={onAskUserCancel}
                onReask={onAskUserReask}
              />
            );
          case "text":
            // The final text block carries the share affordance; text/markdown
            // share formats still use the full message content.
            return group.isLastText ? (
              <div key={i} className="group relative" ref={contentRef}>
                {/* The share menu is deliberately OUTSIDE the skip-render
                    wrapper: content-visibility implies paint containment,
                    which would clip a dropdown that opens past the box. */}
                <div className="chat-message-body">
                  <MarkdownContent content={group.text} />
                </div>
                {showShare && shareOptions.length > 0 && (
                  <div className="mt-1 flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <ShareMenu options={shareOptions} title="Share message" />
                  </div>
                )}
              </div>
            ) : (
              <div key={i} className="chat-message-body">
                <MarkdownContent content={group.text} />
              </div>
            );
        }
      })}

      {unmatchedExchanges.map((ex) => (
        <AskUserCard
          key={ex.requestId}
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
      ))}

      {message.isStreaming && groups.length === 0 && unmatchedExchanges.length === 0 && <ThinkingIndicator />}
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

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
