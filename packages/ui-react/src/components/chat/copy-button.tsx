import { createContext, useContext, useState, type ReactNode } from "react";
import { IconButton, TextButton, type IconButtonProps } from "@schlessera/brain-ui-kit";
import { Check, Copy } from "lucide-react";

/**
 * The overlay placement: top right of a `group/copy` ancestor. A fine pointer
 * reveals it on hover or keyboard focus. A coarse pointer has no hover, so
 * there it is always visible, or a phone could never reach it.
 */
export const COPY_OVERLAY_CLASS =
  "absolute right-2 top-2 flex opacity-0 transition-opacity group-hover/copy:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100";

/**
 * The one copy control for raw text: code and diagram blocks, JSON dumps,
 * payloads, tool input and output. `getText` is read on click, so it can
 * return the full text even when the rendering is clamped or truncated.
 * `size` and `tone` select the kit control; `showLabel` prints the name
 * next to the icon for a toolbar. Omitting both size and tone also supplies
 * the overlay placement/reveal wrapper; explicit variants use host placement.
 */
export function CopyButton({
  getText,
  label = "Copy",
  showLabel = false,
  size,
  tone,
}: {
  getText: () => string;
  /** Accessible name before copying; "Copied" replaces it for two seconds. */
  label?: string;
  showLabel?: boolean;
  size?: IconButtonProps["size"];
  tone?: IconButtonProps["tone"];
}) {
  const [copied, setCopied] = useState(false);
  const name = copied ? "Copied" : label;
  const glyph = copied ? <Check /> : <Copy />;
  const onClick = () => {
    navigator.clipboard.writeText(getText());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  if (showLabel) return <TextButton tone="meta" label={copied ? "Copied" : "Copy"} ariaLabel={name} glyph={glyph} onClick={onClick} />;
  const control = <IconButton size={size ?? "sm"} tone={tone ?? "overlay"} name={name} glyph={glyph} onClick={onClick} />;
  return size === undefined && tone === undefined ? <span className={COPY_OVERLAY_CLASS}>{control}</span> : control;
}

const EnclosingCopy = createContext(false);

/**
 * Marks a subtree whose text an enclosing copy control already copies, so a
 * block inside it (`ClampedPre`) does not draw a second button on top of it.
 */
export function EnclosingCopyControl({ children }: { children: ReactNode }) {
  return <EnclosingCopy.Provider value={true}>{children}</EnclosingCopy.Provider>;
}

export function useEnclosingCopy(): boolean {
  return useContext(EnclosingCopy);
}
