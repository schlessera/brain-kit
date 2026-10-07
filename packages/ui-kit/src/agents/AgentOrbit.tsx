import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { warnOnce } from "../internal/dev.js";
import { layoutOrbit, type OrbitSize } from "../internal/orbit-layout.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { StatusDot } from "../primitives/StatusDot.js";
import { accent, color, font, token } from "../tokens.js";
import type { RunState, Tone } from "../types.js";

/** State rings, never completion: needs you, running, ended. No orbit spins. */
export interface OrbitAgent {
  id: string;
  name: string;
  state: RunState;
  ring?: 0 | 1 | 2;
  meta?: string;
  icon?: IconName;
  tone?: Tone;
}
export interface AgentOrbitProps {
  agents: OrbitAgent[];
  coreIcon?: IconName;
  coreMeta?: string;
  width?: number;
  height?: number;
  compact?: boolean;
  onOpen?: (id: string) => void;
  onOverflow?: () => void;
  legend?: boolean;
}
const BORDERS: Record<RunState, string> = {
  running: token("orbit-border-running"), waiting: token("orbit-border-waiting"),
  done: token("orbit-border-done"), failed: token("orbit-border-failed"), stopped: color.edge,
};
const DOTS: Record<RunState, Tone> = { running: "amber", waiting: "teal", done: "teal", failed: "red", stopped: "neutral" };
function AgentBody({ agent, measuring = false }: { agent: OrbitAgent; measuring?: boolean }) {
  return <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px 5px 7px", boxSizing: "border-box",
    maxWidth: 160, width: "max-content", background: color.raised, border: `1px solid ${BORDERS[agent.state] ?? color.edge}`,
    borderRadius: 16, font: `500 10.5px/1.35 ${font.body}`, color: color.ink }}>
    <StatusDot tone={DOTS[agent.state] ?? "neutral"} pulse={!measuring && (agent.state === "running" || agent.state === "waiting")} size={7}/>
    <Icon icon={agent.icon ?? "agent"} size={13} color={accent[agent.tone ?? "purple"].ink}/>
    <span style={{ minWidth: 0, overflowWrap: "anywhere", whiteSpace: "normal" }}>{agent.name}
      {agent.meta ? <span style={{ display: "block", fontFamily: font.mono, color: agent.state === "failed" ? accent.red.ink : color.inkMute }}>{agent.meta}</span> : null}
    </span>
  </span>;
}
const LABELS = ["needs you", "running", "ended"];
export function AgentOrbit(p: AgentOrbitProps) {
  const measured = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Record<string, OrbitSize>>({});
  const src = Array.isArray(p.agents) ? p.agents : [];
  const width = Math.max(200, Number(p.width) || 340);
  const compact = p.compact === true || width < 332;
  useLayoutEffect(() => {
    const node = measured.current;
    if (!node || compact) return;
    const measure = () => {
      const next: Record<string, OrbitSize> = {};
      for (const el of node.querySelectorAll<HTMLElement>("[data-orbit-measure]")) {
        const rect = el.getBoundingClientRect();
        next[el.dataset.orbitMeasure!] = { width: Math.max(44, Math.ceil(rect.width)), height: Math.max(44, Math.ceil(rect.height)) };
      }
      setSizes(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const el of node.children) observer.observe(el);
    return () => observer.disconnect();
  }, [p.agents, compact]);
  if (p.agents && !Array.isArray(p.agents)) warnOnce("AgentOrbit: `agents` is not an array; the orbit will be empty.");
  if (!src.length) return null;
  const layout = layoutOrbit(src, width, Number(p.height) || (compact ? 236 : 284), compact, sizes);
  return <div data-kit-agent-orbit="" data-orbit-compact={compact ? "true" : "false"} role="group"
    aria-label={`Agents: ${layout.counts.map((n, i) => `${n} ${LABELS[i]}`).join(", ")}`} style={{ width, maxWidth: "100%", margin: "0 auto" }}>
    <div data-orbit-frame="" style={{ position: "relative", width, height: layout.height }}>
      {layout.radii.map((radius, i) => <div key={i} aria-hidden="true" style={{ position: "absolute", left: width / 2 - radius,
        top: layout.height / 2 - radius, width: radius * 2, height: radius * 2, borderRadius: "50%",
        border: `1px dashed ${token(i === 0 ? "orbit-ring-inner" : i === 1 ? "orbit-ring-mid" : "orbit-ring-outer")}` }}/>) }
      <div data-orbit-core="" style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", width: 62, height: 62,
        borderRadius: 22, background: color.surface, border: `1px solid ${color.edge}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2 }}>
        <Icon icon={p.coreIcon ?? "brain"} size={24} color={accent.amber.ink}/>
        {p.coreMeta ? <span style={{ font: `600 8px/1.3 ${font.mono}`, color: color.inkMute }}>{p.coreMeta}</span> : null}
      </div>
      <div ref={measured} aria-hidden="true" style={{ position: "absolute", inset: 0, overflow: "hidden", visibility: "hidden", pointerEvents: "none" }}>
        {!compact && src.map(agent => <div key={agent.id} data-orbit-measure={agent.id} style={{ width: "max-content" }}><AgentBody agent={agent} measuring/></div>)}
      </div>
      {layout.placed.map(position => {
        const agent = position.agent;
        const onClick = compact ? undefined : agent ? p.onOpen ? () => p.onOpen!(agent.id) : undefined : p.onOverflow;
        const style: CSSProperties = { position: "absolute", left: position.x, top: position.y, transform: "translate(-50%,-50%)",
          width: position.width, height: position.height, display: "flex", alignItems: "center", justifyContent: "center",
          padding: 0, border: 0, background: "transparent", borderRadius: 16, cursor: onClick ? "pointer" : undefined,
          color: color.ink, font: `600 11px/1.3 ${font.mono}` };
        const body = !agent ? <span style={{ border: `1px solid ${color.edge}`, borderRadius: 999, padding: "4px 6px", background: color.raised }}>+{position.overflow}</span>
          : compact ? <span title={`${agent.name}${agent.meta ? ` · ${agent.meta}` : ""}`}>
            {agent.state === "running" || agent.state === "waiting" ? <StatusDot tone={DOTS[agent.state]} pulse size={12}/>
              : <Icon icon={agent.state === "done" ? "confirm" : agent.state === "failed" ? "deny" : "cancel"} size={12} color={accent[DOTS[agent.state]].ink}/>}</span>
          : <AgentBody agent={agent}/>;
        return onClick ? <button key={agent ? `agent:${agent.id}` : `overflow:${position.ring}`} type="button" data-orbit-agent={agent?.id}
          data-orbit-ring={position.ring} data-orbit-state={agent?.state} data-orbit-overflow={position.overflow || undefined}
          aria-label={agent ? `${agent.name}${agent.meta ? ` · ${agent.meta}` : ""}` : `${position.overflow} more ${LABELS[position.ring]} agents. Open list.`}
          className="bk-control" style={style} onClick={onClick}>{body}</button>
          : <div key={agent ? `agent:${agent.id}` : `overflow:${position.ring}`} data-orbit-agent={agent?.id} data-orbit-ring={position.ring}
            data-orbit-state={agent?.state} data-orbit-overflow={position.overflow || undefined} style={style}>{body}</div>;
      })}
    </div>
    {p.legend !== false ? <div data-orbit-legend="" style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "6px 14px", padding: "8px 0", font: `500 10px/1.4 ${font.mono}`, color: color.inkMute }}>
      {layout.counts.map((count, i) => <span key={i}>{LABELS[i]} {count}</span>)}
    </div> : null}
  </div>;
}
