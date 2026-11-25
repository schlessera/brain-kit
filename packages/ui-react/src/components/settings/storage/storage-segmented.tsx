import { useRef, type CSSProperties, type KeyboardEvent } from "react";

/**
 * A segmented single choice for the Storage pane's switches (owner, history
 * tier). One `radiogroup`, one tab stop at the checked option, arrows (with
 * Home and End) move the choice and wrap. Each option takes the kit's
 * `.bk-hit` utility, so a coarse pointer gets a 44px target without
 * inflating the paint. The checked option is filled; its state is also
 * `aria-checked`, so meaning never rests on colour.
 */
export function StorageSegmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  function key(event: KeyboardEvent<HTMLDivElement>) {
    const index = options.findIndex((option) => option.value === value);
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (index + 1) % options.length
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? (index - 1 + options.length) % options.length
        : event.key === "Home"
        ? 0
        : event.key === "End"
        ? options.length - 1
        : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(options[next]!.value);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      onKeyDown={key}
      className="inline-flex max-w-full flex-wrap rounded-md border border-border bg-surface"
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            /* raw-button: select — a segmented radio keeps its checked state */
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(option.value)}
            style={{ "--hv-bg": "var(--bk-hover-veil-strong)" } as CSSProperties}
            className={`bk-row bk-hit min-h-8 px-3 text-xs font-medium first:rounded-l-md last:rounded-r-md ${
              on ? "bg-foreground text-background" : "text-muted-foreground"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
