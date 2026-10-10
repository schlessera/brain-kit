import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, RefObject } from "react";
import { Overlay } from "./Overlay.js";
import { BottomSheet } from "./BottomSheet.js";
import { accent, color, z, font, token } from "../tokens.js";

export interface ModelPickerProps {
  id?: string;
  models: { id: string; label: string }[];
  selectedModelId: string | null;
  modelLocked?: boolean;
  defaultEffort?: string;
  effortLevels?: readonly string[];
  /** null means the profile default. */
  selectedEffort?: string | null;
  phone?: boolean;
  /**
   * An action under a locked model: the model cannot change in place, so the
   * locked picker is where the way out lives (#61's "Continue on another
   * backend"). `why` prints the reason it cannot run and leaves it
   * announced as dimmed but focusable, never hidden.
   */
  lockedAction?: { label: string; detail?: string; why?: string; onSelect: () => void };
  containerRef?: RefObject<HTMLDivElement | null>;
  onModel: (id: string) => void;
  onEffort: (level: string | null) => void;
  onDismiss: () => void;
}

/** Two independent radio groups: model remains pinned on resumes, effort does not. */
export function ModelPicker(p: ModelPickerProps) {
  const modelName = useId();
  const effortName = useId();
  const panel = useRef<HTMLDivElement>(null);
  const selected = p.selectedEffort ?? null;
  const [preview, setPreview] = useState({ base: selected, level: selected });
  const navigatingEffort = useRef(false);
  const previewEffort = preview.base === selected ? preview.level : selected;
  const currentEffort = previewEffort === null || p.effortLevels?.includes(previewEffort) ? previewEffort : selected;
  useEffect(() => {
    if (p.phone) return;
    (panel.current?.querySelector<HTMLElement>('input[data-model]:checked:not(:disabled), input[data-effort]:checked')
      ?? panel.current?.querySelector<HTMLElement>("button[data-locked-action]"))?.focus();
  }, [p.phone]);
  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); p.onDismiss(); }
    if (e.key !== "Tab") return;
    const stops = [...(panel.current?.querySelectorAll<HTMLElement>('input:not(:disabled)[tabindex="0"], button[data-locked-action]') ?? [])];
    const first = stops[0];
    const last = stops.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
  const row: CSSProperties = { display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "0 8px", cursor: "pointer", font: `400 12px/1.5 ${font.body}`, color: color.ink };
  const group: CSSProperties = { margin: 0, padding: 0, border: 0, minWidth: 0 };
  const heading: CSSProperties = { padding: "10px 8px 4px", font: `500 11px/1.5 ${font.mono}`, color: color.inkDim };
  const content = <div ref={panel} id={p.id} role={p.phone ? undefined : "dialog"} aria-label={p.phone ? undefined : "Model and effort"} onKeyDown={p.phone ? undefined : keys}
    style={{ maxHeight: p.phone ? "calc(85vh - 90px)" : "72vh", overflowY: "auto" }}>
    <fieldset style={group}>
      <legend style={heading}>Model{p.modelLocked ? " · fixed for this conversation" : ""}</legend>
      <div style={{ maxHeight: "30vh", overflowY: "auto" }}>
        {p.models.map((model, index) => {
          const checked = model.id === p.selectedModelId;
          return <label key={model.id} style={{ ...row, cursor: p.modelLocked ? "default" : "pointer" }}>
            <input data-model="" type="radio" name={modelName} value={model.id} checked={checked} disabled={p.modelLocked}
              tabIndex={checked || (p.selectedModelId === null && index === 0) ? 0 : -1}
              style={{ accentColor: accent.amber.fill, flex: "none" }} onChange={() => p.onModel(model.id)} />
            <span style={{ overflowWrap: "anywhere" }}>{model.label}</span>
          </label>;
        })}
      </div>
    </fieldset>
    {p.modelLocked && p.lockedAction ? <button type="button" data-locked-action="" className="bk-control"
      aria-disabled={p.lockedAction.why ? true : undefined}
      onClick={() => { if (!p.lockedAction!.why) p.lockedAction!.onSelect(); }}
      style={{ ...row, width: "100%", border: 0, background: "transparent", textAlign: "left", flexDirection: "column", alignItems: "flex-start", justifyContent: "center", gap: 0, padding: "6px 8px", cursor: p.lockedAction.why ? "default" : "pointer", color: p.lockedAction.why ? color.inkMute : accent.teal.ink }}>
      <span style={{ font: `500 12px/1.5 ${font.body}` }}>{p.lockedAction.label}…</span>
      {p.lockedAction.why || p.lockedAction.detail ? <span style={{ font: `400 11px/1.4 ${font.mono}`, color: color.inkMute }}>{p.lockedAction.why ?? p.lockedAction.detail}</span> : null}
    </button> : null}
    {p.effortLevels?.length ? <>
      <fieldset style={{ ...group, borderTop: `1px solid ${color.edge}`, marginTop: 8 }}>
        <legend style={heading}>Effort · next message</legend>
        {[null, ...p.effortLevels].map((level) => <label key={level ?? "default"} style={row}>
          <input data-effort="" type="radio" name={effortName} value={level ?? "default"} checked={currentEffort === level}
            tabIndex={currentEffort === level ? 0 : -1} style={{ accentColor: accent.amber.fill, flex: "none" }}
            onChange={() => setPreview({ base: selected, level })} onClick={(e) => { if (!navigatingEffort.current || e.detail > 0) p.onEffort(level); }}
            onKeyUp={() => { navigatingEffort.current = false; }}
            onKeyDown={(e) => {
              navigatingEffort.current = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key);
              if (e.key === "Enter") { e.preventDefault(); p.onEffort(level); }
            }} />
          <span>{level ?? (p.defaultEffort ? `Default (${p.defaultEffort})` : "Default")}</span>
        </label>)}
      </fieldset>
      <p style={{ margin: "10px 8px 4px", font: `400 11px/1.55 ${font.body}`, color: color.inkDim }}>After sending, effort returns to the default.</p>
    </> : null}
  </div>;
  if (p.phone) return <div ref={p.containerRef}>
    <Overlay open variant="sheet" label="Model and effort" data-bk-sheet-adapter="model" onClose={p.onDismiss}>
      <BottomSheet title="Model and effort">{content}</BottomSheet>
    </Overlay>
  </div>;
  return <div ref={p.containerRef}
    style={{ position: "absolute", bottom: "100%", left: 14, zIndex: z.popover, width: 320, maxWidth: "calc(100vw - 48px)", borderRadius: 12, padding: 8, background: color.raised, boxShadow: `0 12px 36px ${token("palette-shadow")}`, maxHeight: "80vh", overflowY: "auto" }}>
    {content}
  </div>;
}
