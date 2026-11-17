import { groupCallouts, undrawnCalloutExplanation } from "./callouts.js";
import { AXIS_TYPES } from "./spec.js";
import { createElement, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, IconButton, color } from "@schlessera/brain-ui-kit";
import type { ContentRendererPack, ContentRendererProps } from "@schlessera/brain-ui-sdk/client";
import { StaticDiagramShareMenu, ZoomViewer, useWikiLinkNavigation } from "@schlessera/brain-ui-react/content-figures";
import { diagramSvgModel, parseDiagram, type DiagramSvgModel, type SvgPrimitive } from "./svg-model.js";
import { DIAGRAM_TOKEN_CSS, typeWidthBudget } from "./skin.js";
import { DIAGRAM_DRAWING_CSS } from "./drawing-style.js";
import { toStatic } from "./render.js";

const attrNames:Record<string,string>={"text-anchor":"textAnchor","font-family":"fontFamily","font-size":"fontSize","font-weight":"fontWeight","letter-spacing":"letterSpacing","stroke-width":"strokeWidth","stroke-dasharray":"strokeDasharray","stroke-linecap":"strokeLinecap","stroke-linejoin":"strokeLinejoin",class:"className"};
function Drawing({model,theme,id,interactive=true}: {model:DiagramSvgModel;theme:ContentRendererProps["theme"];id:string;interactive?:boolean}) {
 const [active,setActive]=useState<string|null>(null), navigation=useWikiLinkNavigation();
 function render(item:SvgPrimitive,key:number):React.ReactNode {
  const attrs:Record<string,unknown>=Object.fromEntries(Object.entries(item.attrs).filter(([name])=>name!=="data-wiki-link").map(([name,value])=>[attrNames[name]??name,value]));
  const node=String(item.attrs["data-diagram-node"]??""), target=item.attrs["data-wiki-link"];
  if(node&&interactive){ attrs.tabIndex=0;attrs.role="group";attrs.onFocus=()=>setActive(node);attrs.onBlur=()=>setActive(null);attrs.onMouseEnter=()=>setActive(node);attrs.onMouseLeave=()=>setActive(null);
   if(typeof target==="string"&&navigation.resolve(target)){attrs.role="link";attrs.onClick=(event:React.MouseEvent<SVGGElement>)=>navigation.open(target,event.currentTarget,event.detail===0);attrs.onKeyDown=(event:React.KeyboardEvent<SVGGElement>)=>{if(event.key==="Enter"){event.preventDefault();navigation.open(target,event.currentTarget,true);}};}
  }
  if(active&&(item.attrs["data-from"]===active||item.attrs["data-to"]===active||item.attrs["data-target"]===active))attrs["data-highlighted"]="";
  return createElement(item.tag,{...attrs,key},item.text,item.children?.map(render));
 }
 const {x,y,width,height}=model.tree.viewBox;
 return <svg xmlns="http://www.w3.org/2000/svg" className="bk-diagram" data-grammar={model.tree.grammar} data-theme={theme} data-diagram-layout={width===320?"narrow":"default"} role={interactive?"figure":"img"} aria-labelledby={`${id}-title ${id}-desc`} viewBox={`${x} ${y} ${width} ${height}`} width={width} height={height} style={{maxWidth:"none",flexShrink:0}}>
  <title id={`${id}-title`}>{model.tree.title}</title><desc id={`${id}-desc`}>{model.tree.desc}</desc>
  <style data-content-renderer-tokens="">{DIAGRAM_TOKEN_CSS}</style><style>{DIAGRAM_DRAWING_CSS}</style>
  {model.elements.map(render)}
 </svg>;
}
/** Frame chrome that only CSS can express: print strips the frame back to the
 * unframed paper figure, and the frame replaces the drawing's own screen edge.
 * The drawing stays a direct child, at native width, so a 320px column still
 * fits the authored 320px layout: the edge is an inset outline, not a border. */
const FRAME_CSS=`[data-diagram-framed]>svg.bk-diagram{margin:0 auto;border-radius:0 0 11px 11px}[data-diagram-framed]>svg.bk-diagram .bk-diagram-screen-frame{display:none}@media print{[data-diagram-framed]{outline:none!important;border-radius:0!important}[data-diagram-framed]>.bk-diagram-head{padding:0!important;border-bottom:none!important}[data-diagram-framed]>[data-diagram-summary],[data-diagram-framed]>[data-diagram-notes]{padding:0!important}}`;
/** Render at native units; never shrink text below the approved 9px floor.
 * Chat and file views frame the figure like other content blocks, with the
 * title and the open/share actions in one header. Share output keeps the
 * unframed figure it has always embedded. */
