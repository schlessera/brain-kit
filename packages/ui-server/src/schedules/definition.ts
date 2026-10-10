/**
 * Schedule definitions: the strict request shape, host materialization, the
 * supported-tool registry and the Markdown definition file.
 *
 * Every rule here follows the scheduled-task contract
 * (docs/integration-contract.md#scheduled-tasks-additive-914). Nothing in a definition
 * carries authority: creator, approval and control state live in the
 * operational ledger.
 */
import { z } from "zod";

import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { canonicalJson } from "./canonical.js";
import { canonicalTimeZone, isoInstant, parseCron, parseInstant, ScheduleTimeError } from "./time.js";

export const SCHEDULE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DEFAULT_LIMITS = Object.freeze({ attemptTimeoutMs: 600_000, maxOperations: 3 });
export const MAX_DEFINITION_FILE_BYTES = 32 * 1024;
export const DEFINITIONS_DIR = "context/scheduled-tasks/definitions";
export const RETIRED_DIR = "context/scheduled-tasks/retired";

const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_SCOPE_BYTES = 8 * 1024;
const MAX_OPERATION_BYTES = 256;
const MAX_PATH_BYTES = 256;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_ARRAY = 32;
const MAX_JSON_KEYS = 32;
// C0/C1 controls. Text fields may keep LF and TAB; identifiers keep nothing.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const TEXT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class ScheduleValidationError extends Error {}

export type JsonScalar = null | boolean | string | number;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const jsonScalar = z.union([z.null(), z.boolean(), z.string(), z.number()]);
const bound = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("enum"), values: z.array(jsonScalar).min(1).max(32) }),
  z.strictObject({ kind: z.literal("string"), maxBytes: z.number().int().positive().max(16_384) }),
  z.strictObject({ kind: z.literal("number"), min: z.number(), max: z.number() }),
]);
const scopeSchema = z.strictObject({
  operation: z.string(),
  tools: z.array(z.strictObject({ name: z.string(), inputs: z.record(z.string(), z.unknown()) })).min(1).max(16),
  targets: z.array(z.string()).max(32),
  egress: z.array(z.string()).max(16),
  variableInputs: z.array(z.strictObject({ pointer: z.string(), bound })).max(32),
});
const limitsSchema = z.strictObject({
  attemptTimeoutMs: z.number().int().positive().max(DEFAULT_LIMITS.attemptTimeoutMs),
  maxOperations: z.number().int().positive().max(DEFAULT_LIMITS.maxOperations),
});
export const scheduleDefinitionInputSchema = z.strictObject({
  prompt: z.string(),
  when: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("at"), at: z.string(), timeZone: z.string().optional() }),
    z.strictObject({ kind: z.literal("cron"), cron: z.string(), timeZone: z.string().optional(),
      endAt: z.string().nullable().optional() }),
  ]),
  scope: scopeSchema,
  limits: limitsSchema.optional(),
  notifyOnSuccess: z.boolean().optional(),
});
export type ScheduleDefinitionInput = z.infer<typeof scheduleDefinitionInputSchema>;
export type ScheduleScope = z.infer<typeof scopeSchema> & { tools: { name: string; inputs: JsonObject }[] };

export type ScheduleWhen =
  | { kind: "at"; at: string; timeZone: string }
  | { kind: "cron"; cron: string; timeZone: string; endAt: string | null };
/** The materialized, reviewed definition consumers see. */
export interface ScheduleDefinition {
  prompt: string;
  when: ScheduleWhen;
  scope: ScheduleScope;
  limits: { attemptTimeoutMs: number; maxOperations: number };
  notifyOnSuccess: boolean;
}
/** The exact stored definition: what the file holds and the fingerprint covers. */
export interface StoredDefinition extends ScheduleDefinition {
  schedule_schema: 1;
  id: string;
}
export type ZoneSource = "explicit" | "client" | "utc_fallback";

// ---------------------------------------------------------------------------
// Supported tools. The host resolves each canonical public name itself; a
// model alias, wildcard or declared allowlist never supplies this mapping.
// `brain_read` mirrors the core MCP tool's registered input schema, which
// packages/core/tests/mcp-input-schemas.json pins; a parity test holds the
// two together.
// ---------------------------------------------------------------------------

