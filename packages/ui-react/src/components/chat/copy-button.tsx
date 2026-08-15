import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** Hover-revealed copy button for code/diagram blocks (expects a `group` ancestor). */
export function CopyButton({ getText, className }: { getText: () => string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      // Icon-only: without these it has no accessible name at all.
      title={copied ? "Copied" : "Copy"}
      aria-label={copied ? "Copied" : "Copy"}
      onClick={() => {
        navigator.clipboard.writeText(getText());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className={
        className ??
        "absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-surface-raised/80 text-muted-foreground opacity-0 transition-all hover:bg-surface-overlay hover:text-foreground group-hover:opacity-100"
      }
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
