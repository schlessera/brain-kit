import {beforeAll,expect,test} from "vitest";
import {commands} from "vitest/browser";
import {toStatic} from "../../../module-diagrams/src/render.js";
import {toFlatSvg} from "../../../module-diagrams/src/flatten.js";
import {axisExamples} from "../../../module-diagrams/tests/fixtures/axis-examples.js";
import quadrant from "../../../module-diagrams/skills/diagram/references/examples/positional/quadrant.diagram.yaml?raw";
import venn from "../../../module-diagrams/skills/diagram/references/examples/positional/venn.diagram.yaml?raw";
import loop from "../../../module-diagrams/skills/diagram/references/examples/positional/loop.diagram.yaml?raw";
import er from "../../../module-diagrams/skills/diagram/references/examples/er.diagram.yaml?raw";
import dependency from "../../../module-diagrams/skills/diagram/references/examples/dependency.diagram.yaml?raw";
import containment from "../../../module-diagrams/skills/diagram/references/examples/architecture-containment.diagram.yaml?raw";
let fonts:string;beforeAll(async()=>{fonts=`<style>${await commands.diagramFontStyles()}</style>`;});
const examples={...Object.fromEntries(Object.entries(axisExamples).map(([key,value])=>[key,JSON.stringify(value)])),quadrant,venn,loop,er,dependency,containment};
for(const [kind,source] of Object.entries(examples))for(const theme of ["light","dark","print"] as const)test(`${kind} ${theme} flattened SVG is pixel-identical to static renderer`,async()=>{
 const flat=toFlatSvg(source,theme),original=await toStatic(source,{theme});expect(flat).not.toContain("var(");expect(await commands.diagramRasterComparison(`export-${kind}-${theme}`,fonts+original,fonts+flat),"FLATTENED_STATIC_RASTER_PARITY").toBe(true);
 const parsed=new DOMParser().parseFromString(flat,"image/svg+xml");expect(parsed.querySelector("parsererror")).toBeNull();for(const element of parsed.querySelectorAll("[fill],[stroke]"))for(const attr of ["fill","stroke"])expect(element.getAttribute(attr)??"").not.toContain("var(");
});
test("authored literal var text survives SVG parsing",()=>{
 const spec=structuredClone(axisExamples.sequence);spec.title="A literal var(--bk-example)";spec.nodes[0]!.label="var(--example)";const parsed=new DOMParser().parseFromString(toFlatSvg(JSON.stringify(spec),"light"),"image/svg+xml");expect(parsed.querySelector("title")!.textContent).toBe(spec.title);expect([...parsed.querySelectorAll("text")].some(t=>t.textContent==="var(--example)")).toBe(true);
});
test("real optional renderer writes keyless PNG and one-page PDF",async()=>{const artifacts=await commands.diagramArtifact();expect(artifacts.map(a=>a.format)).toEqual(["png","pdf"]);expect(artifacts.every(a=>a.bytes>1000)).toBe(true);expect(artifacts.find(a=>a.format==="png")!.pixelEquivalent,"EXPORTED_PNG_LOCKED_FONT_PIXEL_PARITY").toBe(true);expect(artifacts.find(a=>a.format==="pdf")!.fonts).toEqual(["JetBrainsMono","PlusJakartaSans"]);},60000);
for(const theme of ["light","dark","print"] as const)test(`authored free layout ${theme} flattened paint retains exact pixels`,async()=>{const source=await commands.diagramFixture();expect(await commands.diagramRasterComparison(`export-free-${theme}`,fonts+await toStatic(source,{theme}),fonts+toFlatSvg(source,theme)),"FLATTENED_STATIC_RASTER_PARITY").toBe(true);});
import {flattenPaint} from "../../../module-diagrams/src/flatten.js";
import {DIAGRAM_TOKEN_CSS,diagramInkRamp} from "../../../module-diagrams/src/skin.js";
for(const theme of ["light","dark","print"] as const)test(`${theme} all generated opaque ink ramps flatten to exact browser pixels`,async()=>{const ramps=([25,50,75,100] as const).map((step,i)=>({x:i*100,fill:diagramInkRamp(step)})),rects=(flat:boolean)=>ramps.map(({x,fill})=>`<rect x="${x}" width="100" height="100" fill="${flat?flattenPaint(fill,theme):fill}"/>`).join("");const original=`<svg xmlns="http://www.w3.org/2000/svg" class="bk-diagram" data-theme="${theme}" width="400" height="100"><style>${DIAGRAM_TOKEN_CSS}</style>${rects(false)}</svg>`,flat=`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">${rects(true)}</svg>`;expect(await commands.diagramRasterComparison(`export-ramps-${theme}`,original,flat),"GENERATED_INK_RAMP_RASTER_PARITY").toBe(true);});
