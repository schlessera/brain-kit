import type { Reporter, TestModule, TestSpecification } from "vitest/node";
import type { Checkout, Spec } from "./proof-inputs";

export interface CaseReport {
  version: number;
  checkout: Checkout;
  /** Whole requested domain, before the Vitest sequencer applies a shard. */
  selected: Spec[];
  collected: (Spec & { cases: { id: string; name: string }[] })[];
  reason: string;
  unhandledErrors: { name?: string; message?: string }[];
  modules: (Spec & {
    state: string;
    errors: { name?: string; message?: string }[];
    cases: { id: string; name: string; state: string; location: { line: number; column: number } | null; durationMs: number | null }[];
  })[];
}
export type CaseSelection = readonly Spec[] | { version: 1; requested: readonly Spec[]; executed: readonly Spec[] };
export function caseReportProblems(report: CaseReport, selection: CaseSelection, expectedCheckout: Checkout): string[];
export default class ProofCaseReporter implements Reporter {
  constructor(options?: { output?: string });
  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void;
  onTestModuleCollected(module: TestModule): void;
  onTestRunEnd: NonNullable<Reporter["onTestRunEnd"]>;
}