interface SupportedTool {
  inputs: z.ZodType<JsonObject>;
  /** Input keys naming a brain-relative path: each must be an approved target. */
  pathInputs: readonly string[];
}
export const SCHEDULE_TOOLS: Readonly<Record<string, SupportedTool>> = Object.freeze({
  brain_read: {
    inputs: z.strictObject({
      path: z.string(),
      section: z.string().optional(),
      max_tokens: z.number().int().positive().optional(),
    }) as unknown as z.ZodType<JsonObject>,
    pathInputs: ["path"],
  },
});

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function fail(message: string): never {
  throw new ScheduleValidationError(message);
}

/** Validate an arbitrary decoded JSON value against the contract's bounds. */
function assertBoundedJson(value: unknown, depth: number, where: string): asserts value is JsonValue {
  if (depth > MAX_JSON_DEPTH) fail(`${where} nests deeper than ${MAX_JSON_DEPTH}`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (TEXT_CONTROL.test(value)) fail(`${where} contains a control character`);
    if (!value.isWellFormed()) fail(`${where} is not well-formed Unicode`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${where} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY) fail(`${where} has more than ${MAX_JSON_ARRAY} members`);
    value.forEach((child, index) => assertBoundedJson(child, depth + 1, `${where}[${index}]`));
    return;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value);
    if (keys.length > MAX_JSON_KEYS) fail(`${where} has more than ${MAX_JSON_KEYS} keys`);
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key) || CONTROL.test(key)) fail(`${where} has a forbidden key`);
      assertBoundedJson((value as Record<string, unknown>)[key], depth + 1, `${where}.${key}`);
    }
    return;
  }
  fail(`${where} is not JSON`);
}

function identifierText(value: string, where: string, maxBytes: number): void {
  if (value.length === 0 || bytes(value) > maxBytes) fail(`${where} must be 1–${maxBytes} bytes`);
  if (CONTROL.test(value)) fail(`${where} contains a control character`);
  if (!value.isWellFormed()) fail(`${where} is not well-formed Unicode`);
}

/** Exact brain-relative target paths only; protected namespaces are refused. */
export function validateTargetPath(path: string): void {
  identifierText(path, "target", MAX_PATH_BYTES);
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path))
    fail("target must be a brain-relative path");
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    fail("target must be a normalized path");
  if (segments.some((segment) => segment.startsWith(".")) || /[*?[\]{}]/.test(path))
    fail("target may not name hidden, wildcard or operational paths");
  const lower = path.toLowerCase();
  if (lower === "brain.db" || lower.startsWith("brain.db-") || lower.startsWith("brain.config") ||
      lower.startsWith("context/scheduled-tasks/") || lower === "context/scheduled-tasks" ||
      lower.startsWith("context/policies/") || lower === "context/policies")
    fail("target names protected configuration, policy or schedule state");
}

function validateOrigin(origin: string): void {
  identifierText(origin, "egress origin", MAX_PATH_BYTES);
  let url: URL;
  try { url = new URL(origin); } catch { fail("egress must be a normalized origin"); }
  if (url!.origin !== origin || url!.protocol !== "https:") fail("egress must be a normalized HTTPS origin");
}

function decodePointer(pointer: string): string[] {
  if (!pointer.startsWith("/")) fail("variable pointer must be a JSON pointer");
  return pointer.slice(1).split("/").map((token) => {
    if (/~[^01]|~$/.test(token)) fail("variable pointer has an invalid escape");
    return token.replaceAll("~1", "/").replaceAll("~0", "~");
  });
}

