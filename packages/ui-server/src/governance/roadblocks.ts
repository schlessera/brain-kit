import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import {
  queryGovernanceEvents,
  recordGovernanceEvent,
  type GovernanceActor,
  type GovernanceEvent,
  type GovernanceEventPayload,
  type GovernanceProfile,
} from "./events.js";

/**
 * Roadblock classification (#1671): every failed step in a turn, grouped into
 * episodes with the path that finally worked and what the detour cost
 * (docs/decisions/governed-writable-workers.md, "Roadblocks").
 *
 * The rules are deterministic and run on the host over what it already relays
 * for every backend (tool starts, inputs, results, denials, usage) plus the
 * turn's governance events. No model is involved. The records are quiet:
 * they are stored as `roadblock` governance events and never rendered.
 *
 * What the fields are for: the roadblock report (#1672) groups episodes by
 * `signature` across sessions and ranks them by count and waste, so the
 * signature keeps what a remedy would change (the tool family, the command or
 * target area, the cause) and drops what varies per turn (file names, numbers,
 * ids, absolute roots). `remedy` says which lever removes the roadblock:
 * `guidance` when the turn already had a way that worked, `capability` when
 * it had none, or only a workaround through turn temp.
 */

export type RoadblockCategory = GovernanceEventPayload<"roadblock">["category"];
export type RoadblockPayload = GovernanceEventPayload<"roadblock">;

/** One tool call as the host observed it. */
export interface TracedCall {
  toolCallId: string;
  tool: string;
  /** The recorded input object, when the backend sent one. */
  input?: unknown;
  startedAt: number;
  /** When its result or denial landed; null if it never finished. */
  endedAt: number | null;
  /** Result text (a capped head and tail are enough), or null without a result. */
  output: string | null;
  isError: boolean;
  /** A denial by the user or by a permission hook, with its reason. */
  denied: { reason: string | null } | null;
}

/** Cumulative usage of the turn's completed responses at a point in time. */
export interface UsageSample {
  at: number;
  /** Null when the report carried no token counters. */
  tokens: number | null;
  costUsd: number | null;
}

export interface TurnTrace {
  startedAt: number;
  endedAt: number;
  /** Calls in the order they started. */
  calls: TracedCall[];
  /**
   * Live cumulative usage reported during the turn. Empty when the backend
   * reports none for this kind of turn: token and cost waste are then unknown
   * (null), never zero.
   */
  usage: UsageSample[];
  /** The turn total from the result frame, when there was one. */
  finalUsage: { tokens: number | null; costUsd: number | null } | null;
  /** The result frame's `outcomeDetail` (`max_budget`, `max_turns`, ...). */
  outcomeDetail: string | null;
}

/** Caps that keep one episode inside the governance payload limits. */
const MAX_FAILURES = 200;
const MAX_EVENT_IDS = 200;
const MAX_SIGNATURE = 300;
const MAX_FAMILY = 200;
/** The payload schema's limit on a call id; protocol ids may be longer. */
const MAX_ID = 200;
/** Byte budget for one episode's failure list, well under the writer's 64 KiB payload limit. */
const FAILURE_BYTES = 48 * 1024;
/** The governance kinds that can contribute a failure; the rest are never read. */
const CONTRIBUTING_KINDS = ["policy_block", "policy_confirm", "outward_action", "read_only_refusal", "egress_denial",
  "budget_block", "scope_cap"] as const;
/** Token-set similarity at or above which two failed inputs are the same attempt again. */
const RETRY_SIMILARITY = 0.8;

const FAMILY_BY_TOOL: Record<string, string> = {
  bash: "shell", bashoutput: "shell", killshell: "shell",
  write: "file_write", edit: "file_write", multiedit: "file_write", notebookedit: "file_write",
  write_file: "file_write", edit_file: "file_write", apply_staged_changes: "file_write",
  read: "file_read", read_file: "file_read", notebookread: "file_read", brain_read: "file_read",
  brain_read_base: "file_read",
  grep: "search", glob: "search", ls: "search", brain_search: "search", brain_list: "search",
  webfetch: "web", websearch: "web", web_fetch: "web", web_search: "web",
  brain_add: "brain_write", brain_update: "brain_write", brain_archive: "brain_write",
  agent: "subagent", task: "subagent",
};

