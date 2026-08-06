import type { ReactNode } from "react";

/** A key cap for inline keyboard hints ("↵ to open"). */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-surface-raised px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}
