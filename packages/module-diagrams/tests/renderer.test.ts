import { expect, test } from "bun:test";
import { toStatic, diagramsStaticPack } from "../src/render.js";
import { diagramSvgModel, parseDiagram, serializePrimitive } from "../src/svg-model.js";
import { rendererSpec } from "./fixtures/renderer-fixture.js";
const source=JSON.stringify(rendererSpec);
test("the diagrams module exposes its real static renderer pack",()=>{expect(diagramsStaticPack.renderers[0]).toMatchObject({languages:["diagram"],extensions:[".diagram.yaml"],needsBrowser:false});});
test("one neutral geometry model supplies every serialized static theme",async()=>{
 const model=diagramSvgModel(parseDiagram(source));
 expect(model.tree.viewBox).toEqual({x:0,y:0,width:960,height:600});
 expect(model.tree.elements.filter(item=>item.kind==="node").map(item=>({id:item.id,x:item.x,y:item.y,width:item.width,height:item.height}))).toMatchSnapshot();
 const content=model.elements.map(serializePrimitive).join("");
 for(const theme of ["light","dark","print"] as const){const svg=await toStatic(source,{theme});expect(svg).toContain(content);expect(svg).toContain(`data-theme="${theme}"`);expect(svg).toContain("data-content-renderer-tokens");expect(svg).not.toMatch(/<script|foreignObject|on[a-z]+=/i);}
});
test("authored narrow preserves semantics and exact frame without scaling",()=>{const spec=parseDiagram(source),model=diagramSvgModel(spec,"narrow");expect(model.tree.viewBox).toEqual({x:0,y:0,width:320,height:400});expect(model.minimumFont).toBeGreaterThanOrEqual(9);expect(model.tree.elements.filter(e=>e.kind==="node").map(e=>e.id)).toEqual(["raft","ithaca"]);});
test("spec text is escaped and never becomes SVG markup",async()=>{const spec=structuredClone(rendererSpec);spec.title="<script>raft</script>";spec.nodes[0]!.label="<b>Raft</b>";const svg=await toStatic(JSON.stringify(spec),{theme:"print"});expect(svg).toContain("&lt;script&gt;raft&lt;/script&gt;");expect(svg).not.toContain("<script>");expect(svg).not.toContain("<b>");});
test("malformed or newer specs fail instead of emitting partial unsafe SVG",async()=>{await expect(toStatic(source.replace('"schema_version":1','"schema_version":2'),{theme:"print"})).rejects.toThrow("newer than supported");});
