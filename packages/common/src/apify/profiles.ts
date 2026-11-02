/**
 * Qualified Apify batch profiles (#3161,
 * [the contract](../../../../docs/decisions/apify-capability.md#selected-execution-eligibility-and-monetary-enforcement)).
 *
 * A profile is concrete, reviewed integration data for one exact Actor build.
 * It is not an extension seam: profiles are code in this package. A build
 * without one can be discovered, inspected and proposed, never run.
 *
 * A profile qualifies a build only when it can state, from evidence:
 *
 * - the full exact-build input schema, validated in full (no keyword this
 *   module cannot check, no secret field, no connector);
 * - an all-in pay-per-event price list whose platform usage is included and
 *   whose currency cap the platform enforces, with every event priced;
 * - which input fields carry target URLs, and that nothing else does;
 * - which input fields bound the work, mapped to the policy's result limits;
 * - how the build treats its targets: no expansion beyond them, redirects and
 *   site authorization (robots.txt checked by the host before dispatch, or a
 *   written site permission for named origins);
 * - the fixed run options (memory, longest timeout) and output bounds;
 * - a defensible upper bound for everything after the start: status and
 *   result requests, the abort and the remote retention of the run's storage.
 *
 * {@link APIFY_QUALIFIED_PROFILES} is empty: no real build has been measured
 * and qualified. Tests qualify fictional Odysseus builds through the same
 * {@link qualifyProfile} check production profiles must pass.
 */
import { canonicalJson, sha256 } from "./canonical.js";

/** One input-schema property; only the keywords listed in {@link SCHEMA_KEYWORDS} are understood. */
type SchemaNode = Readonly<Record<string, unknown>>;

export interface ApifyProfileTarget {
  /** The top-level input field. */
  readonly field: string;
  /** `url`: one URL string; `url_list`: an array of URL strings; `request_list`: an array of `{ url }` objects. */
  readonly shape: "url" | "url_list" | "request_list";
}

export interface ApifyQualifiedProfile {
  /** `name@revision`; a grant names it exactly. */
  readonly id: string;
  readonly actor_id: string;
  readonly build_number: string;
  /** SHA-256 of the canonical input schema below; must equal the live build's. */
  readonly schema_sha256: string;
  /** SHA-256 of the canonical price list this profile was qualified against; must equal the live Actor's. */
  readonly pricing_sha256: string;
  /** The exact build's input schema, validated in full before every dispatch. */
  readonly input_schema: SchemaNode;
  readonly billing: {
    /** Only all-in pay-per-event builds qualify initially. */
    readonly model: "PAY_PER_EVENT";
    /** Platform usage is paid by the developer and included in the event prices. */
    readonly platform_usage: "included";
    /** The platform's `maxTotalChargeUsd` cap is verified for this build. */
    readonly currency_cap: "verified";
    /** USD per event, every event the build can charge. An unlisted event makes a run's cost unknown. */
    readonly events: Readonly<Record<string, number>>;
    /** The smallest cap Apify accepts for this build, or null when it states none. */
    readonly minimal_max_total_charge_usd: number | null;
  };
  /** The only input fields that may carry a URL. */
  readonly targets: readonly ApifyProfileTarget[];
  /** Integer input fields that bound how many result items the run can produce; each must be set and within `max_result_items`. */
  readonly work_limits: readonly { readonly field: string; readonly limit: "max_result_items" }[];
  readonly site: {
    /** The build fetches exactly its targets: no link following, sitemap or search expansion. */
    readonly expansion: "none";
    /** Redirects it follows stay on the target's origin. */
    readonly redirects: "same_origin";
    /**
     * `robots`: the host checks every target URL against its site's robots.txt
     * before dispatch. `written_permission`: only `permitted_origins`, each with
     * a recorded written yes from the site, may be targeted.
     */
    readonly authorization: "robots" | "written_permission";
    readonly permitted_origins: readonly string[];
  };
  readonly run: { readonly memory_mbytes: number; readonly max_timeout_seconds: number };
  readonly output: { readonly max_item_bytes: number };
  readonly lifecycle: {
    /** USD the account pays for one status, result or abort request. */
    readonly request_usd: number;
    /** USD per GB-day the account pays to keep the run's storage. */
    readonly storage_usd_per_gb_day: number;
    /** How long Apify keeps the run's unnamed storage, in whole days. Local expiry never shortens it. */
    readonly remote_retention_days: number;
    readonly status_requests: number;
    readonly result_requests: number;
    readonly abort_requests: number;
  };
  /** Reads public pages and writes only its own run storage. */
  readonly effects: "read_only";
}

