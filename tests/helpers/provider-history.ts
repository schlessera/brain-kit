import { expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
}
export type Captures = Record<string, HistoryCapture>;

/** Preserve insertion order and every content byte; only cache breakpoints may move. */
export function bytes(value: unknown): string {
  return JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);
}

export function identical(expected: unknown, actual: unknown, label: string): void {
  compareBytes(bytes(expected), bytes(actual), label);
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
export function body(exchange: Exchange): any { return JSON.parse(exchange.raw); }
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

export async function captureOffline(probe: string): Promise<Captures> {
  const root = resolve(import.meta.dir, "../..");
  const scratch = mkdtempSync(join(tmpdir(), "odysseus-provider-history-"));
  const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
    process.execPath, "--preload", join(root, "scripts/test-network-child-preload.ts"), probe, scratch], {
    cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", TMPDIR: tmpdir(), HOME: join(scratch, "home"),
      PI_CODING_AGENT_DIR: join(scratch, "pi-agent") }, stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), 170_000);
  try {
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    return JSON.parse(readFileSync(join(scratch, "requests.json"), "utf8"));
  } finally { clearTimeout(deadline); child.kill(); rmSync(scratch, { recursive: true, force: true }); }
}
