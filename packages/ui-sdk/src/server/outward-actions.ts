/** Visible command effects only (#1664); opaque scripts are deliberately unknown. */
import { bashCommand } from "./confirm-patterns.js";

export type OutwardActionKind = "git_push" | "gh_write" | "mcp_tool" | "http_write";
export interface VisibleOutwardAction {
  action: OutwardActionKind;
  /** The visible shell segment, without another command's approval scope. */
  command: string;
  target: string | null;
  historyRewrite: boolean;
  /** A named git remote to resolve through credential-free maintenance Git. */
  remote?: string;
  /** Explicit git options precede remote lookup too; dynamic ones never grant. */
  gitOptions?: readonly string[];
}
export interface OutwardClassification {
  kind: "outward" | "read" | "unknown";
  actions: VisibleOutwardAction[];
  /** Unknown/config-sourced segments remain outside visible approval coverage. */
  opaque?: true;
}
/** Neither shipped backend supplies built-in mail/calendar/booking/payment MCP descriptors. */
export const BUILTIN_OUTWARD_MCP_DESCRIPTORS: readonly { tool: string; target: string; effect: string }[] = Object.freeze([]);

interface Word { value: string; dynamic: boolean }
interface Segment { words: Word[]; source: string }
function segments(command: string): Segment[] {
  const result: Segment[] = [];
  let words: Word[] = [], value = "", active = false, dynamic = false;
  let quote: "'" | '"' | null = null, start = 0;
  const word = () => { if (active) words.push({ value, dynamic }); value = ""; active = false; dynamic = false; };
  const segment = (end: number) => { word(); if (words.length) result.push({ words, source: command.slice(start, end).trim() }); words = []; start = end + 1; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\" && quote !== "'") {
      active = true; if (i + 1 < command.length) { const escaped = command[++i]!; if (escaped !== "\n") value += escaped; } else dynamic = true;
    } else if (quote) {
      if (ch === quote) quote = null;
      else { if (quote === '"' && (ch === "$" || ch === "`")) dynamic = true; value += ch; }
    } else if (ch === "'" || ch === '"') { quote = ch; active = true; }
    else if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") segment(i);
    else if (/\s/.test(ch)) word();
    else { active = true; if (ch === "$" || ch === "`") dynamic = true; value += ch; }
  }
  if (quote) dynamic = true;
  segment(command.length);
  return result;
}
const binary = (value: string) => value.slice(value.lastIndexOf("/") + 1);
/** Normalized destination for explicit URLs, stripping credential-bearing userinfo. */
export function outwardTarget(value: string): string | null {
  try {
    if (/^[\w.-]+@[\w.-]+:/.test(value)) value = `ssh://${value.replace(":", "/")}`;
    const url = new URL(value);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
  } catch { return null; }
}
const githubWrites: Readonly<Record<string, ReadonlySet<string>>> = {
  issue: new Set(["create", "comment", "edit", "close"]),
  pr: new Set(["create", "merge", "comment", "review"]), release: new Set(["create"]),
};
const githubReads: Readonly<Record<string, ReadonlySet<string>>> = {
  issue: new Set(["view", "list", "status"]), pr: new Set(["view", "list", "status", "diff", "checks"]),
  release: new Set(["view", "list", "download"]),
};
function classify(segment: Segment): OutwardClassification {
  let words = segment.words;
  while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].value)) words = words.slice(1);
  if (words[0]?.value === "command" || words[0]?.value === "exec") words = words.slice(1);
  if (words[0]?.value === "rtk" && words[1]?.value === "proxy") words = words.slice(2);
  const name = binary(words[0]?.value ?? ""), args = words.slice(1);
  const values = args.map(word => word.value), uncertain = words.some(word => word.dynamic);
  const result = (action: OutwardActionKind, target: string | null, historyRewrite = false,
    extra: Partial<VisibleOutwardAction> = {}): OutwardClassification => ({ kind: "outward", actions: [{ action,
      command: segment.source, target: uncertain ? null : target, historyRewrite, ...extra }] });
  if (name === "git") {
    let verb = 0;
    const gitOptions: string[] = [];
    for (; verb < values.length && values[verb]!.startsWith("-"); verb++) {
      const option = values[verb]!; gitOptions.push(option);
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(option)) {
        if (!values[verb + 1]) return { kind: "unknown", actions: [] };
        gitOptions.push(values[++verb]!);
      }
    }
    if (values[verb] !== "push") return { kind: "unknown", actions: [] };
    const push = values.slice(verb + 1);
    const rewrite = push.some(value => /^--(?:force(?:-with-lease|-if-includes)?|mirror|delete|prune)(?:=|$)/.test(value)
      || /^-[^-]*[fd]/.test(value) || value.startsWith("+") || value.startsWith(":"));
    let remote: string | undefined;
    for (let i = 0; i < push.length; i++) {
      const value = push[i]!;
      if (["--repo", "--receive-pack", "--exec", "--push-option", "-o"].includes(value)) {
        const next = push[++i]; if (value === "--repo") remote = next;
      } else if (value.startsWith("--repo=")) remote = value.slice(7);
      else if (!value.startsWith("-") && remote === undefined) remote = value;
    }
    return result("git_push", remote ? outwardTarget(remote) : null, rewrite,
      { ...(!uncertain && remote ? { remote } : {}), ...(!uncertain ? { gitOptions } : {}) });
  }
  if (name === "gh") {
    let method: string | undefined, data = false;
    for (let i = 0; i < values.length; i++) {
      const value = values[i]!;
      if (value === "-X" || value === "--method") method = values[++i];
      else if (value.startsWith("--method=")) method = value.slice(9);
      else if (/^-X.+/.test(value)) method = value.slice(2);
      if (["-f", "-F", "--raw-field", "--field", "--input"].some(flag => value === flag || value.startsWith(flag + "=") || (flag.length === 2 && value.startsWith(flag) && value.length > 2))) data = true;
    }
    if (githubWrites[values[0] ?? ""]?.has(values[1] ?? "") || (values[0] === "api" && ((method && method.toUpperCase() !== "GET") || data))) return result("gh_write", null);
    if (!uncertain && (githubReads[values[0] ?? ""]?.has(values[1] ?? "") || (values[0] === "api" && !data && (!method || method.toUpperCase() === "GET")))) return { kind: "read", actions: [] };
  }
  if (name === "curl" || name === "wget") {
    let method: string | undefined, data = false, opaque = uncertain;
    const targets: string[] = [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i]!;
      if (name === "curl" && /^-[^-]/.test(value)) {
        for (let flag = 1; flag < value.length; flag++) {
          const ch = value[flag]!;
          if ("dFT".includes(ch)) data = true;
          if (ch === "K") opaque = true;
          if ("XHoduAe bcEKmxy".replaceAll(" ", "").includes(ch) || "FT".includes(ch)) {
            const argument = value.slice(flag + 1) || values[++i];
            if (ch === "X") method = argument;
            break;
          }
        }
      }
      if (value === "--request" || value === "--method") method = values[++i];
      else if (value.startsWith("--request=") || value.startsWith("--method=")) method = value.slice(value.indexOf("=") + 1);
      else if (name === "curl" && /^-X.+/.test(value)) method = value.slice(2);
      if (["-d", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "-F", "--form", "--form-string", "-T", "--upload-file", "--post-data", "--post-file", "--body-data", "--body-file"].some(flag => value === flag || value.startsWith(flag + "=") || (flag.length === 2 && value.startsWith(flag) && value.length > 2))) data = true;
      if (["--config", "-K", "--execute", "-e", "--use-askpass"].some(flag => value === flag || value.startsWith(flag + "="))) opaque = true;
      if (/^https?:\/\//i.test(value)) targets.push(value);
    }
    if ((method && method.toUpperCase() !== "GET") || data) return { ...result("http_write", !opaque && targets.length === 1 ? outwardTarget(targets[0]!) : null), ...(opaque ? { opaque: true as const } : {}) };
    if (!opaque && targets.length) return { kind: "read", actions: [] };
  }
  return { kind: "unknown", actions: [] };
}

/** A read grant requires every visible segment to be known read; unknown code stays unknown. */
export function classifyOutwardCall(toolName: string, shellToolName: string, input: unknown): OutwardClassification {
  if (toolName !== shellToolName) {
    const descriptor = BUILTIN_OUTWARD_MCP_DESCRIPTORS.find(item => item.tool === toolName);
    return descriptor ? { kind: "outward", actions: [{ action: "mcp_tool", command: toolName, target: descriptor.target, historyRewrite: false }] } : { kind: "unknown", actions: [] };
  }
  const command = bashCommand(input);
  if (!command) return { kind: "unknown", actions: [] };
  const items = segments(command).map(classify), actions = items.flatMap(item => item.actions);
  return { kind: actions.length ? "outward" : items.length && items.every(item => item.kind === "read") ? "read" : "unknown", actions,
    ...(items.some(item => item.kind === "unknown" || item.opaque) ? { opaque: true as const } : {}) };
}
