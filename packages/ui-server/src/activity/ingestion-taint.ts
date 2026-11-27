/** Which completed tool calls ingested untrusted content (G6); this grants no tool authority. */
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { z } from "zod";
import type {InputSafetyOutputStatus} from "@schlessera/brain-ui-sdk/server";
import { posix } from "node:path";
import { WORKER_AREA_ROOT, WORKER_REFERENCE_ROOT, WORKER_WORKTREE_ROOT } from "@schlessera/brain-ui-sdk/internal";
import { commandTaintSource } from "./command-taint.js";

type IngestionSource = "web_fetch" | "web_search" | "staged_share" | "chat_attachment" | "workspace_read" | "mcp_document"
  | "user_marked" | "fetching_command" | "unclassified_command" | "compute_output" | "legacy_unknown";

/** Whether a brain-relative path carries the user's untrusted mark (#2673). */
export type MarkedLookup = (path: string) => boolean;

/** Claude's web tools and Pi's host-owned ones (#3685): stored-content reads and source checks return external pages too. */
const WEB_TOOLS: Record<string, IngestionSource> = { WebFetch: "web_fetch", WebSearch: "web_search", fetch_content: "web_fetch", web_search: "web_search",
  get_search_content: "web_fetch", source_check: "web_search" };
/** brain-kit's own MCP servers serve brain content; every other server's result is an external document. */
const BRAIN_MCP_SERVERS = new Set(["brain", "brain-ui"]);
/** File tools and the input key naming the path they read. Edit results quote the file. */
const FILE_TOOLS: Record<string, string> = { Read: "file_path", Edit: "file_path", NotebookEdit: "notebook_path", Grep: "path", Glob: "path",
  read_file: "path", edit_file: "path", grep: "path", brain_read: "path", brain_read_base: "path" };
/** The host's compute collect tool on either backend; the worker brain server's copy is disallowed. */
const COMPUTE_OUTPUT_TOOLS = new Set(["brain_compute_collect", "mcp__brain-ui__brain_compute_collect"]);
/** The host's attachment reader on either backend (#3154): every call names a user-attached original, successful or not. */
const ATTACHMENT_READ_TOOLS = new Set(["read_attachment", "mcp__brain-ui__read_attachment"]);
/** Tools whose output lists the paths they matched, so a search from an ancestor directory is visible. */
const SEARCH_TOOLS = new Set(["Grep", "Glob", "grep"]);

/** The untrusted area a brain-relative path leads with. */
function leadingArea(relative: string): IngestionSource | null {
  const [first, second] = relative.split("/");
  return first === "workspaces" ? "workspace_read" : first === ".brain-ui" && second === "inbox" ? "staged_share"
    : first === ".brain-ui" && second === "attachments" ? "chat_attachment" : null;
}
/** An area segment anywhere: for a view whose root the host cannot name. */
function anyArea(path: string): IngestionSource | null {
  const segments = path.split("/");
  if (segments.includes("workspaces")) return "workspace_read";
  if (segments.some((segment, index) => segment === ".brain-ui" && segments[index + 1] === "inbox")) return "staged_share";
  return segments.some((segment, index) => segment === ".brain-ui" && segments[index + 1] === "attachments") ? "chat_attachment" : null;
}
/**
 * The untrusted area a path names. Relative paths resolve against the brain
 * (the worker's cwd) and absolute ones are normalized first, so `.` and `..`
 * cannot hide an area. Below the brain or the strict area root the area must
 * lead; any other absolute path is a view the host cannot name, so an area
 * segment anywhere in it counts.
 */
function pathSource(path: string, brainPath: string | undefined): IngestionSource | null {
  if (!path) return null;
  if (!path.startsWith("/") && !brainPath) {
    const relative = posix.normalize(path);
    return relative.startsWith("../") ? anyArea(relative) : leadingArea(relative);
  }
  const absolute = path.startsWith("/") ? posix.normalize(path) : posix.resolve(brainPath!, path);
  // A sealed acquisition or writable snapshot alone proves no actual read
  // provenance. Ordinary file tools retain the workspace restriction.
  if ([WORKER_REFERENCE_ROOT, WORKER_WORKTREE_ROOT].some(root => isWithin(root, absolute, { includeRoot: true }))) return "workspace_read";
  for (const root of [brainPath && posix.normalize(brainPath).replace(/\/$/, ""), WORKER_AREA_ROOT]) {
    if (root && isWithin(root, absolute, { includeRoot: false })) return leadingArea(absolute.slice(root.length + 1));
  }
  return anyArea(absolute);
}

