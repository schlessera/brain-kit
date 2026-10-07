import type { OrbitAgent } from "../agents/AgentOrbit.js";

export interface OrbitSize { width: number; height: number }
export interface OrbitPlacement extends OrbitSize {
  agent?: OrbitAgent;
  ring: 0 | 1 | 2;
  overflow: number;
  x: number;
  y: number;
}
export function agentRing(agent: OrbitAgent): 0 | 1 | 2 {
  return agent.ring ?? (agent.state === "waiting" ? 0 : agent.state === "running" ? 1 : 2);
}
function overlaps(a: OrbitPlacement, b: OrbitPlacement, gap: number) {
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap
    && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + gap;
}
/** Circumference bounds capacity; actual rectangles also bound the frame and other rings. */
export function layoutOrbit(agents: OrbitAgent[], width: number, requestedHeight: number, compact: boolean, sizes: Record<string, OrbitSize>) {
  const groups = ([0, 1, 2] as const).map(ring => agents.filter(agent => agentRing(agent) === ring));
  const maximumHeight = compact ? 12 : 44;
  const inner = compact ? 46 : 61;
  const outer = compact ? Math.min(106, width / 2 - 16) : 165;
  const gap = (outer - inner) / 2;
  const radii = [inner, inner + gap, inner + 2 * gap];
  const height = Math.max(requestedHeight, 2 * (radii[2]! + maximumHeight / 2 + (compact ? 4 : 8)));
  const placed: OrbitPlacement[] = [];
  const clearance = compact ? 1 : 4;
  const core: OrbitPlacement = { ring: 0, overflow: 0, x: width / 2, y: height / 2, width: 62, height: 62 };
  for (const ring of [0, 1, 2] as const) {
    const group = groups[ring]!;
    if (!group.length) continue;
    const reserved = ([0, 1, 2] as const).filter(next => next > ring && groups[next]!.length).map(next => ({
      ring: next, overflow: 0, x: width / 2, y: height / 2 - radii[next]!, width: compact ? 28 : 44, height: compact ? 12 : 44,
    }));
    const maxWidth = compact ? 12 : Math.max(44, ...group.map(a => Math.min(160, sizes[a.id]?.width ?? 160)));
    const capacity = Math.min(group.length, compact ? 12 : Math.max(1, Math.floor(2 * Math.PI * radii[ring]! / (maxWidth + 8))));
    for (let count = capacity; count >= 1; count--) {
      const overflow = group.length > count ? group.length - count + 1 : 0;
      const candidate: OrbitPlacement[] = Array.from({ length: count }, (_, i) => {
        const agent = overflow && i === count - 1 ? undefined : group[i]!;
        const angle = (i * 360 / count - 90) * Math.PI / 180;
        const size = agent ? sizes[agent.id] : undefined;
        return { agent, ring, overflow: agent ? 0 : overflow,
          x: width / 2 + Math.cos(angle) * radii[ring]!, y: height / 2 + Math.sin(angle) * radii[ring]!,
          width: compact ? (agent ? 12 : 28) : Math.min(160, Math.max(44, size?.width ?? 160)),
          height: compact ? 12 : Math.max(44, size?.height ?? 44) };
      });
      const valid = candidate.every((p, i) =>
        p.x - p.width / 2 >= 0 && p.x + p.width / 2 <= width && p.y - p.height / 2 >= 0 && p.y + p.height / 2 <= height
        && !overlaps(p, core, clearance)
        && placed.every(other => !overlaps(p, other, clearance))
        && reserved.every(other => !overlaps(p, other, clearance))
        && candidate.slice(0, i).every(other => !overlaps(p, other, clearance)));
      if (valid) { placed.push(...candidate); break; }
    }
    // Very tall labels may fit no slot. The last-slot summary still represents
    // the complete ring; the host's full list retains every name and record.
    if (!placed.some(position => position.ring === ring)) {
      placed.push({ ring, overflow: group.length, x: width / 2, y: height / 2 - radii[ring]!, width: compact ? 28 : 44, height: compact ? 12 : 44 });
    }
  }
  return { width, height, radii, placed, counts: groups.map(group => group.length) };
}
