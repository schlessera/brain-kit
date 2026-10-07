import { useLayoutEffect, useRef } from "react";

/** One compositor sweep for the owning frame (#1126).
 *
 * Snapshot the committed loading layout, not a second React tree: the seeds,
 * wrapping and baselines are identical, and supplied children are never mounted
 * three more times. Only ghost glyphs paint in the inert copies. Controls and
 * resource elements become empty boxes, so copies have no actions or requests.
 * The snapshots stay put through the 600ms handoff and disappear with the band.
 */
export function GhostBand(p: { loading: boolean; arriving?: boolean; animate?: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!p.loading || !track.current) return;
    const frame = track.current.parentElement!.parentElement!;
    const scale = frame.offsetWidth ? frame.getBoundingClientRect().width / frame.offsetWidth : 1;
    const snapshot = (source: Element): Element | null => {
      if (source.classList.contains("bk-ghost-viewport")) return null;
      const resource = /^(BUTTON|INPUT|SELECT|TEXTAREA|A|IMG|VIDEO|AUDIO|IFRAME|OBJECT|EMBED|SCRIPT|STYLE|LINK)$/;
      if (resource.test(source.tagName)) {
        const box = frame.ownerDocument.createElement("span");
        const rect = source.getBoundingClientRect();
        box.style.cssText = `display:inline-block;width:${rect.width / scale}px;height:${rect.height / scale}px;flex:none;visibility:hidden`;
        return box;
      }
      const copy = source.cloneNode(false) as HTMLElement;
      for (const a of [...copy.attributes]) {
        if (/^(id|name|role|tabindex|title|autofocus|contenteditable|href|src|srcset|on.*|aria-.*)$/i.test(a.name)) copy.removeAttribute(a.name);
      }
      if (copy.classList.contains("bk-ghost")) {
        copy.classList.replace("bk-ghost", "bk-ghost-copy-glyph");
        const blur = (source as HTMLElement).style?.filter.match(/blur\(([\d.]+)px\)/)?.[1];
        copy.style.filter = `blur(${Number(blur ?? 0) + 1.2}px)`;
      }
      for (const child of source.childNodes) {
        if (child.nodeType === 1) {
          const next = snapshot(child as Element);
          if (next) copy.appendChild(next);
        } else if (child.nodeType === 3) copy.appendChild(child.cloneNode());
      }
      return copy;
    };
    const layout = snapshot(frame)! as HTMLElement;
    // The frame clone keeps its border/padding box and flex/grid layout. Its
    // background, furniture and non-ghost text are hidden by the copy cascade.
    // Absolute positioning uses the frame’s padding box; do not count its
    // border a second time inside the copies. The content box stays identical.
    layout.style.border = "none";
    layout.style.width = "100%";
    layout.style.margin = "0";
    for (const target of track.current.querySelectorAll(".bk-ghost-copy")) {
      target.replaceChildren(layout.cloneNode(true));
    }
  });
  if (!p.loading && !p.arriving) return null;
  return (
    <div className="bk-ghost-viewport" aria-hidden="true" inert>
      <div ref={track} className={`bk-ghost-track${p.arriving ? " bk-ghost-out" : ""}`} aria-hidden="true" inert data-still={p.animate === false ? "" : undefined}>
        <div className="bk-ghost-band">
          {(["amber", "purple", "blue"] as const).map((hue) => (
            <div key={hue} className="bk-ghost-window" data-ghost-hue={hue}>
              <div className="bk-ghost-counter-band">
                <div className="bk-ghost-copy" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
