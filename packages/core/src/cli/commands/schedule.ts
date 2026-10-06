/**
 * `brain schedule` — the authenticated host's scheduled-task consumer (#914).
 *
 * Every subcommand talks to one UI host over HTTP. There is no local store,
 * database, runner or offline fallback: definitions and their approvals are
 * host-owned, and creating a schedule never executes it. `due` is read-only.
 * Contract: docs/integration-contract.md#scheduled-tasks-additive-914.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { z } from "zod";

import { emit, parseArgs, UsageError, type Flags } from "../io.js";
import { credentialCookie, HostResponseTooLargeError, hostFetch, readBoundedJson, serverOrigin } from "../host-client.js";
import type { CoreCommand } from "../types.js";

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_SCOPE_FILE_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// Response schemas: the CLI verifies every envelope before reporting success.
// ---------------------------------------------------------------------------

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const id = z.string().regex(KEY);
const jsonScalar = z.union([z.null(), z.boolean(), z.string(), z.number()]);
const definition = z.strictObject({
  prompt: z.string(),
  when: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("at"), at: iso, timeZone: z.string() }),
    z.strictObject({ kind: z.literal("cron"), cron: z.string(), timeZone: z.string(), endAt: iso.nullable() }),
  ]),
  scope: z.strictObject({
    operation: z.string(),
    tools: z.array(z.strictObject({ name: z.string(), inputs: z.record(z.string(), z.unknown()) })),
    targets: z.array(z.string()),
    egress: z.array(z.string()),
    variableInputs: z.array(z.strictObject({ pointer: z.string(), bound: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("enum"), values: z.array(jsonScalar) }),
      z.strictObject({ kind: z.literal("string"), maxBytes: z.number().int() }),
      z.strictObject({ kind: z.literal("number"), min: z.number(), max: z.number() }),
    ]) })),
  }),
  limits: z.strictObject({ attemptTimeoutMs: z.number().int(), maxOperations: z.number().int() }),
  notifyOnSuccess: z.boolean(),
});
const occurrenceState = z.enum(["queued", "running", "unwinding", "waiting_for_action", "retrying",
  "completed", "failed", "cancelled", "expired", "unknown"]);
const blockedReason = z.enum(["dispatch_disabled", "budget_disabled", "capacity", "authority_unusable",
  "definition_drift", "backend_unavailable", "unknown_effect", "occurrence_limit", "restore_pending"]);
const occurrence = z.strictObject({
  id, taskId: id, dueAt: iso, expiresAt: iso, state: occurrenceState,
  operationsUsed: z.number().int().min(0).max(3), maxOperations: z.number().int().min(1).max(3),
  runIds: z.array(z.string()).max(3),
  result: z.strictObject({ state: z.enum(["available", "pruned", "unavailable"]), text: z.string().nullable() })
    .refine((r) => (r.state === "available") === (r.text !== null)),
});
const task = z.strictObject({
  id, definition, creatorPrincipalId: z.string().min(1), createdAt: iso,
  zoneSource: z.enum(["explicit", "client", "utc_fallback"]),
  state: z.enum(["publishing", "active", "paused", "cancelled", "completed", "failed", "expired"]),
  executionAvailable: z.boolean(), blockedReason: blockedReason.nullable(),
  nextDueAt: iso.nullable(), lastOccurrence: occurrence.nullable(), compensationPending: z.boolean(),
});
const proposal = z.strictObject({
  id, taskId: id, key: id, definition,
  zoneSource: z.enum(["explicit", "client", "utc_fallback"]),
  executionPolicy: z.strictObject({ backendId: z.string(), profileId: z.string().nullable(), inferenceOrigins: z.array(z.string()) }),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: iso, approvalState: z.enum(["pending", "approved"]),
});
const cursor = z.string().min(1).max(1024).nullable();
const schemas = {
  proposal: z.strictObject({ ok: z.literal(true), proposal }),
  approval: z.strictObject({ ok: z.literal(true), approvalId: id }),
  add: z.strictObject({ ok: z.literal(true), created: z.boolean(), task }),
  list: z.strictObject({ ok: z.literal(true), tasks: z.array(task), nextCursor: cursor }),
  cancel: z.strictObject({ ok: z.literal(true), changed: z.boolean(), task,
    runningOccurrences: z.array(occurrence).max(1) }),
  reconcile: z.strictObject({ ok: z.literal(true), changed: z.boolean(), task }),
  due: z.strictObject({ ok: z.literal(true), evaluatedAt: iso, nextCursor: cursor, due: z.array(z.strictObject({
    taskId: id, occurrenceId: id, dueAt: iso, expiresAt: iso, admittable: z.boolean(), blockedReason: blockedReason.nullable(),
  })) }),
};
const ERROR_CODES = ["invalid_request", "invalid_cursor", "unauthorized", "not_found", "key_conflict",
  "approval_required", "approval_expired", "definition_conflict", "server_unavailable", "unsupported_capability"] as const;
const errorSchema = z.strictObject({ ok: z.literal(false),
  error: z.strictObject({ code: z.enum(ERROR_CODES), message: z.string().max(1024) }) });

/** Exit 1: validation, auth, conflict, not found. Exit 2: unavailable or unverifiable. */
const EXIT_TWO = new Set(["server_unavailable", "unsupported_capability", "invalid_response"]);

