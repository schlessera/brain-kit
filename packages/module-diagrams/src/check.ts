import { checkPositional } from "./positional-check.js";
import { checkContainment } from "./containment.js";
import { checkNodeLink } from "./node-link-check.js";
import { checkDiagramSkin } from "./skin.js";
import { checkDiagramLayouts } from "./layout.js";
import { checkAxis } from "./axis-check.js";
import { buildDiagram, DiagramGeometryError } from "./geometry.js";
import { isMap, parseDocument } from "yaml";
import { diagramSpecSchema, FREE_LAYOUT_TYPES, type DiagramSpec } from "./spec.js";

export interface DiagramFinding { path: string; code: string; message: string }
export interface DiagramCheckResult { schema_version: 1; valid: boolean; type: DiagramSpec["type"] | null; errors: DiagramFinding[]; warnings: DiagramFinding[] }
const field = (parts: readonly PropertyKey[]) => parts.reduce<string>((path, part) => typeof part === "number" ? `${path}[${part}]` : /^[A-Za-z_$][\w$]*$/.test(String(part)) ? `${path}.${String(part)}` : `${path}[${JSON.stringify(String(part))}]`, "$");
const result = (): DiagramCheckResult => ({ schema_version: 1, valid: false, type: null, errors: [], warnings: [] });
const finding = (path: string, code: string, message: string): DiagramFinding => ({ path, code, message });

/** One standalone YAML document or exactly one Markdown diagram fence. */
export function diagramSource(source: string): string {
  // A literal block inside a standalone spec may itself show Markdown fences.
  // Its declared version establishes the standalone form before fence scanning.
  const standalone = parseDocument(source, { version: "1.2", schema: "core" });
  if (isMap(standalone.contents) && standalone.contents.has("schema_version")) return source;
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/), specs: string[] = [];
  let opening: { marker: string; length: number; diagram: boolean; start: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (opening) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === opening.marker && close[1]!.length >= opening.length) {
        if (opening.diagram) specs.push(lines.slice(opening.start, i).join("\n"));
        opening = undefined;
      }
      continue;
    }
    const start = /^ {0,3}(`{3,}|~{3,})([^`~]*)$/.exec(line);
    if (start) opening = { marker: start[1]![0]!, length: start[1]!.length, diagram: start[2]!.trim() === "diagram", start: i + 1 };
  }
  if (opening?.diagram) throw Error("The diagram fence is not closed");
  if (specs.length > 1) throw Error("Expected exactly one diagram fence; check each diagram separately");
  return specs[0] ?? source;
}