function validateScope(input: z.infer<typeof scopeSchema>): ScheduleScope {
  identifierText(input.operation, "operation", MAX_OPERATION_BYTES);
  if (input.operation.trim() === "") fail("operation must not be blank");
  const targets = new Set<string>();
  for (const target of input.targets) {
    validateTargetPath(target);
    if (targets.has(target)) fail("duplicate target");
    targets.add(target);
  }
  const origins = new Set<string>();
  for (const origin of input.egress) {
    validateOrigin(origin);
    if (origins.has(origin)) fail("duplicate egress origin");
    origins.add(origin);
  }
  // No supported tool reaches the network, so any tool egress is broader than needed.
  if (origins.size > 0) fail("egress is not supported by the selected tools");
  const seenTools = new Set<string>();
  const tools = input.tools.map((tool, index) => {
    const supported = Object.hasOwn(SCHEDULE_TOOLS, tool.name) ? SCHEDULE_TOOLS[tool.name] : undefined;
    if (!supported) fail(`tool ${index} is not supported for scheduled work`);
    assertBoundedJson(tool.inputs, 1, `tools[${index}].inputs`);
    const parsed = supported!.inputs.safeParse(tool.inputs);
    if (!parsed.success) fail(`tools[${index}].inputs do not match the tool's input schema`);
    for (const key of supported!.pathInputs) {
      const value = (tool.inputs as JsonObject)[key];
      if (typeof value !== "string" || !targets.has(value)) fail(`tools[${index}].inputs.${key} must be an approved target`);
    }
    const identity = canonicalJson({ name: tool.name, inputs: tool.inputs });
    if (seenTools.has(identity)) fail("duplicate tool");
    seenTools.add(identity);
    return { name: tool.name, inputs: tool.inputs as JsonObject };
  });
  const pointers = new Set<string>();
  for (const variable of input.variableInputs) {
    identifierText(variable.pointer, "variable pointer", MAX_PATH_BYTES);
    if (pointers.has(variable.pointer)) fail("duplicate variable pointer");
    pointers.add(variable.pointer);
    const [root, index, inputs, ...path] = decodePointer(variable.pointer);
    const tool = root === "tools" && index !== undefined && /^(0|[1-9]\d*)$/.test(index) ? tools[Number(index)] : undefined;
    if (!tool || inputs !== "inputs" || path.length === 0) fail("variable pointer must name a tool-input leaf");
    if (path.length === 1 && SCHEDULE_TOOLS[tool!.name]!.pathInputs.includes(path[0]!))
      fail("variable pointer may not vary a target path");
    let leaf: JsonValue | undefined = tool!.inputs;
    for (const key of path) {
      leaf = leaf && typeof leaf === "object" && !Array.isArray(leaf) && Object.hasOwn(leaf, key)
        ? (leaf as JsonObject)[key] : Array.isArray(leaf) && /^(0|[1-9]\d*)$/.test(key) ? leaf[Number(key)] : undefined;
    }
    if (leaf === undefined || (leaf !== null && typeof leaf === "object")) fail("variable pointer must name an existing scalar leaf");
    const b = variable.bound;
    if (b.kind === "enum") {
      const values = new Set(b.values.map((value) => canonicalJson(value)));
      if (values.size !== b.values.length) fail("duplicate enum value");
      for (const value of b.values) assertBoundedJson(value, 1, "enum value");
      if (!values.has(canonicalJson(leaf))) fail("approved value must be within its enum bound");
    } else if (b.kind === "string") {
      if (typeof leaf !== "string" || bytes(leaf) > b.maxBytes) fail("approved value must be within its string bound");
    } else {
      if (!Number.isFinite(b.min) || !Number.isFinite(b.max) || b.min > b.max) fail("number bound must be finite and ordered");
      if (typeof leaf !== "number" || leaf < b.min || leaf > b.max) fail("approved value must be within its number bound");
    }
  }
  const scope: ScheduleScope = { operation: input.operation, tools, targets: input.targets,
    egress: input.egress, variableInputs: input.variableInputs };
  if (bytes(canonicalJson(scope)) > MAX_SCOPE_BYTES) fail(`scope exceeds ${MAX_SCOPE_BYTES} bytes`);
  return scope;
}

