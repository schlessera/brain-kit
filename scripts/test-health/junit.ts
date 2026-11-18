/**
 * Case results from the two report formats this repository's runners write:
 * Bun's JUnit XML (`bun test --reporter=junit`) and the Vitest case report
 * (`tmp/proof-cases.json`, scripts/proof-case-report.mjs).
 *
 * Only names, states, durations and assertion counts are kept. Bun's XML also
 * carries the machine's hostname, which must never reach the ledger.
 */

export interface CaseResult {
  file: string;
  name: string;
  state: "passed" | "failed" | "skipped";
  ms: number | null;
  /** Assertions the case executed; `null` when the runner does not report it. */
  assertions: number | null;
  message?: string;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const decode = (text: string): string => text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, entity: string) => {
  if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
  if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
  return ENTITIES[entity] ?? whole;
});

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[match[1]!] = decode(match[2]!);
  return out;
}

/** Bun nests a `<testsuite>` per `describe`; a case's name is its suite path plus its own name. */
export function parseJunit(xml: string): CaseResult[] {
  const cases: CaseResult[] = [];
  const suites: string[] = [];
  let current: CaseResult | null = null;
  for (const match of xml.matchAll(/<(\/?)(testsuites|testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, raw, selfClosing] = match;
    const attrs = attributes(raw ?? "");
    if (tag === "testsuite") {
      if (closing) suites.pop();
      // The outermost suite is the file; its name is not part of a case name.
      else if (!selfClosing) suites.push(attrs.line === undefined ? "" : attrs.name ?? "");
    } else if (tag === "testcase") {
      if (closing) { current = null; continue; }
      const path = [...suites.filter(Boolean), attrs.name ?? ""].join(" > ");
      const result: CaseResult = { file: attrs.file ?? "", name: path, state: "passed",
        ms: attrs.time === undefined ? null : Math.round(Number(attrs.time) * 1_000_000) / 1000,
        assertions: attrs.assertions === undefined ? null : Number(attrs.assertions) };
      cases.push(result);
      current = selfClosing ? null : result;
    } else if (current && !closing) {
      if (tag === "skipped") current.state = "skipped";
      else { current.state = "failed"; if (attrs.message) current.message = attrs.message.slice(0, 500); }
    }
  }
  return cases;
}

interface ProofCases { modules?: Array<{ file?: unknown; cases?: Array<{ name?: unknown; state?: unknown; durationMs?: unknown }> }> }

export function parseProofCases(json: string): CaseResult[] {
  const report = JSON.parse(json) as ProofCases;
  const cases: CaseResult[] = [];
  for (const module of report.modules ?? []) {
    if (typeof module.file !== "string") continue;
    for (const test of module.cases ?? []) {
      const state = test.state === "passed" ? "passed" : test.state === "skipped" || test.state === "pending" ? "skipped" : "failed";
      cases.push({ file: module.file, name: String(test.name ?? ""), state,
        ms: typeof test.durationMs === "number" ? Math.round(test.durationMs * 1000) / 1000 : null, assertions: null });
    }
  }
  return cases;
}