/** Programs whose first plain argument names what they did (`git push`, `brain index`). */
const SUBCOMMAND_PROGRAMS = new Set(["git", "gh", "brain", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "docker",
  "podman", "kubectl", "cargo", "go", "pip", "pip3", "uv", "apt", "apt-get", "brew", "systemctl", "deno",
  "poetry", "rtk", "codex", "claude"]);
/** Wrappers skipped to reach the program that actually ran. */
const COMMAND_PREFIXES = new Set(["sudo", "env", "time", "timeout", "nice", "nohup", "command", "exec", "builtin", "stdbuf"]);
/** Segments that set up a command rather than being it. */
const SETUP_COMMANDS = new Set(["cd", "export", "set", "source", ".", "pushd", "popd", "true", "unset", "umask"]);
/** Headers describe control flow; their condition/iteration words are not body intent. */
const SHELL_HEADERS = new Set(["for", "select", "while", "until", "if", "elif"]);
/** Reserved words that introduce or close a compound-command body. */
const SHELL_BODY_WORDS = new Set(["then", "else", "do", "done", "fi", "esac", "{", "}", "!"]);
/** Wrapper options that take a value (`sudo -u <user>`), so the value is not read as the program. */
/** Global options that take a value, before a multi-command program's subcommand. */
const PROGRAM_VALUE_OPTIONS: Record<string, Set<string>> = {
  git: new Set(["-C", "-c"]),
  npm: new Set(["--prefix"]),
  bun: new Set(["--cwd"]),
  docker: new Set(["-H", "--host", "--context", "--config"]),
};
/** Global flags that take no value, before a multi-command program's subcommand. */
const PROGRAM_FLAG_OPTIONS: Record<string, Set<string>> = {
  git: new Set(["--no-pager", "-P", "-p", "--paginate", "--bare", "--no-optional-locks", "--literal-pathspecs",
    "--no-replace-objects", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"]),
  npm: new Set(["-s", "--silent", "-q", "--quiet", "-g", "--global", "-ws", "--workspaces"]),
  bun: new Set(["--silent", "--bun", "-b"]),
  docker: new Set(["-D", "--debug", "--tls", "--tlsverify"]),
  brain: new Set(["--json", "-q", "--quiet", "-v", "--verbose"]),
};
/** Programs whose option names an output file, and that option. */
const OUTPUT_OPTIONS: Record<string, Set<string>> = {
  curl: new Set(["-o", "--output"]),
  wget: new Set(["-O", "--output-document"]),
  sort: new Set(["-o", "--output"]),
  pandoc: new Set(["-o", "--output"]),
};
const WRAPPER_VALUE_OPTIONS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-U", "-T", "-r", "-t", "--user", "--group", "--host", "--prompt",
    "--chdir", "--close-from", "--other-user", "--role", "--type", "--command-timeout"]),
  env: new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
};
/**
 * Directory names a signature may keep: the brain's own structural areas and
 * the worker's write areas. Any other directory is `<dir>`, so a signature
 * never carries a name the user chose (a person, a client, a project).
 */
const KNOWN_AREAS = new Set([".brain", "scratch", "turns", "workspaces", "context", "policies", ".git", "hooks", "info",
  ".claude", "skills", "agents", ".agents", ".brain-ui", "node_modules", "tmp", "home", "inbox", "archive", "templates"]);
/** Where a standard program lives; a program run from anywhere else is a script, named `<script>`. */
const SYSTEM_BIN = /^\/(?:usr\/(?:local\/)?)?s?bin\//;
/** Exit 1 means "no match" or "differs" for these, as Claude Code treats them. */
const EXIT_ONE_IS_ANSWER = new Set(["grep", "rg", "egrep", "fgrep", "diff"]);

