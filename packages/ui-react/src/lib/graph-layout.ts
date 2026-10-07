import type { Block } from "@schlessera/brain-ui-sdk/client";

type GraphBlock = Extract<Block, { kind: "graph" }>;

/**
 * Pure two-column layout: the first focus gets its own row, indices stay intact.
 * Reserve wrapped labels even at the kit's 220px width floor, plus the legend.
 * No DOM measurement, random state, simulation or invented relationships.
 */
export function planGraph(nodes: GraphBlock["nodes"], legendCount = 0) {
  const focus = nodes.findIndex(node => node.focus);
  const remaining = nodes.map((_, i) => i).filter(i => i !== focus);
  const rows: number[][] = focus < 0 ? [] : [[focus]];
  for (let i = 0; i < remaining.length; i += 2) rows.push(remaining.slice(i, i + 2));

  // 42% of 220px, less padding/border, leaves at least 64px for a label.
  // Twelve pixels per UTF-16 unit conservatively covers the kit's 11px font;
  // 16px covers its 1.4 line height. The 24px gap separates adjacent rows.
  const heights = rows.map(row => Math.max(48,
    Math.ceil(Math.max(...row.map(i => nodes[i]!.label.length)) * 12 / 64) * 16 + 24));
  const minHeight = Math.max(240, heights.reduce((a, b) => a + b, 0) + 96 + legendCount * 32);
  let top = 48;
  const positions = new Map<number, { x: number; y: number }>();
  rows.forEach((row, i) => {
    row.forEach((index, column) => positions.set(index, {
      x: row.length === 1 ? 50 : 25 + 50 * column,
      y: (top + heights[i]! / 2) / minHeight * 100,
    }));
    top += heights[i]!;
  });
  return {
    minHeight,
    nodes: nodes.map((node, i) => ({
      label: node.label, tone: node.tone, focus: i === focus, ...positions.get(i)!,
    })),
  };
}
