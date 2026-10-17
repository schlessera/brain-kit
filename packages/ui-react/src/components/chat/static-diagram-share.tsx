import { useBrainUiRoot } from "../../root-context.js";
import { ShareMenu } from "../share/share-menu.js";
import { renderAndShare, shareFile } from "../../lib/share.js";
/** The shared, existing share path for a trusted browser-free diagram entry. */
export function StaticDiagramShareMenu({svg, filename = "diagram"}: {svg: () => Promise<string>; filename?: string}) {
 const root=useBrainUiRoot();
 const html=async(tight:boolean)=> { const drawing=await svg(); if(drawing.length>480000)throw Error("Diagram is too large to share as an image"); return `${tight ? '<style>body{width:fit-content;padding:24px}</style>' : ""}${drawing}`; };
 return <ShareMenu title="Share diagram" options={[
  {id:"png",label:"Image (PNG)",run:async()=>renderAndShare(root,{content:await html(true),contentType:"html",format:"png",filename,title:root.config.shareTitle})},
  {id:"pdf",label:"PDF",run:async()=>renderAndShare(root,{content:await html(false),contentType:"html",format:"pdf",filename,title:root.config.shareTitle})},
  {id:"svg",label:"Vector (SVG)",run:async()=>shareFile(new File([await svg()],`${filename}.svg`,{type:"image/svg+xml"}),{title:root.config.shareTitle})}
 ]}/>;
}
