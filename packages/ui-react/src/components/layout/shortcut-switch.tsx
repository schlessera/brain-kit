import { Toggle } from "@schlessera/brain-ui-kit";
import { useId } from "react";
import { useUIStore } from "../../stores/ui-store.js";

/**
 * The off switch for single-key shortcuts (D36). WCAG 2.1.4 asks that a
 * single-character shortcut can be turned off, remapped, or made active only
 * on focus; the design chose focus scope AND an off switch, because a reader
 * whose screen reader or speech input types letters into a focused card
 * still needs the switch. Modifier shortcuts are not governed by it.
 */
export function ShortcutSwitch() {
  const on = useUIStore((s) => s.singleKeyShortcuts);
  const set = useUIStore((s) => s.setSingleKeyShortcuts);
  const id = useId();
  return (
    <>
      <span className="text-xs text-muted-foreground">
        <span id={id}>Single-key shortcuts</span>
        {/* Outside the labelling span, so the switch's name is the four
            words and the hint stays a hint. */}
        <span className="ml-1.5 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/70">
          a d on a focused approval · j k in a list
        </span>
      </span>
      <Toggle on={on} tone="amber" labelledBy={id} onClick={() => set(!on)} />
    </>
  );
}