export function DiagramContent({source,theme,mode}:ContentRendererProps) {
 const spec=useMemo(()=>parseDiagram(source),[source]), desktop=useMemo(()=>diagramSvgModel(spec),[spec]);
 const narrow=useMemo(()=>{try{return spec.layouts?.narrow || (AXIS_TYPES as readonly string[]).includes(spec.type)?diagramSvgModel(spec,"narrow"):null;}catch{return null;}},[spec]);
 const host=useRef<HTMLElement>(null), [width,setWidth]=useState(0),[viewer,setViewer]=useState(false),id=useId().replace(/[^a-z0-9-]/gi,"");
 useEffect(()=>{const element=host.current;if(!element)return;const observer=new ResizeObserver(entries=>setWidth(entries[0]!.contentRect.width));observer.observe(element);setWidth(element.getBoundingClientRect().width);return()=>observer.disconnect();},[]);
 const model=width>=desktop.tree.viewBox.width ? desktop : narrow&&width>=narrow.tree.viewBox.width?narrow:null;
 const renderModel=mode==="share"?desktop:model, framed=mode!=="share", inset=framed?"0 12px":undefined;
 const share=<StaticDiagramShareMenu svg={()=>toStatic(source,{theme:"print"})}/>;
 return <figure ref={host} className="bk-diagram" data-theme={theme} data-content-renderer="diagram" data-renderer-mode={mode} data-diagram-framed={framed?"":undefined} aria-labelledby={framed?`${id}-caption`:undefined} style={{margin:"12px 0",maxWidth:"100%",minWidth:0,color:"var(--bk-diagram-text)",fontFamily:'"Plus Jakarta Sans",system-ui,sans-serif',...framed?{boxSizing:"border-box",borderRadius:12,outline:`1px solid ${color.edge}`,outlineOffset:-1,paddingBottom:renderModel?0:12}:{}}}>
  <style data-content-renderer-tokens="">{DIAGRAM_TOKEN_CSS}</style>
  {framed ? <figcaption className="bk-diagram-head" style={{display:"flex",alignItems:"center",gap:8,minWidth:0,padding:"4px 6px 4px 12px",borderBottom:`1px solid ${color.line}`}}>
   <span id={`${id}-caption`} data-diagram-title="" style={{flex:"1 1 auto",minWidth:0,fontFamily:'"DM Serif Text",Georgia,serif',fontSize:18,overflowWrap:"anywhere"}}>{spec.title}</span>
   <span className="bk-diagram-controls" style={{flex:"none",marginLeft:"auto",display:"flex",alignItems:"center",gap:4}}>
    <IconButton size="sm" icon="enlarge" name="Open diagram" onClick={()=>setViewer(true)}/>
    {share}
   </span>
  </figcaption> : <figcaption style={{fontFamily:'"DM Serif Text",Georgia,serif',fontSize:18}}>{spec.title}</figcaption>}
  {renderModel ? <Drawing model={renderModel} theme={theme} id={id}/> : <><p data-diagram-summary="" style={{padding:inset}}>{spec.desc}</p>{spec.callouts?.length?<div data-diagram-notes="" style={{padding:inset}}>{groupCallouts(spec).map(group=>{
   const planned=desktop.elements.flatMap(item=>item.attrs["data-diagram-notes-band"]!==undefined?item.children??[]:[]).find(item=>item.attrs["data-diagram-callout-group"]===group.target);
   return <section key={group.target} data-target={group.target}><h3 style={{fontFamily:'"JetBrains Mono",monospace',fontSize:9.5,fontWeight:600,color:"var(--bk-diagram-text)"}}>{group.name} · {group.indices.length} {group.indices.length===1?"NOTE":"NOTES"}</h3>
    {planned?.attrs["data-target-drawn"]==="false"?<p style={{fontSize:14}}>{undrawnCalloutExplanation(spec,group.target)}</p>:null}
    <ol style={{margin:0,padding:0,listStyle:"none"}}>{group.indices.map(index=><li key={index} value={index+1} data-diagram-callout={index} style={{display:"grid",gridTemplateColumns:`${Math.max(24,typeWidthBudget(String(spec.callouts!.length),"label"))}px minmax(0,1fr)`,columnGap:8,fontSize:14,fontWeight:500}}><span data-callout-index="" style={{fontFamily:'"JetBrains Mono",monospace',fontSize:9.5,fontWeight:600,textAlign:"right",color:"var(--bk-color-ink-mute)"}}>{index+1}</span><span data-callout-text="" style={{minWidth:0,overflowWrap:"anywhere"}}>{spec.callouts![index]!.text}</span></li>)}</ol>
   </section>;
  })}</div>:null}</>}
  {framed ? null : <div className="bk-diagram-controls" style={{display:"flex",gap:8,flexWrap:"wrap"}}>
   <Button label="Open diagram" block={false} onClick={()=>setViewer(true)} style={{minHeight:44,minWidth:44}}/>
   {share}
  </div>}
  <div className="bk-diagram-print" style={{display:"none"}}><Drawing model={desktop} theme="print" id={`${id}-print`} interactive={false}/></div>
  <style>{`@media print{[data-content-renderer="diagram"]>.bk-diagram,[data-content-renderer="diagram"]>[data-diagram-summary],[data-content-renderer="diagram"]>[data-diagram-notes],.bk-diagram-controls{display:none!important}.bk-diagram-print{display:block!important}}`}</style>
  {framed ? <style>{FRAME_CSS}</style> : null}
  {viewer&&<ZoomViewer label="Diagram viewer" onClose={()=>setViewer(false)} minScale={1} maxFitScale={1} actions={<StaticDiagramShareMenu svg={()=>toStatic(source,{theme:"print"})}/>}><Drawing model={narrow??desktop} theme={theme} id={`${id}-viewer`}/></ZoomViewer>}
 </figure>;
}
export const diagramsContentPack:ContentRendererPack={renderers:[{languages:["diagram"],extensions:[".diagram.yaml"],needsBrowser:false,toStatic,Component:DiagramContent}]};
export default diagramsContentPack;
