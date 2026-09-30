import type { ReactNode } from "react";
import { classifyLink, refusalSentence } from "../links.js";
import { color, font } from "../tokens.js";

/** Shared label/detail/host anatomy for rating and ranking rows. */
export function DecisionRowText(p: {
  item: { label: string; detail?: string; link?: string };
  labelId?: string;
  detailId?: string;
  label?: ReactNode;
  children?: ReactNode;
}) {
  const verdict = p.item.link ? classifyLink(p.item.link) : null;
  return (
    <div className="bk-decision-text bk-asklist-text-col" style={{ minWidth: 0 }}>
      <div id={p.labelId} style={{ font: `600 13px/1.45 ${font.body}`, color: color.ink, overflowWrap: "anywhere" }}>
        {p.label ?? p.item.label}
      </div>
      {p.item.detail || verdict || p.children ? (
        <div id={p.detailId} className="bk-decision-detail" style={{ font: `400 11px/1.5 ${font.body}`, color: color.inkMute }}>
          {p.item.detail ? <span className={verdict?.ok ? "bk-decision-clamp" : undefined}>{p.item.detail}</span> : null}
          {verdict?.ok ? (
            <a href={verdict.href} target="_blank" rel="noopener noreferrer" className="bk-asklist-link"
              aria-label={`${p.item.label} on ${verdict.host} (${verdict.host}), new tab`}>
              {verdict.hostUnicode ?? verdict.host}
            </a>
          ) : verdict ? <span>[link withheld — {refusalSentence(verdict)}]</span> : null}
          {p.children}
        </div>
      ) : null}
    </div>
  );
}
