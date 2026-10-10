interface PositionedNode {
  id: string;
  x: number;
  y: number;
  size: number;
  community?: number;
}

interface NodeLink { source: string; target: string; }

interface LayoutSettings {
  pull: number; anchor: number; linkedGap: number; unlinkedGap: number;
  passes: number; maxStep: number; clusterSpread: number; collisionPasses: number;
}
const defaults: LayoutSettings = {
  pull: 0.45, anchor: 0.002, linkedGap: 0, unlinkedGap: 0.5,
  passes: 64, maxStep: 20, clusterSpread: 0.2, collisionPasses: 16,
};

/** Pull neighbors together, then separate marks on a display copy of the layout. */
export function separateNodes(
  input: PositionedNode[],
  width: number,
  height: number,
  gap = 0.5,
  links: NodeLink[] = [],
  attractLinked = true,
): PositionedNode[] {
  const settings = { ...defaults, unlinkedGap: gap };
  const nodes = input.map(node => ({ ...node }));
  if (nodes.length < 2 || Math.min(width, height) <= 100) return nodes;
  // Translate whole communities without changing their internal arrangement.
  if (attractLinked && settings.clusterSpread !== 1) {
    const centers = new Map<number, { x: number; y: number; count: number }>();
    const center = { x: 0, y: 0 };
    for (const node of nodes) {
      center.x += node.x / nodes.length; center.y += node.y / nodes.length;
      if (node.community === undefined) continue;
      const group = centers.get(node.community) ?? { x: 0, y: 0, count: 0 };
      group.x += node.x; group.y += node.y; group.count++;
      centers.set(node.community, group);
    }
    for (const node of nodes) {
      const group = node.community === undefined ? undefined : centers.get(node.community);
      if (!group) continue;
      node.x += (group.x / group.count - center.x) * (settings.clusterSpread - 1);
      node.y += (group.y / group.count - center.y) * (settings.clusterSpread - 1);
    }
  }
  const available = Math.min(width, height) - 80;
  const maxSize = Math.max(...nodes.map(node => node.size));
  const indexes = new Map(nodes.map((node, i) => [node.id, i]));
  const neighbors = nodes.map(() => new Set<number>());
  const pairs: [number, number][] = [];
  for (const link of links) {
    const a = indexes.get(link.source), b = indexes.get(link.target);
    if (a === undefined || b === undefined || a === b || neighbors[a]!.has(b)) continue;
    neighbors[a]!.add(b); neighbors[b]!.add(a);
    pairs.push([a, b]);
  }
  // Peel dangling trees so they can follow their final attachment position.
  // Keep one root in an entirely tree-shaped component.
  const branches: [number, number][] = [];
  if (attractLinked) {
    const degrees = neighbors.map(set => set.size);
    const queue = degrees.flatMap((degree, i) => degree === 1 ? [i] : []);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const i = queue[cursor]!;
      if (degrees[i] !== 1) continue;
      const parent = [...neighbors[i]!].find(j => degrees[j]! > 0)!;
      branches.push([i, parent]); degrees[i] = 0;
      if (--degrees[parent]! === 1) queue.push(parent);
    }
  }
  function attachBranches() {
    if (!branches.length) return;
    const detached = new Set(branches.map(([i]) => i));
    const core = nodes.filter((_, i) => !detached.has(i));
    const span = Math.max(
      Math.max(...core.map(n => n.x)) - Math.min(...core.map(n => n.x)),
      Math.max(...core.map(n => n.y)) - Math.min(...core.map(n => n.y)), 1,
    );
    for (let index = branches.length - 1; index >= 0; index--) {
      const [i, parent] = branches[index]!, node = nodes[i]!, other = nodes[parent]!;
      const angle = Math.atan2(input[i]!.y - input[parent]!.y, input[i]!.x - input[parent]!.x);
      const distance = (node.size + other.size + settings.unlinkedGap) * span / available;
      node.x = other.x + Math.cos(angle) * distance;
      node.y = other.y + Math.sin(angle) * distance;
    }
  }
  const anchors = nodes.map(node => ({ x: node.x, y: node.y }));
  const attractionPasses = attractLinked && pairs.length ? settings.passes : 0;
  for (let pass = 0; pass < attractionPasses + settings.collisionPasses; pass++) {
    if (pass === attractionPasses) attachBranches();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y);
    }
    const unitsPerPixel = Math.max(maxX - minX, maxY - minY, 1) / available;
    if (pass < attractionPasses) {
      const pulls = nodes.map(() => ({ x: 0, y: 0 }));
      for (const [a, b] of pairs) {
        const first = nodes[a]!, second = nodes[b]!;
        const x = second.x - first.x, y = second.y - first.y;
        const distance = Math.hypot(x, y);
        const target = (first.size + second.size + gap) * unitsPerPixel;
        if (distance <= target) continue;
        const pull = Math.min((distance - target) * settings.pull, settings.maxStep * unitsPerPixel) / distance;
        pulls[a]!.x += x * pull; pulls[a]!.y += y * pull;
        pulls[b]!.x -= x * pull; pulls[b]!.y -= y * pull;
      }
      for (let i = 0; i < nodes.length; i++) {
        const degree = neighbors[i]!.size;
        if (!degree) continue;
        const node = nodes[i]!, original = anchors[i]!;
        // Average neighbor pulls so hubs cannot collapse the entire map;
        // a weak anchor retains the coarse structure of the source layout.
        node.x += pulls[i]!.x / degree + (original.x - node.x) * settings.anchor;
        node.y += pulls[i]!.y / degree + (original.y - node.y) * settings.anchor;
      }
    }
    const cellSize = (maxSize * 2 + Math.max(gap, settings.linkedGap)) * unitsPerPixel;
    const cells = new Map<number, number[]>();
    const stride = Math.ceil((maxY - minY) / cellSize) + 3;
    let largestOverlap = 0;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const cx = Math.floor((node.x - minX) / cellSize), cy = Math.floor((node.y - minY) / cellSize);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const j of cells.get((cx + dx) * stride + cy + dy) ?? []) {
          const other = nodes[j]!;
          let x = node.x - other.x, y = node.y - other.y;
          const clearance = neighbors[i]!.has(j) ? settings.linkedGap : gap;
          // A subpixel margin keeps zero-clearance marks from intersecting
          // after projection and WebGL float rounding.
          const minimum = (node.size + other.size + clearance + 0.05) * unitsPerPixel;
          const squared = x * x + y * y;
          if (squared >= minimum * minimum) continue;
          let distance = Math.sqrt(squared);
          largestOverlap = Math.max(largestOverlap, (minimum - distance) / unitsPerPixel);
          if (distance < 1e-10) {
            const angle = (i * 137.508 + j * 37.1) * Math.PI / 180;
            x = Math.cos(angle); y = Math.sin(angle); distance = 1;
            const displacement = minimum / 2;
            node.x += x * displacement; node.y += y * displacement;
            other.x -= x * displacement; other.y -= y * displacement;
          } else {
            const displacement = (minimum - distance) / (2 * distance);
            node.x += x * displacement; node.y += y * displacement;
            other.x -= x * displacement; other.y -= y * displacement;
          }
        }
      }
      const key = Math.floor((node.x - minX) / cellSize) * stride + Math.floor((node.y - minY) / cellSize);
      const cell = cells.get(key);
      if (cell) cell.push(i); else cells.set(key, [i]);
    }
    // Finish with collision-only passes so the last spring step cannot leave
    // overlapping marks, including when size-by changes at an existing zoom.
    if (largestOverlap < 0.01 && pass >= attractionPasses) break;
  }
  return nodes;
}
