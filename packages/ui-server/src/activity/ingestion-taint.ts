/** Which completed tool calls ingested untrusted content (G6); this grants no tool authority. */
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { z } from "zod";
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

/** A search from an ancestor directory taints when its output names a file in an untrusted area or a marked file. */
export function outputTaintSource(tool: string, output: string, brainPath?: string, marked?: MarkedLookup): IngestionSource | null {
  // Legacy scalar callers report a known source, not collection completeness.
  // Reuse exact path parsing; the collector retains the separate unknown signal.
  const signals = outputTaintSignals(tool, output, brainPath, marked, searchOutputContext(tool, {}));
  const known = signals.find(
    signal => signal.source !== "legacy_unknown");
  return known?.source ?? null;
}

/** Independent detector signals; `key` is local correlation, never persisted raw. */
export interface IngestionSignal {
  source: IngestionSource;
  detector: "tool_web_input" | "tool_file_input" | "tool_search_output" | "external_mcp_input"
    | "attachment_input" | "compute_input" | "unproxied_shell_input" | "explicit_untrusted_input";
  key: string;
}

/** Versioned installed-tool inventory. Completeness still needs delivery hooks and epoch acknowledgement. */
export const INGESTION_DETECTOR_MANIFEST = {
  version: 1,
  web: WEB_TOOLS, webInputKeys: { WebFetch:["url"],WebSearch:["query"],fetch_content:["url","urls"],web_search:["query","queries"],get_search_content:["url"],source_check:["claim","queries"] }, files: FILE_TOOLS, search: [...SEARCH_TOOLS], attachments: [...ATTACHMENT_READ_TOOLS],
  compute: [...COMPUTE_OUTPUT_TOOLS], referenceReads:["reference_read","mcp__brain-ui__reference_read"], hostRemotePages:["brain_apify_discover","brain_apify_inspect","brain_apify_results","brain_github_issue_read","brain_github_issue_search"], externalMcp: "mcp__<server>__<tool> except brain and brain-ui",
  shell: ["Bash", "bash"],
  exclusions: ["proxied_shell_local_read", "opaque_tunnel_inner_protocol", "uninstrumented_backend_input", "missing_historical_signals"],
} as const;

function fileSignals(path: string, brainPath: string | undefined, marked: MarkedLookup | undefined,
  detector: "tool_file_input" | "tool_search_output"): IngestionSignal[] {
  if(Buffer.byteLength(path)>1024)throw new Error("Safety path capacity exceeded");
  const normalized = posix.normalize(path), result: IngestionSignal[] = [];
  const area = pathSource(normalized, brainPath);
  if (area) result.push({ source: area, detector, key: normalized });
  const relative = brainRelative(normalized, brainPath);
  // A workspace/staged/attachment signal must never hide the explicit mark.
  if (relative !== null && marked?.(relative)) result.push({ source: "user_marked", detector: "explicit_untrusted_input", key: relative });
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
    if(values.length>256||values.some(value=>Buffer.byteLength(value)>2048))throw new Error("Safety web input capacity exceeded");
    return [...new Set(values.length?values:["unknown_input"])].map(key=>({source,detector:"tool_web_input" as const,key}));
  }
  const detector = source === "compute_output" ? "compute_input" : source === "chat_attachment" ? "attachment_input"
      : source === "mcp_document" ? "external_mcp_input" : "unproxied_shell_input";
  return [{ source, detector, key: "input" }];
}

/** Admitted format only. Invalid or incomplete output always retains unknown coverage. */
interface SearchOutputContext { backendId?: string; outputMode?: string; lineNumbers?: boolean; offset?: number; limit?: number }
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