/** Pure, keyless validation. No content is evaluated or rendered. */
export function checkDiagram(source: string): DiagramCheckResult {
  const output = result();
  let input: unknown;
  try {
    if (source.length > 1024 * 1024 || new TextEncoder().encode(source).byteLength > 1024 * 1024) throw Error("Diagram input exceeds the 1 MiB parse bound");
    const document = parseDocument(diagramSource(source), { version: "1.2", schema: "core", uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw Error([...document.errors, ...document.warnings].map(error => error.message).join("; "));
    input = document.toJS({ maxAliasCount: 0 });
  } catch (error) { output.errors.push(finding("$", "parse", (error as Error).message)); return output; }
  if (input && typeof input === "object" && "schema_version" in input && typeof input.schema_version === "number" && input.schema_version > 1) {
    output.errors.push(finding("$.schema_version", "upgrade_required", `Diagram schema_version ${input.schema_version} is newer than supported version 1; upgrade the diagrams module`));
    return output;
  }
  const parsed = diagramSpecSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") for (const key of issue.keys) output.errors.push(finding(field([...issue.path, key]), "unknown_field", "Unknown field"));
      else output.errors.push(finding(field(issue.path), "schema", issue.message));
    }
    return output;
  }
  const spec = parsed.data; output.type = spec.type;
  const error = (path: string, code: string, message: string) => output.errors.push(finding(path, code, message));
  const warn = (path: string, limit: number, count: number, noun: string) => {
    if (count > limit) output.warnings.push(finding(path, "budget", `${count} ${noun} exceeds the ${limit} default budget; split into overview and detail`));
  };
  const ids = new Set<string>(), nodeIds = new Set(spec.nodes.map(item => item.id));
  const declare = (id: string, path: string) => { if (ids.has(id)) error(path, "duplicate_id", `Duplicate element id '${id}'`); ids.add(id); };
  spec.nodes.forEach((item, index) => declare(item.id, `$.nodes[${index}].id`));
  spec.groups?.forEach((item, index) => declare(item.id, `$.groups[${index}].id`));
  spec.edges.forEach((item, index) => { if (item.id) declare(item.id, `$.edges[${index}].id`); });
  const refer = (id: string, path: string, allowed = ids) => { if (!allowed.has(id)) error(path, "unknown_reference", `Unknown element id '${id}'`); };
  spec.groups?.forEach((group, index) => {
    const members = new Set<string>();
    group.members.forEach((id, member) => { refer(id, `$.groups[${index}].members[${member}]`, nodeIds); if (members.has(id)) error(`$.groups[${index}].members[${member}]`, "duplicate_reference", "Group member is repeated"); members.add(id); });
  });
  const scopes = spec.type === "architecture" ? spec.containment?.scopes ?? [] : [];
  scopes.forEach((scope,index)=>declare(scope.id,`$.containment.scopes[${index}].id`));
  const containment = spec.type === "architecture" ? checkContainment(spec) : { errors: [], warnings: [] };
  output.errors.push(...containment.errors); output.warnings.push(...containment.warnings);
  const endpoints = new Set([...nodeIds, ...scopes.map(scope=>scope.id), ...(spec.groups?.map(group => group.id) ?? [])]);
  spec.edges.forEach((edge, index) => {
    refer(edge.from, `$.edges[${index}].from`, endpoints); refer(edge.to, `$.edges[${index}].to`, endpoints);
    if (edge.label) warn(`$.edges[${index}].label`, 14, Array.from(edge.label).length, "arrow-label characters");
  });
  const focal = new Set(spec.nodes.filter(node => node.role === "focal").map(node => node.id));
  spec.focal?.forEach((id, index) => { refer(id, `$.focal[${index}]`); focal.add(id); });
  if (focal.size > 2) error("$.focal", "focal_count", "At most two focal elements are allowed, including nodes with role: focal");
  spec.callouts?.forEach((callout, index) => refer(callout.target, `$.callouts[${index}].target`));
  warn("$.nodes", 9, spec.nodes.length, "nodes"); warn("$.edges", 12, spec.edges.length, "edges"); warn("$.callouts", 2, spec.callouts?.length ?? 0, "callouts");
  const typeLimits: Partial<Record<DiagramSpec["type"], number>> = { sequence: 5, swimlane: 5, er: 8, "layer-stack": 6, pyramid: 6, venn: 3 };
  const limit = typeLimits[spec.type];
  if (limit !== undefined && !(spec.type === "swimlane" && "axis" in spec && spec.axis)) warn("$.nodes", limit, spec.nodes.length, `${spec.type} items`);
  if (spec.type === "tree") {
    const children = new Map<string, string[]>(), incoming = new Map(spec.nodes.map(node => [node.id, 0]));
    for (const edge of spec.edges) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
      children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
      incoming.set(edge.to, incoming.get(edge.to)! + 1);
    }
    const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id), depth = new Map(queue.map(id => [id, 1]));
    let visited = 0, maximum = 0;
    for (let position = 0; position < queue.length; position++) {
      const id = queue[position]!, current = depth.get(id)!; visited++; maximum = Math.max(maximum, current);
      for (const child of children.get(id) ?? []) { depth.set(child, Math.max(depth.get(child) ?? 0, current + 1)); incoming.set(child, incoming.get(child)! - 1); if (incoming.get(child) === 0) queue.push(child); }
    }
    if (visited !== nodeIds.size) error("$.edges", "tree_cycle", "A tree cannot contain a directed cycle");
    warn("$.nodes", 4, maximum, "tree levels");
    const breadth=new Map<number,number>();for(const level of depth.values())breadth.set(level,(breadth.get(level)??0)+1);
    for(const [level,count] of breadth)warn("$.nodes",5,count,`tree items at level ${level}`);
  }
  const family=checkNodeLink(spec); output.errors.push(...family.errors); output.warnings.push(...family.warnings);
  if ((FREE_LAYOUT_TYPES as readonly string[]).includes(spec.type)) {
    const nodes = spec.nodes as Extract<DiagramSpec, { type: typeof FREE_LAYOUT_TYPES[number] }>["nodes"];
    nodes.forEach((node, index) => {
      for (const key of ["at", "size"] as const) node[key].forEach((value, coordinate) => { if (value % 4 !== 0) error(`$.nodes[${index}].${key}[${coordinate}]`, "grid", "Structural geometry must align to the 4px grid"); });
      for (let previous = 0; previous < index; previous++) {
        const other = nodes[previous]!;
        if (node.at[0] < other.at[0] + other.size[0] && node.at[0] + node.size[0] > other.at[0] && node.at[1] < other.at[1] + other.size[1] && node.at[1] + node.size[1] > other.at[1]) {
          error(`$.nodes[${index}].at`, "overlap", `Node '${node.id}' overlaps '${other.id}'`); break;
        }
      }
    });
  }
  if (!output.errors.length && (FREE_LAYOUT_TYPES as readonly string[]).includes(spec.type)) {
    try { buildDiagram(spec); }
    catch (failure) {
      if (failure instanceof DiagramGeometryError) output.errors.push(...failure.findings);
      else throw failure;
    }
  }
  output.errors.push(...checkDiagramSkin(spec), ...checkDiagramLayouts(spec));
  const positional = checkPositional(spec); output.errors.push(...positional.errors); output.warnings.push(...positional.warnings);
  const axisFindings = checkAxis(spec); output.errors.push(...axisFindings.errors); output.warnings.push(...axisFindings.warnings);
  output.valid = output.errors.length === 0;
  return output;
}
