import { Mic } from "lucide-react";
import { cn } from "../../lib/utils.js";

export function MicButton({
  active,
  disabled,
  onTap,
}: {
  active: boolean;
  disabled?: boolean;
  onTap: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      disabled={disabled}
      title={active ? "Stop dictation" : "Voice dictation"}
      aria-label={active ? "Stop dictation" : "Voice dictation"}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-150",
        active
          ? "bg-primary text-primary-foreground animate-pulse"
          : "text-muted-foreground hover:bg-surface-raised hover:text-foreground",
        disabled && "opacity-30 cursor-not-allowed"
      )}
    >
      <Mic className="h-4 w-4" />
    </button>
  );
}