const FS_DENIED = /\bEROFS\b|read-only file system|\bEACCES\b|\bEPERM\b|permission denied(?! \(publickey)|operation not permitted/i;
const NETWORK_REFUSED = /\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bENETUNREACH\b|\bEHOSTUNREACH\b|\bECONNRESET\b|could not resolve host|connection refused|network is unreachable|temporary failure in name resolution|name or service not known|failed to connect to|proxy refused|egress denied/i;
/** `Exit code N` is Claude Code's Bash failure line; `[exit N]` is the pi bash tool's. */
const EXIT_LINE = /^(?:Exit code (\d+)|\[exit (\d+)\])\s*$/gm;
/** Families whose calls can open a connection, so an egress denial can be theirs. */
const CONNECTING_FAMILY = /^(?:shell(?::|$)|web$|mcp:|tool:)/;
/** Where a workaround puts what it could not put where it meant to. */
const TURN_TEMP = /(?:^|[\s"'=:(])(?:\/tmp\/|\/tmp\b|\$\{?BRAIN_WORKER_SCRATCH\}?|\$\{?TMPDIR\}?|\$\{?HOME\}?\/|~\/)/;

/** The tool's own name, without a `mcp__<server>__` prefix. */
function bareTool(tool: string): { name: string; server: string | null } {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  return mcp ? { name: mcp[2]!, server: mcp[1]! } : { name: tool, server: null };
}

function commandOf(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string") {
    return (input as { command: string }).command;
  }
  return null;
}

/** The program (and its subcommand, for multi-command tools) a shell line ran first. */
export function commandIntent(command: string): string {
  const segments = command.split(/(;;)|&&|\|\||[;|\n]/);
  let inCase = false;
  let caseArm = false;
  for (const segment of segments) {
    if (!segment) continue;
    if (segment === ";;") { caseArm = inCase; continue; }
    let tokens = segment.trim().split(/\s+/).filter(Boolean);
    // Only unquoted leading reserved words are structural. As with the
    // existing segment splitter, this is a heuristic, not a shell parser.
    while (SHELL_BODY_WORDS.has(tokens[0] ?? "")) {
      if (tokens[0] === "esac") { inCase = false; caseArm = false; }
      tokens.shift();
    }
    if (SHELL_HEADERS.has(tokens[0] ?? "")) continue;
    if (tokens[0] === "case") {
      const inWord = tokens.indexOf("in", 2);
      tokens = inWord < 0 ? [] : tokens.slice(inWord + 1);
      inCase = true;
      caseArm = true;
    }
    if (caseArm) {
      const patternEnd = tokens.findIndex((token) => token.endsWith(")"));
      if (patternEnd >= 0) { tokens = tokens.slice(patternEnd + 1); caseArm = false; }
    }
    let i = 0;
    let wrapper: string | null = null;
    let awaitingDuration = false;
    while (i < tokens.length) {
      const token = tokens[i]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { i += 1; continue; }
      if (COMMAND_PREFIXES.has(token)) {
        wrapper = token;
        awaitingDuration = token === "timeout";
        i += 1;
        continue;
      }
      // `timeout [options] 30 git push`: the duration is the wrapper's operand.
      if (awaitingDuration && /^[\d.]+[smhd]?$/.test(token)) { awaitingDuration = false; i += 1; continue; }
      if (wrapper && token.startsWith("-")) {
        // Each wrapper's own value-taking options; `--opt=value` is one token.
        i += !token.includes("=") && WRAPPER_VALUE_OPTIONS[wrapper]?.has(token) ? 2 : 1;
        if (token === "--") break;
        continue;
      }
      break;
    }
    const head = tokens[i];
    if (!head) continue;
    const raw = head.replace(/^["'(]+|["')]+$/g, "");
    const base = (raw.split("/").pop() || raw).toLowerCase();
    const program = raw.includes("/") && !SYSTEM_BIN.test(raw) ? "<script>"
      : /^[a-z0-9][a-z0-9._+-]{0,40}$/.test(base) ? base : "<program>";
    if (SETUP_COMMANDS.has(program)) continue;
    if (!SUBCOMMAND_PROGRAMS.has(program)) return program;
    // The subcommand follows the program and only its known global options
    // (`git -C <dir> push`). Past any other option the next word may be that
    // option's value, such as a repository or host name, so it is not read.
    let j = i + 1;
    while (tokens[j]?.startsWith("-")) {
      const option = tokens[j]!;
      if (option.includes("=") || PROGRAM_FLAG_OPTIONS[program]?.has(option)) { j += 1; continue; }
      if (!PROGRAM_VALUE_OPTIONS[program]?.has(option)) return program;
      j += 2;
    }
    const sub = tokens[j];
    return sub && /^[a-z][a-z0-9:_-]{0,40}$/.test(sub) ? `${program} ${sub}` : program;
  }
  return "(empty)";
}

/**
 * The program whose status a single pipeline exits with: its last stage. Null
 * for a command list (`&&`, `||`, `;`, newlines), whose status could have come
 * from any member.
 */
function statusProgram(command: string): string | null {
  if (/&&|\|\||[;\n]/.test(command)) return null;
  const stages = command.split("|").map((s) => s.trim()).filter(Boolean);
  return stages.length ? commandIntent(stages.at(-1)!).split(" ")[0]! : null;
}

/**
 * A path reduced to the area it targets: the directory it sits in, by its last
 * name only, so `/srv/brain/.brain/x.md` and `.brain/y.md` group together and
 * absolute roots never leak into the signature.
 */
export function pathArea(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter((p) => p && p !== ".");
  if (parts.length <= 1) return "*";
  const dir = parts.at(-2)!;
  return KNOWN_AREAS.has(dir) ? `${dir}/*` : "<dir>/*";
}

function normalizeText(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+/g, "N");
}

function pathOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "notebook_path", "target", "destination"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return null;
}

/** A URL's scheme only: hosts can be private, and egress events already record them. */
function urlKind(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const url = (input as { url?: unknown }).url;
  if (typeof url !== "string") return null;
  try { return `${new URL(url).protocol.replace(/:$/, "")}-url`; } catch { return "url"; }
}

/** The tool family a call belongs to; an episode only closes within it. */
export function familyOf(tool: string, input: unknown): string {
  const { name, server } = bareTool(tool);
  const family = FAMILY_BY_TOOL[name.toLowerCase()];
  if (family === "shell") {
    const command = commandOf(input);
    return clipTo(command === null ? "shell" : `shell:${commandIntent(command)}`, MAX_FAMILY);
  }
  if (family) return family;
  return clipTo(server ? `mcp:${server}:${name}` : `tool:${name}`, MAX_FAMILY);
}

/** What a call was aiming at, normalized for grouping. */
function intentOf(tool: string, input: unknown): string {
  const command = commandOf(input);
  if (command !== null && FAMILY_BY_TOOL[bareTool(tool).name.toLowerCase()] === "shell") return commandIntent(command);
  const path = pathOf(input);
  if (path) return pathArea(path);
  return urlKind(input) ?? "*";
}

interface Cause {
  category: Exclude<RoadblockCategory, "retry">;
  /** The detail a remedy would key on: `EROFS .brain/*`, `exit 128`. */
  detail: string;
}

function exitCodeOf(output: string): number | null {
  let code: number | null = null;
  for (const match of output.matchAll(EXIT_LINE)) code = Number(match[1] ?? match[2]);
  return code;
}

/** The path an fs error names, reduced to its area. */
function deniedArea(output: string): string | null {
  const line = output.split("\n").find((l) => FS_DENIED.test(l));
  if (!line) return null;
  const path = /['"`]?((?:\/|\.{1,2}\/|~\/)?[\w.@~+-]+(?:\/[\w.@~+-]+)+)/.exec(line);
  return path ? pathArea(path[1]!) : null;
}

/** Why a finished call failed, or null when it did not. */
export function failureCause(call: TracedCall): Cause | null {
  if (call.denied) return { category: "permission_denied", detail: "denied" };
  if (call.output === null) return null;
  const output = call.output;
  const shell = FAMILY_BY_TOOL[bareTool(call.tool).name.toLowerCase()] === "shell";
  const exit = shell ? exitCodeOf(output) : null;
  // Exit 1 of a search or diff is an answer, not a failure, whichever way the
  // backend flagged it. pi's bash reports any other nonzero exit only in its
  // text, not as a tool error.
  const command = commandOf(call.input);
  const answered = exit === 1 && command !== null && EXIT_ONE_IS_ANSWER.has(statusProgram(command) ?? "");
  if (answered) return null;
  const failed = call.isError || (exit !== null && exit !== 0);
  if (!failed) return null;
  if (FS_DENIED.test(output)) {
    const code = /\bEROFS\b|read-only file system/i.test(output) ? "EROFS" : /\bEPERM\b|operation not permitted/i.test(output) ? "EPERM" : "EACCES";
    const area = deniedArea(output) ?? (pathOf(call.input) ? pathArea(pathOf(call.input)!) : null);
    return { category: "fs_denied", detail: area ? `${code} ${area}` : code };
  }
  if (NETWORK_REFUSED.test(output)) {
    const code = /\b(E[A-Z]{4,})\b/.exec(output)?.[1] ?? "refused";
    return { category: "network_refused", detail: code };
  }
  if (exit !== null && exit !== 0) return { category: "shell_nonzero", detail: `exit ${exit}` };
  return { category: "tool_error", detail: "error" };
}

/** What makes two attempts "the same again": the tool and its normalized input tokens. */
function fingerprint(tool: string, input: unknown): Set<string> {
  let text: string;
  try { text = typeof input === "string" ? input : JSON.stringify(sortKeys(input)) ?? ""; }
  catch { text = String(input); }
  const tokens = normalizeText(text.toLowerCase()).split(/[^a-z0-9_./~$-]+/).filter(Boolean);
  return new Set([`tool=${tool}`, ...tokens]);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 1 : shared / union;
}

function clipTo(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** One failed step on the turn's timeline: a call, or a governance event with no call. */
interface Failure {
  /** When the failed attempt began: where its waste starts. */
  at: number;
  /** When the turn could know it failed: where it sits on the timeline. */
  known: number;
  order: number;
  family: string;
  call: TracedCall | null;
  cause: Cause;
  intent: string;
  print: Set<string>;
  callSignature: string;
  eventIds: number[];
}

/** The category and detail a governance event contributes, and whether it can attach to a call. */
function governanceCause(event: GovernanceEvent): { cause: Cause; tool: string | null; family: string; attach: boolean; host?: string } | null {
  const p = event.payload as Record<string, unknown>;
  const tool = typeof p.tool === "string" ? p.tool : null;
  const toolFamily = tool ? familyOf(tool, typeof p.input === "string" ? { command: p.input } : undefined) : null;
  switch (event.kind) {
    case "policy_block":
      return { cause: { category: "policy_block", detail: `commands.deny ${(p.rule as { index?: number })?.index ?? "?"}` },
        tool, family: toolFamily ?? "policy", attach: true };
    case "policy_confirm":
      if (p.decision === "approved") return null;
      return { cause: { category: "permission_denied", detail: `confirm ${String(p.decision)}` }, tool, family: toolFamily ?? "policy", attach: true };
    case "outward_action":
      if (p.decision !== "declined" && p.decision !== "refused") return null;
      return { cause: { category: "permission_denied", detail: `outward ${String(p.action)} ${String(p.decision)}` }, tool,
        family: toolFamily ?? "outward", attach: true };
    case "read_only_refusal":
      return { cause: { category: "fs_denied", detail: `${String(p.code ?? p.protection)} ${pathArea(String(p.path))}` }, tool,
        family: toolFamily ?? "file_write", attach: true };
    case "egress_denial":
      return { cause: { category: "network_refused", detail: `egress ${String(p.reason)}` }, tool: null, family: "network", attach: true, host: String(p.host).toLowerCase() };
    case "budget_block":
      return { cause: { category: "budget", detail: `${String(p.scope)} ${String(p.unit)} ${String(p.stage)}` }, tool: null, family: "budget", attach: false };
    case "scope_cap":
      return { cause: { category: "scope_cap", detail: String(p.cap) }, tool: null, family: "scope", attach: false };
    default:
      return null;
  }
}

/**
 * Classify a turn's roadblocks. Pure: identical inputs give identical
 * episodes, in the order their first failure happened.
 */
export function classifyRoadblocks(trace: TurnTrace, events: readonly GovernanceEvent[]): RoadblockPayload[] {
  const turnEnd = trace.endedAt;
  const failures: Failure[] = [];
  const failureByCall = new Map<string, Failure>();
  // Calls are the timeline's backbone; a success is a step that can resolve.
  const steps = trace.calls.map((call, index) => ({ call, index, family: familyOf(call.tool, call.input) }));
  for (const { call, index, family } of steps) {
    const cause = failureCause(call);
    if (!cause) continue;
    const intent = intentOf(call.tool, call.input);
    const failure: Failure = {
      at: call.startedAt, known: call.endedAt ?? call.startedAt, order: index, family, call, cause, intent,
      print: fingerprint(call.tool, call.input),
      callSignature: "",
      eventIds: [],
    };
    failures.push(failure);
    failureByCall.set(call.toolCallId, failure);
  }

  // Governance events refine the call they happened in, or stand on their own.
  const sortedEvents = [...events].filter((e) => e.kind !== "roadblock").sort((a, b) => a.id - b.id);
  let standalone = 0;
  for (const event of sortedEvents) {
    const contribution = governanceCause(event);
    if (!contribution) continue;
    let target: Failure | undefined;
    if (contribution.attach) {
      // A failed call in flight when the event was written: of the event's
      // tool when it names one (the latest started), otherwise one whose
      // input names the refused host, and only when exactly one fits.
      const inFlight = failures.filter((failure) => {
        const call = failure.call;
        if (!call || call.startedAt > event.at || (call.endedAt ?? turnEnd) < event.at) return false;
        if (contribution.tool) return bareTool(contribution.tool).name === bareTool(call.tool).name;
        // Only a call whose own input names the refused host.
        if (contribution.host === undefined || !CONNECTING_FAMILY.test(failure.family)) return false;
        const host = contribution.host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?:^|[^a-z0-9.-])${host}(?:$|[^a-z0-9-])`).test(rawInputText(call).toLowerCase());
      });
      if (contribution.tool) {
        for (const failure of inFlight) if (!target || failure.call!.startedAt >= target.call!.startedAt) target = failure;
      } else if (inFlight.length === 1) {
        target = inFlight[0];
      }
    }
    if (target) {
      // The server's own record names the rule, so it outranks what the
      // output text suggested.
      target.cause = contribution.cause;
      target.eventIds.push(event.id);
      continue;
    }
    standalone += 1;
    failures.push({
      at: event.at, known: event.at, order: trace.calls.length + standalone, family: contribution.family, call: null,
      cause: contribution.cause, intent: contribution.family, print: new Set([`event=${event.kind}`, contribution.cause.detail]),
      callSignature: "", eventIds: [event.id],
    });
  }

  // A backend that ended the turn on its own budget or turn cap, with no event for it.
  if (trace.outcomeDetail === "max_budget" && !failures.some((f) => f.cause.category === "budget")) {
    failures.push({ at: turnEnd, known: turnEnd, order: trace.calls.length + standalone + 1, family: "budget", call: null,
      cause: { category: "budget", detail: "turn usd sdk_backstop" }, intent: "budget", print: new Set(["max_budget"]),
      callSignature: "", eventIds: [] });
  }
  if (trace.outcomeDetail === "max_turns" && !failures.some((f) => f.cause.category === "scope_cap")) {
    failures.push({ at: turnEnd, known: turnEnd, order: trace.calls.length + standalone + 2, family: "scope", call: null,
      cause: { category: "scope_cap", detail: "max_turns" }, intent: "scope", print: new Set(["max_turns"]),
      callSignature: "", eventIds: [] });
  }

  for (const failure of failures) {
    const tool = failure.call?.tool ?? failure.family;
    failure.callSignature = clipTo(`${tool}|${failure.intent}|${failure.cause.category} ${failure.cause.detail}`, MAX_SIGNATURE);
  }

  // The timeline: a failure sits where the turn learned of it, a success
  // where it began, so a parallel call that started before the failure was
  // known never counts as the path that worked around it.
  type Step = { at: number; order: number; family: string; failure: Failure | null; call: TracedCall | null };
  const timeline: Step[] = [
    ...failures.map((f) => ({ at: f.known, order: f.order, family: f.family, failure: f, call: f.call })),
    ...steps.filter(({ call }) => !failureByCall.has(call.toolCallId) && call.output !== null && !call.denied)
      .map(({ call, index, family }) => ({ at: call.startedAt, order: index, family, failure: null, call })),
  ].sort((a, b) => a.at - b.at || a.order - b.order);

  interface Episode { family: string; failures: Failure[]; resolution: TracedCall | null; closedAt: number }
  const open = new Map<string, Episode>();
  const episodes: Episode[] = [];
  for (const step of timeline) {
    const episode = open.get(step.family);
    if (step.failure) {
      if (episode) episode.failures.push(step.failure);
      else {
        const opened: Episode = { family: step.family, failures: [step.failure], resolution: null, closedAt: turnEnd };
        open.set(step.family, opened);
        episodes.push(opened);
      }
    } else if (episode) {
      // Same family, later success: the path that finally worked.
      episode.resolution = step.call;
      episode.closedAt = step.at;
      open.delete(step.family);
    }
  }

  return episodes.map((episode) => toPayload(episode, trace));
}

function tokensAt(trace: TurnTrace, at: number, end: boolean): { tokens: number | null; costUsd: number | null } {
  if (end && trace.finalUsage) return trace.finalUsage;
  if (trace.usage.length === 0) return { tokens: null, costUsd: null };
  let sample: UsageSample | null = null;
  for (const s of trace.usage) if (s.at <= at && (!sample || s.at >= sample.at)) sample = s;
  // Before the first completed response nothing has been spent yet, as far
  // as the samples measure at all.
  return sample ? { tokens: sample.tokens, costUsd: sample.costUsd }
    : { tokens: trace.usage.every((s) => s.tokens !== null) ? 0 : null, costUsd: trace.usage.every((s) => s.costUsd !== null) ? 0 : null };
}

function toPayload(
  episode: { family: string; failures: Failure[]; resolution: TracedCall | null; closedAt: number },
  trace: TurnTrace
): RoadblockPayload {
  const first = episode.failures[0]!;
  const counted = episode.failures.slice(0, MAX_FAILURES);
  const allCategories = counted.map((failure, i) => {
    const again = counted.slice(0, i).some((earlier) => earlier.call && failure.call
      && similarity(earlier.print, failure.print) >= RETRY_SIMILARITY);
    return again ? "retry" as const : failure.cause.category;
  });
  // Bounded by count and by serialized bytes, so an episode always fits the
  // writer's payload limit.
  const entries: RoadblockPayload["failures"] = [];
  let bytes = 0;
  for (const [i, failure] of counted.entries()) {
    const entry = { toolCallId: failure.call ? boundedId(failure.call.toolCallId) : null, signature: failure.callSignature,
      category: allCategories[i]! };
    bytes += Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (bytes > FAILURE_BYTES) break;
    entries.push(entry);
  }
  const categories = allCategories.slice(0, entries.length);
  const resolution = episode.resolution;
  const workaround = resolution !== null && TURN_TEMP.test(targetText(resolution));
  // Waste runs from the first failed attempt until the working path began
  // (or the turn ended). Unknown usage stays null: never counted as zero.
  const from = first.at;
  const to = resolution ? resolution.startedAt : trace.endedAt;
  const start = tokensAt(trace, from, false);
  const stop = tokensAt(trace, to, resolution === null);
  const tokens = start.tokens !== null && stop.tokens !== null && trace.usage.length > 0 ? Math.max(0, stop.tokens - start.tokens) : null;
  const costUsd = start.costUsd !== null && stop.costUsd !== null && trace.usage.length > 0 ? Math.max(0, stop.costUsd - start.costUsd) : null;
  return {
    category: categories.includes("retry") ? "retry" : first.cause.category,
    family: episode.family,
    signature: clipTo(`${episode.family}|${first.intent}|${first.cause.category} ${first.cause.detail}`, MAX_SIGNATURE),
    failures: entries,
    resolution: resolution
      ? { toolCallId: boundedId(resolution.toolCallId), signature: clipTo(`${resolution.tool}|${intentOf(resolution.tool, resolution.input)}`, MAX_SIGNATURE) }
      : null,
    remedy: resolution !== null && !workaround ? "guidance" : "capability",
    waste: { tokens, costUsd, ms: Math.max(0, Math.round(to - from)) },
    eventIds: [...new Set(episode.failures.flatMap((f) => f.eventIds))].sort((a, b) => a - b).slice(0, MAX_EVENT_IDS),
  };
}

/**
 * A call id within the schema's limit. A longer one keeps a prefix and a
 * digest of the whole id, so distinct calls stay distinct and the same id
 * always maps to the same value.
 */
function boundedId(id: string): string {
  if (id.length <= MAX_ID) return id;
  return `${id.slice(0, MAX_ID - 33)}#${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

/** A call's input as text, for matching what an event names. */
function rawInputText(call: TracedCall): string {
  if (typeof call.input === "string") return call.input;
  try { return JSON.stringify(call.input) ?? ""; } catch { return ""; }
}

/**
 * Where a shell command wrote: redirection and `tee` targets, `-o`/`--output`
 * values, and the destination of `cp`, `mv`, `install`, `ln`, `touch` and
 * `mkdir`. Never the text it wrote.
 */
export function shellTargets(command: string): string[] {
  const targets: string[] = [];
  const unquote = (t: string) => t.replace(/^["']|["']$/g, "");
  // `>`, `>>`, `>|`, `1>`, `&>`, `&>>`; never a duplication such as `2>&1`.
  for (const m of command.matchAll(/(?:^|[^<>])(?:\d+|&)?>>?\|?\s*(?!&)("[^"]*"|'[^']*'|[^\s;|&<>]+)/g)) targets.push(unquote(m[1]!));
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const program = (tokens[0] ?? "").split("/").pop();
    const operands = tokens.slice(1).filter((t) => !t.startsWith("-") && !/^[0-9]*[<>]/.test(t));
    if (program === "tee") targets.push(...operands.map(unquote));
    else if (["cp", "mv", "install", "ln"].includes(program ?? "") && operands.length) targets.push(unquote(operands.at(-1)!));
    else if (program === "touch" || program === "mkdir") targets.push(...operands.map(unquote));
    const outputs = OUTPUT_OPTIONS[program ?? ""];
    if (outputs) {
      tokens.forEach((t, i) => {
        const [name, value] = t.startsWith("--") && t.includes("=") ? [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)] : [t, undefined];
        if (!outputs.has(name)) return;
        const target = value ?? tokens[i + 1];
        if (target) targets.push(unquote(target));
      });
    }
  }
  return targets;
}

/** Where a call wrote: a shell command's targets or a file tool's target, never the content it wrote. */
function targetText(call: TracedCall): string {
  const command = commandOf(call.input);
  if (command !== null && FAMILY_BY_TOOL[bareTool(call.tool).name.toLowerCase()] === "shell") {
    return shellTargets(command).map((t) => ` ${t}`).join("");
  }
  return pathOf(call.input) ?? "";
}

export interface RoadblockAttribution {
  turnId: string;
  sessionId: string | null;
  actor: GovernanceActor;
  model: string | null;
  profile: GovernanceProfile | null;
}

/**
 * Classify a finished turn and store each episode as a `roadblock` governance
 * event. Idempotent per turn: a second call stores nothing new. Throws on a
 * storage failure; the caller decides that it must not fail the turn.
 */
export function recordTurnRoadblocks(db: Database, attribution: RoadblockAttribution, trace: TurnTrace): number {
  const events: GovernanceEvent[] = [];
  for (let after = 0; ;) {
    const page = queryGovernanceEvents(db, { turnId: attribution.turnId, kinds: [...CONTRIBUTING_KINDS], after, limit: 500 });
    events.push(...page);
    if (page.length < 500) break;
    after = page.at(-1)!.id;
  }
  const episodes = classifyRoadblocks(trace, events);
  let recorded = 0;
  let failure: unknown;
  episodes.forEach((payload, index) => {
    // One episode the writer refuses never costs the turn its other episodes.
    try {
    const result = recordGovernanceEvent(db, {
      kind: "roadblock",
      payload,
      sessionId: attribution.sessionId,
      turnId: attribution.turnId,
      actor: attribution.actor,
      model: attribution.model,
      profile: attribution.profile,
      at: trace.endedAt,
      dedupeKey: `${attribution.turnId}:${index}`,
    });
    if (result.recorded) recorded += 1;
    } catch (error) { failure ??= error; }
  });
  if (failure !== undefined) throw failure;
  return recorded;
}