export function outputTaintSignals(tool: string, output: string, brainPath?: string, marked?: MarkedLookup, context?: SearchOutputContext): IngestionSignal[] {
  if (!SEARCH_TOOLS.has(tool)) return [];
  if(Buffer.byteLength(output)>1048576)throw new Error('Safety search output capacity exceeded');
  const result:IngestionSignal[]=[],seen=new Set<string>(),contentPaths=new Set<string>();let unknown=false;
  const add=(path:string)=>{
    if(!path||path.includes('\0')){unknown=true;return;}
    if(/truncat|omitted|\.\.\.|…/i.test(path))unknown=true;
    for(const signal of fileSignals(path,brainPath,marked,'tool_search_output')){
      const key=JSON.stringify([signal.detector,signal.key]);if(seen.has(key))continue;
      if(result.length>=256)throw new Error('Safety search signal capacity exceeded');seen.add(key);result.push(signal);
    }
  };
  const content=(text:string,numbers:boolean)=>{
    if(/truncat|omitted|\.\.\.|…/i.test(text))unknown=true;
    for(const line of text.split('\n')){
      if(!line){unknown=true;continue;}
      let count=0;
      // No line numbers: every colon could separate the filename and content.
      // With numbers: lookahead preserves overlapping `:2:7:` candidates.
      for(const split of line.matchAll(numbers?/(?=:[1-9][0-9]*:)/g:/(?=:)/g)){
        if(count++>=256)throw new Error('Safety search candidate capacity exceeded');const path=line.slice(0,split.index);contentPaths.add(path);add(path);
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
  let parsed:unknown;try{parsed=JSON.parse(output);}catch{/* Pi returns raw text; Claude requires its structured schema. */}
  if(tool==='grep'&&(context===undefined||context.backendId==='pi')){
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
    if(!checked.success||!['files_with_matches','content','count'].includes(mode??'')){unknown=true;salvage(parsed,mode);}
    else {const value=checked.data;for(const path of value.filenames)add(path);
      const lines=mode==='files_with_matches'?value.filenames.length:value.content?value.content.split('\n').length:0;
      const total=mode==='content'?value.totalLines:value.totalFiles;
      const limits=[value.appliedLimit??0,context?.limit??250];
      // An optional total cannot be invented from a full page. Offset pages
      // omit earlier sources even if their returned page is otherwise valid.
      if(value.mode!==undefined&&value.mode!==mode||value.numFiles!==value.filenames.length||
        new Set(value.filenames).size!==value.filenames.length||
        value.totalFiles!==undefined&&value.totalFiles!==value.numFiles||
        (value.appliedOffset??0)>0||(context?.offset??0)>0||
        limits.some(limit=>limit>0&&(lines>limit||lines===limit&&total===undefined))||
        value.numLines!==undefined&&value.numLines!==lines||value.totalLines!==undefined&&value.totalLines!==lines)unknown=true;
      let matches=mode==='files_with_matches'?value.numFiles:lines;
      if(mode==='files_with_matches'){if(value.content!==undefined&&value.content!=='')unknown=true;}
      else if(value.content===undefined)unknown=true;
      else {
        if(!value.content&&value.numFiles>0)unknown=true;
        if(mode==='content'){if(value.content)content(value.content,context?.lineNumbers!==false);}
        else {
          matches=0;
          for(const line of value.content?value.content.split('\n'):[]){
            const split=/:([1-9][0-9]*)$/.exec(line);
            if(split){const path=line.slice(0,split.index);if(contentPaths.has(path))unknown=true;contentPaths.add(path);add(path);matches+=Number(split[1]);if(!Number.isSafeInteger(matches))unknown=true;}
            else unknown=true;
          }
        }
      }
      if(mode!=='files_with_matches'&&(value.numFiles!==contentPaths.size||value.filenames.some(path=>!contentPaths.has(path))))unknown=true;
      // Only counts accounted for by the identified output can establish
      // completeness; unsupported count semantics remain restrictive.
      if(value.numMatches!==undefined&&value.numMatches!==matches)unknown=true;
    }
  }else unknown=true;
  if(unknown){if(result.length>=256)throw new Error('Safety search signal capacity exceeded');result.push({source:'legacy_unknown',detector:'tool_search_output',key:'unknown_remainder'});}
  return result;
}

/** Retain only validated format selectors, never raw input. */
export function searchOutputContext(tool:string,input:unknown,backendId=tool==='grep'?'pi':'claude'):SearchOutputContext {
  if(tool!=='Grep')return {backendId};
  const value=input&&typeof input==='object'?input as Record<string,unknown>:{};
  const mode=value.output_mode===undefined?'files_with_matches':value.output_mode,numbers=value['-n']===undefined?true:value['-n'],offset=value.offset===undefined?0:value.offset,limit=value.head_limit===undefined?250:value.head_limit;
  return {backendId,outputMode:typeof mode==='string'&&['content','files_with_matches','count'].includes(mode)&&typeof numbers==='boolean'&&Number.isSafeInteger(offset)&&Number(offset)>=0&&Number.isSafeInteger(limit)&&Number(limit)>=0?mode:'unknown',lineNumbers:numbers===true,offset:typeof offset==='number'?offset:0,limit:typeof limit==='number'?limit:250};
}
