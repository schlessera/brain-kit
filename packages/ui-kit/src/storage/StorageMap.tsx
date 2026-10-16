import { useId, useRef, useState, type KeyboardEvent } from "react";
import { color, font } from "../tokens.js";

export interface StorageMapItem { id: string; name: string; owner: "brain" | "app" | "operator"; bytes: number; label: string; smaller?: boolean }
export interface StorageMapProps {
  items: readonly StorageMapItem[]; width: number; height: number; label: string; descriptionId: string;
  onOpen: (id: string) => void; onUp: () => void;
}
/** Bounded binary subdivision preserves area without a chart runtime. Input is already a disjoint union. */
export function storageRectangles(items: readonly StorageMapItem[], width: number, height: number) {
  const result: Array<{ item: StorageMapItem; x: number; y: number; width: number; height: number }> = [];
  function split(rows: readonly StorageMapItem[], x: number, y: number, w: number, h: number) {
    if (!rows.length || w <= 0 || h <= 0) return;
    if (rows.length === 1) { result.push({item: rows[0]!,x,y,width:w,height:h}); return; }
    const total=rows.reduce((sum,row)=>sum+row.bytes,0);let cut=1, first=rows[0]!.bytes;
    while(cut<rows.length-1 && first+rows[cut]!.bytes<=total/2)first+=rows[cut++]!.bytes;
    const ratio=first/total;
    if(w>=h) { split(rows.slice(0,cut),x,y,w*ratio,h);split(rows.slice(cut),x+w*ratio,y,w*(1-ratio),h); }
    else { split(rows.slice(0,cut),x,y,w,h*ratio);split(rows.slice(cut),x,y+h*ratio,w,h*(1-ratio)); }
  }
  split(items.filter(item=>Number.isFinite(item.bytes)&&item.bytes>0),0,0,Math.max(0,width),Math.max(0,height));
  return result;
}
/** One roving tab stop; the equivalent list remains the complete interaction surface. */
export function StorageMap({items,width,height,label,descriptionId,onOpen,onUp}:StorageMapProps) {
  const prefix=useId(), group=useRef<HTMLDivElement>(null), [active,setActive]=useState<string|null>(null);
  const rectangles=storageRectangles(items,width,height), targets=rectangles.filter(rect=>rect.width>=44 && rect.height>=44).sort((a,b)=>a.y-b.y||a.x-b.x);
  const selected=targets.some(rect=>rect.item.id===active)?active:targets[0]?.item.id;
  function key(event:KeyboardEvent) {
    if(event.key==="Backspace" || event.altKey&&event.key==="ArrowUp") {event.preventDefault();onUp();return;}
    if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(event.key)||!targets.length)return;
    event.preventDefault();const current=targets.findIndex(rect=>rect.item.id===selected);
    const next=event.key==="Home"?0:event.key==="End"?targets.length-1:(current+(["ArrowLeft","ArrowUp"].includes(event.key)?-1:1)+targets.length)%targets.length;
    const id=targets[next]!.item.id;setActive(id);group.current?.querySelector<HTMLElement>(`[data-storage-map-index="${next}"]`)?.focus();
  }
  return <div ref={group} role="group" aria-label={label} aria-describedby={descriptionId} onKeyDown={key} tabIndex={targets.length?undefined:0} style={{position:"relative",width:"100%",height,fontFamily:font.body}}>
    {rectangles.map(rect=>{
      const {item}=rect,target=targets.findIndex(value=>value.item.id===item.id),labelled=rect.width>=62&&rect.height>=40;
      const skin={position:"absolute" as const,left:rect.x,top:rect.y,width:rect.width,height:rect.height,boxSizing:"border-box" as const,padding:4,overflow:"hidden",border:`1px ${item.owner==="operator"||item.smaller?"dashed":"solid"} ${color.edge}`,background:item.owner==="app"?`repeating-linear-gradient(135deg, transparent, transparent 6px, var(--bk-color-edge) 6px, var(--bk-color-edge) 7px)` : "var(--bk-color-raised)",color:color.ink,textAlign:"left" as const,fontSize:12,lineHeight:1.35,borderRadius:3};
      const contents=labelled?<><span style={{display:"block",overflowWrap:"anywhere",fontWeight:600}}>{item.name}</span><span style={{display:"block"}}>{item.label}</span><span style={{display:"block",fontSize:10}}>{item.smaller?"Open list":item.owner==="brain"?"Brain":item.owner==="app"?"App":"Operator"}</span></>:null;
      return target>=0?<button /* raw-button: composite — a roving proportional map tile */ key={item.id} id={`${prefix}-${target}`} type="button" data-storage-map-index={target} aria-label={`${item.name}, ${item.owner}, ${item.label}${item.smaller?", Open list":""}`} tabIndex={selected===item.id?0:-1} onFocus={()=>setActive(item.id)} onClick={()=>onOpen(item.id)} style={skin}>{contents}</button>:<div key={item.id} aria-hidden="true" style={skin}>{contents}</div>;
    })}
  </div>;
}
