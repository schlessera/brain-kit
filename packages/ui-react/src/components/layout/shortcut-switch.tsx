import { Icon, Toggle } from "@schlessera/brain-ui-kit";
import { useId } from "react";
import { useUIStore } from "../../stores/ui-store.js";

/**
 * The off switch for single-key shortcuts (D36, D37). WCAG 2.1.4 asks that
 * a single-character shortcut can be turned off, remapped, or made active
 * only on focus; the design chose focus scope AND an off switch, because a
 * reader whose screen reader or speech input types letters into a focused
 * card still needs the switch. Modifier shortcuts are not governed by it.
 *
 * Drawn as D5 draws it: a group row — icon, title, the mono hint as the
 * subtitle — with the kit `Toggle` trailing, named by the row's title. The
 * kit `ListRow`'s own toggle is decorative, so the row is composed here.
 */
export function ShortcutSwitch() {
  const on = useUIStore((s) => s.singleKeyShortcuts);
  const set = useUIStore((s) => s.setSingleKeyShortcuts);
  const id = useId();
  return (
    <div className="flex items-center gap-3 px-3 py-3">
      <Icon icon="capability" size={17} color="var(--bk-amber-ink)" />
      <span className="min-w-0 flex-1">
        <span id={id} className="block text-[12.5px] font-semibold text-foreground">Single-key shortcuts</span>
        <span className="mt-0.5 block font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground">
          a d on a focused approval · j k in a list
        </span>
      </span>
      <Toggle on={on} tone="amber" labelledBy={id} onClick={() => set(!on)} />
    </div>
  );
}
