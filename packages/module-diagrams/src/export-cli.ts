import { existsSync,lstatSync } from "node:fs";
import { basename,dirname,extname,join,relative } from "node:path";
import { markdownFences,resolveWritable,writeFileSafely,renderHtmlArtifact,SCRATCH_DIR,scratchName,assertScratchWritable,writeScratchFile,isInScratch } from "@schlessera/brain/module";
import {readRegularText} from "./regular-text.js";
import { parseDiagram } from "./svg-model.js";
import { embedDiagramFonts } from "./fonts.js";
import { toFlatSvg } from "./flatten.js";
import { checkDiagram } from "./check.js";
import type { DiagramTheme } from "./skin.js";
import { sourceHash,markDerived,derivedIdentity } from "./derived.js";
export interface ArtifactFinding {code:string;path:string;message:string}
export interface DiagramExportResult {schema_version:1;ok:boolean;input:string;output:string|null;format:"svg"|"png"|"pdf";theme:DiagramTheme;bytes:number;warnings:ArtifactFinding[];errors:ArtifactFinding[]}
export interface DiagramBuildResult {schema_version:1;ok:boolean;input:string;figures:{id:string;light:string;dark:string;picture:string;source_sha256:string}[];written:string[];warnings:ArtifactFinding[];errors:ArtifactFinding[]}
const themes=new Set(["light","dark","print"]),formats=new Set(["svg","png","pdf"]);
const finding=(code:string,path:string,error:unknown):ArtifactFinding=>({code,path,message:error instanceof Error?error.message:String(error)});
/** Bounded UTF-8 input, before a complete allocation, for files and stdin. */
export async function readDiagramInput(root:string,input:string):Promise<{source:string;path:string;absolute:string|null}>{
 const absolute=input==="-"?null:resolveWritable(root,input);if(input!=="-"&&!absolute)throw Error("Input path must remain inside the brain");if(absolute&&!lstatSync(absolute).isFile())throw Error("Input must be a regular file");
 const file=absolute?Bun.file(absolute):Bun.stdin,reader=file.stream().getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>1024*1024)throw Error("Diagram input exceeds the 1 MiB parse bound");chunks.push(item.value);}}finally{await reader.cancel();}
 return {source:new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks,size)),path:absolute?relative(root,absolute):"-",absolute};
}
function target(root:string,path:string):string {const parent=resolveWritable(root,dirname(path));if(!parent)throw Error("Output path must remain inside the brain");const result=join(parent,basename(path)),entry=lstatSync(result,{throwIfNoEntry:false});if(entry?.isSymbolicLink()||entry&&!entry.isFile())throw Error("Output must be an unlinked regular file name");if(!resolveWritable(root,result))throw Error("Output path must remain inside the brain");return result;}
function ownedTarget(root:string,path:string,id:string,document:string):boolean {
 const absolute=target(root,path);if(!existsSync(absolute))return false;
 const identity=derivedIdentity(readRegularText(absolute,8*1024*1024));if(!identity||identity.id!==id||identity.document!==document)throw Error(`Refusing to replace an unrelated SVG: ${path}`);return true;
}
function write(root:string,path:string,data:string|Uint8Array,replace=true):string {const absolute=target(root,path);if(isInScratch(root,path)||isInScratch(root,absolute)){assertScratchWritable(root,absolute);writeScratchFile(root,path,data,{replace});}else writeFileSafely(absolute,data,{replace});return relative(root,absolute);}
function args(argv:string[]):{position:string[];flags:Record<string,string>} {const position:string[]=[],flags:Record<string,string>={};for(let i=0;i<argv.length;i++){const arg=argv[i]!;if(arg.startsWith("--")){if(!["--theme","--format","--out"].includes(arg)||flags[arg]!==undefined)throw Error(`Unknown or repeated option '${arg}'`);const value=argv[++i];if(!value||value.startsWith("--"))throw Error(`${arg} requires a value`);flags[arg]=value;}else position.push(arg);}return {position,flags};}
export async function exportDiagram(argv:string[],root:string):Promise<DiagramExportResult>{
 const result:DiagramExportResult={schema_version:1,ok:false,input:argv[0]??"",output:null,format:"svg",theme:"print",bytes:0,warnings:[],errors:[]};
 try{const parsed=args(argv);if(parsed.position.length!==1)throw Error("Usage: brain diagram export <file|-> --theme light|dark|print --format svg|png|pdf [--out path]");const theme=parsed.flags["--theme"]??"print",format=parsed.flags["--format"]??"svg";if(!themes.has(theme)||!formats.has(format))throw Error("Unknown diagram theme or artifact format");result.theme=theme as DiagramTheme;result.format=format as DiagramExportResult["format"];
  const input=await readDiagramInput(root,parsed.position[0]!);result.input=input.path;const checked=checkDiagram(input.source);result.warnings=checked.warnings.map(w=>finding(w.code,w.path,w.message));if(!checked.valid){result.errors=checked.errors.map(e=>finding(e.code,e.path,e.message));return result;}
  const svg=embedDiagramFonts(toFlatSvg(input.source,result.theme)),defaultName=input.path==="-"?join(SCRATCH_DIR,scratchName(`diagram-${theme}`,format)):input.path.replace(/(?:\.diagram\.ya?ml|\.[^./\\]+)$/i,"")+`.${theme}.${format}`,output=parsed.flags["--out"]??defaultName;
  if(extname(output).toLowerCase()!==`.${format}`)throw Error("Output extension must match the artifact format");const destination=target(root,output);if(destination===input.absolute)throw Error("The source cannot be replaced by its derived artifact");if(isInScratch(root,output))assertScratchWritable(root,destination);
  let data:string|Uint8Array=svg;if(format!=="svg"){const box=/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/.exec(svg)!;const width=Number(box[1]),height=Number(box[2]);data=await renderHtmlArtifact({html:`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}svg{display:block}@page{size:${width}px ${height}px;margin:0}</style></head><body>${svg}</body></html>`,format:format as "png"|"pdf",width:Math.max(320,width)});}
  result.output=write(root,output,data,input.path!=="-"||!!parsed.flags["--out"]);result.bytes=typeof data==="string"?Buffer.byteLength(data):data.byteLength;result.ok=true;
 }catch(error){result.errors.push(finding("export","$",error));}return result;
}
export async function buildDiagrams(argv:string[],root:string):Promise<DiagramBuildResult>{
 const result:DiagramBuildResult={schema_version:1,ok:false,input:argv[0]??"",figures:[],written:[],warnings:[],errors:[]};
 try{const parsed=args(argv);if(parsed.position.length!==1||Object.keys(parsed.flags).length||parsed.position[0]==="-")throw Error("Usage: brain diagram build <markdown file>");const input=await readDiagramInput(root,parsed.position[0]!);result.input=input.path;if(!/\.md$/i.test(input.path))throw Error("Build takes a Markdown file");const plan:{id:string;source:string;hash:string;light:string;dark:string;svgLight:string;svgDark:string}[]=[],ids=new Set<string>(),document=sourceHash(input.path);
  for(const fence of markdownFences(input.source).filter(f=>f.language==="diagram")){const checked=checkDiagram(fence.value);result.warnings.push(...checked.warnings.map(w=>finding(w.code,`${input.path}:${fence.line}:${w.path}`,w.message)));if(!checked.valid){result.errors.push(...checked.errors.map(e=>finding(e.code,`${input.path}:${fence.line}:${e.path}`,e.message)));continue;}const spec=parseDiagram(fence.value);if(!spec.id){result.warnings.push(finding("missing_id",`${input.path}:${fence.line}`,"Fence has no id; no derived pair was built"));continue;}if(ids.has(spec.id)){result.errors.push(finding("duplicate_id",`${input.path}:${fence.line}`,`Repeated diagram id '${spec.id}'`));continue;}ids.add(spec.id);const hash=sourceHash(fence.value),light=join(dirname(input.path),`${spec.id}.light.svg`),dark=join(dirname(input.path),`${spec.id}.dark.svg`);
   for(const path of [light,dark])ownedTarget(root,path,spec.id,document);
   plan.push({id:spec.id,source:fence.value,hash,light,dark,svgLight:markDerived(embedDiagramFonts(toFlatSvg(fence.value,"light")),{id:spec.id,source:hash,document}),svgDark:markDerived(embedDiagramFonts(toFlatSvg(fence.value,"dark")),{id:spec.id,source:hash,document})});
  }
  if(result.errors.length)return result;
  for(const item of plan){result.written.push(write(root,item.light,item.svgLight,ownedTarget(root,item.light,item.id,document)));result.written.push(write(root,item.dark,item.svgDark,ownedTarget(root,item.dark,item.id,document)));const escape=(value:string)=>value.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");const picture=`<picture><source media="(prefers-color-scheme: dark)" srcset="${escape(basename(item.dark))}"><img src="${escape(basename(item.light))}" alt="${escape(parseDiagram(item.source).desc)}"></picture>`;result.figures.push({id:item.id,light:item.light,dark:item.dark,picture,source_sha256:item.hash});}result.ok=true;
 }catch(error){result.errors.push(finding("build","$",error));}return result;
}
