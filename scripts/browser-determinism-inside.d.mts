export const RESULT_KIND: "brain-browser-determinism-passes";
export interface PassPair { project: string; file: string; }
export interface PassPlan { root: string; result: string; pairs: PassPair[]; repetitions: number; deadlineFactor: number; burners: number | null; cpuList: string | null; }
export interface PassFailure { project: string | null; file: string | null; repetition: number | null; test: string | null; reason: string; }
export interface PassOutcome { passes: { repetition: number; elapsedSeconds: number; ok: boolean }[]; failure: PassFailure | null; alsoFailed: PassPair[]; }
/** The part of a Vitest test module the runner reads. */
export interface EndedModule {
  project: { name: string }; moduleId: string;
  ok(): boolean; errors(): { message?: string }[];
  children: { allTests(state?: string): Iterable<{ fullName: string; result(): { errors?: { message?: string }[] } }> };
}
export interface PassCollector { reporter: { onTestModuleEnd(module: EndedModule): void }; take(): EndedModule[]; }
/** The part of a Vitest instance the runner drives. */
export interface PassRunner {
  globTestSpecifications(): Promise<{ project: { name: string }; moduleId: string }[]>;
  runTestSpecifications(specifications: any[], allTestsRun: boolean): Promise<{ unhandledErrors: unknown[] }>;
}
export function burnerSource(parent: number, lifetimeMs?: number): string;
export function startBurners(count: number, lifetimeMs?: number): { pids: number[]; stop(): void };
export function readPassPlan(value: unknown): PassPlan;
export function passCollector(): PassCollector;
export function runPasses(options: { vitest: PassRunner; collector: PassCollector; pairs: readonly PassPair[]; repetitions: number;
  repo?: string; log?: (line: string) => void; now?: () => number }): Promise<PassOutcome>;

export function scaleVitestDeadlines(vitest: { projects: { name: string; config: { testTimeout: number; hookTimeout: number; env?: Record<string, string> } }[] },
  factor: number, log?: (line: string) => void): void;
