import type { CSSProperties } from "react";
import { useEffect } from "react";
import { useUIStore, type ThemePreference } from "../../stores/ui-store.js";
import { cn } from "../../lib/utils.js";

/**
 * Writes the stored theme preference to `<html data-theme>`. That attribute
 * is the whole switch: the kit's `tokens.css` maps it onto `color-scheme`,
 * every `--bk-*` token is `light-dark()`, and the browser picks the half — so
 * nothing else in the app has to know. `system` lets `prefers-color-scheme`
 * decide.
 *
 * Runs in an effect, so the first paint of a stored non-default preference
 * can still flash the default. A host that cares puts a one-line inline
 * script in its HTML before the stylesheet:
 *   `document.documentElement.dataset.theme = localStorage.getItem("brain-theme") || "dark"`
 * (with the root's storage prefix, if it sets one). The kit's README says the
 * same; the app cannot do it for the host because the host owns the HTML.
 */
export function useApplyTheme(): void {
  const theme = useUIStore((s) => s.theme);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = theme;
  }, [theme]);
}

const OPTIONS: Array<{ id: ThemePreference; label: string; hint: string }> = [
  { id: "system", label: "System", hint: "Follow the device" },
  { id: "light", label: "Paper", hint: "Light, for daylight" },
  { id: "dark", label: "Dark", hint: "The default" },
];

/**
 * The design's three-way toggle, kept in Settings ("respect the system, offer
 * the override"). One radiogroup, three options, no icon: the label is the
 * meaning.
 */
export function ThemeToggle() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5"
    >
      {OPTIONS.map((o) => (
        <button style={{ "--hv-bg": "var(--bk-hover-veil-strong)" } as CSSProperties} /* raw-button: select — Radiogroup theme segment keeps its checked state. */
          key={o.id}
          type="button"
          role="radio"
          aria-checked={theme === o.id}
          title={o.hint}
          onClick={() => setTheme(o.id)}
          className={cn(
            "bk-row rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            theme === o.id
              ? "bg-surface-raised text-foreground"
              : "text-muted-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