class ScheduleCliError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

// ---------------------------------------------------------------------------
// Argument handling
// ---------------------------------------------------------------------------

const COMMON = ["server", "credential-file", "json", "human", "root"];
const ALLOWED: Record<string, string[]> = {
  add: [...COMMON, "key", "prompt", "at", "cron", "time-zone", "client-time-zone", "end-at", "scope-file",
    "attempt-timeout-ms", "max-operations", "notify-success", "approve"],
  list: [...COMMON, "id", "state", "limit", "cursor"],
  cancel: [...COMMON, "key"],
  reconcile: [...COMMON, "key"],
  due: [...COMMON, "limit", "cursor"],
};
const BOOLEAN = new Set(["json", "human", "notify-success", "approve"]);

function strictFlags(verb: string, flags: Flags): Record<string, string | undefined> {
  const allowed = ALLOWED[verb]!;
  const values: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(flags)) {
    if (!allowed.includes(key)) throw new UsageError(`Unsupported schedule ${verb} flag: --${key}`);
    if (BOOLEAN.has(key)) continue;
    if (typeof value !== "string") throw new UsageError(`--${key} needs a value`);
    values[key] = value;
  }
  return values;
}

function positiveInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new UsageError(`--${name} must be a positive integer`);
  return Number(value);
}

/** The scope file is a strict, private-or-not regular file that grants nothing. */
async function readScopeFile(path: string): Promise<unknown> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new UsageError("--scope-file must be a readable regular file (symlinks are refused)"); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SCOPE_FILE_BYTES) throw new UsageError(`--scope-file must be a regular file of at most ${MAX_SCOPE_FILE_BYTES} bytes`);
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_SCOPE_FILE_BYTES) throw new UsageError(`--scope-file must be at most ${MAX_SCOPE_FILE_BYTES} bytes`);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new UsageError("--scope-file is not valid UTF-8"); }
    try {
      const scope = JSON.parse(text) as unknown;
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new Error("not an object");
      return scope;
    } catch { throw new UsageError("--scope-file must contain one JSON scope object"); }
  } finally { await handle.close(); }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface Host { origin: string; cookie?: string }