/**
 * The brain-relative record key a file-tool path names, or null when it names
 * nothing inside the brain. A relative path resolves against the brain (the
 * worker's cwd); an absolute one only counts below the brain's host path, so
 * a view the host cannot name is not matched against marks.
 */
function brainRelative(path: string, brainPath: string | undefined): string | null {
  if (!path) return null;
  let relative: string;
  if (!path.startsWith("/")) relative = posix.normalize(path);
  else {
    const root = brainPath && posix.normalize(brainPath).replace(/\/$/, "");
    const absolute = posix.normalize(path);
    if (!root || !isWithin(root, absolute, { includeRoot: false })) return null;
    relative = absolute.slice(root.length + 1);
  }
  relative = relative.replace(/\/$/, "");
  return relative && relative !== "." && relative !== ".." && !relative.startsWith("../") ? relative : null;
}

/** The area a path reads, else whether it names a file the user marked untrusted. */
function fileSource(path: string, brainPath: string | undefined, marked: MarkedLookup | undefined): IngestionSource | null {
  const area = pathSource(path, brainPath);
  if (area || !marked) return area;
  const relative = brainRelative(path, brainPath);
  return relative !== null && marked(relative) ? "user_marked" : null;
}

/**
 * The source a call's input already establishes, before its result arrives.
 * On a turn behind the egress proxy (`shellProxied`), the proxy's admitted
 * connections are the shell signal, so the command classifier is skipped
 * (#3429). A shell read of an untrusted file is then not detected: path
 * detection is not extended to shell arguments.
 */
export function inputTaintSource(tool: string, input: unknown, brainPath?: string, marked?: MarkedLookup,
  shellProxied = false): IngestionSource | null {
  const command = shellProxied ? null : commandTaintSource(tool, input);
  if (command) return command;
  if (WEB_TOOLS[tool]) return WEB_TOOLS[tool];
  // A collected external compute job returns a remote machine's output (#3108).
  if (COMPUTE_OUTPUT_TOOLS.has(tool)) return "compute_output";
  if (ATTACHMENT_READ_TOOLS.has(tool)) return "chat_attachment";
  if (tool === "reference_read" || tool === "mcp__brain-ui__reference_read") return "workspace_read";
  const server = /^mcp__(.+?)__/.exec(tool)?.[1];
  if (server !== undefined && !BRAIN_MCP_SERVERS.has(server)) return "mcp_document";
  // brain-kit's own document readers can still name a file in an untrusted area.
  const key = FILE_TOOLS[tool.replace(/^mcp__brain(?:-ui)?__/, "")];
  const path = key && input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  return typeof path === "string" ? fileSource(path, brainPath, marked) : null;
}

/** Independent detector signals; `key` is local correlation, never persisted raw. */
export interface IngestionSignal {
  source: IngestionSource;
  detector: "tool_web_input" | "tool_file_input" | "tool_search_output" | "external_mcp_input"
    | "attachment_input" | "compute_input" | "unproxied_shell_input" | "explicit_untrusted_input";
  key: string;
}

/** User-controlled keys cannot alias synthetic coverage evidence. */
export function ingestionSignalIdentity(signal:IngestionSignal):string {
  const kind=signal.source==='legacy_unknown'?'synthetic':signal.detector==='explicit_untrusted_input'||signal.detector==='tool_web_input'?'user':'structural';
  return JSON.stringify([kind,signal.source,signal.detector,signal.key]);
}

function fileSignals(path: string, brainPath: string | undefined, marked: MarkedLookup | undefined,
  detector: "tool_file_input" | "tool_search_output"): IngestionSignal[] {
  if(Buffer.byteLength(path)>1024)return [{source:"legacy_unknown",detector,key:"unknown_path"}];
  const normalized = posix.normalize(path), result: IngestionSignal[] = [];
  const area = pathSource(normalized, brainPath);
  if (area) result.push({ source: area, detector, key: normalized });
  const relative = brainRelative(normalized, brainPath);
  // A workspace/staged/attachment signal must never hide the explicit mark.
  try{if (relative !== null && marked?.(relative)) result.push({ source: "user_marked", detector: "explicit_untrusted_input", key: relative });}
  catch{result.push({source:"legacy_unknown",detector,key:"unknown_mark"});}
  return result;
}

