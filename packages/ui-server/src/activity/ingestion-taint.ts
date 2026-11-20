/** Which completed tool calls ingested untrusted content (G6); this grants no tool authority. */
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
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
  const signals = outputTaintSignals(tool, output, brainPath, marked);
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

/** Each distinct returned normalized path contributes independently of the input.
 * Unparseable/truncated search output is a separate unknown-provenance signal.
 * This is conservative text observation, not a claim of verified source bytes. */
export function outputTaintSignals(tool: string, output: string, brainPath?: string, marked?: MarkedLookup, context?: {backendId?: string; outputMode?: string}): IngestionSignal[] {
  if (!SEARCH_TOOLS.has(tool)) return [];
  if(Buffer.byteLength(output)>1048576)throw new Error("Safety search output capacity exceeded");
  // These are the installed backend tool formats, not guesses from a line.
  // Claude Grep's mode is retained from its admitted input; Glob text is paths.
  const format = tool === "Glob" ? "files_with_matches" : tool === "grep"
    ? context === undefined || context.backendId === "pi" ? "pi-grep" : "unknown" : context?.outputMode ?? "unknown";
  const result: IngestionSignal[] = [], seen = new Set<string>();
  const paths: string[] = [], texts: string[] = [];
  let unknown = !["files_with_matches", "content", "count", "pi-grep"].includes(format);
  try {
    const collect = (value: unknown, depth: number, path = false): void => {
      if(depth>8){unknown=true;return;}
      if(typeof value==="string"){(path?paths:texts).push(value);return;}
      if(Array.isArray(value)){for(const item of value)collect(item,depth+1,path);return;}
      if(value&&typeof value==="object"){
        let recognized=false;
        for(const [key,item] of Object.entries(value)){
          if(["truncated","has_more"].includes(key)&&item===true||key==="omitted"&&typeof item==="number"&&item>0)unknown=true;
          if(["filenames","files","paths","matches","content","text","output","file_path","filePath","path"].includes(key)){
            recognized=true;collect(item,depth+1,["filenames","files","paths","file_path","filePath","path"].includes(key));
          }
        }
        if(!recognized)unknown=true;
      }else unknown=true;
    };
    collect(JSON.parse(output),0);
  }catch{ texts.push(output); }
  // Pi emits this only as the entire text of an empty result. Neither line
  // trimming nor a sentinel mixed with other content establishes emptiness.
  if(format==="pi-grep"&&!unknown&&!paths.length&&texts.length===1&&texts[0]==="No matches.")return [];
  const entries=[...paths.map(text=>({text,path:true})),...texts.flatMap(text=>text.split("\n").map(line=>({text:line,path:false})))];
  for(const entry of entries){
    const text=entry.text;
    // Check every path line, including exact fields and Glob content blocks.
    if(/truncat|omitted|\.\.\.|…/i.test(text))unknown=true;
    if(!text){if(entry.path)unknown=true;continue;}
    let candidates:string[];
    if(entry.path||format==="files_with_matches")candidates=[text];
    else if(format==="count"){
      const count=/:([0-9]+)$/.exec(text);candidates=count?[text.slice(0,count.index)]:[text];if(!count)unknown=true;
    }else{
      // Zero-width matches retain overlapping delimiters in `file:2:7:text`.
      // Every possible filename is checked; ambiguity remains restrictive.
      candidates=[];
      for(const split of text.matchAll(/(?=:[1-9][0-9]*:)/g)){
        if(candidates.length>=256)throw new Error("Safety search candidate capacity exceeded");
        const path=text.slice(0,split.index);
        if(Buffer.byteLength(path)>1024)throw new Error("Safety path capacity exceeded");
        candidates.push(path);
      }
      if(!candidates.length){unknown=true;candidates.push(text);}
      else {if(candidates.length>1)unknown=true;if(format==="unknown")candidates.push(text);}
    }
    for(const path of candidates){
      if(!path||/[\r\n\0]/.test(path)){unknown=true;continue;}
      for(const signal of fileSignals(path,brainPath,marked,"tool_search_output")){
        const id=JSON.stringify([signal.detector,signal.key]);if(seen.has(id))continue;
        if(result.length>=256)throw new Error("Safety search signal capacity exceeded");
        seen.add(id);result.push(signal);
      }
    }
  }
  if(unknown){if(result.length>=256)throw new Error("Safety search signal capacity exceeded");result.push({source:"legacy_unknown",detector:"tool_search_output",key:"unknown_remainder"});}
  return result;
}

/** Installed backend formats, from the admitted tool input rather than result text. */
export function searchOutputContext(tool: string, input: unknown, backendId = tool === "grep" ? "pi" : "claude"): {backendId: string; outputMode?: string} {
  if(tool!=="Grep")return {backendId};
  const requested=input&&typeof input==="object"?(input as Record<string,unknown>).output_mode:undefined;
  const mode=requested??"files_with_matches";
  return {backendId,outputMode:typeof mode==="string"&&["content","files_with_matches","count"].includes(mode)?mode:"unknown"};
}
