import { FilterRow, Label, ListRow, Surface, Toggle } from "@schlessera/brain-ui-kit";
import { useId, type ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/**
 * The graph options form's primitives, on the kit (S7, the `graph`
 * directory). `GraphControls` stays the container — every option reads and
 * writes the graph store — and composes these. The canvas itself is WebGL
 * and has no kit counterpart; the kit's `GraphView` is a static
 * neighbourhood drawing for a chat answer, not a scene.
 *
 * A segmented choice is the kit `FilterRow`: one tab stop, ←→ and Home/End
 * inside, activation following focus — which is what a mode switch is. A
 * switch is the kit `Toggle`, named by the visible text beside it.
 *
 * D6 draws the depth and the switches as a `Surface pad={0}` of group
 * `ListRow`s (`Rows`, `ToggleRow`, `ValueRow`): the row carries the handler
 * and its own title names it, the same shape D5's Settings groups use.
 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5">
        <Label text={label} />
      </div>
      {children}
    </div>
  );
}

export function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const active = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <FilterRow
      items={options.map((o) => ({ label: o.label, onClick: () => onChange(o.value) }))}
      active={active}
      mono={false}
    />
  );
}

export function SwitchRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div className="flex min-h-11 w-full items-center justify-between gap-3 text-xs text-foreground">
      <span id={id}>{label}</span>
      <Toggle on={checked} tone="amber" labelledBy={id} onClick={() => onChange(!checked)} />
    </div>
  );
}

/** A `Surface pad={0}` of group `ListRow`s — D6's depth and switch block. */
export function Rows({ children }: { children: ReactNode }) {
  return <Surface pad={0}>{children}</Surface>;
}

/**
 * A switch row inside `Rows`. The kit `ListRow`'s toggle is decorative and
 * the row is the button, named by its title (the D5 pattern).
 */
export function ToggleRow({
  checked,
  onChange,
  label,
  subtitle,
  tone = "amber",
  last = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  subtitle?: string;
  tone?: "amber" | "teal" | "purple";
  last?: boolean;
}) {
  return (
    <ListRow
      title={label}
      subtitle={subtitle}
      subMono={subtitle !== undefined}
      toggle={checked}
      toggleTone={tone}
      last={last}
      onClick={() => onChange(!checked)}
    />
  );
}

/**
 * A switch the host cannot serve yet, drawn anyway (the sixth pass, §3b:
 * "until that exists the control is drawn but disabled with its reason, the
 * same rule the palette follows"). The reason prints in mono where the
 * subtitle would go, and the switch is the kit `Toggle` in its disabled
 * state — `aria-disabled`, out of the tab order, dimmed by the kit's own
 * rule, never a bare opacity on the row. It keeps its role and its name,
 * because a control the reader is told about should also be one a screen
 * reader can find. The no-op handler is what gives it the role: the kit
 * gates every operable trait on a handler, and "disabled" is a state of an
 * operable switch, not the absence of one.
 */
export function DisabledToggleRow({
  label,
  reason,
  tone = "amber",
  last = false,
}: {
  label: string;
  /** Mono, printed under the title: "needs provenance". */
  reason: string;
  tone?: "amber" | "teal" | "purple";
  last?: boolean;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        "flex min-h-14 w-full items-center justify-between gap-3 px-3.5 py-2.5",
        !last && "border-b border-border"
      )}
      data-disabled-row=""
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span id={id} className="text-[13px] text-foreground">
          {label}
        </span>
        <span className="font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">{reason}</span>
      </div>
      <Toggle on={false} tone={tone} labelledBy={id} disabled onClick={noop} />
    </div>
  );
}

function noop() {}

/**
 * A row whose trailing mono value is the current choice and whose click
 * steps to the next one — D6's `Depth · 2 hops`. The subtitle spells the
 * ring so the step is not a surprise.
 */
export function ValueRow<T extends string | number>({
  label,
  options,
  value,
  format,
  onChange,
  last = false,
}: {
  label: string;
  options: readonly T[];
  value: T;
  format: (value: T) => string;
  onChange: (value: T) => void;
  last?: boolean;
}) {
  const index = Math.max(0, options.indexOf(value));
  const next = options[(index + 1) % options.length]!;
  return (
    <ListRow
      title={label}
      subtitle={options.map(format).join(" · ")}
      subMono
      value={format(value)}
      last={last}
      onClick={() => onChange(next)}
    />
  );
}
