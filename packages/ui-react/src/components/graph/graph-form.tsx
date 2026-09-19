import { FilterRow, Label, ListRow, Surface, Toggle } from "@schlessera/brain-ui-kit";
import { useId, type ReactNode } from "react";

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
