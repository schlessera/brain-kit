import type { ReactNode } from "react";
import { TextButton } from "../primitives/TextButton.js";
import { color, font } from "../tokens.js";

export interface StorageCrumb {
  id: string;
  label: string;
}

export interface StorageBreadcrumbProps {
  /** From the top (`Storage`) down; the last crumb is the current folder. */
  trail: readonly StorageCrumb[];
  /** Go to an ancestor: the map re-roots and the list follows. */
  onNavigate: (id: string) => void;
  /**
   * After the current crumb: the `⋯` menu that carries Open for the current
   * folder, since rows have no Open of their own (#4544 ruling 1). The caller
   * owns the menu; the kit only places it.
   */
  actions?: ReactNode;
  label?: string;
}

/**
 * `Storage › Packs › objects › pack`, always shown above the list. Every
 * ancestor is a 44px target and the crumbs wrap at 320px and at 200% zoom.
 * The current crumb is `aria-current="location"` and focusable by script
 * (`tabIndex=-1`, `data-storage-crumb-current`) so a caller can move focus to
 * it after drilling, as storage.md asks.
 */
export function StorageBreadcrumb({ trail, onNavigate, actions, label = "Storage location" }: StorageBreadcrumbProps) {
  return (
    <nav aria-label={label} data-storage-breadcrumb="" style={{ minWidth: 0, maxWidth: "100%" }}>
      <ol style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0 2px", margin: 0, padding: 0, listStyle: "none", font: `500 12.5px/1.3 ${font.body}`, color: color.inkDim }}>
        {trail.map((crumb, index) => {
          const current = index === trail.length - 1;
          return (
            <li key={crumb.id} style={{ display: "inline-flex", alignItems: "center", minWidth: 0, maxWidth: "100%" }}>
              {current ? (
                <span
                  aria-current="location"
                  tabIndex={-1}
                  data-storage-crumb-current=""
                  style={{ display: "inline-flex", alignItems: "center", minHeight: 44, padding: "0 4px", fontWeight: 600, color: color.ink, overflowWrap: "anywhere" }}
                >
                  {crumb.label}
                </span>
              ) : (
                <TextButton label={crumb.label} tone="inherit" onClick={() => onNavigate(crumb.id)} style={{ overflowWrap: "anywhere", textAlign: "left", minWidth: 44, justifyContent: "center" }} />
              )}
              {current ? null : (
                <span aria-hidden="true" style={{ padding: "0 2px", color: color.inkMute }}>
                  {"›"}
                </span>
              )}
            </li>
          );
        })}
        {actions ? <li style={{ display: "inline-flex", alignItems: "center" }}>{actions}</li> : null}
      </ol>
    </nav>
  );
}