export function inputTaintSignals(tool: string, input: unknown, brainPath?: string, marked?: MarkedLookup,
  shellProxied = false): IngestionSignal[] {
  const source = inputTaintSource(tool, input, brainPath, undefined, shellProxied);
  if (tool === "reference_read" || tool === "mcp__brain-ui__reference_read") return [{ source: "workspace_read", detector: "tool_file_input", key: "managed_reference" }];
  const key = FILE_TOOLS[tool.replace(/^mcp__brain(?:-ui)?__/, "")];
  const path = key && input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  if (typeof path === "string") return fileSignals(path, brainPath, marked, "tool_file_input");
  if (!source) return [];
  if(source==="web_fetch"||source==="web_search"){
    const object=input&&typeof input==="object"?input as Record<string,unknown>:{};
    const keys=source==="web_fetch"?["url","urls"]:["query","queries","claim"];
    const values=keys.flatMap(key=>typeof object[key]==="string"?[object[key] as string]:Array.isArray(object[key])?(object[key] as unknown[]).filter((v):v is string=>typeof v==="string"):[]);
    const incomplete=values.length>256||values.some(value=>Buffer.byteLength(value)>2048);
    const kept=values.slice(0,incomplete?255:256).filter(value=>Buffer.byteLength(value)<=2048);
    const result:IngestionSignal[]=[...new Set(kept.length?kept:["unknown_input"])].map(key=>({source,detector:"tool_web_input" as const,key}));
    if(incomplete)result.push({source:"legacy_unknown",detector:"tool_web_input",key:"unknown_remainder"});
    return result;
  }
  const detector = source === "compute_output" ? "compute_input" : source === "chat_attachment" ? "attachment_input"
      : source === "mcp_document" ? "external_mcp_input" : "unproxied_shell_input";
  return [{ source, detector, key: "input" }];
}

/** Admitted format only. Invalid or incomplete output always retains unknown coverage. */
interface SearchOutputContext { unverifiedNote?:boolean; displayOnly?:boolean; backendId?: string; outputMode?: string; lineNumbers?: boolean; contextRows?:boolean; offset?: number; limit?: number; outputComplete?: boolean }
// Installed SDK: GlobInput/GrepInput and GlobOutput/GrepOutput in
// @anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:905-983,3506-3545. Pi's shipped grep and text
// envelope are `grepTool` (packages/ui-backend-pi/src/file-tools.ts:44-82)
// and `textResult` (packages/ui-backend-pi/src/tool-kit.ts:25-27).
const natural = z.number().int().nonnegative().safe();
const globOutput = z.object({ durationMs: z.number().finite().nonnegative(), numFiles: natural,
  filenames: z.array(z.string()), truncated: z.boolean(), totalMatches: natural.optional(), countIsComplete: z.boolean().optional() }).strict();
const grepOutput = z.object({ mode: z.enum(['content','files_with_matches','count']).optional(), numFiles: natural,
  filenames: z.array(z.string()), content: z.string().optional(), numLines: natural.optional(), numMatches: natural.optional(),
  totalFiles: natural.optional(), totalLines: natural.optional(), appliedLimit: natural.optional(), appliedOffset: natural.optional() }).strict();

/** Process evidence is mandatory for Pi search; omission never proves success. */
export function searchOutputComplete(output:string,status:InputSafetyOutputStatus|undefined,requireProcess=false):boolean|undefined {
  if(status===undefined)return requireProcess?false:undefined;
  if(requireProcess&&(status.exitCode===undefined||status.stderr===undefined||status.truncated===undefined))return false;
  return status.complete&&status.stderr!==true&&status.truncated!==true&&
    (status.exitCode===undefined||status.exitCode===0&&output.length>0&&output!=="No matches."||status.exitCode===1&&output==="No matches.");
}

/** Parse complete top-level fields within the byte budget. An oversized content
 * string must not erase a preceding, independently complete filenames array. */
