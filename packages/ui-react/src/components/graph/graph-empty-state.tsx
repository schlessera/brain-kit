import { Waypoints, RefreshCw, ServerCrash, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Full-canvas cards for the states where there is no scene to draw:
 * server too old, repo indexed by a pre-graph CLI, graph not yet computed,
 * plain fetch failures, and mode-specific "nothing here" messages.
 */
export function GraphEmptyState({
  icon = "graph",
  title,
  children,
}: {
  icon?: "graph" | "sync" | "server" | "warn";
  title: string;
  children?: ReactNode;
}) {
  const Icon =
    icon === "sync"
      ? RefreshCw
      : icon === "server"
        ? ServerCrash
        : icon === "warn"
          ? TriangleAlert
          : Waypoints;
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border border-border bg-surface px-8 py-10 text-center">
        <Icon className="h-8 w-8 text-muted-foreground" />
        <h2 className="font-display text-lg text-foreground">{title}</h2>
        {children && (
          <div className="text-xs leading-relaxed text-muted-foreground">{children}</div>
        )}
      </div>
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </code>
  );
}
