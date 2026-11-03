/**
 * Extension seams. Each seam carries its own `@experimental` tag until 1.0;
 * docs/extending/README.md lists them.
 *
 * The meta-mechanism: a typed interface here → config accepts a built-in name
 * (string) OR a passed-in implementation (value) → optionally shared as an npm
 * package. No plugin loader, no DI container, no runtime discovery.
 *
 * A seam exists only where a second implementation is plausible within a
 * year. Everything else stays concrete code.
 */

/** A piece of multimodal content passed to a completion request. */
export type ContentPart =
  | { kind: "text"; text: string }
  | { kind: "image"; data: Uint8Array; mimeType: string }
  | { kind: "pdf"; data: Uint8Array }
  | ({ kind: "video"; mimeType: string; clip?: { start?: number; end?: number } } &
      ({ uri: string } | { path: string } | { data: Uint8Array }));

/**
 * Plain (non-agentic) LLM completion. Used for enrichment (chunk contexts,
 * asset descriptions), note processing, and briefings.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface CompletionProvider {
  id: string;
  capabilities: { vision: boolean; /** Omission means unsupported. */ video?: boolean };
  complete(req: {
    system?: string;
    prompt: string;
    parts?: ContentPart[];
    maxTokens?: number;
    /** Cancellation/deadline for this request; cleanup uses a fresh deadline. */
    signal?: AbortSignal;
  }): Promise<string>;
}

/**
 * Agentic run inside a repo — shells out to a coding agent CLI (claude, pi,
 * codex, gemini, or any custom value). Used by skill-invoking flows.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface AgentRunner {
  id: string;
  capabilities: { streaming: boolean; skills: boolean };
  run(
    prompt: string,
    opts: { cwd: string; timeoutMs?: number; onRuntime?: (runtime: AgentRuntime) => void }
  ): Promise<string>;
  runStreaming?(
    prompt: string,
    opts: {
      cwd: string;
      onEvent: (e: { kind: "tool" | "text"; label: string }) => void;
      onRuntime?: (runtime: AgentRuntime) => void;
    }
  ): Promise<string>;
}

/**
 * What an agent run said about the runtime that executed it (#290), passed to
 * `onRuntime` as soon as the runtime reports it — before the run can still
 * fail, so a caller keeps it when the run then throws. Observed, never probed:
 * a runner that cannot tell does not call it, and `version` is absent when the
 * runtime named itself but not its version.
 *
 * @experimental Part of the `AgentRunner` seam; may change before 1.0.
 */
export interface AgentRuntime {
  /** e.g. `claude-code`, the name chat records for the same binary. */
  name: string;
  version?: string;
}

/**
 * Text (and optionally multimodal) embeddings. Enrichment/generation concerns
 * live in enrichment.ts on top of CompletionProvider — NOT here.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface EmbeddingProvider {
  /** Stable identity, e.g. "gemini:gemini-embedding-2". Changing it forces a re-embed. */
  id: string;
  dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Query cancellation is optional; search also bounds providers that ignore it. */
  embedQuery(text: string, opts?: { signal?: AbortSignal }): Promise<Float32Array>;
  /** Optional multimodal support; absent → core embeds the text description instead. */
  embedImage?(buffer: Uint8Array, mimeType: string, description: string): Promise<Float32Array>;
  embedPdf?(buffer: Uint8Array, description: string): Promise<Float32Array>;
}

/** The retrieval lane a search ran in; a reranker declares which it serves. */
export type SearchMode = "fts" | "vector" | "hybrid";

/**
 * What a reranker judges. Deliberately not a SearchResult: the same reranker
 * orders a brain document, a record from another source, or the union of
 * several sources fanned out behind one query. `excerpt` is the passage the
 * retriever matched — the one query-conditioned field, and the one that
 * carries the signal; unconditioned text (document heads, bodies) measured
 * worse.
 *
 * @experimental Part of the `Reranker` seam; may change before 1.0.
 */
