import { Chip, Disclosure, Icon, MessageBubble, StatusDot } from "@schlessera/brain-ui-kit";
import type { ReactNode } from "react";
import type { TurnRetry } from "@schlessera/brain-ui-sdk/protocol";
import { describeRetry } from "@schlessera/brain-ui-sdk/protocol";
import { cn } from "../../lib/utils.js";

/**
 * The pieces of one transcript turn that are pure presentation (S7, the
 * `chat` directory). `MessageBubble` in `message-bubble.tsx` stays the
 * memoized container that reads the message, groups its parts and routes
 * the tool timelines, ask cards and markdown; these draw the frame around
 * them on the kit.
 *
 * A user turn is the design's tucked bubble (kit `MessageBubble role="user"`,
 * right-aligned, one corner cut); a brain turn has no bubble — "the answer is
 * the page" — and the kit's decorative action row is off, because the app's
 * share menu is real and sits under the last text block. The thinking blurb
 * is a kit `Disclosure` whose summary says what is hidden ("Thought for ~N
 * tokens"), controlled by the container so it can auto-collapse when the
 * stream ends.
 */
export interface TurnHeaderProps {
  who: string;
  /** Mono time, already formatted. */
  when: string;
  /** The user turn came in by voice: which kind. */
  voice?: "voice-dictate" | "voice-conversation";
  tone: "user" | "brain";
}

export function TurnHeader(p: TurnHeaderProps) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <span
        className={cn(
          "select-none font-[family-name:var(--font-mono)] text-xs font-semibold uppercase tracking-widest",
          p.tone === "user" ? "text-primary/80" : "text-accent/80",
        )}
      >
        {p.who}
      </span>
      <div className="h-px flex-1 bg-border/40" />
      {p.voice && (
        <span
          role="img"
          aria-label={p.voice === "voice-conversation" ? "Voice conversation" : "Voice dictation"}
          className={p.voice === "voice-conversation" ? "flex text-primary/70" : "flex text-primary/50"}
        >
          <Icon icon="mic" size={12} />
        </span>
      )}
      <span className="font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/40">{p.when}</span>
    </div>
  );
}

/** The user's bubble: attachments above the text, both the container's. */
export function UserTurn({ children }: { children: ReactNode }) {
  return (
    <MessageBubble role="user" text="">
      <div className="space-y-2 text-left">{children}</div>
    </MessageBubble>
  );
}

/** A resumed message knows only how many images it carried. */
export function AttachmentCount({ count }: { count: number }) {
  return <Chip label={`${count} image${count === 1 ? "" : "s"}`} icon="image" variant="outline" tone="neutral" mono={false} />;
}

export interface ThinkingBlockProps {
  content: ReactNode;
  /** Roughly how much was thought; the collapsed summary's number. */
  chars: number;
  streaming: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ThinkingBlock(p: ThinkingBlockProps) {
  if (p.streaming) {
    return (
      <div className="rounded-lg bg-surface/50 px-4 py-3">
        <div className="font-[family-name:var(--font-mono)] text-xs italic leading-relaxed text-muted-foreground/60 whitespace-pre-wrap">
          {p.content}
          <span className="ml-1 inline-flex align-middle">
            <StatusDot tone="amber" pulse size={6} />
          </span>
        </div>
      </div>
    );
  }
  return (
    <Disclosure label={`Thought for ~${Math.round(p.chars / 4)} tokens`} icon="agent" open={p.open} onOpenChange={p.onOpenChange}>
      <div className="font-[family-name:var(--font-mono)] text-xs italic leading-relaxed text-muted-foreground/60 whitespace-pre-wrap">
        {p.content}
      </div>
    </Disclosure>
  );
}

/**
 * A failed model call the runtime is about to retry (#575): the same dot,
 * saying why the turn is waiting, so a backoff never reads as a hang.
 */
export function RetryIndicator({ retry }: { retry: TurnRetry }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      <StatusDot tone="amber" pulse size={6} />
      {describeRetry(retry)}
    </div>
  );
}

/** Nothing has arrived yet: the one breathing dot the design allows. */
export function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      <StatusDot tone="amber" pulse size={6} />
      Thinking...
    </div>
  );
}
