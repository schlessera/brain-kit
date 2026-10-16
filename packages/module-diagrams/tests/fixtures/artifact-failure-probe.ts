import { mock } from "bun:test";
import { join } from "node:path";
const mode=process.argv[2]!,root=process.argv[3]!;
if(mode==="partial"){
 const real=await import("@schlessera/brain/module"),originalWrite=real.writeFileSafely;let writes=0;
 mock.module("@schlessera/brain/module",()=>({...real,writeFileSafely:(...args:Parameters<typeof real.writeFileSafely>)=>{if(++writes===2)throw Error("Controlled second artifact write failure");return originalWrite(...args);}}));
 const {buildDiagrams}=await import("../../src/export-cli.js");console.log(JSON.stringify(await buildDiagrams(["dispatch.md"],root)));
}else{
 const calls:unknown[]=[];
 mock.module("@schlessera/brain-render-puppeteer",()=>({createRenderer:(options:unknown)=>{calls.push(options);return {renderPng:async()=>{calls.push("png");throw Error("Controlled render failure");},renderPdf:async()=>new Uint8Array([1]),shutdown:async()=>{calls.push("shutdown");if(mode==="shutdown")throw Error("Controlled shutdown failure");}};}}));
 const {renderHtmlArtifact}=await import("../../../core/src/lib/render-artifact.js");let message="";
 try{await renderHtmlArtifact({html:"<p>The voyage</p>",format:mode==="shutdown"?"pdf":"png"});}catch(error){message=String(error);}
 console.log(JSON.stringify({calls,message}));
}