/** No real build is qualified; until one is measured, every Actor can be reviewed and none can run. */
export const APIFY_QUALIFIED_PROFILES: readonly ApifyQualifiedProfile[] = Object.freeze([]);

/** Raised for a profile that cannot be qualified as written. Integration code, never user input. */
export class ApifyProfileError extends Error {
  constructor(message: string) { super(message); this.name = "ApifyProfileError"; }
}
/** Actor input a profile refuses. Carries no remote text. */
export class ApifyProfileInputError extends TypeError {
  constructor(message: string) { super(message); this.name = "ApifyProfileInputError"; }
}

const SCHEMA_KEYWORDS = new Set([
  "title", "description", "type", "editor", "default", "prefill", "example", "sectionCaption", "sectionDescription", "enumTitles",
  "unit", "nullable", "enum", "minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
  "items", "properties", "required", "additionalProperties", "isSecret", "schemaVersion", "placeholderKey", "placeholderValue",
]);
const TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);
const ID = /^[a-z0-9][a-z0-9._@-]{0,127}$/u;
const HEX = /^[0-9a-f]{64}$/u;
const MICROS = 1_000_000;
const GB = 1_000_000_000;

const node = (value: unknown): SchemaNode | null => value && typeof value === "object" && !Array.isArray(value) ? value as SchemaNode : null;
const finite = (value: unknown, min = 0) => typeof value === "number" && Number.isFinite(value) && value >= min;
const integer = (value: unknown, min = 0) => typeof value === "number" && Number.isSafeInteger(value) && value >= min;

/** Every keyword is one this module checks; secret and connector fields never qualify. */
function checkSchema(schema: SchemaNode, path: string): void {
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYWORDS.has(key)) throw new ApifyProfileError(`${path} uses ${key}, which the host cannot validate.`);
  if (schema.isSecret === true) throw new ApifyProfileError(`${path} is a secret field; secrets never leave the host this way.`);
  if (typeof schema.editor === "string" && /proxy|connector|oauth|secret|key-?value|dataset/iu.test(schema.editor))
    throw new ApifyProfileError(`${path} uses the ${schema.editor} editor, which reaches account resources.`);
  const type = schema.type;
  if (path !== "input" && (typeof type !== "string" || !TYPES.has(type))) throw new ApifyProfileError(`${path} has no supported type.`);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") throw new ApifyProfileError(`${path} has an invalid pattern.`);
    try { new RegExp(schema.pattern, "u"); } catch { throw new ApifyProfileError(`${path} has an invalid pattern.`); }
  }
  if (schema.items !== undefined) {
    const items = node(schema.items);
    if (!items) throw new ApifyProfileError(`${path}.items is not a schema.`);
    checkSchema(items, `${path}[]`);
  }
  if (schema.properties !== undefined) {
    const properties = node(schema.properties);
    if (!properties) throw new ApifyProfileError(`${path}.properties is not an object.`);
    for (const [name, child] of Object.entries(properties)) {
      const childNode = node(child);
      if (!childNode) throw new ApifyProfileError(`${path}.${name} is not a schema.`);
      checkSchema(childNode, `${path}.${name}`);
    }
  }
}

/**
 * Throws unless the profile is internally consistent and inside the
 * qualified subset. Production profiles pass this at module load; a profile
 * that fails it can never be selected.
 */
