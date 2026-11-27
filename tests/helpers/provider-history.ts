import { expect } from "bun:test";
import { DEADLINE_FACTOR_ENV, watchdogMs } from "../../scripts/test-deadlines.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface Exchange {
  turn: number;
  path: string;
  raw: string;
  main: boolean;
  answer: Record<string, unknown>;
}
export interface HistoryCapture {
  sessions: string[];
  exchanges: Exchange[];
  appends: unknown[];
  budgets?: unknown[];
  /** Private qualification evidence, never a product frame. */
  qualification?: Record<string, unknown>;
  voiceRefusal?: { message: string; before: number; after: number };
  /** Host calls a backend's reference tools made, as the host received them (#2432). */
  calls?: unknown[];
  /** Digests of the tool roster a backend assembled for each turn, where the client may replay an earlier one. */
  rosters?: (string | null)[];
}
export type Captures = Record<string, HistoryCapture>;

/** Preserve every content byte, including schema/input properties named cache_control. */
export function bytes(value: unknown): string { return JSON.stringify(value); }

/** Only API cache-breakpoint positions may move; never walk arbitrary payloads. */
function cacheBlock(block: any): any {
  if (!block || typeof block !== "object" || Array.isArray(block)) return block;
  const { cache_control: _breakpoint, ...rest } = block;
  // Tool-result content is a list of API content blocks too. Tool-use input,
  // schema properties, document data and other nested JSON remain untouched.
  if (rest.type === "tool_result" && Array.isArray(rest.content)) rest.content = rest.content.map(cacheBlock);
  return rest;
}
export function withoutMessageCacheControls(items: any[]): any[] {
  return items.map(item => item && Array.isArray(item.content) ? { ...item, content: item.content.map(cacheBlock) } : item);
}

/**
 * The provider-history rule's one encoding equivalence (2026-11-26, #4324):
 * the API documents string content as shorthand for one text block, and the
 * pinned client wraps exactly the message that carries the moving cache
 * breakpoint in that block. Only a non-empty string message content becomes
 * `[{ type: "text", text }]`; every other byte, the top-level system
 * included, stays exactly as sent.
 */
export function canonicalMessageContent(items: any[]): any[] {
  return items.map(item => item && typeof item.content === "string" && item.content !== ""
    ? { ...item, content: [{ type: "text", text: item.content }] } : item);
}

export function identical(expected: unknown, actual: unknown, label: string): void {
  compareBytes(bytes(expected), bytes(actual), label);
}
/** Names in successful new tool results for this response's actual ToolSearch calls. */
export function discoveredToolNames(previous: Exchange, next: Exchange): string[] {
  const calls = new Set((previous.answer.content as any[] ?? []).filter(part => part.type === "tool_use" && part.name === "ToolSearch").map(part => part.id));
  const found = new Set<string>();
  for (const message of messages(next).slice(messages(previous).length)) {
    if (!Array.isArray(message.content)) continue;
    for (const result of message.content) {
      if (result.type !== "tool_result" || !calls.has(result.tool_use_id) || result.is_error === true || !Array.isArray(result.content)) continue;
      for (const ref of result.content) if (ref.type === "tool_reference" && typeof ref.tool_name === "string") found.add(ref.tool_name);
    }
  }
  return [...found];
}

/** Discovery may insert referenced definitions; all prior bytes and relative order stay fixed. */
export function providerTools(previous: Exchange, next: Exchange, label: string): void {
  const before = body(previous).tools, after = body(next).tools;
  const refs = new Set(discoveredToolNames(previous, next));
  if (!refs.size) { identical(before, after, label); return; }
  const names = new Set(before.map((tool: any) => tool.name));
  expect(new Set(after.map((tool: any) => tool.name)).size, `${label}: unique definitions`).toBe(after.length);
  identical(before, after.filter((tool: any) => names.has(tool.name)), `${label}: earlier definitions and relative order`);
  for (const tool of after.filter((tool: any) => !names.has(tool.name))) {
    expect(tool.defer_loading, `${label}: discovered definition is deferred`).toBe(true);
    expect(refs.has(tool.name), `${label}: definition was actually referenced by this ToolSearch`).toBe(true);
  }
}

/** The local Claude CLI may replay old system bytes; also hold the actual
 * SDK systemPrompt option (or its production fingerprint for hosted turns). */
export function identicalSystemPromptOptions(appends: readonly unknown[], label: string): void {
  expect(appends, `${label}: capture every turn`).toHaveLength(3);
  const [first, ...rest] = appends;
  expect(first, `${label}: present capture`).not.toBeNull();
  expect(first, `${label}: defined capture`).not.toBeUndefined();
  for (const next of rest) identical(first, next, label);
}

