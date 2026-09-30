import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, RefObject } from "react";
import { BottomSheet } from "./BottomSheet.js";
import { accent, color, font, token } from "../tokens.js";

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
    panel.current?.querySelector<HTMLInputElement>('input[data-model]:checked:not(:disabled), input[data-effort]:checked')?.focus();
  }, []);
  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); p.onDismiss(); }
    if (e.key !== "Tab") return;
    const stops = [...(panel.current?.querySelectorAll<HTMLElement>('input:not(:disabled)[tabindex="0"]') ?? [])];
    const first = stops[0];
    const last = stops.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
  const row: CSSProperties = { display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "0 8px", cursor: "pointer", font: `400 12px/1.5 ${font.body}`, color: color.ink };
  const group: CSSProperties = { margin: 0, padding: 0, border: 0, minWidth: 0 };
  const heading: CSSProperties = { padding: "10px 8px 4px", font: `500 11px/1.5 ${font.mono}`, color: color.inkDim };
  const content = <div ref={panel} id={p.id} role="dialog" aria-label="Model and effort" aria-modal={p.phone || undefined} onKeyDown={keys}
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
  return <div ref={p.containerRef} style={p.phone
    ? { position: "fixed", inset: 0, zIndex: 50, background: token("palette-shadow") }
    : { position: "absolute", bottom: "100%", left: 14, zIndex: 50, width: 320, maxWidth: "calc(100vw - 48px)", borderRadius: 12, padding: 8, background: color.raised, boxShadow: `0 12px 36px ${token("palette-shadow")}`, maxHeight: "80vh", overflowY: "auto" }}
    onMouseDown={(e) => { if (p.phone && e.target === e.currentTarget) p.onDismiss(); }}>
    {p.phone ? <BottomSheet title="Model and effort" docked>{content}</BottomSheet> : content}
  </div>;
}