export function qualifyProfile(profile: ApifyQualifiedProfile): ApifyQualifiedProfile {
  if (!ID.test(profile.id) || !/^[A-Za-z0-9]{1,64}$/u.test(profile.actor_id) || !/^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$/u.test(profile.build_number))
    throw new ApifyProfileError("A profile names its id, the immutable Actor id and an exact build number.");
  if (!HEX.test(profile.schema_sha256) || !HEX.test(profile.pricing_sha256)) throw new ApifyProfileError("A profile pins lowercase SHA-256 schema and pricing fingerprints.");
  const schema = node(profile.input_schema);
  if (!schema || schema.type !== "object" || !node(schema.properties)) throw new ApifyProfileError("A profile carries the build's object input schema.");
  if (sha256(canonicalJson(schema)) !== profile.schema_sha256) throw new ApifyProfileError("The profile's schema fingerprint does not match its schema.");
  checkSchema(schema, "input");
  const billing = profile.billing;
  if (billing.model !== "PAY_PER_EVENT" || billing.platform_usage !== "included" || billing.currency_cap !== "verified")
    throw new ApifyProfileError("Only all-in pay-per-event builds with a verified currency cap qualify.");
  const events = Object.entries(billing.events);
  if (!events.length || events.some(([name, price]) => !name || !finite(price))) throw new ApifyProfileError("A profile prices every event the build can charge.");
  if (billing.minimal_max_total_charge_usd !== null && !finite(billing.minimal_max_total_charge_usd)) throw new ApifyProfileError("Invalid minimal charge.");
  const properties = node(schema.properties)!;
  const fieldType = (field: string) => node(properties[field])?.type;
  if (!profile.targets.length) throw new ApifyProfileError("A profile maps the input fields that carry its targets.");
  for (const target of profile.targets) {
    const expected = target.shape === "url" ? "string" : "array";
    if (fieldType(target.field) !== expected) throw new ApifyProfileError(`Target field ${target.field} is not a ${expected} in the schema.`);
  }
  if (!profile.work_limits.length) throw new ApifyProfileError("A profile maps at least one input field that bounds the work.");
  for (const limit of profile.work_limits) {
    if (fieldType(limit.field) !== "integer" || limit.limit !== "max_result_items") throw new ApifyProfileError(`Work limit ${limit.field} must be an integer field mapped to max_result_items.`);
  }
  const site = profile.site;
  if (site.expansion !== "none" || site.redirects !== "same_origin") throw new ApifyProfileError("Only builds that fetch exactly their targets qualify.");
  if (site.authorization === "written_permission") {
    if (!site.permitted_origins.length) throw new ApifyProfileError("A written site permission names its origins.");
    for (const origin of site.permitted_origins) {
      let url: URL;
      try { url = new URL(origin); } catch { throw new ApifyProfileError(`Invalid permitted origin ${origin}.`); }
      if (url.protocol !== "https:" || url.origin !== origin) throw new ApifyProfileError(`Permitted origin ${origin} is not an exact https origin.`);
    }
  } else if (site.authorization !== "robots" || site.permitted_origins.length) throw new ApifyProfileError("Site authorization is robots or a written permission.");
  if (!integer(profile.run.memory_mbytes, 128) || profile.run.memory_mbytes > 32_768 || !integer(profile.run.max_timeout_seconds, 1))
    throw new ApifyProfileError("A profile fixes the run memory (128-32768 MB) and a positive longest timeout.");
  if (!integer(profile.output.max_item_bytes, 1)) throw new ApifyProfileError("A profile bounds one result item's size.");
  const life = profile.lifecycle;
  if (!finite(life.request_usd) || !finite(life.storage_usd_per_gb_day) || !integer(life.remote_retention_days, 1)
    || !integer(life.status_requests, 1) || !integer(life.result_requests, 1) || !integer(life.abort_requests, 1))
    throw new ApifyProfileError("A profile bounds every lifecycle charge: requests, abort and remote retention.");
  if (profile.effects !== "read_only") throw new ApifyProfileError("Only read-only builds qualify.");
  return profile;
}