function completeSearchFields(prefix:string):unknown {
  const fields:Record<string,unknown>=Object.create(null);
  const first=prefix.search(/\S/);if(prefix[first]!=='{')return fields;
  let start=first+1,depth=1,quoted=false,escaped=false;
  const keep=(end:number)=>{try{Object.assign(fields,JSON.parse('{'+prefix.slice(start,end)+'}'));}catch{/* Only independently complete fields survive. */}};
  for(let i=start;i<prefix.length;i++){
    const c=prefix[i];
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;continue;}
    if(c==='{'||c==='[')depth++;
    else if(c==='}'||c===']'){if(depth===1){keep(i);break;}depth--;}
    else if(c===','&&depth===1){keep(i);start=i+1;}

  }
  // The last top-level field may be an unfinished filenames array. Its
  // independently closed string elements remain identifiable before the cut.
  const tail=prefix.slice(start),key=/^\s*("(?:[^"\\]|\\.)*")\s*:\s*\[/.exec(tail);
  let filenameKey=false;try{filenameKey=!!key&&JSON.parse(key[1]!)==='filenames';}catch{/* Invalid keys cannot identify an array. */}
  if(key&&filenameKey){
    const paths:string[]=[];let level=1,inString=false,escape=false,token=-1;
    for(let i=key[0].length;i<tail.length&&level>0;i++){
      const c=tail[i];
      if(inString){
        if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"'){
          inString=false;if(token>=0){try{paths.push(JSON.parse(tail.slice(token,i+1)));}catch{/* Malformed strings cannot identify a path. */}token=-1;}
        }
      }else if(c==='"'){inString=true;token=level===1?i:-1;}
      else if(c==='['||c==='{')level++;
      else if(c===']'||c==='}')level--;
    }
    fields.filenames=[...(Array.isArray(fields.filenames)?fields.filenames:[]),...paths];
  }
  return fields;
}

