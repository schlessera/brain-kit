import { FilterRow, Label, Toggle } from "@schlessera/brain-ui-kit";
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