export interface RerankCandidate {
  /** Stable within its source: a brain path, a record id. */
  id: string;
  /**
   * Where the candidate came from ("brain", "calendar", …). A fan-out sets it
   * so a result traces back to its origin; `source` + `id` is the identity a
   * reranker must preserve. Rerankers return the caller's own objects by
   * reference, never copies, so anything else the caller attached survives.
   */
  source?: string;
  title: string;
  type?: string;
  tags?: string | null;
  summary?: string | null;
  excerpt?: string;
  /**
   * Facts about the candidate the judgment may weigh. A brain passes its
   * lifecycle fields — `status`, `relevance`, `updated` — so a draft or a
   * historical document is judged as one, rather than re-sorted afterwards by
   * fixed multipliers (measured: as evidence they helped the hybrid lane; as
   * multipliers after the judgment they undid it).
   */
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
  /** Retrieval score, for rerankers that nudge instead of replace. */
  score?: number;
}

/** @experimental Part of the `Reranker` seam; may change before 1.0. */
export interface RerankRequest<C extends RerankCandidate = RerankCandidate> {
  query: string;
  /** Candidates in retrieval order. The reranker returns the same set, reordered. */
  candidates: readonly C[];
  /** The lane the candidates came from; absent for a cross-source union. */
  mode?: SearchMode;
  /** Fires when the caller's deadline passes; forward it to any HTTP call. */
  signal?: AbortSignal;
}

/**
 * One reranked candidate with the reranker's own score (a probability for jev).
 *
 * @experimental Part of the `Reranker` seam; may change before 1.0.
 */
export interface Ranked<C extends RerankCandidate = RerankCandidate> {
  item: C;
  score: number;
}

/**
 * Orders one query's candidates by relevance judgment. Inside hybridSearch it
 * runs after fusion and before truncation, and the lifecycle factors (draft,
 * historical, recency, `generated_from`) and `supersedes` demotion still apply
 * after it — a reranker decides what answers the query, the brain's metadata
 * then nudges that order. A fan-out over several sources runs it once over the
 * union (per-source reranking then fusing is not comparable: a Choice's
 * probabilities normalise within one call).
 *
 * Contract: return every candidate exactly once, by reference. Throwing (or
 * missing the caller's deadline) is a degraded mode, not a failure — search
 * keeps the retrieval order and reports it in `warnings`.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface Reranker {
  /** Stable identity including the pinned model, e.g. "jev:jev-1.13.0". */
  id: string;
  capabilities: {
    /** Lanes this reranker serves; search skips it on the others. */
    modes: readonly SearchMode[];
    /**
     * True when candidates leave the machine. Callers then withhold the paths
     * matched by `reranker.exclude` and re-merge them at their retrieval rank,
     * so a network reranker never sees them.
     */
    network: boolean;
  };
  rerank<C extends RerankCandidate>(req: RerankRequest<C>): Promise<Ranked<C>[]>;
  /**
   * The exact request `rerank` would transmit, for privacy inspection
   * (`brain search --rerank-dry-run`). Must not send anything.
   */
  preview?<C extends RerankCandidate>(req: Omit<RerankRequest<C>, "signal">): unknown;
}

/** A skill as discovered from a skills/ directory. */
export interface SkillManifest {
  /** Directory name == skill name. */
  name: string;
  description: string;
  /** Absolute path to the skill directory (contains SKILL.md). */
  dir: string;
  /** Origin layer, for precedence reporting. */
  source: "core" | "module" | "local";
  /** Raw frontmatter for emitters that need extra keys. */
  frontmatter: Record<string, unknown>;
}