export function outputTaintSignals(tool: string, output: string, brainPath?: string, marked?: MarkedLookup, context?: SearchOutputContext): IngestionSignal[] {
  if (!SEARCH_TOOLS.has(tool)) return [];
  const result:IngestionSignal[]=[],seen=new Set<string>(),contentPaths=new Set<string>();let unknown=false;
  try{
  const oversized=Buffer.byteLength(output)>1048576;
  if(oversized)output=Buffer.from(output.slice(0,1048576)).subarray(0,1048576).toString('utf8');
  unknown=oversized||context?.outputComplete===false||context?.unverifiedNote===true;
  const add=(path:string)=>{
    if(!path||path.includes('\0')){unknown=true;return;}
    for(const signal of fileSignals(path,brainPath,marked,'tool_search_output')){
      if(signal.source==='legacy_unknown'){unknown=true;continue;}
      const key=ingestionSignalIdentity(signal);if(seen.has(key))continue;
      if(result.length>=256){unknown=true;continue;}seen.add(key);result.push(signal);
    }
  };
  const content=(text:string,numbers:boolean)=>{
    for(const line of text.split('\n')){
      if(line==='--'&&context?.contextRows)continue;
      if(!line){unknown=true;continue;}
      let count=0;
      // No line numbers: every colon could separate the filename and content.
      // With numbers: lookahead preserves overlapping `:2:7:` candidates.
      for(const split of line.matchAll(numbers?(context?.contextRows?/(?=([:-])[1-9][0-9]*\1)/g:/(?=(:)[1-9][0-9]*\1)/g):context?.contextRows?/(?=[:\-])/g:/(?=:)/g)){
        if(count++>=256){unknown=true;break;}const path=line.slice(0,split.index);contentPaths.add(path);add(path);
      }
      if(count!==1)unknown=true;
    }
  };
  // Validation decides completeness, never whether an independently typed
  // filename survives a malformed sibling or unrelated metadata field.
  const salvage=(value:unknown,mode?:string)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return;
    const fields=value as Record<string,unknown>;
    if(Array.isArray(fields.filenames))for(const path of fields.filenames)if(typeof path==='string')add(path);
    if(typeof fields.content!=='string'||!fields.content)return;
    if(mode==='content')content(fields.content,context?.lineNumbers!==false);
    if(mode==='count')for(const line of fields.content.split('\n')){const split=/:([1-9][0-9]*)$/.exec(line);if(split)add(line.slice(0,split.index));}
  };
  const display=context?.displayOnly&&(tool==='Glob'||tool==='Grep');
  let parsed:unknown;if(!display&&(tool==='Glob'||tool==='Grep'))try{parsed=oversized?completeSearchFields(output):JSON.parse(output);}catch{parsed=completeSearchFields(output);unknown=true;}
  if(display){
    // SDK display text has no filename framing. Never reinterpret a literal
    // filename as JSON; preserve known paths and retain boundary uncertainty.
    if(output.length){
      unknown=true;
      const lines=output.split('\n');
      // Literal filenames are candidates only in filename mode. Match text
      // is not a filename and must not consume the path budget.
      // Older display frames omit the selector even when they carry numbered
      // match rows. Observe those path candidates without assuming the native
      // default filename mode; exact literal marks remain independent.
      const legacy=tool==='Grep'&&context.outputMode==='legacy';
      const filenames=tool==='Glob'||context.outputMode==='files_with_matches'||legacy;
      if(filenames)for(const line of lines)if(line){
        if(legacy&&/:[1-9][0-9]*:/.test(line)){
          content(line,true);
          const relative=Buffer.byteLength(line)<=1024?brainRelative(line,brainPath):null;
          try{if(relative!==null&&marked?.(relative))add(line);}catch{unknown=true;}
        }else add(line);
      }
      let candidates=0;
      joins:for(let span=2;filenames&&span<=lines.length;span++)for(let start=0;start+span<=lines.length;start++){
          if(++candidates>4096)break joins;
          const joined=lines.slice(start,start+span).join('\n');if(Buffer.byteLength(joined)>1024)continue;
          const relative=brainRelative(joined,brainPath);
          try{if(relative!==null&&marked?.(relative))add(joined);}catch{unknown=true;}
      }
      if(context.outputMode==='content')content(lines.join('\n'),context.lineNumbers!==false);
      if(context.outputMode==='count')for(const line of lines){const split=/:([1-9][0-9]*)$/.exec(line);if(split)add(line.slice(0,split.index));}
    }
  }else if(tool==='grep'&&(context===undefined||context.backendId==='pi')){
    // `safetyResultInput` (packages/ui-backend-pi/src/worker-protocol.ts:92-99)
    // joins the shipped tool's text. No JSON envelope is part of this format.
    if(output!=='No matches.'){
      if(!output.includes('\0')){
        // Retained text from older runtimes cannot prove filename boundaries:
        // even several valid-looking rows can be one newline-bearing path.
        unknown=true;for(const line of output.split('\n'))content(line,true);
      }else{
        let offset=0;
        while(offset<output.length){
          const nul=output.indexOf('\0',offset);if(nul<0){unknown=true;break;}
          const prefix=output.slice(offset,nul);
          if(!prefix.endsWith(':'))unknown=true;
          add(prefix.endsWith(':')?prefix.slice(0,-1):prefix);
          const end=output.indexOf('\n',nul+1);
          const row=output.slice(nul+1,end<0?output.length:end);
          if(!/^[1-9][0-9]*:[^\n\0]*$/.test(row)||end<0)unknown=true;
          if(end<0)break;
          offset=end+1;
        }
      }
    }
  }else if((context?.backendId??'claude')==='claude'&&tool==='Glob'){
    const checked=globOutput.safeParse(parsed);
    if(!checked.success){unknown=true;salvage(parsed);}
    else {const value=checked.data;for(const path of value.filenames)add(path);
      if(value.numFiles>100||value.numFiles!==value.filenames.length||new Set(value.filenames).size!==value.filenames.length||value.truncated||value.countIsComplete===false||
        value.totalMatches!==undefined&&value.totalMatches!==value.numFiles||value.countIsComplete===true&&value.totalMatches===undefined)unknown=true;}
  }else if((context?.backendId??'claude')==='claude'&&tool==='Grep'){
    const checked=grepOutput.safeParse(parsed),mode=context?.outputMode;
    if(!checked.success||!['files_with_matches','content','count'].includes(mode??'')){unknown=true;salvage(parsed,mode);if(parsed&&typeof parsed==='object'&&'mode' in parsed&&typeof parsed.mode==='string')salvage(parsed,parsed.mode);}
    else {const value=checked.data;for(const path of value.filenames)add(path);
      if(value.mode!==undefined&&value.mode!==mode)salvage(value,value.mode);
      // Installed CLI 2.1.293, embedded `lno` Grep construction:
      // @anthropic-ai/claude-agent-sdk-linux-x64/claude:1464467-1464477
      // (content return at byte 0xcb4ffdf, count return at 0xcb50202).
      // Content always reports numFiles=0/filenames=[]; count reports all
      // matching files and match totals but leaves filenames empty. `lno`
      // preserves both ':' match and '-' context separators from `pno`.
      // `cDe` reports appliedLimit only when it omitted additional rows.
      const lines=mode==='files_with_matches'?value.filenames.length:value.content?value.content.split('\n').length:0;
      const total=mode==='content'?value.totalLines:mode==='count'?value.numFiles:value.totalFiles;
      const limits=[value.appliedLimit??0,context?.limit??250];
      if(value.mode!==undefined&&value.mode!==mode||new Set(value.filenames).size!==value.filenames.length||
        value.appliedLimit!==undefined||(value.appliedOffset??0)>0||(context?.offset??0)>0||
        limits.some(limit=>limit>0&&(lines>limit||lines===limit&&total===undefined)))unknown=true;
      if(mode==='files_with_matches'){
        if(value.numFiles!==value.filenames.length||value.totalFiles!==undefined&&value.totalFiles!==value.numFiles||
          value.numLines!==undefined||value.totalLines!==undefined||value.numMatches!==undefined&&value.numMatches!==value.numFiles)unknown=true;
        if(value.content!==undefined&&value.content!==''){unknown=true;salvage(value,value.mode==='count'?'count':'content');}
      }else if(mode==='content'){
        if(value.content===undefined||value.numFiles!==0||value.filenames.length!==0||
          value.numLines!==lines||value.totalLines!==lines||
          value.numMatches!==undefined||value.totalFiles!==undefined)unknown=true;
        if(value.content){content(value.content,context?.lineNumbers!==false);if(contentPaths.size===0)unknown=true;}
      }else{
        let matches=0;
        if(value.content===undefined||value.filenames.length!==0||value.numLines!==undefined||value.totalLines!==undefined)unknown=true;
        for(const line of value.content?value.content.split('\n'):[]){
          const split=/:([1-9][0-9]*)$/.exec(line);
          if(split){const path=line.slice(0,split.index);if(contentPaths.has(path))unknown=true;contentPaths.add(path);add(path);matches+=Number(split[1]);if(!Number.isSafeInteger(matches))unknown=true;}
          else unknown=true;
        }
        if(value.numFiles!==contentPaths.size||value.numMatches!==matches||
          value.totalFiles!==undefined&&value.totalFiles!==value.numFiles)unknown=true;
      }
    }
  }else unknown=true;
  }catch{unknown=true;}
  if(unknown){if(result.length===256)result.pop();result.push({source:'legacy_unknown',detector:'tool_search_output',key:'unknown_remainder'});}
  return result;
}

