/**
 * Open failure issues, mapped to the test files they name.
 *
 * An issue about a failed test is evidence about the test as much as about the
 * product: the selector ranks a file with open issues higher, and the audit's
 * failure-issues lens asks whether the test itself needs adapting. Mapping is
 * by text, so it only ever raises a file's priority; the agent reads the issue
 * before acting on it.
 */
import type { IssueRef } from "./select";

export interface Issue { number: number; title: string; body: string; labels: string[]; assignees: number }

const FAILURE_WORDS = /flak|intermittent|timed? out|times out|red main|fails? under|race/i;

/** Issues worth mapping: every `type: test` issue, and any other whose title reads like a test failure. */
export function failureIssues(issues: readonly Issue[]): Issue[] {
  return issues.filter(issue => issue.labels.includes("type: test") || FAILURE_WORDS.test(issue.title)).sort((a, b) => a.number - b.number);
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function mapIssues(issues: readonly Issue[], files: readonly string[]): Map<string, IssueRef[]> {
  const stems = new Map<string, string[]>();
  for (const file of files) {
    const base = file.split("/").pop()!;
    const stem = base.replace(/\.[cm]?[jt]sx?$/, "").replace(/\.(?:test|spec)$/, "");
    for (const key of new Set([base, stem])) stems.set(key, [...(stems.get(key) ?? []), file]);
  }
  // A name maps only when exactly one file carries it and it is distinctive enough not to be prose.
  const names = [...stems.entries()].filter(([key, owners]) => owners.length === 1 && (key.includes(".") || (key.length >= 12 && key.includes("-"))))
    .map(([key, owners]) => ({ pattern: new RegExp(`(?<![\\w./-])${escape(key)}(?![\\w-])`), file: owners[0]! }));
  const mapped = new Map<string, IssueRef[]>();
  for (const issue of failureIssues(issues)) {
    const text = `${issue.title}\n${issue.body}`;
    const hits = new Set<string>();
    for (const file of files) if (text.includes(file)) hits.add(file);
    for (const { pattern, file } of names) if (pattern.test(text)) hits.add(file);
    const ref: IssueRef = { number: issue.number, title: issue.title, needsRepro: issue.labels.includes("needs: repro"), assigned: issue.assignees > 0 };
    for (const file of hits) mapped.set(file, [...(mapped.get(file) ?? []), ref]);
  }
  return mapped;
}

function gh(args: string[], cwd: string): string {
  const result = Bun.spawnSync(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

interface RawIssue { number: number; title: string; body: string | null; labels: Array<{ name: string }>; assignees: unknown[] }

export function fetchIssues(root: string): Issue[] {
  const raw = JSON.parse(gh(["issue", "list", "--state", "open", "--limit", "1000", "--json", "number,title,body,labels,assignees"], root)) as RawIssue[];
  return raw.map(issue => ({ number: issue.number, title: issue.title, body: issue.body ?? "", labels: issue.labels.map(label => label.name), assignees: issue.assignees.length }));
}

/** Files that open pull requests already touch. A run leaves them alone rather than race the other change. */
export function fetchOpenPrFiles(root: string): Set<string> {
  const raw = JSON.parse(gh(["pr", "list", "--state", "open", "--limit", "200", "--json", "number,files"], root)) as Array<{ files?: Array<{ path: string }> }>;
  return new Set(raw.flatMap(pr => (pr.files ?? []).map(file => file.path)));
}
