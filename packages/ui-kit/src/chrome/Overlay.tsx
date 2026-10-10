import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject, type Ref } from "react";

import { warnOnceDevelopment } from "../internal/dev.js";
import { inertOutside, keepModalLive } from "../internal/inert-outside.js";
import { isTopmost, registerOverlay } from "../internal/overlay-stack.js";
import { z } from "../tokens.js";
import { BottomSheet } from "./BottomSheet.js";
import { Icon } from "../primitives/Icon.js";
import { IconButton } from "../primitives/IconButton.js";

export type OverlayVariant = "sheet" | "dialog" | "fullscreen" | "panel";
export type OverlayCloseReason = "escape" | "scrim" | "close-button" | "close-request";
type OverlayName =
  | { title: string; subtitle?: string; label?: never; labelledBy?: never }
  | { label: string; title?: never; labelledBy?: never }
  | { labelledBy: string; title?: never; label?: never };
type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export type OverlayProps = OverlayName & {
  open: boolean;
  /** A request only: the caller owns open and may refuse dismissal. */
  onClose: (reason: OverlayCloseReason) => void;
  variant: OverlayVariant;
  /** sheet md|lg|xl (default lg); dialog md|lg|xl (default md); panel sm|md|lg (default sm). */
  size?: "sm" | "md" | "lg" | "xl";
  closedBy?: "any" | "closerequest" | "none";
  role?: "dialog" | "alertdialog";
  /** Only panel supports non-modal destination geometry. */
  modal?: boolean;
  placement?: "center" | "top";
  initialFocus?: RefObject<HTMLElement | null>;
  /** App adapters use the surface for destination scroll/focus resets. */
  surfaceRef?: Ref<HTMLElement>;
  /** Read from the closing render, after the background is live again. */
  returnFocus?: boolean | (() => HTMLElement | null);
  /** Runs after open=false; never during replay or an open unmount. */
  onAfterClose?: () => void;
  theme?: string;
  keepLive?: string;
  /** For untitled media/sheet chrome, opt into the drawn close slot. */
  closeLabel?: string;
  children: ReactNode;
} & DataAttributes;

const TABBABLE = 'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]';
function stops(surface: HTMLElement): HTMLElement[] {
  return [...surface.querySelectorAll<HTMLElement>(TABBABLE)].filter(element =>
    element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert]") && element.getClientRects().length > 0,
  );
}