/** Retain only validated format selectors, never raw input. */
export function searchOutputContext(tool:string,input:unknown,backendId=tool==='grep'?'pi':'claude'):SearchOutputContext {
  if(tool!=='Grep')return {backendId};
  const value=input&&typeof input==='object'?input as Record<string,unknown>:{};
  const contextValid=['-A','-B','-C','context'].every(key=>value[key]===undefined||typeof value[key]==='number'&&Number.isSafeInteger(value[key])&&(value[key] as number)>=0);
  const contextRows=['-A','-B','-C','context'].some(key=>typeof value[key]==='number'&&(value[key] as number)>0);
  const mode=value.output_mode===undefined?'files_with_matches':value.output_mode,numbers=value['-n']===undefined?true:value['-n'],offset=value.offset===undefined?0:value.offset,limit=value.head_limit===undefined?250:value.head_limit;
  return {backendId,outputMode:contextValid&&typeof mode==='string'&&['content','files_with_matches','count'].includes(mode)&&typeof numbers==='boolean'&&Number.isSafeInteger(offset)&&Number(offset)>=0&&Number.isSafeInteger(limit)&&Number(limit)>=0?mode:'unknown',lineNumbers:numbers===true,contextRows,offset:typeof offset==='number'?offset:0,limit:typeof limit==='number'?limit:250};
}
