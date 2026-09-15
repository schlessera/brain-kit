import type { CSSProperties } from "react";

import { warnOnce } from "../internal/dev.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { StatusDot } from "../primitives/StatusDot.js";
import { accent, color, font, token } from "../tokens.js";
import type { RunState, Tone } from "../types.js";

/**
 * The agent monitor, drawn as an orbit.
 *
 * Distance from the core is how far from done a run is, so one glance answers
 * "is real work happening?". `orbit` 0 is about to land and 1 is just started;
 * `angle` is degrees clockwise from 12 o'clock.
 *
 * **Pills are placed, never animated around.** Motion in this kit is reserved
 * for the breathing status dots, and an orbit that spins would be a second
 * ambient animation — which the design's "what does not change" list forbids
 * outright. The consequence for callers is that two agents at the same angle
 * and radius overlap forever, so the fixtures space them deliberately.
 *
 * ## The placement, exactly
 *
 * ```
 * cx = w / 2                       cy = h / 2
 * rMax = min(w, h) / 2 - 26        r = 40 + orbit * rMax
 * rad = (angle - 90) * PI / 180
 * left = cx + cos(rad) * r         top = cy + sin(rad) * r
 * ```
 *
 * The `- 90` is what makes `angle` clockwise from twelve o'clock rather than
 * from three; the `40 +` is the core's own radius plus its gap, so `orbit: 0`
 * lands on the core's edge instead of inside it. Each pill is then centred on
 * that point with `translate(-50%,-50%)`, so the numbers above are pill
 * CENTRES. `tests/agentorbit-placement.test.tsx` asserts two of them against
 * hand-computed values rather than against the component.
 */
export interface OrbitAgent {
  /** The agent's functional name. */
  name: string;
  icon?: IconName;
  tone?: Tone;
  /** Progress, a count, or the word the run ended on. */
  meta?: string;
  state?: RunState;
  /** 0-1: distance from the core, proportional to how far from done it is. */
  orbit?: number;
  /** Degrees clockwise from 12 o'clock. */
  angle?: number;
}

export interface AgentOrbitProps {
  agents?: OrbitAgent[];
  coreIcon?: IconName;
  /** The corpus size, under the core glyph. */
  coreMeta?: string;
  width?: number;
  height?: number;
}

/** Per-state pill border. The table is the source's `S`, keyed by run state
 * rather than by tone — the border says "still going / your turn / finished /
 * broke", which is not the same axis as the icon's colour. */
const BORDERS: Record<RunState, string> = {
  running: token("orbit-border-running"),
  waiting: token("orbit-border-waiting"),
  done: token("orbit-border-done"),
  failed: token("orbit-border-failed"),
};

const PULSE: Record<RunState, boolean> = { running: true, waiting: true, done: false, failed: false };
const DOTS: Record<RunState, Tone> = { running: "amber", waiting: "teal", done: "teal", failed: "red" };

/** The icon carries the agent's own tone, which is an identity rather than a
 * status — two agents can both be running and still be told apart. */
const INKS: Record<Tone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

const FALLBACK: OrbitAgent[] = [
  { name: "researcher", icon: "researcher", tone: "purple", meta: "72%", state: "running", orbit: 0.62, angle: -52 },
  { name: "note-filer", icon: "filer", tone: "teal", meta: "2/3", state: "running", orbit: 0.42, angle: 74 },
  { name: "source-watch", icon: "watcher", tone: "blue", meta: "done", state: "done", orbit: 0.86, angle: 212 },
  { name: "ledger", icon: "ledger", tone: "gold", meta: "failed", state: "failed", orbit: 0.7, angle: 148 },
];

function ring(inset: number, border: string): CSSProperties {
  return { position: "absolute", inset, borderRadius: "50%", border };
}

export function AgentOrbit(p: AgentOrbitProps) {
  if (p.agents && !Array.isArray(p.agents)) warnOnce("AgentOrbit: `agents` is not an array; the orbit will be empty.");
  const w = Number(p.width) || 340;
  const h = Number(p.height) || 284;
  const src = p.agents || FALLBACK;

  const cx = w / 2;
  const cy = h / 2;
  const rMax = Math.min(w, h) / 2 - 26;

  return (
    <div style={{ position: "relative", width: w, height: h, flex: "none", margin: "0 auto" }}>
      <div style={ring(34, `1px dashed ${token("orbit-ring-inner")}`)} />
      <div style={ring(76, `1px dashed ${token("orbit-ring-mid")}`)} />
      <div
        style={{
          ...ring(112, `1px solid ${token("orbit-ring-outer")}`),
          background: `radial-gradient(circle,${token("orbit-glow")},transparent 70%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%,-50%)",
          width: 62,
          height: 62,
          borderRadius: 22,
          background: color.surface,
          border: `1px solid ${color.edge}`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
        }}
      >
        <Icon icon={p.coreIcon || "brain"} size={24} color={accent.amber.ink} />
        <span style={{ font: `600 8px/1 ${font.mono}`, color: color.inkMute }}>{p.coreMeta ?? "4,812 docs"}</span>
      </div>
      {src.map((a, i) => {
        const state = a.state || "running";
        const rad = (((a.angle ?? 0) - 90) * Math.PI) / 180;
        const r = 40 + (a.orbit ?? 0.6) * rMax;
        const pill: CSSProperties = {
          position: "absolute",
          left: cx + Math.cos(rad) * r,
          top: cy + Math.sin(rad) * r,
          transform: "translate(-50%,-50%)",
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: color.raised,
          border: `1px solid ${BORDERS[state] || BORDERS.running}`,
          borderRadius: 999,
          padding: "5px 10px 5px 7px",
          font: `500 10.5px/1 ${font.body}`,
          whiteSpace: "nowrap",
        };
        return (
          <div key={`${a.name}-${i}`} style={pill}>
            <StatusDot tone={DOTS[state] || DOTS.running} pulse={PULSE[state] ?? true} size={7} />
            <Icon icon={a.icon || "agent"} size={13} color={INKS[a.tone || "purple"] || INKS.purple} />
            {a.name}
            <span
              style={{
                fontFamily: font.mono,
                color: state === "failed" ? accent.red.ink : color.inkMute,
              }}
            >
              {a.meta}
            </span>
          </div>
        );
      })}
    </div>
  );
}