/**
 * Emits skills and agent instructions into the locations an agent reads. The
 * canonical skills home is `.agents/skills/`, discovered natively by Codex
 * and Gemini. Claude and pi use symlinks in `.claude/skills/` and `.pi/skills/`.
 * Codex and Gemini embed the installed agent contract in AGENTS.md and
 * GEMINI.md, respectively.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface SkillEmitter {
  agent: string;
  emit(
    skills: SkillManifest[],
    repoRoot: string
  ): {
    written: string[];
    removed: string[];
    /** Things the emitter deliberately left alone and the user should know about. */
    warnings?: string[];
  };
}

// ---------------------------------------------------------------------------
// Typed authoring helpers — identity functions that give contributors
// inference + excess-property checking without importing the interface.
// ---------------------------------------------------------------------------

export function defineEmbeddingProvider(provider: EmbeddingProvider): EmbeddingProvider {
  return provider;
}

export function defineCompletionProvider(provider: CompletionProvider): CompletionProvider {
  return provider;
}

export function defineAgentRunner(runner: AgentRunner): AgentRunner {
  return runner;
}

export function defineSkillEmitter(emitter: SkillEmitter): SkillEmitter {
  return emitter;
}

export function defineReranker(reranker: Reranker): Reranker {
  return reranker;
}

// ---------------------------------------------------------------------------
// External compute (docs/decisions/external-compute.md). Appended after the
// helpers above so existing citations into this file keep their lines.
// ---------------------------------------------------------------------------

/**
 * JSON a provider may keep on a sandbox or command reference. The host stores
 * it verbatim in the job record and hands it back unchanged.
 *
 * @experimental Part of the `ComputeProvider` seam; may change before 1.0.
 */
export type ComputeJsonValue =
  | null
  | boolean
  | number
  | string
  | ComputeJsonValue[]
  | { [key: string]: ComputeJsonValue };

/**
 * The stable refusal codes. A refusal is not a job state: it returns before
 * any effect. A provider uses one only to report a vendor refusal it could
 * prove left nothing behind.
 *
 * @experimental Part of the `ComputeProvider` seam; may change before 1.0.
 */
export type ComputeRefusalCode =
  | "compute_disabled"
  | "provider_unknown"
  | "provider_unavailable"
  | "capability_unsupported"
  | "lease_required"
  | "policy_denied"
  | "approval_required"
  | "source_refused"
  | "budget_exceeded"
  | "concurrency_exhausted"
  | "accounting_unavailable"
  | "job_unknown";

/**
 * What a provider can honour. Core reads it before any effect and refuses a
 * job that needs more with `capability_unsupported`.
 *
 * @experimental Part of the `ComputeProvider` seam; may change before 1.0.
 */
export interface ComputeCapabilities {
  /** The only workload kind in this slice. */
  commands: true;
  /** Commands outlive one request. */
  detached: boolean;
  /** `allocate` honours `AllocationKey`: a repeated key returns the same sandbox. */
  idempotentAllocate: boolean;
  /** `find` can locate a lost allocation by its key. */
  findByKey: boolean;
  stage: { maxBytes: number } | false;
  collect: { maxBytes: number } | false;
  /** `release("retain")` keeps data for up to this long. */
  retain: { maxSeconds: number } | false;
  /** Provider-side lease ceiling. */
  maxLeaseSeconds: number;
  /** The provider enforces its own auto-stop (`AllocateRequest.remoteExpirySeconds`). */
  remoteExpiry: boolean;
  usage: "actual" | "none";
}

/**
 * Where a provider writes diagnostics. The host's logger redacts the
 * instance's secret from every message and value.
 *
 * @experimental Part of the `ComputeProvider` seam; may change before 1.0.
 */
export interface ComputeLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

/**
 * One provider call's context, built by the host per call and per provider
 * instance: two instances of one implementation never share options or a
 * secret.
 *
 * @experimental Part of the `ComputeProvider` seam; may change before 1.0.
 */
