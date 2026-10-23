/** Which completed tool calls ingested untrusted content (G6); this grants no tool authority. */
import { posix } from "node:path";
import { WORKER_AREA_ROOT } from "@schlessera/brain-ui-sdk/internal";
import { commandTaintSource } from "./command-taint.js";

export type IngestionSource = "web_fetch" | "web_search" | "staged_share" | "workspace_read" | "mcp_document"
  | "fetching_command" | "unclassified_command";

/** Claude's and pi-web-access's web tools. */
const WEB_TOOLS: Record<string, IngestionSource> = { WebFetch: "web_fetch", WebSearch: "web_search", fetch_content: "web_fetch", web_search: "web_search" };
/** brain-kit's own MCP servers serve brain content; every other server's result is an external document. */
const BRAIN_MCP_SERVERS = new Set(["brain", "brain-ui"]);
/** File tools and the input key naming the path they read. Edit results quote the file. */
const FILE_TOOLS: Record<string, string> = { Read: "file_path", Edit: "file_path", NotebookEdit: "notebook_path", Grep: "path", Glob: "path",
  read_file: "path", edit_file: "path", grep: "path", brain_read: "path", brain_read_base: "path" };
/** Tools whose output lists the paths they matched, so a search from an ancestor directory is visible. */
const SEARCH_TOOLS = new Set(["Grep", "Glob", "grep"]);

/** The untrusted area a brain-relative path leads with. */
function leadingArea(relative: string): IngestionSource | null {
  const [first, second] = relative.split("/");
  return first === "workspaces" ? "workspace_read" : first === ".brain-ui" && second === "inbox" ? "staged_share" : null;
}
/** An area segment anywhere: for a view whose root the host cannot name. */
function anyArea(path: string): IngestionSource | null {
  const segments = path.split("/");
  if (segments.includes("workspaces")) return "workspace_read";
  return segments.some((segment, index) => segment === ".brain-ui" && segments[index + 1] === "inbox") ? "staged_share" : null;
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
  for (const root of [brainPath && posix.normalize(brainPath).replace(/\/$/, ""), WORKER_AREA_ROOT]) {
    if (root && absolute.startsWith(root + "/")) return leadingArea(absolute.slice(root.length + 1));
  }
  return anyArea(absolute);
}

/** The source a call's input already establishes, before its result arrives. */
export function inputTaintSource(tool: string, input: unknown, brainPath?: string): IngestionSource | null {
  const command = commandTaintSource(tool, input);
  if (command) return command;
  if (WEB_TOOLS[tool]) return WEB_TOOLS[tool];
  const server = /^mcp__(.+?)__/.exec(tool)?.[1];
  if (server !== undefined && !BRAIN_MCP_SERVERS.has(server)) return "mcp_document";
  // brain-kit's own document readers can still name a file in an untrusted area.
  const key = FILE_TOOLS[tool.replace(/^mcp__brain(?:-ui)?__/, "")];
  const path = key && input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  return typeof path === "string" ? pathSource(path, brainPath) : null;
}

/** A search from an ancestor directory taints when its output names a file in an untrusted area. */
export function outputTaintSource(tool: string, output: string, brainPath?: string): IngestionSource | null {
  if (!SEARCH_TOOLS.has(tool)) return null;
  for (const line of output.split("\n")) {
    const source = pathSource(line.trim().split(":")[0]!, brainPath);
    if (source) return source;
  }
  return null;
}