async function call<T>(host: Host, method: "GET" | "POST", path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  let response: Response;
  try { response = await hostFetch(host.origin, path, { method, cookie: host.cookie, body }); }
  catch { throw new ScheduleCliError("server_unavailable", "Schedule host unavailable; retry with the same --key."); }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new ScheduleCliError("invalid_response", "Schedule host answered with a redirect; it was not followed.");
  }
  let payload: unknown;
  try { payload = await readBoundedJson(response, MAX_RESPONSE_BYTES); }
  catch (error) {
    if (response.status === 401 || response.status === 403) throw new ScheduleCliError("unauthorized", "Schedule host refused this credential.");
    if (response.status >= 500 && !(error instanceof HostResponseTooLargeError)) throw new ScheduleCliError("server_unavailable", "Schedule host unavailable; retry with the same --key.");
    throw new ScheduleCliError("invalid_response", "Schedule host returned an invalid response; retry with the same --key.");
  }
  if (response.ok) {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new ScheduleCliError("invalid_response", "Schedule host returned an invalid response; retry with the same --key.");
    return parsed.data;
  }
  const failure = errorSchema.safeParse(payload);
  if (failure.success) throw new ScheduleCliError(failure.data.error.code, failure.data.error.message);
  if (response.status === 401 || response.status === 403) throw new ScheduleCliError("unauthorized", "Schedule host refused this credential.");
  if (response.status >= 500) throw new ScheduleCliError("server_unavailable", "Schedule host unavailable; retry with the same --key.");
  throw new ScheduleCliError("invalid_response", "Schedule host returned an invalid response; retry with the same --key.");
}

function query(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}

// ---------------------------------------------------------------------------
// Operator review
// ---------------------------------------------------------------------------

/**
 * Show the entire materialized envelope and require an affirmative answer on
 * an interactive terminal. Review happens on stderr so JSON mode still emits
 * exactly one result on stdout. This is usability; the host's operator
 * credential check is the authority.
 */
async function confirmApproval(review: z.infer<typeof proposal>): Promise<boolean> {
  return confirm([
    "Review this scheduled task before approving it.",
    "It will run without you, within exactly this envelope, until cancelled or ended.",
    JSON.stringify({ taskId: review.taskId, definition: review.definition, zoneSource: review.zoneSource,
      executionPolicy: review.executionPolicy }, null, 2),
    `Fingerprint: ${review.fingerprint}`,
    "Type \"approve\" to grant it, anything else to stop: ",
  ], "approve");
}

/** The operator states that the restore or unknown effect was investigated. */
async function confirmReconciliation(current: z.infer<typeof task>): Promise<boolean> {
  return confirm([
    `Scheduled task ${current.id} is ${current.state}${current.blockedReason ? ` (${current.blockedReason})` : ""}.`,
    "Reopening it lets future occurrences run again within the approved envelope below.",
    "Only reopen it once you have checked what its last occurrence actually did:",
    "an unknown occurrence is never replayed, and reopening does not undo or confirm it.",
    JSON.stringify({ definition: current.definition, lastOccurrence: current.lastOccurrence }, null, 2),
    "Type \"reopen\" to reopen it, anything else to stop: ",
  ], "reopen");
}

