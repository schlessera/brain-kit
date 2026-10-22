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
  read_file: "path", edit_file: "path", grep: "path" };
/** Tools whose output lists the paths they matched, so a search from an ancestor directory is visible. */
const SEARCH_TOOLS = new Set(["Grep", "Glob", "grep"]);

function areaSource(relative: string): IngestionSource | null {
  const path = posix.normalize(relative).replace(/^\.\//, "");
  if (path === ".brain-ui/inbox" || path.startsWith(".brain-ui/inbox/")) return "staged_share";
  if (path === "workspaces" || path.startsWith("workspaces/")) return "workspace_read";
  return null;
}
/** A worker sees the brain at its own path or, for strict areas, below the fixed area root. */
function brainRelative(path: string, brainPath: string | undefined): string | null {
  if (!path.startsWith("/")) return path;
  for (const root of [brainPath, WORKER_AREA_ROOT]) if (root && path.startsWith(root + "/")) return path.slice(root.length + 1);
  return null;
}

/** The source a call's input already establishes, before its result arrives. */
export function inputTaintSource(tool: string, input: unknown, brainPath?: string): IngestionSource | null {
  const command = commandTaintSource(tool, input);
  if (command) return command;
  if (WEB_TOOLS[tool]) return WEB_TOOLS[tool];
  const server = /^mcp__(.+?)__/.exec(tool)?.[1];
  if (server !== undefined && !BRAIN_MCP_SERVERS.has(server)) return "mcp_document";
  const key = FILE_TOOLS[tool];
  const path = key && input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  if (typeof path !== "string") return null;
  const relative = brainRelative(path, brainPath);
  return relative === null ? null : areaSource(relative);
}

/** A search from an ancestor directory taints when its output names a file in an untrusted area. */
export function outputTaintSource(tool: string, output: string, brainPath?: string): IngestionSource | null {
  if (!SEARCH_TOOLS.has(tool)) return null;
  for (const line of output.split("\n")) {
    const path = line.trim().split(":")[0]!;
    const relative = path ? brainRelative(path, brainPath) : null;
    const source = relative === null ? null : areaSource(relative);
    if (source) return source;
  }
  return null;
}
