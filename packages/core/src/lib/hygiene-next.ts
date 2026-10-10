/** Deterministic selection over the reconciled canonical hygiene backlog (#1026). */
import { readFileSync } from "fs";
import { wikiLinkTokens } from "./indexer/links.js";
import { safeResolve } from "./safe-path.js";
import type { HygieneFinding, HygieneLogEntry } from "./hygiene.js";

export type ReviewSeverity = "error" | "warning" | "unknown" | "info";
export type ReviewUrgency = "immediate" | "overdue" | "due" | "upcoming" | "unknown";

// Ordinal mappings, never scores or model-assigned priorities.
export const REVIEW_SEVERITY: Record<ReviewSeverity, number> = { error: 0, warning: 1, unknown: 2, info: 3 };
export const REVIEW_URGENCY: Record<ReviewUrgency, number> = { immediate: 0, overdue: 1, due: 2, upcoming: 3, unknown: 4 };

export function reviewUrgency(value: string | null): ReviewUrgency {
  // Canonicalization joins contributing urgency values with newlines. Only
  // explicitly recognized values count; an unsupported value stays unknown.
  return (value?.split("\n") ?? []).filter((v): v is ReviewUrgency => Object.hasOwn(REVIEW_URGENCY, v))
    .sort((a, b) => REVIEW_URGENCY[a] - REVIEW_URGENCY[b])[0] ?? "unknown";
}

export interface HygienePriorityReason {
  severity: ReviewSeverity;
  urgency: ReviewUrgency;
  ageDays: number | null;
  newerWithSameRank: number;
  tieBreak: "only-finding" | "severity" | "urgency" | "age" | "identity";
}

export interface HygieneNextFinding extends HygieneFinding {
  title: string;
  line: number | null;
  field: string | null;
  excerpt: string | null;
  /** Selection supplies manual review until a repair handler is delivered. */
  handler: "manual";
  firstSeen: string | null;
  invalidation: HygieneLogEntry["invalidation"];
  priorityReason: HygienePriorityReason;
}

export interface HygieneNextResult {
  finding: HygieneNextFinding | null;
  counts: {
    eligibleRemaining: number;
    fixed: number;
    dismissed: number;
    snoozed: number;
    nextSnoozeDueAt: string | null;
    informationalNotShown: number;
  };
}

const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const severity = (f: HygieneFinding): ReviewSeverity => f.severity ?? "unknown";
const seenAt = (e: HygieneLogEntry) => e.firstSeen === null ? Infinity : Date.parse(`${e.firstSeen}T00:00:00Z`);

/** Locate evidence in the actual file, without reading outside the brain root. */
function presentation(root: string, f: HygieneFinding) {
  const field = ["required-field", "invalid-field", "field-conflict"].includes(f.category) ? f.evidence : null;
  let line: number | null = null;
  let excerpt: string | null = null;
  const path = safeResolve(root, f.path);
  if (path) {
    try {
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      const needle = f.category === "broken-link" ? wikiLinkTokens(lines.join("\n"), f.evidence)[0] ?? "" : f.evidence;
      const index = field ? lines.findIndex((s) => s.startsWith(`${field}:`))
        : needle ? lines.findIndex((s) => s.includes(needle)) : -1;
      if (index >= 0) {
        line = index + 1;
        const text = lines[index];
        const start = Math.max(0, text.indexOf(needle) - 20);
        excerpt = [...text.slice(start)].slice(0, 60).join("");
      }
    } catch { /* Missing/unreadable evidence is reported as null, never fabricated. */ }
  }
  const title = f.category === "broken-link" ? "A link points to a note that does not exist"
    : f.category === "required-field" ? "A required frontmatter field is missing or invalid"
    : `Review the ${f.category.replace(/-/g, " ")} finding`;
  return { title, line, field, excerpt };
}

/**
 * Select after reconciliation has applied evidence invalidation and due snoozes.
 * Only currently detected open findings are eligible. Info remains visible in
 * the log and in the end receipt, without becoming a required review item.
 */
export function selectHygieneNext(root: string, findings: Map<string, HygieneFinding>, entries: HygieneLogEntry[], now: Date): HygieneNextResult {
  const eligible = entries.filter((e) => e.state === "open" && findings.has(e.id) && severity(findings.get(e.id)!) !== "info");
  const rank = (e: HygieneLogEntry) => {
    const f = findings.get(e.id)!;
    return [REVIEW_SEVERITY[severity(f)], REVIEW_URGENCY[reviewUrgency(f.urgency)]];
  };
  const sameRank = (a: HygieneLogEntry, b: HygieneLogEntry) => rank(a).every((r, i) => r === rank(b)[i]);
  eligible.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1] || seenAt(a) - seenAt(b) || compareId(a.id, b.id));
  const dueTimes = entries.filter((e) => e.state === "snoozed" && e.dueAt !== null).map((e) => e.dueAt!).sort((a, b) => Date.parse(a) - Date.parse(b));
  const counts = {
    eligibleRemaining: eligible.length,
    // These are durable backlog totals, not session counters or a claim that
    // disappearance proves a repair. See the contract's definition of fixed.
    fixed: entries.filter((e) => e.state === "resolved").length,
    dismissed: entries.filter((e) => e.state === "dismissed").length,
    snoozed: entries.filter((e) => e.state === "snoozed").length,
    nextSnoozeDueAt: dueTimes[0] ?? null,
    informationalNotShown: entries.filter((e) => e.state === "open" && findings.get(e.id)?.severity === "info").length,
  };
  const entry = eligible[0];
  if (!entry) return { finding: null, counts };
  const f = findings.get(entry.id)!;
  const second = eligible[1];
  const tieBreak = !second ? "only-finding" : rank(entry)[0] !== rank(second)[0] ? "severity"
    : rank(entry)[1] !== rank(second)[1] ? "urgency" : seenAt(entry) !== seenAt(second) ? "age" : "identity";
  return {
    finding: {
      ...f, ...presentation(root, f), handler: "manual", firstSeen: entry.firstSeen, invalidation: entry.invalidation,
      priorityReason: {
        severity: severity(f), urgency: reviewUrgency(f.urgency),
        ageDays: Number.isFinite(seenAt(entry)) ? Math.max(0, Math.floor((now.getTime() - seenAt(entry)) / 86_400_000)) : null,
        newerWithSameRank: eligible.filter((e) => sameRank(entry, e) && seenAt(e) > seenAt(entry)).length,
        tieBreak,
      },
    },
    counts,
  };
}