function compareBytes(expected: string, actual: string, label: string): void {
  const left = Buffer.from(expected), right = Buffer.from(actual);
  let offset = 0;
  while (offset < Math.min(left.length, right.length) && left[offset] === right[offset]) offset++;
  if (offset === left.length && offset === right.length) return;
  const context = (buffer: Buffer) => JSON.stringify(buffer.subarray(Math.max(0, offset - 120), offset + 120).toString());
  throw new Error(`${label}: first differing byte ${offset}\nexpected: ${context(left)}\nreceived: ${context(right)}`);
}

export function main(capture: HistoryCapture): Exchange[] { return capture.exchanges.filter(e => e.main); }
export function pairs(capture: HistoryCapture): Array<[Exchange, Exchange]> {
  const requests = main(capture);
  return requests.slice(1).map((next, i) => [requests[i]!, next]);
}
export function body(exchange: Exchange): any {
  const request = JSON.parse(exchange.raw);
  if (Array.isArray(request.tools)) request.tools = request.tools.map(cacheBlock);
  if (Array.isArray(request.system)) request.system = request.system.map(cacheBlock);
  if (Array.isArray(request.messages)) request.messages = withoutMessageCacheControls(canonicalMessageContent(request.messages));
  return request;
}
function instructionCount(input: any[]): number {
  const index = input.findIndex(item => item.role !== "system" && item.role !== "developer");
  return index === -1 ? input.length : index;
}
export function system(exchange: Exchange): unknown {
  const request = body(exchange);
  return request.system ?? request.input.slice(0, instructionCount(request.input));
}
export function messages(exchange: Exchange): any[] {
  const request = body(exchange);
  return request.messages ?? request.input.slice(instructionCount(request.input));
}
/** A request's newest turn message: the production model may end it with a runtime system message. */
export function newest(exchange: Exchange): any {
  return messages(exchange).findLast(message => message.role !== "system");
}
/** Raw sent messages, before any comparison normalization. */
export function sentMessages(exchange: Exchange): any[] { return JSON.parse(exchange.raw).messages ?? []; }
export function history(previous: Exchange, next: Exchange): void {
  const prefix = [...messages(previous), previous.answer];
  identical(prefix, messages(next).slice(0, prefix.length), `messages turn ${previous.turn} -> ${next.turn}`);
  expect(messages(next).length, "new user/tool result follows the complete old prefix").toBeGreaterThan(prefix.length);
}
export function noInternalNotes(capture: HistoryCapture): void {
  for (const exchange of capture.exchanges) {
    const raw = bytes(body(exchange));
    const match = /Host inference capabilities|list-price usage limits|unpriced token stop/.exec(raw);
    if (match) compareBytes(raw.slice(0, match.index), raw, "internal budget note in provider request (#2051)");
  }
}

export async function captureOffline(probe: string, options: { isolateManagedSettings?: boolean; managedSettings?: object } = {}): Promise<Captures> {
  const root = resolve(import.meta.dir, "../..");
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-provider-history-"));
  // A private /etc works even when the runner has no /etc/claude-code.
  // Pre-create bind targets before making that view read-only; preserve only
  // basic OS/account resolution files, never the host's managed CLI policy.
  const managed = join(scratch, "managed-settings");
  const systemFiles = ["passwd", "group", "nsswitch.conf", "os-release", "localtime", "hosts", "resolv.conf"];
  if (options.isolateManagedSettings) {
    mkdirSync(join(managed, "claude-code"), { recursive: true });
    for (const name of systemFiles) writeFileSync(join(managed, name), "");
    if (options.managedSettings) writeFileSync(join(managed, "claude-code/managed-settings.json"), JSON.stringify(options.managedSettings));
  }
  const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/",
    ...(options.isolateManagedSettings ? ["--ro-bind", managed, "/etc",
      ...systemFiles.flatMap(name => ["--ro-bind-try", `/etc/${name}`, `/etc/${name}`])] : []), "--proc", "/proc", "--dev", "/dev",
    process.execPath, "--preload", join(root, "scripts/test-network-child-preload.ts"), probe, scratch], {
    cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", TMPDIR: tmpdir(), HOME: join(scratch, "home"),
      PI_CODING_AGENT_DIR: join(scratch, "pi-agent"),
      ...(process.env[DEADLINE_FACTOR_ENV] ? { [DEADLINE_FACTOR_ENV]: process.env[DEADLINE_FACTOR_ENV] } : {}) }, stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), watchdogMs(170_000));
  try {
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    return JSON.parse(readFileSync(join(scratch, "requests.json"), "utf8"));
  } finally { clearTimeout(deadline); child.kill(); rmSync(scratch, { recursive: true, force: true }); }
}
