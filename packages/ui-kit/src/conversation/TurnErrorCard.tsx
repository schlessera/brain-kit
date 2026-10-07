import { useState, type ReactNode } from "react";
import { InlineToast } from "./InlineToast.js";
import { Surface } from "../primitives/Surface.js";
import { Button } from "../primitives/Button.js";
import { DiffBlock } from "../primitives/DiffBlock.js";
import { Icon } from "../primitives/Icon.js";
import { Receipt, type ReceiptRow } from "../evidence/Receipt.js";
import { Disclosure } from "../blocks/Disclosure.js";
import { color, font } from "../tokens.js";

export interface TurnErrorAction {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** The approved failed-turn composition (#576): data in, actions out. */
export interface TurnErrorCardProps {
  headline: string;
  explanation: ReactNode;
  tone: "red" | "gold";
  rows: ReceiptRow[];
  providerMessage: string;
  /** Unknown classification starts with the provider disclosure open. */
  providerOpen?: boolean;
  backend?: string;
  operator?: boolean;
  /** Only the newly received terminal failure announces; replay never does. */
  announce?: boolean;
  actions: TurnErrorAction[];
  notice?: string;
  busy?: boolean;
  retryWarning?: boolean;
}

export function TurnErrorCard(p: TurnErrorCardProps) {
  const [announcement] = useState(p.announce ? `Turn failed. ${p.headline}` : null);
  const [showAll, setShowAll] = useState(false);
  const lines = p.providerMessage.split("\n");
  const preview = lines.slice(0, 40).join("\n").slice(0, 4000);
  const capped = preview.length < p.providerMessage.length;
  const identityRows = p.rows.filter(r => r.k === "model" || r.k === "backend");
  return (
    <section aria-label="Turn failed" className="bk-turn-error" style={{ overflowWrap: "anywhere", width: "100%", minWidth: 0, containerType: "inline-size" }}>
      {/* Withdrawn, never re-spoken, once the failure stops being the new one. */}
      {announcement && p.announce ? <div role="alert" className="bk-sr-only">{announcement}</div> : null}
      <Surface tone={p.tone} tint emphasis="hairline" label="Turn failed" labelIcon="failed">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <p style={{ font: `500 13.5px/1.5 ${font.body}`, color: color.ink, margin: "0 0 5px" }}>{p.headline}</p>
            <div style={{ font: `400 11.5px/1.6 ${font.body}`, color: color.inkDim }}>{p.explanation}</div>
            {p.operator ? <p style={{ font: `400 10px/1.5 ${font.mono}`, color: color.inkMute, margin: "6px 0 0" }}>for whoever runs this server</p> : null}
          </div>
          <div className="bk-turn-error-facts">
            {identityRows.length ? <Receipt bare title="" footnote="" keyWidth={58} rows={identityRows} /> : null}
            <Receipt bare title="" footnote="" keyWidth={58} rows={p.rows.filter(r => r.k !== "model" && r.k !== "backend")} />
          </div>
          <Disclosure label={`Provider message · ${p.providerMessage.length} chars`} open={p.providerOpen}>
            <DiffBlock text={showAll ? p.providerMessage : preview} variant="inset" />
            {capped ? <Button label={showAll ? "Show less" : `Show all · ${p.providerMessage.length} chars`} tone="ghost" onClick={() => setShowAll(v => !v)} style={{ minHeight: 44 }} /> : null}
          </Disclosure>
          {p.retryWarning ? <p style={{ font: `400 11.5px/1.6 ${font.body}`, color: color.inkDim, margin: 0 }}>Retry starts a new turn. Prior actions may run again.</p> : null}
          <div className="bk-turn-error-actions" aria-busy={p.busy || undefined}>
            {p.actions.map(a => <Button key={a.label} label={a.label} tone={a.primary ? "primary" : "ghost"}
              disabled={a.disabled} block={false} onClick={a.onClick}
              // Remove Button's inline flex so the responsive stylesheet owns it.
              style={{ minHeight: 44, flex: undefined }} />)}
          </div>
          {p.notice ? <InlineToast text={p.notice} target="" effect="" undoLabel="" tone="neutral" icon="failed" /> : null}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 7, borderTop: `1px solid ${color.line}`, paddingTop: 9,
            font: `400 10px/1.5 ${font.mono}`, color: color.inkMute }}>
            <Icon icon="scope" size={12} />
            <span>reported by {p.backend ? `the ${p.backend} backend` : "the backend"} · not written by the model</span>
          </div>
        </div>
      </Surface>
    </section>
  );
}