/** The profile a ticket names, if it still describes exactly that build, schema and price. */
export function profileFor(profiles: readonly ApifyQualifiedProfile[], ticket: { profile_id: string; actor_id: string; build_number: string; schema_sha256: string; pricing_sha256: string }) {
  const profile = profiles.find(entry => entry.id === ticket.profile_id) ?? null;
  if (!profile || profile.actor_id !== ticket.actor_id || profile.build_number !== ticket.build_number
    || profile.schema_sha256 !== ticket.schema_sha256 || profile.pricing_sha256 !== ticket.pricing_sha256) return null;
  return profile;
}

/** Full validation of one value against one schema node. */
function validate(schema: SchemaNode, value: unknown, path: string): void {
  if (value === null) {
    if (schema.nullable === true) return;
    throw new ApifyProfileInputError(`${path} must not be null.`);
  }
  const type = schema.type;
  const fail = (what: string) => { throw new ApifyProfileInputError(`${path} ${what}.`); };
  switch (type) {
    case "string": if (typeof value !== "string") fail("must be a string"); break;
    case "integer": if (typeof value !== "number" || !Number.isSafeInteger(value)) fail("must be an integer"); break;
    case "number": if (typeof value !== "number" || !Number.isFinite(value)) fail("must be a number"); break;
    case "boolean": if (typeof value !== "boolean") fail("must be true or false"); break;
    case "array": if (!Array.isArray(value)) fail("must be an array"); break;
    case "object": if (!node(value)) fail("must be an object"); break;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(option => canonicalJson(option) === canonicalJson(value))) fail("is not one of the allowed values");
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) fail(`is below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) fail(`is above ${schema.maximum}`);
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) fail("is too short");
    if (typeof schema.maxLength === "number" && length > schema.maxLength) fail("is too long");
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) fail("does not match its pattern");
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) fail(`has fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) fail(`has more than ${schema.maxItems} items`);
    if (schema.uniqueItems === true && new Set(value.map(item => canonicalJson(item))).size !== value.length) fail("repeats an item");
    const items = node(schema.items);
    value.forEach((item, index) => { if (items) validate(items, item, `${path}[${index}]`); });
  }
  const object = node(value);
  if (object && !Array.isArray(value) && type === "object") {
    const properties = node(schema.properties) ?? {};
    for (const key of Object.keys(object)) {
      const child = node(properties[key]);
      // Undeclared fields refuse: the reviewed schema is the whole input.
      if (!child) fail(`names ${key}, which its schema does not define`);
      validate(child!, object[key], `${path}.${key}`);
    }
    for (const key of Array.isArray(schema.required) ? schema.required : [])
      if (typeof key === "string" && !(key in object)) fail(`lacks the required ${key}`);
  }
}

/** What a validated input means for one run. */
export interface ApifyProfiledInput {
  /** Every target URL, in input order. */
  readonly urls: readonly string[];
  readonly origins: readonly string[];
  /** The most result items the input lets the run produce. */
  readonly items_bound: number;
}

/**
 * Validate the whole input against the profile's exact schema, collect its
 * target URLs from the mapped fields only, and bound its work. Any URL in
 * another field, an unmapped or oversized work limit, or a target outside
 * the profile's site authorization refuses.
 */
