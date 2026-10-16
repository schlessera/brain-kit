import { DIAGRAM_PALETTE } from "./skin.generated.js";
import type { DiagramSpec } from "./spec.js";
export { DIAGRAM_PALETTE, DIAGRAM_TOKEN_CSS } from "./skin.generated.js";
export type DiagramTheme = "light" | "dark" | "print";
export interface DiagramTypeStyle { family: string; size: number; weight: number; tracking: number; uppercase: boolean }
export type DiagramTypeRole = "title" | "name" | "sub" | "label";
export const DIAGRAM_TYPE: Record<DiagramTypeRole, DiagramTypeStyle> = {
 title: { family: '"DM Serif Text", Georgia, serif', size: 18, weight: 400, tracking: 0, uppercase: false },
 name: { family: '"Plus Jakarta Sans", system-ui, -apple-system, sans-serif', size: 12, weight: 600, tracking: 0, uppercase: false },
 sub: { family: '"JetBrains Mono", ui-monospace, monospace', size: 10, weight: 400, tracking: 0, uppercase: false },
 label: { family: '"JetBrains Mono", ui-monospace, monospace', size: 9.5, weight: 600, tracking: 0.09, uppercase: true },
};
/** Per-code-point widths include wide glyphs and tracking rather than script averages. */
export function typeWidthBudget(text: string, role: DiagramTypeRole, fontSize: number = DIAGRAM_TYPE[role].size): number {
 if (!Number.isFinite(fontSize) || fontSize < 9) throw Error("Diagram type must be at least 9px");
 const style = DIAGRAM_TYPE[role], value = style.uppercase ? text.toUpperCase() : text;
 return Array.from(value).reduce((width, char) => width + fontSize * (/[\u0000-\u007f]/.test(char) ? role === "name" || role === "title" ? /[MWmw@%]/.test(char) ? 1.1 : /[il .,'!]/.test(char) ? 0.4 : 0.72 : 0.62 : 1.2) + style.tracking * fontSize, 0);
}
/** Shared painter/checker fit policy; never shrink below the floor. */
export function fitDiagramText(text: string, role: DiagramTypeRole, availableWidth: number): number {
 const normal = DIAGRAM_TYPE[role].size, width = typeWidthBudget(text, role, normal);
 const fitted = Math.min(normal, normal * availableWidth / Math.max(width, 1));
 if (!Number.isFinite(fitted) || fitted < 9) throw Error("Text cannot fit at the 9px floor");
 return fitted;
}
export interface DiagramPaint { fill: string; stroke: string; text: string; sub: string; strokeWidth: number; dash: string; radius: number; tag: string }
const token = (name: string) => `var(--bk-${name})`;
/** The approved focal sublabel uses diagram-text in every theme. */
export function diagramNodePaint(role: string = "default", focal: boolean = role === "focal", inGroup: boolean = false): DiagramPaint {
 const ground = role === "external" || role === "boundary" ? inGroup ? "diagram-cluster" : "diagram-bg" : "diagram-node";
 return { fill: token(focal ? "diagram-focal-tint" : ground), stroke: token(focal ? "amber-ink" : "diagram-line"), text: token("diagram-text"), sub: token(focal ? "diagram-text" : "color-ink-mute"), strokeWidth: focal ? 2 : 1, dash: role === "optional" || role === "boundary" ? "4 3" : "", radius: role === "boundary" ? 8 : 5, tag: ({ default: "AGENT", focal: "AGENT", store: "STORE", input: "INPUT", external: "EXTERNAL", optional: "OPTIONAL", boundary: "BOUNDARY" } as Record<string, string>)[role] ?? "AGENT" };
}
export interface DiagramEdgePaint { stroke: string; width: number; dash: string; linecap: "round" | "butt"; head: "open" | "filled" | "hollow" }
export function diagramEdgePaint(kind: string = "default", transit: boolean = false): DiagramEdgePaint {
 return { stroke: token(kind === "primary" ? "diagram-text" : kind === "link" ? "blue-ink" : "diagram-line"), width: kind === "primary" || kind === "async" ? 1.5 : 1, dash: transit || kind === "return" ? "6 4" : kind === "async" ? "1.5 3.5" : "", linecap: kind === "async" && !transit ? "round" : "butt", head: kind === "primary" ? "filled" : kind === "link" ? "hollow" : "open" };
}
export function contrastRatio(foreground: string, background: string): number {
 const luminance = (hex: string) => {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw Error("Expected an opaque canonical color");
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
 };
 const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export interface DiagramSkinFinding { path: string; code: "contrast" | "text_floor"; message: string }
export function checkDiagramSkin(spec: DiagramSpec): DiagramSkinFinding[] {
 const findings: DiagramSkinFinding[] = [];
 for (const theme of ["light", "dark", "print"] as const) {
  const palette = DIAGRAM_PALETTE[theme];
  const pair = (ink: string, ground: string, minimum: number) => {
   const ratio = contrastRatio(palette[ink]!, palette[ground]!);
   if (ratio < minimum) findings.push({ path: "$", code: "contrast", message: `${theme}: ${ink} on ${ground} is ${ratio.toFixed(2)}:1, below ${minimum}:1` });
  };
  for (const ground of ["diagram-bg", "diagram-node", "diagram-cluster"]) {
   pair("diagram-text", ground, 4.5); pair("color-ink-mute", ground, 4.5); pair("diagram-line", ground, 3); pair("blue-ink", ground, 4.5); pair("focus-ring", ground, 3);
  }
  pair("diagram-text", "diagram-focal-tint", 4.5); pair("amber-ink", "diagram-focal-tint", 4.5);
  pair("diagram-cluster-border", "diagram-cluster", 3); pair("diagram-cluster-border", "diagram-bg", 3);
 }
 spec.nodes.forEach((node, index) => {
  if (!("size" in node)) return;
  const size = node.size as [number, number];
  const shape = "shape" in node ? node.shape : undefined;
  if (shape === "merge" || shape === "initial" || shape === "final") return;
  const lines = diagramNodeLines({...node,fanIn:spec.type === "dependency" ? spec.edges.filter(edge=>edge.to===node.id).length : undefined}, spec.type);
  const available = shape === "decision" ? size[0] / 2 - 16 : size[0] - 16;
  for (const line of lines) if (typeWidthBudget(line.value, line.role, 9) > available) findings.push({ path: `$.nodes[${index}]`, code: "text_floor", message: "Node text cannot fit its per-character width budget at the 9px floor; enlarge the node or shorten the text" });
  const height = shape === "decision" ? size[1] / 2 : size[1];
  if (height < lines.length * 12 + 16) findings.push({ path: `$.nodes[${index}].size[1]`, code: "text_floor", message: "Node height cannot fit its text lines at the 9px floor" });
 });
 spec.groups?.forEach((group, index) => {
  const members = spec.nodes.flatMap(node => group.members.includes(node.id) && "at" in node && "size" in node ? [{ at: node.at as [number, number], size: node.size as [number, number] }] : []);
  if (!members.length) return;
  const width = Math.max(...members.map(node => node.at[0] + node.size[0])) - Math.min(...members.map(node => node.at[0])) + 32;
  if (typeWidthBudget(group.label, "label", 9) > width - 16) findings.push({ path: `$.groups[${index}].label`, code: "text_floor", message: "Group label cannot fit its per-character width budget at the 9px floor" });
 });
 return findings;
}
/** Opaque ink ramps replace alpha ink. */
export function diagramInkRamp(step: 25 | 50 | 75 | 100, ground: string = "diagram-bg"): string { return `color-mix(in srgb, var(--bk-diagram-text) ${step}%, var(--bk-${ground}))`; }

/** Shared type-specific text contents keep validation and both painters in agreement. */
export function diagramNodeLines(node: { label: string; sub?: string; tag?: string; role?: string; nodeKind?: string; kind?: string; fields?: Array<{name:string;type?:string;key?:"PK"|"FK"}>; fanIn?:number }, type: DiagramSpec["type"]): Array<{value:string;role:DiagramTypeRole}> {
 const tag=node.tag ?? (type === "architecture" ? !node.role && ["compute","endpoint","managed"].includes(node.nodeKind ?? node.kind ?? "") ? (node.nodeKind ?? node.kind)!.toUpperCase() : diagramNodePaint(node.role).tag : type === "er" ? "ENTITY" : undefined);
 return [...(type === "dependency" ? [{value:`${node.fanIn} IN`,role:"label" as const}] : []), ...(tag ? [{value:tag,role:"label" as const}] : []), {value:node.label,role:"name" as const}, ...(node.sub ? [{value:node.sub,role:"sub" as const}] : []), ...(node.fields ?? []).map(field=>({value:`${field.key === "PK" ? "# " : field.key === "FK" ? "→ " : ""}${field.name}${field.type ? `: ${field.type}` : ""}`,role:"sub" as const}))];
}