export interface ComputeContext {
  /** The configured instance id (`compute.providers` key). */
  instanceId: string;
  /** The instance's `options`, as the provider's `configSchema` parsed them. */
  options: unknown;
  /** The instance credential, resolved on the trusted host. Never forward it into a sandbox. */
  secret?: string;
  /** Aborts when the call's deadline passes or the host cancels. */
  signal: AbortSignal;
  /** Epoch milliseconds by the host clock: the lease deadline or the call timeout, whichever is earlier. */
  deadline: number;
  /** The transport to use; tests replace it. */
  fetch: typeof fetch;
  log: ComputeLogger;
}

/**
 * The idempotency key the host derives from the job id and writes durably
 * before it calls `allocate`.
 *
 * @experimental Part of the `ComputeProvider` seam; may change before 1.0.
 */
export type AllocationKey = string;

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export interface SandboxRef {
  /** The provider's id for the sandbox. Never shown to a caller as a job id. */
  id: string;
  data?: ComputeJsonValue;
}

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export interface CommandHandle {
  sandbox: SandboxRef;
  id: string;
  data?: ComputeJsonValue;
}

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export interface AllocateRequest {
  key: AllocationKey;
  /** The host lease. The host stays authoritative for it. */
  leaseSeconds: number;
  /** Set only for `remoteExpiry` providers: auto-stop no later than this many seconds from now. */
  remoteExpirySeconds?: number;
  /** The job may ask for `release("retain")`. */
  retain: boolean;
}

/**
 * The declared source: repository-relative files, already resolved, checked
 * and hashed by the host. An empty bundle is valid.
 *
 * @experimental Part of the `ComputeProvider` seam; may change before 1.0.
 */
export interface SourceBundle {
  files: { path: string; sha256: string; bytes: number; read(): Promise<Uint8Array> }[];
  /** The manifest hash recorded on the job. */
  hash: string;
}

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export interface CommandSpec {
  argv: string[];
  /** Relative to the staged source root. */
  cwd?: string;
  /** The explicit allowlist of non-secret values. Nothing else reaches the sandbox. */
  env: Record<string, string>;
}

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export interface ArtifactRequest {
  paths: { path: string; maxBytes: number }[];
}

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export interface CostObservation {
  /** Unknown is `null`, never zero. */
  usd: number | null;
  seconds: number | null;
  coverage: "complete" | "partial" | "unknown";
}

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export type ComputeHealth = { kind: "ok"; detail?: string } | { kind: "unavailable"; reason: string };

/**
 * A vendor refusal that provably left nothing behind.
 *
 * @experimental Part of the `ComputeProvider` seam; may change before 1.0.
 */
export interface ComputeRefused {
  kind: "refused";
  code: ComputeRefusalCode;
  reason: string;
}

/**
 * The effect did not happen.
 *
 * @experimental Part of the `ComputeProvider` seam; may change before 1.0.
 */
export interface ComputeFailed {
  kind: "failed";
  reason: string;
}

/**
 * The effect happened or may have happened and its outcome is unknown, such
 * as a lost response. Never a guessed success or failure.
 *
 * @experimental Part of the `ComputeProvider` seam; may change before 1.0.
 */
export interface ComputeUncertain {
  kind: "uncertain";
  reason: string;
}

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export type AllocateOutcome = { kind: "ok"; sandbox: SandboxRef } | ComputeRefused | ComputeFailed | ComputeUncertain;

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export type FindOutcome = { kind: "ok"; sandbox: SandboxRef } | { kind: "not_found" } | ComputeFailed | ComputeUncertain;

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export type StageOutcome = { kind: "ok" } | ComputeRefused | ComputeFailed | ComputeUncertain;

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export type ExecOutcome = { kind: "ok"; handle: CommandHandle } | ComputeRefused | ComputeFailed | ComputeUncertain;

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export type ComputeExitReason = "exited" | "signal" | "oom" | "provider_error" | "killed";

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export type CommandStatus =
  | { kind: "running" }
  | {
      kind: "exited";
      /** The command's exit code, kept as reported; `null` when it ended without one. */
      code: number | null;
      signal: string | null;
      reason: ComputeExitReason;
      /** Bounded output, when the provider has it. */
      stdout?: string;
      stderr?: string;
      truncated?: boolean;
    }
  | ComputeFailed
  | ComputeUncertain;

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export type KillOutcome = { kind: "ok" } | ComputeFailed | ComputeUncertain;

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export type CollectedArtifact =
  | { path: string; status: "collected"; data: Uint8Array }
  | { path: string; status: "missing" }
  | { path: string; status: "too_large"; bytes?: number };

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export type CollectOutcome = { kind: "ok"; artifacts: CollectedArtifact[] } | ComputeRefused | ComputeFailed | ComputeUncertain;