async function confirm(lines: string[], word: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  process.stderr.write(lines.join("\n"));
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.once("line", resolve);
      rl.once("close", () => resolve(""));
    });
    return answer.trim() === word;
  } finally { rl.close(); }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function add(host: Host, values: Record<string, string | undefined>, flags: Flags) {
  const key = values.key, prompt = values.prompt;
  if (!key || !KEY.test(key)) throw new UsageError("--key must be a 1–128 character key (letters, digits, . _ : -)");
  if (prompt === undefined) throw new UsageError("--prompt is required");
  if ((values.at === undefined) === (values.cron === undefined)) throw new UsageError("Give exactly one of --at or --cron");
  if (values["end-at"] !== undefined && values.cron === undefined) throw new UsageError("--end-at is accepted only with --cron");
  if (!values["scope-file"]) throw new UsageError("--scope-file is required");
  const scope = await readScopeFile(values["scope-file"]);
  const attemptTimeoutMs = positiveInteger("attempt-timeout-ms", values["attempt-timeout-ms"]);
  const maxOperations = positiveInteger("max-operations", values["max-operations"]);
  const timeZone = values["time-zone"] !== undefined ? { timeZone: values["time-zone"] } : {};
  const when = values.at !== undefined
    ? { kind: "at", at: values.at, ...timeZone }
    : { kind: "cron", cron: values.cron, ...timeZone, ...(values["end-at"] !== undefined ? { endAt: values["end-at"] } : {}) };
  // Limits are reviewed as one object; a missing half takes its default.
  const limits = attemptTimeoutMs !== undefined || maxOperations !== undefined
    ? { limits: { attemptTimeoutMs: attemptTimeoutMs ?? 600_000, maxOperations: maxOperations ?? 3 } } : {};
  const definitionInput = { prompt, when, scope, ...limits, ...(flags["notify-success"] === true ? { notifyOnSuccess: true } : {}) };
  const proposed = await call(host, "POST", "/api/schedules/proposals", schemas.proposal, {
    key, definition: definitionInput,
    ...(values["client-time-zone"] !== undefined ? { clientTimeZone: values["client-time-zone"] } : {}),
  });
  const review = proposed.proposal;
  let approvalId: string | undefined;
  if (review.approvalState === "pending") {
    if (flags.approve !== true || !(await confirmApproval(review))) {
      throw new ScheduleCliError("approval_required",
        `Review the stored schedule proposal ${review.id} before creation; rerun with --approve on an operator terminal.`);
    }
    approvalId = (await call(host, "POST", `/api/schedules/proposals/${encodeURIComponent(review.id)}/approve`, schemas.approval,
      { fingerprint: review.fingerprint, decision: "approve" })).approvalId;
  }
  return call(host, "POST", "/api/schedules", schemas.add, { proposalId: review.id, ...(approvalId ? { approvalId } : {}) });
}