export function profileInput(profile: ApifyQualifiedProfile, input: Readonly<Record<string, unknown>>, maxResultItems: number): ApifyProfiledInput {
  validate(profile.input_schema, input, "input");
  const urls: string[] = [];
  const targetFields = new Set(profile.targets.map(target => target.field));
  const take = (raw: unknown, field: string) => {
    if (typeof raw !== "string") throw new ApifyProfileInputError(`input.${field} must hold URLs.`);
    let url: URL;
    try { url = new URL(raw.trim()); } catch { throw new ApifyProfileInputError(`input.${field} holds a URL that does not parse.`); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new ApifyProfileInputError(`input.${field} holds an unsupported URL.`);
    if (url.username || url.password) throw new ApifyProfileInputError(`input.${field} must not carry credentials in a URL.`);
    urls.push(url.href);
  };
  for (const target of profile.targets) {
    const value = input[target.field];
    if (value === undefined || value === null) continue;
    if (target.shape === "url") take(value, target.field);
    else for (const entry of value as unknown[]) {
      if (target.shape === "request_list") {
        // A request carries only its URL: no method, headers, payload or user data reach the target.
        const request = node(entry);
        if (!request || Object.keys(request).some(key => key !== "url")) throw new ApifyProfileInputError(`input.${target.field} entries are { url } only.`);
        take(request.url, target.field);
      } else take(entry, target.field);
    }
  }
  // No other field may smuggle a target.
  const scan = (value: unknown, field: string): void => {
    if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value.trim()))
      throw new ApifyProfileInputError(`input.${field} carries a URL, but only the profile's target fields may.`);
    if (Array.isArray(value)) for (const item of value) scan(item, field);
    else if (node(value)) for (const child of Object.values(value as object)) scan(child, field);
  };
  for (const [field, value] of Object.entries(input)) if (!targetFields.has(field)) scan(value, field);
  if (!urls.length) throw new ApifyProfileInputError("The input names no target.");
  let itemsBound = Number.POSITIVE_INFINITY;
  for (const limit of profile.work_limits) {
    const value = input[limit.field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
      throw new ApifyProfileInputError(`input.${limit.field} must be set to a positive whole number; it bounds the run's work.`);
    if (value > maxResultItems) throw new ApifyProfileInputError(`input.${limit.field} exceeds the policy's max_result_items (${maxResultItems}).`);
    itemsBound = Math.min(itemsBound, value);
  }
  const origins = [...new Set(urls.map(url => new URL(url).origin))].sort();
  if (profile.site.authorization === "written_permission") {
    const outside = origins.filter(origin => !profile.site.permitted_origins.includes(origin));
    if (outside.length) throw new ApifyProfileInputError(`No written site permission covers ${outside.join(", ")}.`);
  }
  return { urls, origins, items_bound: itemsBound };
}

/** Microdollars, rounded up so a reservation never understates. */
export const micros = (usd: number) => Math.ceil(Math.round(usd * 1e9) / 1e3);

/**
 * The lifecycle liability reserved beside the run cap: every status, result
 * and abort request the profile allows, plus the remote retention of the
 * most storage the run can write.
 */
export function lifecycleMicros(profile: ApifyQualifiedProfile, itemsBound: number): { requests: number; storage: number } {
  const life = profile.lifecycle;
  const requests = micros(life.request_usd * (life.status_requests + life.result_requests + life.abort_requests));
  const storedBytes = itemsBound * profile.output.max_item_bytes;
  const storage = Math.ceil(life.storage_usd_per_gb_day * MICROS * (storedBytes / GB) * life.remote_retention_days);
  if (!Number.isSafeInteger(requests) || !Number.isSafeInteger(storage)) throw new ApifyProfileError("Lifecycle liability overflows.");
  return { requests, storage };
}

/**
 * The cost of one charged-event report, in microdollars, or null when an
 * event has no known price. `runPrices` are the prices the run itself
 * reports; the higher of the two applies, so a price change never lowers a
 * liability.
 */
export function eventMicros(profile: ApifyQualifiedProfile, counts: Readonly<Record<string, number>>, runPrices: Readonly<Record<string, number>> | null): number | null {
  let total = 0;
  for (const [event, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count) || count < 0) return null;
    if (count === 0) continue;
    const qualified = profile.billing.events[event];
    const reported = runPrices?.[event];
    if (qualified === undefined && reported === undefined) return null;
    const price = Math.max(qualified ?? 0, reported ?? 0);
    total += micros(price * count);
  }
  return Number.isSafeInteger(total) ? total : null;
}
