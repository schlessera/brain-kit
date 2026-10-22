import { afterAll, afterEach, beforeAll, expect, test as browserTest } from "vitest";
import { commands } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider, createBrainUiRoot, type BrainUiRoot } from "@schlessera/brain-ui-react";
import { DiagramContent } from "../../../module-diagrams/src/ui.js";
import { toStatic } from "../../../module-diagrams/src/render.js";
import { calloutsSpec, narrowCallouts } from "../../../module-diagrams/tests/fixtures/callouts.js";
import quadrantExample from "../../../module-diagrams/skills/diagram/references/examples/positional/quadrant.diagram.yaml?raw";
import pyramidExample from "../../../module-diagrams/skills/diagram/references/examples/positional/pyramid.diagram.yaml?raw";
import loopExample from "../../../module-diagrams/skills/diagram/references/examples/positional/loop.diagram.yaml?raw";
import { axisExamples } from "../../../module-diagrams/tests/fixtures/axis-examples.js";
import { parseDiagram } from "../../../module-diagrams/src/svg-model.js";
import { buildDiagramLayout } from "../../../module-diagrams/src/layout.js";

let host: HTMLDivElement, render: Root, root: BrainUiRoot, styles: HTMLStyleElement;
const originalTheme = document.documentElement.dataset.theme;
beforeAll(async () => { styles = document.createElement("style"); styles.dataset.diagramCaptureConsumer = ""; styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
// A Vitest deadline rejects its wrapper without cancelling the async body.
// Retain the whole body, including captures it may schedule after that deadline.
let ownedCase: Promise<void> | undefined, ownedTeardown: Promise<void> | undefined;
function test(name: string, run: () => Promise<void>) {
  browserTest(name, () => {
    if (ownedCase || ownedTeardown) throw Error("PREVIOUS_CALLOUT_CASE_NOT_DRAINED");
    ownedCase = Promise.resolve().then(run);
    return ownedCase;
  });
}
async function teardownCase() {
  const work = ownedCase;
  const teardown = ownedTeardown ??= (async () => {
    // The test still receives its original rejected promise. Teardown observes
    // settlement so a failure cannot leave later work using another case's DOM.
    if (work) await Promise.allSettled([work]);
    const failures: unknown[] = [];
    for (const cleanup of [() => { if (render) flushSync(() => render.unmount()); },
      () => root?.dispose(), () => host?.remove(), () => { document.documentElement.dataset.theme = originalTheme; }]) {
      try { cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "CALLOUT_CASE_TEARDOWN_FAILED");
    if (ownedCase !== work) throw Error("CALLOUT_CASE_OWNERSHIP_CHANGED");
    ownedCase = undefined;
  })();
  // A failed or still-pending teardown retains ownership. Another case refuses
  // before its body runs, and styles remain while unknown work could use them.
  await teardown;
  if (ownedTeardown === teardown) ownedTeardown = undefined;
}
afterAll(async () => { if (ownedCase || ownedTeardown) await teardownCase(); styles?.remove(); });
afterEach(teardownCase);
function mount(source: string, width: number, theme: "light" | "dark" | "print" = "light") {
  if (!host?.isConnected) { host = document.createElement("div"); document.body.append(host); render = createRoot(host); root = createBrainUiRoot({ storage: null, request: async () => Response.json({ renderers: [], enabled: [] }) }); }
  document.documentElement.dataset.theme = theme; host.style.width = `${width}px`;
  flushSync(() => render.render(<BrainUiProvider root={root}><DiagramContent source={source} theme={theme} mode="chat" /></BrainUiProvider>));
}
async function svgReady() { await expect.poll(() => host.querySelector("figure > svg.bk-diagram")).not.toBeNull(); await document.fonts.ready; return host.querySelector<SVGSVGElement>("figure > svg.bk-diagram")!; }
const canonical = (item: Element): unknown => ({ tag: item.localName, attrs: Object.fromEntries([...item.attributes].filter(attr => attr.name !== "xmlns").map(attr => [attr.name, attr.value])), text: item.childElementCount ? undefined : item.textContent, children: [...item.children].map(canonical) });
const annotation = (svg: ParentNode) => [...svg.querySelectorAll(":scope > [data-diagram-callout],:scope > [data-diagram-callout-key],:scope > [data-diagram-notes-band]")].map(canonical);
const distance = (x: number, y: number, box: DOMRect) => Math.hypot(Math.max(box.x - x, 0, x - box.x - box.width), Math.max(box.y - y, 0, y - box.y - box.height));
const separated = (a: DOMRect, b: DOMRect, gap = 4) => a.x + a.width + gap <= b.x || a.x - gap >= b.x + b.width || a.y + a.height + gap <= b.y || a.y - gap >= b.y + b.height;
function sampled(path: SVGGeometryElement) {
  const points: DOMPoint[] = [], length = path.getTotalLength();
  for (let at = 0; at <= length; at += 0.5) points.push(path.getPointAtLength(at));
  points.push(path.getPointAtLength(length)); return points;
}
/** Actual fonts/bboxes/curves supplement the planner's conservative geometry. */
function assertAnnotations(svg: SVGSVGElement, source: string, count: number) {
  const notes = [...svg.querySelectorAll<SVGGElement>("[data-diagram-callout]")];
  expect(notes.length, "NONEMPTY_FULL_ANNOTATION_PROOF").toBe(count);
  const spec = parseDiagram(source), tree = buildDiagramLayout(spec, svg.dataset.diagramLayout === "narrow" ? "narrow" : "default");
  const nodes = [...svg.querySelectorAll<SVGGraphicsElement>("[data-diagram-node] > rect:not(.bk-diagram-node-focus),[data-diagram-node] > path,[data-diagram-node] > polygon,[data-diagram-node] > circle")];
  const masks = [...svg.querySelectorAll<SVGGraphicsElement>("[data-edge-mask],[data-group-heading-mask],[data-cardinality] rect,[data-axis$='mask']")];
  const paths = [...svg.querySelectorAll<SVGGeometryElement>("[data-diagram-edge] path,[data-diagram-shape]:is(path,line),[data-diagram-shape] > path")].filter(path => !path.closest("[data-diagram-node]")).map(path => ({ path, points: sampled(path) }));
  const issues: string[] = [];
  for (const text of svg.querySelectorAll<SVGTextElement>("text")) {
    const m = text.getScreenCTM()!, scale = Math.min(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
    if (parseFloat(getComputedStyle(text).fontSize) * scale < 9) issues.push("font floor");
  }
  const allText = [...svg.querySelectorAll<SVGTextElement>("[data-diagram-node] text,[data-diagram-group] text")];
  const legend = svg.querySelector<SVGGElement>("[data-diagram-legend]")?.getBBox();
  for (const note of notes) {
    const index = Number(note.dataset.diagramCallout), sourceNote = spec.callouts![index]!;
    expect(note.getAttribute("aria-label")).toBe(`Note on ${note.getAttribute("aria-label")!.split(": ")[0]!.slice(8)}: ${sourceNote.text}`);
    const texts = [...note.querySelectorAll<SVGTextElement>("text:not([data-callout-index])")];
    expect(texts.map(text => text.textContent).join(" "), `SOURCE_TEXT_${index}`).toBe(sourceNote.text);
    for (const text of texts) {
      const style = getComputedStyle(text), box = text.getBBox();
      if (style.fontSize !== "11px" || style.fontWeight !== "500" || !style.fontFamily.includes("Plus Jakarta Sans")) issues.push(`note role ${index}`);
      if (box.x < 8 || box.x + box.width > svg.viewBox.baseVal.width - 8) issues.push(`note frame ${index}`);
      if ([...nodes, ...masks].some(obstacle => !separated(box, obstacle.getBBox()))) issues.push(`note box ${index}`);
      if (paths.some(({ path, points }) => points.some(point => distance(point.x, point.y, box) < 4 + parseFloat(getComputedStyle(path).strokeWidth) / 2))) issues.push(`note connector ${index}`);
      if (legend && box.y + box.height + 4 > legend.y) issues.push(`note legend ${index}`);
    }
    const indexText = note.querySelector<SVGTextElement>("[data-callout-index]");
    if (indexText) {
      const box = indexText.getBBox();
      expect(indexText.textContent).toBe(String(index + 1)); expect(getComputedStyle(indexText).fontSize).toBe("9.5px");
      if (texts.some(text => !separated(box, text.getBBox(), 4))) issues.push(`index clearance ${index}`);
      continue;
    }
    const dot = note.querySelector<SVGCircleElement>("circle")!, leader = note.querySelector<SVGLineElement>("line")!;
    const target = svg.querySelector<SVGGElement>(`[data-diagram-node="${note.dataset.target}"],[data-diagram-group="${note.dataset.target}"]`);
    if (target) {
      const outline = target.querySelector<SVGGeometryElement>("rect,path,circle,polygon")!;
      const min = Math.min(...sampled(outline).map(point => Math.hypot(point.x - dot.cx.baseVal.value, point.y - dot.cy.baseVal.value)));
      if (min > 0.51) issues.push(`dot actual boundary ${index}`);
    }
    const length = leader.getTotalLength(); if (length < 8 || length > 24) issues.push(`leader length ${index}`);
    for (const point of sampled(leader).slice(6)) if ([...nodes, ...masks].some(obstacle => distance(point.x, point.y, obstacle.getBBox()) < 0.5)) issues.push(`leader obstacle ${index}`);
  }
  const cues = [...svg.querySelectorAll<SVGGElement>("[data-diagram-callout-key]")];
  for (const cue of cues) {
    const box = cue.querySelector<SVGRectElement>("rect")!.getBBox(), text = cue.querySelector<SVGTextElement>("text")!, target = cue.dataset.target;
    const targetGroup = svg.querySelector<SVGGElement>(`[data-diagram-node="${target}"],[data-diagram-group="${target}"]`);
    if(targetGroup){const outline=targetGroup.querySelector<SVGGeometryElement>("rect,path,circle,polygon")!;const centre=new DOMPoint(box.x+box.width/2,box.y+box.height/2);expect(outline.isPointInFill(centre)||sampled(outline).some(point=>distance(point.x,point.y,box)<0.51),"CUE_CONTACTS_ACTUAL_TARGET_GEOMETRY").toBe(true);}
    expect(box.height).toBe(16); expect(box.width).toBeGreaterThanOrEqual(16); expect(box.width).toBeGreaterThanOrEqual(text.getBBox().width + 10); expect(getComputedStyle(text).fontSize).toBe("9.5px");
    if (box.x < 12 || box.x + box.width > svg.viewBox.baseVal.width - 12 || box.y < 12) issues.push("cue frame");
    if ([...nodes.filter(node => node.closest("[data-diagram-node]")?.getAttribute("data-diagram-node") !== target), ...masks, ...allText].some(obstacle => !separated(box, obstacle.getBBox()))) issues.push(`cue unrelated geometry or text ${target}`);
    if (cues.some(other => other !== cue && !separated(box, other.getBBox()))) issues.push("cue collision");
    if (legend && box.y + box.height + 4 > legend.y) issues.push("cue legend");
    for (const { path, points } of paths) {
      const edgeIndex = path.closest("[data-diagram-edge]")?.getAttribute("data-diagram-edge"), shapeId = path.getAttribute("data-diagram-shape") ?? path.parentElement?.getAttribute("data-diagram-shape");
      const own = edgeIndex !== null && edgeIndex !== undefined ? spec.edges[Number(edgeIndex)]?.id === target : tree.elements.some(item => item.kind === "shape" && item.id === shapeId && item.edgeId === target);
      if (!own && points.some(point => distance(point.x, point.y, box) < 4 + parseFloat(getComputedStyle(path).strokeWidth) / 2)) issues.push(`cue connector ${target}`);
    }
  }
  for (const heading of svg.querySelectorAll<SVGGElement>("[data-callout-group-heading]")) {
    const width = Number(heading.dataset.columnWidth);
    for (const text of heading.querySelectorAll<SVGTextElement>("text")) { expect(getComputedStyle(text).fontSize, "HEADER_LABEL_SIZE").toBe("9.5px"); expect(text.getBBox().width).toBeLessThanOrEqual(width - Number(heading.dataset.headingOffset)); }
  }
  expect([...new Set(issues)], "ACTUAL_CALLOUT_GEOMETRY_AND_ROLE_CLEARANCE").toEqual([]);
}
async function assertParity(svg: SVGSVGElement, source: string, theme: "light" | "dark" | "print") {
  const xml = new DOMParser().parseFromString(await toStatic(source, { theme }), "image/svg+xml");
  expect(annotation(svg), "SHARED_CLIENT_STATIC_ALL_ANNOTATION_GEOMETRY").toEqual(annotation(xml.documentElement));
}
for (const theme of ["light", "dark", "print"] as const) {
 test(`literal full notes client/static capture ${theme}`, async () => {
  const source = JSON.stringify(calloutsSpec); mount(source, 800, theme); const svg = await svgReady(); assertAnnotations(svg, source, 1); await assertParity(svg, source, theme);
  await commands.diagramCapture('[data-content-renderer="diagram"]', `callouts-literal-${theme}`);
 });
 test(`literal to grouped full notes live client/static ${theme}`, async () => {
  let source = JSON.stringify(calloutsSpec); mount(source, 800, theme); let svg = await svgReady(); assertAnnotations(svg, source, 1); await assertParity(svg, source, theme);
  const previousHost = host;
  const spec = { ...calloutsSpec, callouts: Array.from({ length: 1024 }, (_, i) => ({ target: "odysseus", text: `Prepare provisions ${i + 1}` })) };
  source = JSON.stringify(spec); mount(source, 800, theme); svg = await svgReady(); expect(host, "GROUPED_UPDATE_RETAINS_CLIENT_ROOT").toBe(previousHost); assertAnnotations(svg, source, 1024); await assertParity(svg, source, theme);
  expect(svg.querySelectorAll("[data-diagram-callout-key]")).toHaveLength(1); expect(svg.querySelector("[data-diagram-callout-key]")!.textContent).toBe("1");
  expect(svg.querySelector("[data-diagram-notes-band]")!.getAttribute("data-columns")).toBe("2");
  const rows = [...svg.querySelectorAll<SVGGElement>("[data-diagram-callout]")];
  for (const column of [0, 1]) { const selected = rows.filter(row => row.dataset.column === String(column)); expect(selected).toHaveLength(512); expect(new Set(selected.map(row => row.querySelector("[data-callout-index]")!.getAttribute("x"))).size).toBe(1); }
 });
 test(`literal to grouped full notes capture ${theme}`, async () => {
  mount(JSON.stringify(calloutsSpec), 800, theme); const literal = await svgReady(); expect(literal.querySelectorAll("[data-diagram-callout]")).toHaveLength(1);
  const previousHost = host;
  const source = JSON.stringify({ ...calloutsSpec, callouts: Array.from({ length: 1024 }, (_, i) => ({ target: "odysseus", text: `Prepare provisions ${i + 1}` })) });
  mount(source, 800, theme); const svg = await svgReady(); expect(host, "CAPTURE_UPDATE_RETAINS_CLIENT_ROOT").toBe(previousHost);
  expect(svg.querySelectorAll("[data-diagram-callout]"), "CAPTURE_ALL_SOURCE_NOTES").toHaveLength(1024);
  expect([...svg.querySelectorAll("[data-callout-index]")].map(index => index.textContent), "CAPTURE_ALL_SOURCE_INDICES").toEqual(Array.from({ length: 1024 }, (_, i) => String(i + 1)));
  await commands.diagramCapture('[data-content-renderer="diagram"]', `callouts-1024-${theme}`);
 });
}

// Keep full geometry and raster capture independently within the case budget.
// Both cases mount the complete authored narrow source; teardown owns each body.
for (const theme of ["light", "dark", "print"] as const) {
 test(`authored narrow grouped notes geometry ${theme}`, async () => {
  const spec = { ...narrowCallouts(), callouts: Array.from({ length: 1024 }, (_, i) => ({ target: "odysseus", text: `Prepare provisions ${i + 1}` })) }, source = JSON.stringify(spec);
  mount(source, 320, theme); const svg = await svgReady(); assertAnnotations(svg, source, 1024);
  expect(svg.getAttribute("width")).toBe("320"); expect(svg.querySelector("[data-diagram-notes-band]")!.getAttribute("data-columns")).toBe("1"); expect(host.scrollWidth).toBeLessThanOrEqual(320);
  expect(svg.querySelectorAll("[data-diagram-callout-key]")).toHaveLength(1);
 });
 test(`authored narrow grouped notes capture ${theme}`, async () => {
  const spec = { ...narrowCallouts(), callouts: Array.from({ length: 1024 }, (_, i) => ({ target: "odysseus", text: `Prepare provisions ${i + 1}` })) }, source = JSON.stringify(spec);
  mount(source, 320, theme); const svg = await svgReady();
  expect(svg.getAttribute("width")).toBe("320"); expect(svg.querySelector("[data-diagram-notes-band]")!.getAttribute("data-columns")).toBe("1"); expect(host.scrollWidth).toBeLessThanOrEqual(320);
  expect(svg.querySelectorAll("[data-diagram-callout]"), "CAPTURE_ALL_NARROW_SOURCE_NOTES").toHaveLength(1024);
  expect([...svg.querySelectorAll("[data-callout-index]")].map(index => index.textContent), "CAPTURE_ALL_NARROW_SOURCE_INDICES").toEqual(Array.from({ length: 1024 }, (_, i) => String(i + 1)));
  await commands.diagramCapture('[data-content-renderer="diagram"]', `callouts-1024-narrow-${theme}`);
});
}
for (const width of [636, 640]) test(`responsive columns at nearest authored grid width ${width}`, async () => {
  const source = JSON.stringify({ ...calloutsSpec, nodes: [{ id: "odysseus", label: "Odysseus", at: [width - 184, 64], size: [160, 64] }], groups: [], edges: [], callouts: Array.from({ length: 9 }, (_, i) => ({ target: "odysseus", text: i % 2 ? "Prepare provisions before the voyage to Ithaca and read the ledger." : `Voyage ${i + 1}` })) });
  mount(source, 800); const svg = await svgReady(); assertAnnotations(svg, source, 9); await assertParity(svg, source, "light");
  expect(svg.getAttribute("width")).toBe(String(width)); expect(svg.querySelector("[data-diagram-notes-band]")!.getAttribute("data-columns")).toBe(width >= 640 ? "2" : "1");
  const rows = [...svg.querySelectorAll<SVGGElement>("[data-diagram-callout]")]; expect(rows.map(row => row.dataset.column)).toEqual(width >= 640 ? ["0", "0", "0", "0", "0", "1", "1", "1", "1"] : Array(9).fill("0"));
  for (const heading of svg.querySelectorAll<SVGGElement>("[data-callout-group-heading]")) expect(Number(heading.dataset.columnWidth)).toBeGreaterThanOrEqual(280);
  await commands.diagramCapture('[data-content-renderer="diagram"]', `callouts-columns-${width}`);
});
test("fixed canvas compatibility preserves all notes inline only when band cannot fit", async () => {
  for (const [y, band] of [[460, false], [440, true]] as const) {
    const source = JSON.stringify({ ...calloutsSpec, size: "doc-inline", nodes: [{ id: "odysseus", label: "Odysseus", at: [400, y], size: [160, 64] }], edges: [], groups: [], callouts: [{ target: "odysseus", text: "Prepare provisions" }, { target: "odysseus", text: "Read the ledger" }] });
    mount(source, 960); const svg = await svgReady(); assertAnnotations(svg, source, 2); await assertParity(svg, source, "light"); expect(svg.getAttribute("height")).toBe("600"); expect(!!svg.querySelector("[data-diagram-notes-band]")).toBe(band);
  }
});
for (const theme of ["light", "dark", "print"] as const) test(`semantic-only and safe-unmarked targets ${theme}`, async () => {
  const spec = { ...calloutsSpec, type: "quadrant", nodes: [{ id: "odysseus", label: "Odysseus" }], groups: [], edges: [{ id: "record", from: "odysseus", to: "odysseus", label: "RECORD" }], callouts: [{ target: "record", text: "Prepare provisions" }] }, source = JSON.stringify(spec);
  mount(source, 960, theme); const svg = await svgReady(); assertAnnotations(svg, source, 1); await assertParity(svg, source, theme);
  expect(svg.querySelector("[data-diagram-callout-key]")).toBeNull(); expect(svg.querySelector("[data-diagram-callout-group]")!.getAttribute("data-target-drawn")).toBe("false"); expect(svg.textContent).toContain("Not drawn: quadrant diagrams don’t draw connectors."); expect(svg.querySelector("[data-diagram-edge],path")).toBeNull();
  await commands.diagramCapture('[data-content-renderer="diagram"]', `callouts-semantic-${theme}`);
  const unmarked = JSON.stringify({ ...calloutsSpec, callouts: [{ target: "voyage", text: "Prepare provisions" }, { target: "voyage", text: "Read the ledger" }] }); mount(unmarked, 800, theme); const grouped = await svgReady(); assertAnnotations(grouped, unmarked, 2); expect(grouped.textContent).toContain("Not marked: no clear spot on the drawing."); expect(grouped.querySelector("[data-diagram-callout-group]")!.getAttribute("data-target-drawn")).toBe("unmarked");
});
for (const theme of ["light", "dark"] as const) test(`summary groups all source notes and semantic explanation ${theme}`, async () => {
  const spec = { ...calloutsSpec, callouts: [{ target: "odysseus", text: "Prepare provisions" }, { target: "ledger", text: "Read the ledger" }, { target: "odysseus", text: "Return to Ithaca" }] };
  mount(JSON.stringify(spec), 300, theme); await expect.poll(() => host.querySelector("[data-diagram-notes]")).not.toBeNull();
  expect(host.querySelectorAll("[data-diagram-notes] section")).toHaveLength(2); const rows = [...host.querySelectorAll<HTMLLIElement>("[data-diagram-notes] li")]; expect(rows.map(row => row.value)).toEqual([1, 3, 2]); expect(rows.map(row => row.querySelector("[data-callout-text]")!.textContent)).toEqual(["Prepare provisions", "Return to Ithaca", "Read the ledger"]); expect([...host.querySelectorAll("button,[role=button]")].some(button => button.textContent === "Open diagram")).toBe(true);
  for(const row of rows){const index=row.querySelector<HTMLElement>("[data-callout-index]")!;expect(index.textContent).toBe(String(row.value));expect(index.getBoundingClientRect().width,"VISIBLE_SUMMARY_SOURCE_INDEX").toBeGreaterThan(0);expect(getComputedStyle(index).visibility).toBe("visible");}
  await commands.diagramCapture('[data-content-renderer="diagram"]', `callouts-summary-${theme}`);
});
test("actual family geometry and named line/path targets retain every annotation", async () => {
  for (const original of Object.values(axisExamples)) {
    const source = JSON.stringify({ ...original, size: "fit", callouts: [{ target: original.nodes[0]!.id, text: "Prepare provisions" }] }); mount(source, 1100); const svg = await svgReady(); assertAnnotations(svg, source, 1); await assertParity(svg, source, "light");
  }
  for (const name of ["flowchart", "state-machine", "architecture-containment"] as const) {
    const original = JSON.parse(await commands.diagramFixture(name)); const target = name === "architecture-containment" ? original.containment.scopes[0].id : original.nodes.find((node: { shape?: string }) => ["decision", "initial"].includes(node.shape ?? ""))?.id ?? original.nodes[0].id;
    const source = JSON.stringify({ ...original, size: "fit", callouts: [{ target, text: "Prepare provisions" }] }); mount(source, 1600); const svg = await svgReady(); assertAnnotations(svg, source, 1); await assertParity(svg, source, "light");
  }
});

test("multi-digit shared keys reserve header space and remain attached to actual nodes",async()=>{
 const nodes=Array.from({length:100},(_,i)=>({id:`voyage-${i}`,label:"Voyage",at:[48+i%10*240,64+Math.floor(i/10)*128],size:[160,64]}));
 const source=JSON.stringify({...calloutsSpec,nodes,groups:[],edges:[],callouts:nodes.flatMap(node=>[{target:node.id,text:"Prepare provisions"},{target:node.id,text:"Read the ledger"}])});
 mount(source,2400);const svg=await svgReady();assertAnnotations(svg,source,200);await assertParity(svg,source,"light");expect(svg.querySelectorAll("[data-diagram-callout-key]")).toHaveLength(100);
 const last=svg.querySelector('[data-diagram-callout-key="100"]')!;expect(last.textContent).toBe("100");
 for(const group of svg.querySelectorAll<SVGGElement>("[data-diagram-callout-group]")){
  const keys=[...group.querySelectorAll<SVGGElement>("[data-callout-header-key]")],headers=[...group.querySelectorAll<SVGGElement>("[data-callout-group-heading]")];
  for(let i=0;i<keys.length;i++)expect(separated(keys[i]!.getBBox(),headers[i]!.getBBox(),4),"MULTIDIGIT_KEY_HEADER_CLEARANCE").toBe(true);
 }
 await commands.diagramCapture('[data-content-renderer="diagram"]',"callouts-multidigit-keys");
});
test("narrow unbreakable text uses readable full summary and retains all 1024 source indices",async()=>{
 const spec={...narrowCallouts(),callouts:Array.from({length:1024},(_,i)=>({target:"odysseus",text:i===0?"W".repeat(200):`Prepare provisions ${i+1}`}))};mount(JSON.stringify(spec),320);
 await expect.poll(()=>host.querySelector("[data-diagram-notes]")).not.toBeNull();const rows=[...host.querySelectorAll<HTMLLIElement>("[data-diagram-notes] li")];expect(rows).toHaveLength(1024);expect(rows[1023]!.querySelector("[data-callout-index]")!.textContent).toBe("1024");expect(rows[0]!.querySelector("[data-callout-text]")!.textContent).toBe("W".repeat(200));expect(host.scrollWidth).toBeLessThanOrEqual(320);
 const semantic=JSON.stringify({...calloutsSpec,type:"quadrant",nodes:[{id:"odysseus",label:"Odysseus"}],groups:[],edges:[{id:"record",from:"odysseus",to:"odysseus",label:"RECORD"}],callouts:[{target:"record",text:"Prepare provisions"}]});mount(semantic,300,"dark");await expect.poll(()=>host.querySelector("[data-diagram-notes]")?.textContent).toContain("Not drawn: quadrant diagrams don’t draw connectors.");await commands.diagramCapture('[data-content-renderer="diagram"]',"callouts-semantic-summary-dark");
});

test("painted polygon/circle and exact named route identity avoid invented geometry",async()=>{
 for(const original of [JSON.parse(quadrantExample),JSON.parse(pyramidExample)]){
  const target=original.nodes[0].id,source=JSON.stringify({...original,size:"fit",callouts:[{target,text:"Prepare provisions"},{target,text:"Read the ledger"}]});mount(source,1000);const svg=await svgReady();assertAnnotations(svg,source,2);await assertParity(svg,source,"light");
 }
 const state=JSON.parse(await commands.diagramFixture("state-machine"));const target=state.nodes.find((node:{shape?:string})=>node.shape==="initial").id;const stateSource=JSON.stringify({...state,size:"fit",callouts:[{target,text:"Prepare provisions"},{target,text:"Read the ledger"}]});mount(stateSource,1600);assertAnnotations(await svgReady(),stateSource,2);
 const sequence={...structuredClone(axisExamples.sequence),size:"fit",edges:[{id:"release",from:"zeus",to:"hermes",label:"RELEASE ORDER"},{id:"sail",from:"odysseus",to:"odysseus",label:"SAIL 17 DAYS"}],callouts:[{target:"release",text:"Prepare provisions"},{target:"sail",text:"Read the ledger"}]},source=JSON.stringify(sequence);mount(source,800);let svg=await svgReady();assertAnnotations(svg,source,2);await assertParity(svg,source,"light");expect(svg.querySelector('[data-diagram-edge="0"]')!.getAttribute("aria-label")).toBe("RELEASE ORDER, 1 note");expect(svg.querySelector('[data-diagram-edge="1"]')!.getAttribute("aria-label")).toBe("SAIL 17 DAYS, 1 note");
 const mismatch=JSON.stringify({...sequence,edges:[{id:"release",from:"hermes",to:"zeus",label:"RETURN"}],callouts:[{target:"release",text:"Prepare provisions"}]});mount(mismatch,800);svg=await svgReady();assertAnnotations(svg,mismatch,1);expect(svg.querySelector('[data-diagram-callout-group="release"]')!.getAttribute("data-target-drawn")).toBe("false");expect(svg.querySelector('[data-diagram-callout-key][data-target="release"]')).toBeNull();
 const ring=JSON.parse(loopExample),station=ring.positional.loop.stations[0],next=ring.positional.loop.stations[1];ring.size="fit";ring.edges=[{id:"word",from:station,to:next,label:"WORD"},{id:"record",from:station,to:next,label:"RECORD"}];ring.callouts=[{target:"word",text:"Prepare provisions"},{target:"record",text:"Read the ledger"}];const ringSource=JSON.stringify(ring);mount(ringSource,1000);svg=await svgReady();assertAnnotations(svg,ringSource,2);expect(svg.querySelector('[data-diagram-callout-group="record"]')!.getAttribute("data-target-drawn")).toBe("false");
 const before=new DOMParser().parseFromString(await toStatic(JSON.stringify({...ring,callouts:undefined}),{theme:"light"}),"image/svg+xml");expect(svg.querySelectorAll("path").length,"NO_FICTIONAL_EXTRA_RING_PATH").toBe(before.querySelectorAll("path").length);
});
test("interleaved repeated targets retain exact grouped indices and duplicate-label identity",async()=>{
 const source=JSON.stringify({...calloutsSpec,nodes:[{id:"odysseus",label:"Voyage",at:[80,80],size:[160,64]},{id:"hermes",label:"Voyage",at:[400,80],size:[160,64]},{id:"ledger",label:"Ledger",at:[720,80],size:[160,64]}],edges:[],groups:[],callouts:[{target:"odysseus",text:"First provisions",side:"below"},{target:"hermes",text:"First message"},{target:"odysseus",text:"Second provisions",side:"above"},{target:"ledger",text:"Single record"},{target:"hermes",text:"Second message"}]});mount(source,1000);const svg=await svgReady();assertAnnotations(svg,source,5);await assertParity(svg,source,"light");expect(svg.querySelector('[data-diagram-callout="3"]')!.getAttribute("data-placement")).toBe("below");expect([...svg.querySelectorAll('[data-diagram-callout-group="odysseus"] [data-callout-index]')].map(text=>text.textContent)).toEqual(["1","3"]);expect([...svg.querySelectorAll('[data-diagram-callout-group="hermes"] [data-callout-index]')].map(text=>text.textContent)).toEqual(["2","5"]);
});
