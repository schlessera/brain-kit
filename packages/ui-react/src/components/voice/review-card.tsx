import { Mic, Pencil, Send, X } from "lucide-react";

export function ReviewCard({
  text,
  onSend,
  onEdit,
  onDiscard,
  onAppend,
}: {
  text: string;
  onSend: () => void;
  onEdit: () => void;
  onDiscard: () => void;
  onAppend: () => void;
}) {
  if (!text) return null;
  return (
    <div className="mb-2 rounded-2xl border border-primary/30 bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.3)]">
      <div className="flex items-start gap-3 px-4 pt-3 pb-2">
        <Mic className="mt-0.5 h-4 w-4 flex-none text-primary" />
        <p className="max-h-40 flex-1 overflow-y-auto text-sm leading-relaxed text-foreground">
          {text}
        </p>
      </div>
      <div className="flex items-center justify-between border-t border-border/40 px-2 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onDiscard}
            title="Discard"
            className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs text-muted-foreground transition-colors hover:bg-surface-raised hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
            Discard
          </button>
          <button
            type="button"
            onClick={onEdit}
            title="Edit"
            className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </button>
          <button
            type="button"
            onClick={onAppend}
            title="Append more voice"
            className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            <Mic className="h-3.5 w-3.5" />
            Add
          </button>
        </div>
        <button
          type="button"
          onClick={onSend}
          className="flex h-10 items-center gap-2 rounded-xl bg-primary-fill px-5 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-[0.98]"
        >
          <Send className="h-4 w-4" />
          Send
        </button>
      </div>
    </div>
  );
}