function validatePrompt(prompt: string): string {
  // CRLF normalizes once, at proposal time; stored text is never repaired later.
  const normalized = prompt.replaceAll("\r\n", "\n");
  if (normalized.trim() === "") fail("prompt must not be blank");
  if (bytes(normalized) > MAX_PROMPT_BYTES) fail(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`);
  if (TEXT_CONTROL.test(normalized)) fail("prompt contains a control character");
  // A lone surrogate cannot be written as UTF-8: the file would never match.
  if (!normalized.isWellFormed()) fail("prompt is not well-formed Unicode");
  return normalized;
}

/** Normalize the caller's input for request-key matching (no clock or zone resolution). */
export function normalizeDefinitionInput(raw: unknown): ScheduleDefinitionInput {
  const parsed = scheduleDefinitionInputSchema.safeParse(raw);
  if (!parsed.success) fail("definition does not match the schedule schema");
  return { ...parsed.data, prompt: validatePrompt(parsed.data.prompt) };
}

/**
 * Materialize a definition at first proposal: resolve the zone, require a
 * future first-create instant, fill defaults and check every bound. Throws
 * ScheduleValidationError.
 */
export function materializeDefinition(input: ScheduleDefinitionInput, options: {
  id: string;
  now: number;
  clientTimeZone?: string;
}): { definition: StoredDefinition; zoneSource: ZoneSource } {
  if (!SCHEDULE_ID.test(options.id)) fail("invalid task id");
  const prompt = validatePrompt(input.prompt);
  const scope = validateScope(input.scope);
  let timeZone: string, zoneSource: ZoneSource;
  if (input.when.timeZone !== undefined) {
    const zone = canonicalTimeZone(input.when.timeZone);
    if (!zone) fail("timeZone is not a valid IANA zone");
    timeZone = zone!; zoneSource = "explicit";
  } else if (options.clientTimeZone !== undefined) {
    const zone = canonicalTimeZone(options.clientTimeZone);
    if (!zone) fail("client time zone is not a valid IANA zone");
    timeZone = zone!; zoneSource = "client";
  } else {
    timeZone = "UTC"; zoneSource = "utc_fallback";
  }
  let when: ScheduleWhen;
  if (input.when.kind === "at") {
    const at = parseInstant(input.when.at);
    if (at === null) fail("at must be an ISO instant with Z or a numeric offset");
    if (at! <= options.now) fail("at must be in the future");
    when = { kind: "at", at: isoInstant(at!), timeZone };
  } else {
    try { parseCron(input.when.cron); } catch (error) {
      if (error instanceof ScheduleTimeError) fail(error.message);
      throw error;
    }
    let endAt: string | null = null;
    if (input.when.endAt !== undefined && input.when.endAt !== null) {
      const end = parseInstant(input.when.endAt);
      if (end === null) fail("endAt must be an ISO instant with Z or a numeric offset");
      if (end! <= options.now) fail("endAt must be in the future");
      endAt = isoInstant(end!);
    }
    when = { kind: "cron", cron: input.when.cron, timeZone, endAt };
  }
  const definition: StoredDefinition = {
    schedule_schema: 1,
    id: options.id,
    prompt,
    when,
    scope,
    limits: input.limits ? { ...input.limits } : { ...DEFAULT_LIMITS },
    notifyOnSuccess: input.notifyOnSuccess ?? false,
  };
  if (bytes(serializeDefinition(definition)) > MAX_DEFINITION_FILE_BYTES)
    fail(`definition file exceeds ${MAX_DEFINITION_FILE_BYTES} bytes`);
  return { definition, zoneSource };
}

/** The consumer view: every field except the file schema marker and id. */
export function publicDefinition(stored: StoredDefinition): ScheduleDefinition {
  const { schedule_schema: _schema, id: _id, ...definition } = stored;
  return definition;
}

const FRONTMATTER_KEYS = ["schedule_schema", "id", "when", "scope", "limits", "notifyOnSuccess"] as const;

/**
 * Deterministic file bytes. Each frontmatter value is JSON, which is valid
 * YAML flow syntax, so no YAML tag, date or anchor can enter a definition.
 */
export function serializeDefinition(definition: StoredDefinition): string {
  const lines = FRONTMATTER_KEYS.map((key) => `${key}: ${canonicalJson(definition[key])}`);
  return `---\n${lines.join("\n")}\n---\n${definition.prompt}`;
}

/** Strictly parse definition-file text. Throws ScheduleValidationError. */
export function parseDefinitionFile(text: string): StoredDefinition {
  if (bytes(text) > MAX_DEFINITION_FILE_BYTES) fail("definition file is too large");
  if (text.includes("\u0000")) fail("definition file contains NUL");
  let parsed;
  try { parsed = parseFrontmatter(text); }
  catch { fail("definition frontmatter is malformed or has duplicate keys"); }
  const data = parsed!.data as Record<string, unknown>;
  const keys = Object.keys(data);
  if (keys.length !== FRONTMATTER_KEYS.length || !FRONTMATTER_KEYS.every((key) => keys.includes(key)))
    fail("definition frontmatter has missing or unknown fields");
  assertBoundedJson(JSON.parse(JSON.stringify(data)) as unknown, 0, "frontmatter");
  // Dates, Buffers or other YAML-typed values do not survive a JSON round trip unchanged.
  try { if (canonicalJson(data) !== canonicalJson(JSON.parse(JSON.stringify(data)))) fail("frontmatter is not JSON data"); }
  catch (error) { if (error instanceof ScheduleValidationError) throw error; fail("frontmatter is not JSON data"); }
  if (data.schedule_schema !== 1 || typeof data.id !== "string" || !SCHEDULE_ID.test(data.id))
    fail("definition schema or id is invalid");
  const stored = { ...data, prompt: parsed!.content } as unknown as StoredDefinition;
  const input = scheduleDefinitionInputSchema.safeParse(publicDefinition(stored));
  if (!input.success) fail("definition does not match the schedule schema");
  validateScope(input.data.scope);
  if (serializeDefinition(stored) !== text) fail("definition file is not in canonical form");
  return stored;
}
