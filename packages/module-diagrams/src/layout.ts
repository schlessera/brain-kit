import { buildAxisDiagram } from "./axis-layout.js";
import { AXIS_TYPES } from "./spec.js";

import { checkNodeLink } from "./node-link-check.js";
import { checkContainment } from "./containment.js";
import { buildDiagram, DiagramGeometryError, type DiagramTree } from "./geometry.js";
import { checkDiagramSkin } from "./skin.js";
import { FREE_LAYOUT_TYPES, type DiagramSpec } from "./spec.js";
export interface DiagramLayoutFinding { path: string; code: "layout" | "text_floor" | "contrast" | "unroutable"; message: string }
/** Apply authored placement only. Semantic fields and edges are never duplicated. */
export function diagramLayout(spec: DiagramSpec, name: "default" | "narrow" = "default"): DiagramSpec {
 if (name === "default") return spec;
 const layout = spec.layouts?.narrow;
 if (!layout) throw Error("No authored narrow layout; use the caption/summary and Open diagram fallback");
 const positions = new Map(layout.nodes.map(node => [node.id, node]));
 return { ...spec, size: "fit", layouts: undefined, nodes: spec.nodes.map(node => ({ ...node, at: positions.get(node.id)!.at, size: positions.get(node.id)!.size })) } as DiagramSpec;
}
/** One deterministic tree with the exact authored 320px frame; never reflow. */
export function buildDiagramLayout(spec: DiagramSpec, name: "default" | "narrow" = "default"): DiagramTree {
 if ((AXIS_TYPES as readonly string[]).includes(spec.type)) return buildAxisDiagram(spec, name === "narrow" ? 320 : 720);
 const findings = checkDiagramLayouts(spec);
 if (findings.length) throw Error(findings.map(item => item.message).join("; "));
 const tree = buildDiagram(diagramLayout(spec, name));
 if (name === "narrow") tree.viewBox = { x: 0, y: 0, width: 320, height: spec.layouts!.narrow.height };
 return tree;
}
export function checkDiagramLayouts(spec: DiagramSpec): DiagramLayoutFinding[] {
 const layout = spec.layouts?.narrow, findings: DiagramLayoutFinding[] = [];
 if (!layout) return findings;
 const error = (path: string, message: string) => findings.push({ path, code: "layout", message });
 if (!(FREE_LAYOUT_TYPES as readonly string[]).includes(spec.type)) { error("$.layouts.narrow", "Authored node placement is available only for free-layout types"); return findings; }
 const expected = new Set(spec.nodes.map(node => node.id)), seen = new Set<string>();
 layout.nodes.forEach((node, index) => {
  const path = `$.layouts.narrow.nodes[${index}]`;
  if (!expected.has(node.id) || seen.has(node.id)) error(`${path}.id`, "Narrow placement must name each semantic node exactly once, with no extra IDs");
  seen.add(node.id);
  if ([...node.at, ...node.size, layout.height].some(value => value % 4 !== 0)) error(path, "Authored structural geometry must align to the 4px grid");
  if (node.at[0] + node.size[0] > layout.width || node.at[1] + node.size[1] > layout.height) error(path, "Authored node exceeds the narrow frame");
  for (const other of layout.nodes.slice(0, index)) if (node.at[0] < other.at[0] + other.size[0] && node.at[0] + node.size[0] > other.at[0] && node.at[1] < other.at[1] + other.size[1] && node.at[1] + node.size[1] > other.at[1]) error(path, "Authored narrow nodes overlap");
 });
 for (const id of expected) if (!seen.has(id)) error("$.layouts.narrow.nodes", `Missing authored placement for '${id}'`);
 if (findings.length) return findings;
 const placed = diagramLayout(spec, "narrow");
 const semantic=[...checkNodeLink(placed).errors,...(placed.type==="architecture"?checkContainment(placed).errors:[])];
 semantic.forEach(item=>error(item.path.replace("$.nodes","$.layouts.narrow.nodes"),item.message));
 findings.push(...checkDiagramSkin(placed).map(item => ({ ...item, path: item.path.replace("$.nodes", "$.layouts.narrow.nodes") })));
 if (!findings.length) try {
  const tree = buildDiagram(placed);
  for (const element of tree.elements) if ("width" in element && (element.x < 0 || element.y < 0 || element.x + element.width > layout.width || element.y + element.height > layout.height)) error("$.layouts.narrow", "Authored groups or label masks exceed the narrow frame");
  for (const element of tree.elements) if (element.kind === "connector" && element.points.some(point => point.x < 0 || point.y < 0 || point.x > layout.width || point.y > layout.height)) error("$.layouts.narrow", "Authored connector exceeds the narrow frame");
 } catch (failure) {
  if (failure instanceof DiagramGeometryError) findings.push(...failure.findings.map(item => ({ ...item, path: `$.layouts.narrow${item.path.slice(1)}` })));
  else throw failure;
 }
 return findings;
}
