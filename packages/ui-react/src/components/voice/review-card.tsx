import { Button } from "@schlessera/brain-ui-kit";
import { Mic } from "lucide-react";

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
      <div className="flex items-center justify-between gap-2 border-t border-border/40 px-2 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          <Button tone="quiet" size="sm" icon="dismiss" label="Discard" block={false} style={{ minHeight: 44 }} onClick={onDiscard} />
          <Button tone="quiet" size="sm" icon="edit" label="Edit" block={false} style={{ minHeight: 44 }} onClick={onEdit} />
          <Button tone="quiet" size="sm" icon="mic" label="Add" ariaLabel="Append more voice" block={false} style={{ minHeight: 44 }} onClick={onAppend} />
        </div>
        <Button tone="primary" size="md" icon="send" label="Send" block={false} style={{ minHeight: 44, flexShrink: 0 }} onClick={onSend} />
      </div>
    </div>
  );
}
