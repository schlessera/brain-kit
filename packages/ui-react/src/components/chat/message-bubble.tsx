import { uiConfig } from "../../config.js";
import { useRef, useState } from "react";
import { ChevronDown, Sparkles, Mic, Image as ImageIcon } from "lucide-react";
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

export function MessageBubble({
  message,
  onToolApproval,
  onAskUserSubmit,
  onAskUserCancel,
}: {
  message: ChatMessage;
  onToolApproval: (toolUseId: string, approved: boolean) => void;
  onAskUserSubmit: (
    requestId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserAnnotation>
  ) => void;
  onAskUserCancel: (requestId: string) => void;
}) {
  const isUser = message.role === "user";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="py-4"
    >
      {/* Label row */}
      <div className="mb-2 flex items-center gap-3">
        <span
          className={
            isUser
              ? "select-none font-[family-name:var(--font-mono)] text-xs font-semibold uppercase tracking-widest text-primary/80"
              : "select-none font-[family-name:var(--font-mono)] text-xs font-semibold uppercase tracking-widest text-accent/80"
          }
        >
          {isUser ? "You" : uiConfig.assistantName}
        </span>
        <div className="h-px flex-1 bg-border/40" />
        {isUser && message.source && message.source !== "typed" && (
          <Mic
            className={
              message.source === "voice-conversation"
                ? "h-3 w-3 text-primary/70"
                : "h-3 w-3 text-primary/50"
            }
            aria-label={
              message.source === "voice-conversation"
                ? "Voice conversation"
                : "Voice dictation"
            }
          />
        )}
        <span className="font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/40">
          {formatTime(message.timestamp)}
        </span>
      </div>

      {/* Content */}
      {isUser ? (
        <div className="space-y-2">
          <UserAttachments message={message} />
          {message.content && (
            <div className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
              {linkifyPaths(message.content)}
            </div>
          )}
        </div>
      ) : (
        <AssistantContent
          message={message}
          onToolApproval={onToolApproval}
          onAskUserSubmit={onAskUserSubmit}
          onAskUserCancel={onAskUserCancel}
        />
      )}
    </motion.div>
  );
}

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
          <img
            key={i}
            src={a.previewUrl}
            alt="Attached image"
            className="h-20 w-20 rounded-lg border border-border/60 object-cover"
          />
        ))}
      </div>
    );
  }

  if (message.attachmentCount && message.attachmentCount > 0) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-lg border border-border/40 bg-surface/50 px-2.5 py-1 text-xs text-muted-foreground">
        <ImageIcon className="h-3.5 w-3.5" />
        {message.attachmentCount} image{message.attachmentCount === 1 ? "" : "s"}
      </div>
    );
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
}: {
  message: ChatMessage;
  onToolApproval: (toolUseId: string, approved: boolean) => void;
  onAskUserSubmit: (
    requestId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserAnnotation>
  ) => void;
  onAskUserCancel: (requestId: string) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const showShare =
    !message.isStreaming && !!message.content && message.content.trim().length > 0;
  const shareOptions = showShare
    ? buildMessageShareOptions({
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
                live={message.isStreaming}
                onSubmit={onAskUserSubmit}
                onCancel={onAskUserCancel}
              />
            );
          case "text":
            // The final text block carries the share affordance; text/markdown
            // share formats still use the full message content.
            return group.isLastText ? (
              <div key={i} className="group relative" ref={contentRef}>
                <MarkdownContent content={group.text} />
                {showShare && shareOptions.length > 0 && (
                  <div className="mt-1 flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <ShareMenu options={shareOptions} title="Share message" />
                  </div>
                )}
              </div>
            ) : (
              <MarkdownContent key={i} content={group.text} />
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
          live={message.isStreaming}
          onSubmit={onAskUserSubmit}
          onCancel={onAskUserCancel}
        />
      ))}

      {message.isStreaming && groups.length === 0 && unmatchedExchanges.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
            style={{ animation: "breathe 2s ease-in-out infinite" }}
          />
          Thinking...
        </div>
      )}
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

  if (!isStreaming && !expanded) {
    // Collapsed: minimal clickable text
    const estimatedTokens = Math.round(content.length / 4);
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground/50 transition-colors hover:text-muted-foreground"
      >
        <Sparkles className="h-3 w-3" />
        <span className="font-[family-name:var(--font-mono)]">
          Thought for ~{estimatedTokens} tokens
        </span>
        <ChevronDown className="h-3 w-3" />
      </button>
    );
  }

  return (
    <div className="rounded-lg bg-surface/50 px-4 py-3">
      {!isStreaming && (
        <button
          onClick={() => setExpanded(false)}
          className="mb-2 text-[11px] font-medium text-muted-foreground/50 transition-colors hover:text-muted-foreground"
        >
          Hide thinking
        </button>
      )}
      <div className="font-[family-name:var(--font-mono)] text-xs leading-relaxed text-muted-foreground/60 italic whitespace-pre-wrap">
        {linkifyPaths(content)}
        {isStreaming && (
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-primary ml-1"
            style={{ animation: "breathe 2s ease-in-out infinite" }}
          />
        )}
      </div>
    </div>
  );
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