/** @experimental Part of the `ComputeProvider` seam; may change before 1.0. */
export type ReleaseOutcome =
  | { kind: "released" }
  /** Data kept until this epoch-millisecond deadline. */
  | { kind: "retained"; until: number }
  | ComputeFailed
  | ComputeUncertain;

/**
 * A job's cost. Unknown is `null` with a coverage marker, never zero.
 *
 * @experimental Part of the `ComputeProvider` seam; may change before 1.0.
 */
export interface JobCost {
  estimate: { usd: number | null; basis: "ceiling" | "none" };
  actual: { usd: number | null; coverage: "complete" | "partial" | "unknown"; source: "provider" | "none" };
}

/**
 * What an implementation's `configSchema` must offer: a zod schema satisfies
 * it. It validates the instance's `options`.
 *
 * @experimental Part of the `ComputeProvider` seam; may change before 1.0.
 */
export interface ComputeOptionsSchema {
  safeParse(input: unknown): { success: true; data?: unknown } | { success: false; error?: { message: string } };
}

/**
 * External compute: allocates a disposable sandbox, runs commands in it,
 * returns results and releases it. It runs no model and holds no
 * conversation. The host owns the job, its lease, admission and recovery;
 * the provider maps vendor transport only. Every method returns a typed
 * outcome rather than throwing for expected vendor states, and a transport
 * failure whose effect is unknown is `{ kind: "uncertain" }`. Optional methods
 * exist exactly when the matching capability says so.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface ComputeProvider {
  /** Implementation id, e.g. `boat`. */
  readonly id: string;
  readonly capabilities: ComputeCapabilities;
  /** Validates the instance `options`. */
  configSchema?: ComputeOptionsSchema;
  /** Reports readiness. Allocates nothing. */
  health(ctx: ComputeContext): Promise<ComputeHealth>;
  allocate(req: AllocateRequest, ctx: ComputeContext): Promise<AllocateOutcome>;
  /** Present iff `capabilities.findByKey`. */
  find?(key: AllocationKey, ctx: ComputeContext): Promise<FindOutcome>;
  /** Present iff `capabilities.stage`. */
  stage?(sandbox: SandboxRef, source: SourceBundle, ctx: ComputeContext): Promise<StageOutcome>;
  exec(sandbox: SandboxRef, command: CommandSpec, ctx: ComputeContext): Promise<ExecOutcome>;
  poll(handle: CommandHandle, ctx: ComputeContext): Promise<CommandStatus>;
  kill(handle: CommandHandle, ctx: ComputeContext): Promise<KillOutcome>;
  /** Present iff `capabilities.collect`. */
  collect?(sandbox: SandboxRef, request: ArtifactRequest, ctx: ComputeContext): Promise<CollectOutcome>;
  /** Releasing an already released sandbox is not an error. */
  release(sandbox: SandboxRef, mode: "discard" | "retain", ctx: ComputeContext): Promise<ReleaseOutcome>;
  /** Present iff `capabilities.usage` is `actual`. */
  usage?(sandbox: SandboxRef, ctx: ComputeContext): Promise<CostObservation>;
}

export function defineComputeProvider(provider: ComputeProvider): ComputeProvider {
  return provider;
}
