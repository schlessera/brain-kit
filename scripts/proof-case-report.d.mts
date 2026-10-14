import type { Reporter, TestModule, TestSpecification } from "vitest/node";
import type { Checkout, Spec } from "./proof-inputs";

export interface CaseReport {
  version: number;
  checkout: Checkout;
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
export function caseReportProblems(report: CaseReport, expectedSpecs: readonly Spec[], expectedCheckout: Checkout): string[];
export default class ProofCaseReporter implements Reporter {
  constructor(options?: { output?: string });
  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void;
  onTestModuleCollected(module: TestModule): void;
  onTestRunEnd: NonNullable<Reporter["onTestRunEnd"]>;
}
