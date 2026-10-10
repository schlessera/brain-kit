import { useBrainUiRoot } from "../../root-context.js";
import { useEffect, useRef, useState } from "react";
import { Share2, Loader2, Check, AlertCircle } from "lucide-react";
import { cn } from "../../lib/utils.js";

export interface ShareOption {
  id: string;
  label: string;
  /** Optional short hint shown below the label. */
  hint?: string;
  /** Async action: returns true on success, false on user-cancel. */
  run: () => Promise<boolean>;
}

interface ShareMenuProps {
  options: ShareOption[];
  /** Aria label / tooltip for the trigger button. */
  title?: string;
  /** When provided, override the default icon button with a custom trigger. */
  className?: string;
  /**
   * Optional render-prop for a custom trigger. Receives the click handler plus
   * the status icon, so a custom trigger keeps the busy/done/error feedback
   * instead of silently swallowing it.
   */
  renderTrigger?: (props: {
    onClick: () => void;
    busy: boolean;
    status: Status;
    icon: React.ReactNode;
  }) => React.ReactNode;
}

type Status = "idle" | "busy" | "done" | "error";

export function ShareMenu({ options, title = "Share", className, renderTrigger }: ShareMenuProps) {
  const root = useBrainUiRoot();
  const lifetime = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    lifetime.current++;
    setOpen(false); setStatus("idle"); setError(null);
    const invalidate = () => { lifetime.current++; clearTimeout(timer.current); };
    return invalidate;
  }, [root]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Captured and stopped: an Escape that dismisses this menu must not also
      // reach whatever the menu is layered over (the diagram viewer closes on
      // Escape too, and dismissing both at once reads as a bug).
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // If there's only one option, the trigger should fire it directly.
  const single = options.length === 1 ? options[0] : null;

  const runOption = async (opt: ShareOption) => {
    const token = ++lifetime.current;
    clearTimeout(timer.current);
    setOpen(false);
    setStatus("busy");
    setError(null);
    try {
      const shared = await opt.run();
      if (token !== lifetime.current) return;
      setStatus(shared ? "done" : "idle");
      timer.current = setTimeout(() => { if (token === lifetime.current) setStatus("idle"); }, 1200);
    } catch (err) {
      if (token !== lifetime.current) return;
      console.error("[share-menu]", err);
      setError(err instanceof Error ? err.message : "Share failed");
      setStatus("error");
      timer.current = setTimeout(() => { if (token === lifetime.current) setStatus("idle"); }, 3000);
    }
  };

  const handleTrigger = () => {
    if (status === "busy") return;
    if (single) {
      void runOption(single);
      return;
    }
    setOpen((v) => !v);
  };

  const icon =
    status === "busy" ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
    ) : status === "done" ? (
      <Check className="h-3.5 w-3.5" />
    ) : status === "error" ? (
      <AlertCircle className="h-3.5 w-3.5 text-destructive" />
    ) : (
      <Share2 className="h-3.5 w-3.5" />
    );

  return (
    <div ref={wrapperRef} className={cn("relative inline-flex", className)}>
      {renderTrigger ? (
        renderTrigger({ onClick: handleTrigger, busy: status === "busy", status, icon })
      ) : (
        <button
          onClick={handleTrigger}
          disabled={status === "busy"}
          title={error ?? title}
          aria-label={title}
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
        >
          {icon}
        </button>
      )}
      {open && !single && (
        <div
          role="menu"
          className="absolute right-0 top-full z-popover mt-1 min-w-[12rem] overflow-hidden rounded-lg border border-border bg-background py-1 shadow-lg"
        >
          {options.map((opt) => (
            <button
              key={opt.id}
              role="menuitem"
              onClick={() => void runOption(opt)}
              className="block w-full px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-surface-raised"
            >
              <div className="font-medium">{opt.label}</div>
              {opt.hint && <div className="text-[10px] text-muted-foreground">{opt.hint}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
