import { noSandboxFromEnv, resolveDocumentRenderer } from "../providers/renderers/puppeteer.js";
/** Render one offline HTML artifact through the existing optional renderer. */
export async function renderHtmlArtifact(input:{html:string;format:"png"|"pdf";width?:number}):Promise<Uint8Array>{
 if(input.format!=="png"&&input.format!=="pdf")throw Error("Artifact format must be png or pdf");
 const renderer=await resolveDocumentRenderer({noSandbox:noSandboxFromEnv(),allowHosts:[]});
 try{return input.format==="png"?await renderer.renderPng({html:input.html,width:input.width}):await renderer.renderPdf({html:input.html,width:input.width});}finally{await renderer.shutdown();}
}