/** Native top-layer modals, plus a destination panel that keeps navigation live. */
export function Overlay(p: OverlayProps) {
  const heading = useId();
  const id = useRef(Symbol("overlay"));
  const element = useRef<HTMLElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const openingFocus = useRef<{ opener: HTMLElement | null } | null>(null);
  const latest = useRef(p);
  latest.current = p;
  const modal = p.variant !== "panel" || p.modal !== false;
  const closedBy = p.closedBy ?? "any";
  const size = p.size ?? (p.variant === "sheet" ? "lg" : p.variant === "dialog" ? "md" : "sm");

  useLayoutEffect(() => {
    const here = element.current;
    if (!p.open || !here) return;
    const effectGeneration = ++generation.current;
    const dialog = here as HTMLDialogElement;
    const doc = here.ownerDocument;
    // A StrictMode replay must retain the opener from the first setup.
    openingFocus.current ??= { opener: doc.activeElement as HTMLElement | null };
    const { opener } = openingFocus.current;
    let active = true;
    const request = (reason: OverlayCloseReason) => {
      if (active && isTopmost(doc, id.current) && latest.current.closedBy !== "none") latest.current.onClose(reason);
    };
    const unregister = registerOverlay(doc, { id: id.current, modal, escape: () => request("escape") });
    const focusInitial = () => {
      const body = surface.current?.querySelector<HTMLElement>(".bk-overlay-body");
      (latest.current.initialFocus?.current ?? surface.current?.querySelector<HTMLElement>("[data-autofocus]") ??
        (body && stops(body)[0]) ?? (surface.current && stops(surface.current)[0]) ?? here).focus();
    };
    const cancel = (event: Event) => {
      if (!event.cancelable) return;
      event.preventDefault();
      request("close-request");
    };
    const close = () => {
      // close-watcher anti-abuse can produce a non-cancelable cancel event.
      if (!active || !latest.current.open || dialog.open) return;
      dialog.showModal();
      focusInitial();
      request("close-request");
    };
    const releaseModal = modal ? keepModalLive(here) : () => {};
    if (modal) {
      here.addEventListener("cancel", cancel);
      here.addEventListener("close", close);
      // Keep returnFocus under caller control, rather than native restoration.
      opener?.blur();
      dialog.showModal();
      if (here.getClientRects().length === 0) {
        active = false;
        unregister();
        dialog.close();
        releaseModal();
        opener?.focus();
        warnOnceDevelopment("Overlay cannot open in a hidden subtree.");
      }
    }
    const releaseInert = !modal ? inertOutside(here, p.keepLive) : () => {};
    if (active) focusInitial();
    return () => {
      active = false;
      here.removeEventListener("cancel", cancel);
      here.removeEventListener("close", close);
      if (modal && dialog.open) dialog.close();
      unregister();
      releaseInert();
      releaseModal();
      // React restores pre-mutation focus after layout cleanups. Return focus
      // after that commit, or it can overwrite the opener with the old tab.
      queueMicrotask(() => {
        if (generation.current !== effectGeneration) return;
        const closing = latest.current;
        openingFocus.current = null;
        const policy = closing.returnFocus ?? true;
        const target = typeof policy === "function" ? policy() : policy ? opener : null;
        if (target?.isConnected && !target.closest("[inert]") && !target.matches(":disabled")) target.focus();
        if (!closing.open) closing.onAfterClose?.();
      });
    };
  }, [p.open, modal, p.keepLive]);

  if (!p.open) return null;
  function keys(event: KeyboardEvent<HTMLElement>) {
    if (!isTopmost(event.currentTarget.ownerDocument, id.current) || event.defaultPrevented) return;
    if (event.key === "Escape" && modal && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (closedBy !== "none") p.onClose("escape");
    } else if (event.key === "Tab" && modal && surface.current) {
      const items = stops(surface.current);
      const current = event.currentTarget.ownerDocument.activeElement;
      if (!items.includes(current as HTMLElement) || (event.shiftKey ? current === items[0] : current === items.at(-1))) {
        event.preventDefault();
        (event.shiftKey ? items.at(-1) : items[0] ?? element.current)?.focus();
      }
    }
  }
  const dismiss = (p.variant === "panel" || closedBy !== "none") ? () => p.onClose("close-button") : undefined;
  const data = Object.fromEntries(Object.entries(p).filter(([key]) => key.startsWith("data-")));
  const shared = {
    ...data,
    className: "bk-overlay",
    "data-bk-overlay": p.variant,
    "data-size": size,
    "data-placement": p.placement ?? "center",
    "data-destination": !modal ? "" : undefined,
    "data-theme": p.theme,
    "aria-label": p.label,
    "aria-labelledby": p.title ? heading : p.labelledBy,
    tabIndex: -1,
    onKeyDown: keys,
  };
  // Keep the slot's rectangular 44px hit area at the rounded IconButton corners.
  // The transparent glyph child covers the target without changing the paint.
  const children = <>
    <div className="bk-overlay-scrim" aria-hidden="true" data-scrim={p.variant === "fullscreen" ? "opaque" : p.variant === "panel" ? "veil" : "dim"}
      onPointerDown={event => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        if (closedBy === "any" && isTopmost(event.currentTarget.ownerDocument, id.current)) p.onClose("scrim");
      }} />
    <div ref={node => {
      surface.current = node;
      if (typeof p.surfaceRef === "function") p.surfaceRef(node);
      else if (p.surfaceRef) p.surfaceRef.current = node;
    }} className="bk-overlay-surface">
      {p.title && p.variant !== "fullscreen" ? p.variant === "panel" ?
        <header className="bk-overlay-header"><h2 id={heading} {...(!modal ? { tabIndex: -1, "data-destination-heading": "" } : {})}>{p.title}</h2>{dismiss && <IconButton size="md" tone="mute" style={{ position: "relative" }} glyph={<><Icon icon="dismiss" size={16} /><span style={{ position: "absolute", inset: 0 }} /></>} name={p.closeLabel ?? `Close ${p.title}`} onClick={dismiss} />}</header> :
        <BottomSheet title={p.title} titleId={heading} subtitle={"subtitle" in p ? p.subtitle : undefined} onDismiss={dismiss} closeLabel={p.closeLabel} /> : null}
      {p.title && p.variant === "fullscreen" ? <h2 id={heading} className="bk-overlay-sr-title">{p.title}</h2> : null}
      {(!p.title || p.variant === "fullscreen") && p.closeLabel ? <span style={{
        position: "absolute", zIndex: 1,
        top: p.variant === "fullscreen" ? "calc(8px + env(safe-area-inset-top))" : 12,
        right: p.variant === "fullscreen" ? 12 : 20,
      }}><IconButton size="md" tone="mute" style={{ position: "relative" }} glyph={<><Icon icon="dismiss" size={16} /><span style={{ position: "absolute", inset: 0 }} /></>} name={p.closeLabel}
        disabled={closedBy === "none"} onClick={() => p.onClose("close-button")} /></span> : null}
      <div className="bk-overlay-body">{p.children}</div>
    </div>
  </>;
  return modal ? <dialog {...shared} ref={node => { element.current = node; }} role={p.role ?? "dialog"} aria-modal="true">{children}</dialog> :
    <section {...shared} ref={node => { element.current = node; }} style={{ zIndex: z.panel }}>{children}</section>;
}
