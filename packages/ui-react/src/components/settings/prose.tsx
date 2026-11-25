import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Reading copy in a wide Settings pane (#4538): section intros, help
 * paragraphs, banner text and empty-state copy keep the 68ch measure while
 * the pane's cards, grids and forms use its full width. Use `span` inside a
 * `Callout`, whose box still spans the pane.
 */
export function Prose({ as: Tag = "p", className, children }: { as?: "p" | "span"; className?: string; children: ReactNode }) {
  return <Tag data-prose="" className={cn("max-w-[68ch]", Tag === "span" && "block", className)}>{children}</Tag>;
}

/**
 * Cards and rows of a wide pane: one column below 560px of pane, then as many
 * 260px-minimum columns as fit (two to 840, three or four past it).
 */
export const PANE_GRID = "grid grid-cols-1 @[560px]/settings-pane:grid-cols-[repeat(auto-fill,minmax(260px,1fr))]";
