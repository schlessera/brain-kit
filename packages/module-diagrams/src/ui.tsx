import { createElement, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@schlessera/brain-ui-kit";
import type { ContentRendererPack, ContentRendererProps } from "@schlessera/brain-ui-sdk/client";
import { StaticDiagramShareMenu, ZoomViewer, useWikiLinkNavigation } from "@schlessera/brain-ui-react/content-figures";
import { diagramSvgModel, parseDiagram, type DiagramSvgModel, type SvgPrimitive } from "./svg-model.js";
import { DIAGRAM_TOKEN_CSS } from "./skin.js";
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
  if(active&&(item.attrs["data-from"]===active||item.attrs["data-to"]===active))attrs["data-highlighted"]="";
  return createElement(item.tag,{...attrs,key},item.text,item.children?.map(render));
 }
 const {width,height}=model.tree.viewBox;
 return <svg xmlns="http://www.w3.org/2000/svg" className="bk-diagram" data-theme={theme} data-diagram-layout={width===320?"narrow":"default"} role={interactive?"figure":"img"} aria-labelledby={`${id}-title ${id}-desc`} viewBox={`0 0 ${width} ${height}`} width={width} height={height} style={{maxWidth:"none",flexShrink:0}}>
  <title id={`${id}-title`}>{model.tree.title}</title><desc id={`${id}-desc`}>{model.tree.desc}</desc>
  <style data-content-renderer-tokens="">{DIAGRAM_TOKEN_CSS}</style><style>{DIAGRAM_DRAWING_CSS}</style>
  {model.elements.map(render)}
 </svg>;
}
/** Render at native units; never shrink text below the approved 9px floor. */
export function DiagramContent({source,theme,mode}:ContentRendererProps) {
 const spec=useMemo(()=>parseDiagram(source),[source]), desktop=useMemo(()=>diagramSvgModel(spec),[spec]);
 const narrow=useMemo(()=>spec.layouts?.narrow?diagramSvgModel(spec,"narrow"):null,[spec]);
 const host=useRef<HTMLElement>(null), [width,setWidth]=useState(0),[viewer,setViewer]=useState(false),id=useId().replace(/[^a-z0-9-]/gi,"");
 useEffect(()=>{const element=host.current;if(!element)return;const observer=new ResizeObserver(entries=>setWidth(entries[0]!.contentRect.width));observer.observe(element);setWidth(element.getBoundingClientRect().width);return()=>observer.disconnect();},[]);
 const model=width>=desktop.tree.viewBox.width ? desktop : narrow&&width>=narrow.tree.viewBox.width?narrow:null;
 const renderModel=mode==="share"?desktop:model;
 return <figure ref={host} className="bk-diagram" data-theme={theme} data-content-renderer="diagram" data-renderer-mode={mode} style={{margin:"12px 0",maxWidth:"100%",minWidth:0,color:"var(--bk-diagram-text)",fontFamily:'"Plus Jakarta Sans",system-ui,sans-serif'}}>
  <style data-content-renderer-tokens="">{DIAGRAM_TOKEN_CSS}</style>
  <figcaption style={{fontFamily:'"DM Serif Text",Georgia,serif',fontSize:18}}>{spec.title}</figcaption>
  {renderModel ? <Drawing model={renderModel} theme={theme} id={id}/> : <p data-diagram-summary="">{spec.desc}</p>}
  <div className="bk-diagram-controls" style={{display:"flex",gap:8,flexWrap:"wrap"}}>
   <Button label="Open diagram" block={false} onClick={()=>setViewer(true)} style={{minHeight:44,minWidth:44}}/>
   <StaticDiagramShareMenu svg={()=>toStatic(source,{theme:"print"})}/>
  </div>
  <div className="bk-diagram-print" style={{display:"none"}}><Drawing model={desktop} theme="print" id={`${id}-print`} interactive={false}/></div>
  <style>{`@media print{[data-content-renderer="diagram"]>.bk-diagram,[data-content-renderer="diagram"]>[data-diagram-summary],.bk-diagram-controls{display:none!important}.bk-diagram-print{display:block!important}}`}</style>
  {viewer&&<ZoomViewer label="Diagram viewer" onClose={()=>setViewer(false)} minScale={1} maxFitScale={1} actions={<StaticDiagramShareMenu svg={()=>toStatic(source,{theme:"print"})}/>}><Drawing model={narrow??desktop} theme={theme} id={`${id}-viewer`}/></ZoomViewer>}
 </figure>;
}
export const diagramsContentPack:ContentRendererPack={renderers:[{languages:["diagram"],extensions:[".diagram.yaml"],needsBrowser:false,toStatic,Component:DiagramContent}]};
export default diagramsContentPack;