export const scheduleCommand: CoreCommand = {
  summary: "Manage scheduled tasks on a UI host (no local runner)",
  helpBlock: [
    "  brain schedule add --server ORIGIN [--credential-file FILE] --key KEY --prompt TEXT (--at ISO|--cron EXPR)",
    "      [--time-zone ZONE] [--client-time-zone ZONE] [--end-at ISO] --scope-file FILE",
    "      [--attempt-timeout-ms N] [--max-operations N] [--notify-success] [--approve] [--json]",
    "  brain schedule list --server ORIGIN [--credential-file FILE] [--id ID] [--state STATE] [--limit N] [--cursor CURSOR] [--json]",
    "  brain schedule cancel ID --server ORIGIN [--credential-file FILE] --key KEY [--json]",
    "  brain schedule reconcile ID --server ORIGIN [--credential-file FILE] --key KEY [--json]",
    "  brain schedule due --server ORIGIN [--credential-file FILE] [--limit N] [--cursor CURSOR] [--json]",
  ].join("\n"),
  async run(rest, cli) {
    const fail = (code: string, message: string) => {
      emit(cli.json, { ok: false, error: { code, message } }, () => console.error(message));
      return EXIT_TWO.has(code) ? 2 : 1;
    };
    try {
      const { args, flags } = parseArgs(rest);
      const [verb, ...positional] = args;
      if (!verb || !Object.hasOwn(ALLOWED, verb)) throw new UsageError("Usage: brain schedule add|list|cancel|reconcile|due --server ORIGIN ...");
      const values = strictFlags(verb, flags);
      if (!values.server) throw new UsageError("--server is required");
      const host: Host = { origin: serverOrigin(values.server) };
      if (values["credential-file"] !== undefined) {
        try { host.cookie = await credentialCookie(values["credential-file"], host.origin); }
        catch { return fail("credential_file_invalid", "Schedule credential file is invalid, not private, or belongs to another server."); }
      }
      switch (verb) {
        case "add": {
          if (positional.length) throw new UsageError("schedule add takes no positional arguments");
          const result = await add(host, values, flags);
          emit(cli.json, result, () => console.log(
            `${result.created ? "Created" : "Already created"} scheduled task ${result.task.id} (${result.task.state}). ` +
            (result.task.executionAvailable ? "Execution is available." : `Nothing runs yet: ${result.task.blockedReason ?? result.task.state}.`)));
          return 0;
        }
        case "list": {
          if (positional.length) throw new UsageError("schedule list takes no positional arguments");
          if (values.limit !== undefined) positiveInteger("limit", values.limit);
          const result = await call(host, "GET", `/api/schedules${query({ id: values.id, state: values.state, limit: values.limit, cursor: values.cursor })}`, schemas.list);
          emit(cli.json, result, () => {
            if (result.tasks.length === 0) console.log("No scheduled tasks.");
            for (const t of result.tasks) console.log(`${t.id}  ${t.state}  next ${t.nextDueAt ?? "-"}  ${t.definition.scope.operation}`);
            if (result.nextCursor) console.log(`More: --cursor ${result.nextCursor}`);
          });
          return 0;
        }
        case "cancel": {
          if (positional.length !== 1 || !KEY.test(positional[0]!)) throw new UsageError("Usage: brain schedule cancel ID --key KEY");
          if (!values.key || !KEY.test(values.key)) throw new UsageError("--key must be a 1–128 character key (letters, digits, . _ : -)");
          const result = await call(host, "POST", `/api/schedules/${encodeURIComponent(positional[0]!)}/cancel`, schemas.cancel, { key: values.key });
          emit(cli.json, result, () => {
            console.log(`${result.changed ? "Cancelled" : "Already cancelled or finished:"} ${result.task.id} (${result.task.state}). Future and unstarted work will not run.`);
            if (result.runningOccurrences.length) console.log("An attempt that already started keeps running within its limits; cancellation does not stop or undo it.");
            if (result.task.compensationPending) console.log("Retiring the definition file is still pending on the host.");
          });
          return 0;
        }
        case "reconcile": {
          if (positional.length !== 1 || !KEY.test(positional[0]!)) throw new UsageError("Usage: brain schedule reconcile ID --key KEY");
          if (!values.key || !KEY.test(values.key)) throw new UsageError("--key must be a 1–128 character key (letters, digits, . _ : -)");
          const [current] = (await call(host, "GET", `/api/schedules${query({ id: positional[0] })}`, schemas.list)).tasks;
          if (!current) throw new ScheduleCliError("not_found", "No such scheduled task.");
          if (!(await confirmReconciliation(current)))
            throw new ScheduleCliError("approval_required", `Reconciling ${current.id} needs confirmation on an operator terminal.`);
          const result = await call(host, "POST", `/api/schedules/${encodeURIComponent(current.id)}/reconcile`, schemas.reconcile,
            { key: values.key, decision: "reopen" });
          emit(cli.json, result, () => console.log(result.changed
            ? `Reopened ${result.task.id} (${result.task.state}).`
            : `Nothing to reconcile: ${result.task.id} is ${result.task.state}${result.task.blockedReason ? ` (${result.task.blockedReason})` : ""}.`));
          return 0;
        }
        case "due": {
          if (positional.length) throw new UsageError("schedule due takes no positional arguments");
          if (values.limit !== undefined) positiveInteger("limit", values.limit);
          const result = await call(host, "GET", `/api/schedules/due${query({ limit: values.limit, cursor: values.cursor })}`, schemas.due);
          emit(cli.json, result, () => {
            if (result.due.length === 0) console.log(`Nothing is due at ${result.evaluatedAt}.`);
            for (const d of result.due) console.log(`${d.taskId}  due ${d.dueAt}  ${d.admittable ? "admittable" : `blocked: ${d.blockedReason}`}`);
            if (result.nextCursor) console.log(`More: --cursor ${result.nextCursor}`);
          });
          return 0;
        }
      }
      return 1;
    } catch (error) {
      if (error instanceof UsageError) return fail("invalid_request", error.message);
      if (error instanceof ScheduleCliError) return fail(error.code, error.message);
      throw error;
    }
  },
};
