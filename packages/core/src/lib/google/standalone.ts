/**
 * Google for a standalone `brain google` process (#4208, plan
 * [`docs/plans/google-workspace.md`](../../../../../docs/plans/google-workspace.md)
 * §10, decision record ruling 4).
 *
 * The same operations, decision function, transport and projections the
 * hosted tools use (`@schlessera/brain-common/internal/google-operations`
 * and `…/google-gog`), under the policy's `google` block and the standalone
 * posture:
 *
 * - Reads only, in this release: `gmail.search`, `gmail.thread.get`,
 *   `gmail.message.get`, `gmail.draft.get` and `gmail.labels.list`. The
 *   principal is the local operator, who is the owner. There is no session,
 *   so no taint and no remembered approval, and nobody to ask: nothing ever
 *   waits for a card.
 * - Routing: with no conversation to inspect, a policy whose provider rules
 *   restrict what reaches `google` refuses as `recipient_unproven`, as a
 *   standalone Apify process does.
 * - `hidden_labels` holds on results, exactly as on the host: a search drops
 *   every thread with a hidden label on any message; a get of one answers as
 *   a miss does, and a real miss answers the same.
 * - A content result is not tainted, because nothing here has a session to
 *   taint. Its third-party text is marked `untrusted`, and whoever reads it
 *   (a local agent included) should treat it so. A local agent with shell
 *   access runs as this user and is inside the boundary: it can run gog or
 *   read the keyring itself. `status` says so.
 *
 * `connect` wraps gog's OAuth flow into the selected home (`./home.ts`) with
 * the flags brain-kit owns: `--services` from the policy, read-only scopes
 * unless `--write`, and with `--write` exactly `gmail.readonly` and
 * `gmail.modify`. It then reads back the scopes gog recorded for the grant,
 * removes a grant broader than it asked for, and fails.
 */
import { mkdirSync, chmodSync } from "node:fs";
import {
  contentGmailDraft, contentGmailMessageResult, contentGmailSearch, contentGmailThread, decideGoogleCall, effectiveGoogleMode, GMAIL_LIMITS, GMAIL_TOOL_NAMES,
  gmailLabelDirectory, GOOGLE_NOT_FOUND_MESSAGE, GOOGLE_OPERATION_SPECS, GOOGLE_OPERATIONS, GOOGLE_SERVICES, isGmailThreadId, parseGoogleMailbox, parseGoogleToolCall,
  structuredGmailDraft, structuredGmailLabels, structuredGmailMessageResult, structuredGmailSearch, structuredGmailThread,
  type GmailLabelDirectory, type GmailLabelRecord, type GmailReadInput, type GmailSearchInput, type GoogleDecisionFacts, type GoogleError,
  type GoogleErrorCode, type GooglePolicy, type GoogleRoutingVerdict,
} from "@schlessera/brain-common/internal/google-operations";
import {
  createGogTransport, GOG_PIN_REFUSALS, gogEnvironment, type GogBinary, type GogEnvironment, type GogResult, type GogTransport, type GogTransportOptions,
} from "@schlessera/brain-common/internal/google-gog";
import { resolveEnv } from "../../config/env.js";
import { checkGovernancePolicy, type EffectiveGovernancePolicy, type GovernancePolicyCheck } from "../governance-policy.js";
import { GoogleCursorStale, googleCursorStore } from "./cursors.js";
import {
  connectScopes, GMAIL_MODIFY_SCOPE, GMAIL_READONLY_SCOPE, GOG_IDENTITY_SCOPES, gogAuthArgv, runGogAuth, type GogAuthInvocation, type GogAuthRun,
} from "./gog-auth.js";
import { checkGoogleHome, selectGoogleHome, type GoogleHomeSelection } from "./home.js";

/** The recipient G2 provider routing names for Google (plan §6, step 10). */
export const GOOGLE_RECIPIENT = "google";

export type GoogleReadCommand = "gmail.search" | "gmail.thread.get" | "gmail.message.get" | "gmail.draft.get" | "gmail.labels.list";
export type GoogleCliOperation = "status" | "connect" | GoogleReadCommand;

export type GoogleEnvelope =
  | { ok: true; operation: GoogleCliOperation; data: unknown }
  | { ok: false; operation: GoogleCliOperation; error: GoogleError };

/** What `status` reports. Never an address, a token or a password. */
export interface GoogleStatus {
  state: "available" | "unavailable";
  /** The first reason Google is unavailable, or null. */
  reason: string | null;
  /** `standalone`: this user's own home; `host`: the chat server's, from an operator's shell. */
  boundary: "standalone" | "host";
  /** The plain statement of what the boundary does not stop; null on a host. */
  statement: string | null;
  home: { path: string; source: GoogleHomeSelection["source"]; exists: boolean; ok: boolean; reason: string | null };
  pin: { state: "verified" | "fake" | "refused" | "not_checked"; version: string | null; commit: string | null; sha256: string | null; reason: string | null };
  policy: {
    status: GovernancePolicyCheck["status"]; enabled: boolean; account: string | null; services: string[];
    read: GooglePolicy["modes"]["read"]; standalone_reversible: GooglePolicy["standalone"]["reversible"];
  };
  account: { alias: string | null; connected: boolean };
  scopes: { granted: string[] | null; needed: string[]; broader: string[]; missing: string[]; write: boolean };
  warnings: string[];
}

export const GOOGLE_STANDALONE_STATEMENT =
  "A local agent with shell access runs as you and is inside this boundary: it can run gog or read its keyring itself, " +
  "and brain google holds it to the policy only for what it asks brain google to do. Read-only scopes are the only enforcement here.";

export interface StandaloneGoogleOptions {
  root: string;
  /** Read in core's one chokepoint; tests pass their own. */
  env?: Readonly<Record<string, string | undefined>>;
  /** A test's fake gog (`createFakeGog().binary`). Never configuration: production always runs the pinned binary its home names. */
  binary?: GogBinary;
  transport?: Pick<GogTransportOptions, "timeouts" | "retryDelayMs">;
  /** The authorization's own limit, for tests. Default ten minutes. */
  connectTimeoutMs?: number;
  now?: () => number;
}

export interface GoogleConnectInput {
  /** The account's address: gog keys its token by it. Never printed. */
  address: string;
  write: boolean;
  remote: boolean;
  /** For `--remote`, the redirect URL the browser landed on (step 2). */
  authUrl?: string;
  /** An OAuth client JSON to store in the home first. */
  credentials?: Uint8Array;
}

export interface StandaloneGoogle {
  status(): Promise<GoogleEnvelope>;
  connect(input: GoogleConnectInput): Promise<GoogleEnvelope>;
  /** One Gmail read, from its tool's own input (`brain_google_gmail_search` or `brain_google_gmail_read`). */
  read(operation: GoogleReadCommand, input: unknown): Promise<GoogleEnvelope>;
}

// ------------------------------------------------------------------ errors

const MESSAGES: Partial<Record<string, string>> = {
  policy_invalid: "Google is unavailable because context/policies/governance.md is invalid. Repair it (brain policy check) before using Google.",
  not_connected: "No Google account is connected in this home. Connect one with brain google connect.",
  cursor: "This cursor is not a next_cursor of an earlier search of the same query on this account, or it has expired. Search again.",
  cursor_unwritable: "The next page's cursor could not be kept in the Google home, so this page was not returned.",
  connection_changed: "The Google account was connected again while this search ran, so its page was not returned. Search again.",
};

function error(code: GoogleErrorCode, reason: string | null, message: string): GoogleError {
  return { code, reason, message };
}

const refused = (operation: GoogleCliOperation, failure: GoogleError): GoogleEnvelope => ({ ok: false, operation, error: failure });

/** A miss and a hidden target read the same (plan §5): one code, no reason, one message. */
const NOT_FOUND = error("not_found", null, GOOGLE_NOT_FOUND_MESSAGE);
const asMiss = (failure: GoogleError) => failure.code === "not_found" ? NOT_FOUND : failure;

/** The routing verdict for a call with no conversation behind it. */
export function standaloneGoogleRouting(providers: EffectiveGovernancePolicy["providers"]): GoogleRoutingVerdict {
  return providers.every(rule => rule.allow.includes(GOOGLE_RECIPIENT)) ? "allowed" : "recipient_unproven";
}

// ------------------------------------------------------------------ gog's account answers

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

function json(run: GogAuthRun): unknown {
  if (!run.stdout) return undefined;
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(run.stdout)); } catch { return undefined; }
}

/** An account command's failure as a coded error. Its stderr is never read. */
function authFailure(run: GogAuthRun, step: string): GoogleError {
  if (run.end.kind === "spawn_failed") return error("transport_incompatible", "spawn_failed", "gog could not be started.");
  if (run.end.kind === "output_too_large") return error("transport_incompatible", "output_too_large", "gog answered more than brain google reads.");
  if (run.end.kind !== "exit") {
    return error("unavailable", `${step}_${run.end.kind}`, "gog did not finish, so this step may or may not have taken effect in the Google home; run brain google status to see what it holds.");
  }
  switch (run.end.exitCode) {
    case 2: return error("transport_incompatible", "usage", "gog refused the command brain google built; this gog is not the release it expects.");
    case 4: return error("unavailable", "auth_required", MESSAGES.not_connected!);
    case 10: return error("unavailable", "config", "gog's configuration in the Google home is missing or unreadable (an OAuth client: brain google connect --credentials <file>).");
    default: return error("unavailable", `${step}_failed`, `gog's ${step.replace(/_/g, " ")} step failed (exit ${run.end.exitCode}).`);
  }
}

/** `auth alias list --json`: `{ aliases: { alias: address } }`. */
function aliasesOf(value: unknown): Map<string, string> | null {
  if (!isRecord(value) || !isRecord(value.aliases)) return null;
  const entries = Object.entries(value.aliases);
  if (!entries.every(([, address]) => typeof address === "string")) return null;
  return new Map(entries.map(([alias, address]) => [alias, (address as string).toLowerCase()]));
}

/** An OAuth scope as Google names one; anything else in gog's answer is not a scope this module repeats. */
export const GOOGLE_SCOPE_PATTERN = /^(?:openid|email|profile|https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._-]{1,128}|https:\/\/mail\.google\.com\/)$/;

/** Whether the policy can admit any Gmail write at all, so a grant may carry `gmail.modify`. */
function policyMayWrite(policy: GooglePolicy): boolean {
  if (!policy.services.includes("gmail")) return false;
  return GOOGLE_OPERATIONS.some(operation => {
    const base = GOOGLE_OPERATION_SPECS[operation].base;
    return base !== "read" && effectiveGoogleMode(policy, operation, base).mode !== "deny";
  });
}

/** `auth list --json`: the scopes gog recorded for one address, sorted; null when none is stored, undefined when the answer is unreadable. */
function recordedScopes(value: unknown, address: string): string[] | null | undefined {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return undefined;
  for (const account of value.accounts) {
    if (!isRecord(account) || typeof account.email !== "string") return undefined;
    if (account.email.toLowerCase() !== address.toLowerCase()) continue;
    if (account.scopes === undefined) return [];
    if (!isStrings(account.scopes) || !account.scopes.every(scope => GOOGLE_SCOPE_PATTERN.test(scope))) return undefined;
    return [...new Set(account.scopes)].sort();
  }
  return null;
}

// ------------------------------------------------------------------ the service

/** What a command works in once policy, home and credential are known. */
interface Prepared {
  policy: GooglePolicy;
  effective: EffectiveGovernancePolicy;
  selection: GoogleHomeSelection;
  home: string;
  exists: boolean;
  env: GogEnvironment;
  transport: GogTransport;
}

export function createStandaloneGoogle(options: StandaloneGoogleOptions): StandaloneGoogle {
  const coreEnv = options.env ? resolveEnv(options.env as NodeJS.ProcessEnv) : resolveEnv();
  const now = options.now ?? Date.now;

  function loadPolicy(): { check: GovernancePolicyCheck; policy: GooglePolicy } {
    const check = checkGovernancePolicy(options.root);
    return { check, policy: check.effective.google };
  }

  /**
   * Policy, home and credential, in that order; the first that fails is the
   * answer. `account` is the alias the transport is built for.
   */
  function prepare(account: string | null, { create = false } = {}): { ok: true; prepared: Prepared } | { ok: false; error: GoogleError } {
    const { check, policy } = loadPolicy();
    if (!check.ok) return { ok: false, error: error("unavailable", "policy_invalid", MESSAGES.policy_invalid!) };
    const selection = selectGoogleHome(coreEnv.google);
    let home = checkGoogleHome(selection.path, options.root);
    if (home.ok && !home.exists && create) {
      try {
        mkdirSync(home.path, { recursive: true, mode: 0o700 });
        chmodSync(home.path, 0o700);
      } catch {
        return { ok: false, error: error("unavailable", "home_unwritable", `The Google home (${selection.names.home}) could not be created.`) };
      }
      home = checkGoogleHome(selection.path, options.root);
    }
    if (!home.ok) return { ok: false, error: error("unavailable", home.reason, `${home.detail} (${selection.names.home})`) };
    if (!selection.keyringPassword) {
      return { ok: false, error: error("unavailable", "keyring_password_unset", `${selection.names.keyringPassword} is not set: gog's file keyring in the Google home needs it.`) };
    }
    const environment = gogEnvironment({ home: home.path, keyringPassword: selection.keyringPassword });
    if (!environment.ok) {
      return { ok: false, error: error("unavailable", `${environment.reason}_invalid`, environment.reason === "keyring_password"
        ? `${selection.names.keyringPassword} holds a line break or NUL, which gog cannot take.` : "The Google home cannot be given to gog.") };
    }
    if (!options.binary && !selection.gogPath) {
      return { ok: false, error: error("unavailable", "gog_path_unset", `${selection.names.gogPath} is not set: name the pinned gog release binary.`) };
    }
    const transport = createGogTransport({
      binary: options.binary ?? { kind: "pinned", path: selection.gogPath! },
      // An account command names no account; the transport still needs a valid alias to exist.
      account: account ?? "unset",
      environment: { home: home.path, keyringPassword: selection.keyringPassword },
      ...options.transport,
    });
    return { ok: true, prepared: { policy, effective: check.effective, selection, home: home.path, exists: home.exists, env: environment.environment, transport } };
  }

  /** Runs one account command, after the transport re-checked the pinned binary's identity. */
  async function account(prepared: Prepared, call: GogAuthInvocation, run: { stdin?: Uint8Array; stderr?: "inherit" | "drop"; timeoutMs?: number } = {}):
    Promise<{ ok: true; run: GogAuthRun } | { ok: false; error: GoogleError }> {
    const pin = await prepared.transport.availability();
    if (!pin.ok) return pin;
    const executable = pin.fake ? options.binary!.path : pin.pin.path;
    let argv: string[];
    try { argv = gogAuthArgv(call); } catch { return { ok: false, error: error("invalid_input", "argv", "A value cannot be given to gog: it holds a control character or a line break.") }; }
    const result = await runGogAuth(executable, argv, {
      env: prepared.env, stdin: run.stdin ?? null, stderr: run.stderr ?? "drop", timeoutMs: run.timeoutMs ?? 30_000,
    });
    return { ok: true, run: result };
  }

  /** The scopes gog recorded for the alias's address: null when the alias or its token is missing. */
  async function grantOf(prepared: Prepared, alias: string): Promise<{ ok: true; scopes: string[] | null } | { ok: false; error: GoogleError }> {
    const listed = await account(prepared, { command: "auth.alias.list" });
    if (!listed.ok) return listed;
    if (listed.run.end.kind !== "exit" || listed.run.end.exitCode !== 0) return { ok: false, error: authFailure(listed.run, "alias_list") };
    const aliases = aliasesOf(json(listed.run));
    if (!aliases) return { ok: false, error: error("transport_incompatible", "unexpected_shape", "gog's alias list is not in the shape brain google reads.") };
    const address = aliases.get(alias);
    if (!address) return { ok: true, scopes: null };
    const tokens = await account(prepared, { command: "auth.list" });
    if (!tokens.ok) return tokens;
    if (tokens.run.end.kind !== "exit" || tokens.run.end.exitCode !== 0) return { ok: false, error: authFailure(tokens.run, "account_list") };
    const scopes = recordedScopes(json(tokens.run), address);
    if (scopes === undefined) return { ok: false, error: error("transport_incompatible", "unexpected_shape", "gog's account list is not in the shape brain google reads.") };
    return { ok: true, scopes };
  }

  // ---------------------------------------------------------------- status

  async function status(): Promise<GoogleEnvelope> {
    const { check, policy } = loadPolicy();
    const selection = selectGoogleHome(coreEnv.google);
    const home = checkGoogleHome(selection.path, options.root);
    const needed = policy.services.includes("gmail") ? [GMAIL_READONLY_SCOPE] : [];
    const data: GoogleStatus = {
      state: "unavailable", reason: null,
      boundary: selection.kind,
      statement: selection.kind === "standalone" ? GOOGLE_STANDALONE_STATEMENT : null,
      home: { path: selection.path, source: selection.source, exists: home.ok && home.exists, ok: home.ok, reason: home.ok ? null : home.reason },
      pin: { state: "not_checked", version: null, commit: null, sha256: null, reason: null },
      policy: {
        status: check.status, enabled: policy.enabled, account: policy.account, services: [...policy.services],
        read: policy.modes.read, standalone_reversible: policy.standalone.reversible,
      },
      account: { alias: policy.account, connected: false },
      scopes: { granted: null, needed, broader: [], missing: [...needed], write: false },
      warnings: [],
    };
    const reasons: string[] = [];
    if (!check.ok) reasons.push("policy_invalid");
    else if (!policy.enabled) reasons.push("not_enabled");
    else if (policy.account === null) reasons.push("no_account");
    else if (!policy.services.includes("gmail")) reasons.push("service_not_enabled");
    if (!home.ok) reasons.push(home.reason);
    else if (!home.exists) reasons.push("not_connected");
    const prepared = home.ok && home.exists && check.ok ? prepare(policy.account) : null;
    if (prepared && !prepared.ok) reasons.push(prepared.error.reason ?? prepared.error.code);
    if (prepared?.ok) {
      const pin = await prepared.prepared.transport.availability();
      if (!pin.ok) {
        data.pin = { state: "refused", version: null, commit: null, sha256: null, reason: pin.error.reason };
        reasons.push(pin.error.code === "transport_incompatible" ? "binary_refused" : pin.error.reason ?? pin.error.code);
      } else {
        data.pin = pin.fake ? { state: "fake", version: null, commit: null, sha256: null, reason: null }
          : { state: "verified", version: pin.pin.version, commit: pin.pin.commit, sha256: pin.pin.sha256, reason: null };
        if (policy.account !== null) {
          const grant = await grantOf(prepared.prepared, policy.account);
          if (!grant.ok) reasons.push(grant.error.reason ?? grant.error.code);
          else if (grant.scopes === null) reasons.push("not_connected");
          else {
            const granted = grant.scopes;
            // What the policy can use: reads, and gmail.modify only while it can admit a write.
            const allowed = new Set([...GOG_IDENTITY_SCOPES, GMAIL_READONLY_SCOPE, ...(policyMayWrite(policy) ? [GMAIL_MODIFY_SCOPE] : [])]);
            data.account.connected = true;
            data.scopes = {
              granted, needed,
              broader: granted.filter(scope => !allowed.has(scope)),
              missing: needed.filter(scope => !granted.includes(scope)),
              write: granted.includes(GMAIL_MODIFY_SCOPE),
            };
            if (data.scopes.broader.length > 0) {
              data.warnings.push(`The connected grant holds scopes the policy cannot use (${data.scopes.broader.join(", ")}); reconnect with brain google connect, without --write unless the policy allows writes, to narrow it.`);
            }
            if (data.scopes.missing.length > 0) reasons.push("scopes_missing");
          }
        }
      }
    }
    data.state = reasons.length === 0 ? "available" : "unavailable";
    data.reason = reasons[0] ?? null;
    return { ok: true, operation: "status", data };
  }

  // ---------------------------------------------------------------- connect

  async function connect(input: GoogleConnectInput): Promise<GoogleEnvelope> {
    const op = "connect" as const;
    const parsed = parseGoogleMailbox(input.address);
    if (!parsed.ok || parsed.mailbox.display_name !== null || /[<>]/.test(input.address)) {
      return refused(op, error("invalid_input", "address", "Give the account's plain email address, such as odysseus@example.com."));
    }
    const address = parsed.mailbox.address;
    if (input.authUrl !== undefined) {
      let url: URL | null = null;
      try { url = new URL(input.authUrl); } catch { /* refused below */ }
      if (!input.remote || !url || !/^https?:$/.test(url.protocol) || input.authUrl.length > 4096 || /[\p{Cc}\u2028\u2029]/u.test(input.authUrl)) {
        return refused(op, error("invalid_input", "auth_url", "--auth-url takes the one-line http(s) URL the browser landed on after a brain google connect --remote."));
      }
    }
    if (input.credentials !== undefined) {
      let client: unknown;
      try { client = input.credentials.length <= 64 * 1024 ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.credentials)) : undefined; } catch { client = undefined; }
      if (!isRecord(client)) return refused(op, error("invalid_input", "credentials", "--credentials takes the OAuth client JSON file Google Cloud gave you (a Desktop client), at most 64 KiB."));
    }
    const { check, policy } = loadPolicy();
    if (!check.ok) return refused(op, error("unavailable", "policy_invalid", MESSAGES.policy_invalid!));
    if (policy.account === null) {
      return refused(op, error("unavailable", "no_account", "The policy's google block names no account alias; connect stores the account under that alias."));
    }
    const services = GOOGLE_SERVICES.filter(service => policy.services.includes(service));
    if (services.length === 0) {
      return refused(op, error("unavailable", "service_not_enabled", "The policy's google.services lists no service, and connect asks only for what it lists."));
    }
    const ready = prepare(policy.account, { create: true });
    if (!ready.ok) return refused(op, ready.error);
    const prepared = ready.prepared;
    const alias = policy.account;

    if (input.credentials !== undefined) {
      const stored = await account(prepared, { command: "auth.credentials.set", positionals: ["-"] }, { stdin: input.credentials });
      if (!stored.ok) return refused(op, stored.error);
      if (stored.run.end.kind !== "exit" || stored.run.end.exitCode !== 0) return refused(op, authFailure(stored.run, "credentials"));
    }

    const step = !input.remote ? null : input.authUrl === undefined ? 1 : 2;
    const flags: [string, string | true][] = [
      ["services", services.join(",")],
      ["gmail-scope", "readonly"],
      ...(input.write ? [["extra-scopes", GMAIL_MODIFY_SCOPE] as [string, string]] : []),
      ["force-consent", true],
      ...(step === null ? [] : [["remote", true] as [string, true], ["step", String(step)] as [string, string]]),
      ...(step === 2 ? [["auth-url", input.authUrl!] as [string, string]] : []),
    ];
    const added = await account(prepared, { command: "auth.add", flags, positionals: [address], readonly: !input.write },
      // Only the browser flow needs gog's stderr: it shows the URL to open when no browser starts. A remote step prompts for nothing.
      { stderr: step === null ? "inherit" : "drop", timeoutMs: options.connectTimeoutMs ?? 10 * 60_000 });
    if (!added.ok) return refused(op, added.error);
    if (added.run.end.kind !== "exit" || added.run.end.exitCode !== 0) return refused(op, authFailure(added.run, "authorization"));
    if (step === 1) {
      const answer = json(added.run);
      const url = isRecord(answer) && typeof answer.auth_url === "string" && answer.auth_url.startsWith("https://") && !/[\p{Cc}\s]/u.test(answer.auth_url)
        ? answer.auth_url : null;
      if (!url) return refused(op, error("transport_incompatible", "unexpected_shape", "gog's authorization URL is not in the shape brain google reads."));
      return { ok: true, operation: op, data: {
        state: "authorize", alias, auth_url: url, write: input.write,
        next: "Open auth_url in a browser, approve, then run the same brain google connect command again with --auth-url '<the URL the browser landed on>'.",
      } };
    }

    // Read back what gog recorded for this grant before naming it under the alias.
    const tokens = await account(prepared, { command: "auth.list" });
    if (!tokens.ok) return refused(op, tokens.error);
    if (tokens.run.end.kind !== "exit" || tokens.run.end.exitCode !== 0) return refused(op, authFailure(tokens.run, "account_list"));
    const granted = recordedScopes(json(tokens.run), address);
    if (granted === undefined) return refused(op, error("transport_incompatible", "unexpected_shape", "gog's account list is not in the shape brain google reads."));
    if (granted === null) return refused(op, error("unavailable", "not_stored", "gog finished but stored no grant for this account in the Google home."));
    const wanted = connectScopes(input.write);
    const broader = granted.filter(scope => !wanted.includes(scope));
    if (broader.length > 0) {
      // Never keep a credential broader than asked for: remove it, then refuse.
      const removed = await account(prepared, { command: "auth.remove", positionals: [address], force: true });
      const gone = removed.ok && removed.run.end.kind === "exit" && removed.run.end.exitCode === 0;
      return refused(op, error("policy_denied", "scopes_broader", gone
        ? `gog recorded a grant broader than brain google asked for (${broader.join(", ")}), so it was removed again. Nothing is connected.`
        : `gog recorded a grant broader than brain google asked for (${broader.join(", ")}), and removing it failed: remove it before using this home.`));
    }
    const missing = wanted.filter(scope => !granted.includes(scope));
    if (missing.length > 0) {
      return refused(op, error("unavailable", "scopes_missing", `The grant lacks ${missing.join(", ")}; connect again and approve every scope on Google's consent screen.`));
    }
    const named = await account(prepared, { command: "auth.alias.set", positionals: [alias, address] });
    if (!named.ok) return refused(op, named.error);
    if (named.run.end.kind !== "exit" || named.run.end.exitCode !== 0) return refused(op, authFailure(named.run, "alias"));
    // The alias may now name another account: no earlier search's page token carries over.
    const warnings: string[] = [];
    try { googleCursorStore(prepared.home, now).clear(); }
    catch { warnings.push("Earlier search cursors could not be forgotten; they expire within the hour. Do not page an earlier search."); }
    return { ok: true, operation: op, data: {
      state: "connected", alias, write: input.write, boundary: prepared.selection.kind, home: prepared.home, scopes: granted, warnings,
    } };
  }

  // ---------------------------------------------------------------- reads

  async function read(operation: GoogleReadCommand, input: unknown): Promise<GoogleEnvelope> {
    const call = parseGoogleToolCall(operation === "gmail.search" ? GMAIL_TOOL_NAMES.search : GMAIL_TOOL_NAMES.read, input);
    if (!call.ok) return refused(operation, call.error);
    if (call.call.operation !== operation) return refused(operation, error("invalid_input", "operation_mismatch", "The input names a different read than the command."));
    const { check, policy } = loadPolicy();
    if (!check.ok) return refused(operation, error("unavailable", "policy_invalid", MESSAGES.policy_invalid!));
    const facts: GoogleDecisionFacts = {
      principal: "owner", posture: "standalone", routing: standaloneGoogleRouting(check.effective.providers),
      card_available: false, turn_reversible_items: 0,
    };
    const decide = (targetLabels: readonly string[] | undefined) =>
      decideGoogleCall(policy, { operation, input: call.call.input }, { ...facts, ...(targetLabels ? { target_label_ids: targetLabels } : {}) });
    // Everything but the targets' labels, before anything reaches Google; the labels are checked on what the read returns.
    const before = decide([]);
    if (before.outcome !== "admitted") return refused(operation, before.outcome === "refused" ? before.error : error("policy_denied", "needs_card", "This needs an approval brain google cannot ask for."));
    const ready = prepare(policy.account);
    if (!ready.ok) return refused(operation, ready.error);
    const prepared = ready.prepared;
    if (!prepared.exists) return refused(operation, error("unavailable", "not_connected", MESSAGES.not_connected!));
    const { transport } = prepared;
    const hidden = policy.gmail.hidden_labels;
    const view = (call.call.input as { view?: "structured" | "content" }).view ?? "content";
    // Label names come from reading the label list, so only where the policy admits that read itself.
    const namesAdmitted = decideGoogleCall(policy, { operation: "gmail.labels.list", input: { target: "labels" } }, facts).outcome === "admitted";
    const labelDirectory = async (): Promise<GmailLabelDirectory> => {
      // Names only: without them a result carries ids and null names.
      if (!namesAdmitted) return new Map();
      const labels = await transport.execute("gmail.labels.list", {});
      return labels.ok ? gmailLabelDirectory(labels.value) : new Map();
    };
    const shapeError = error("transport_incompatible", "unexpected_shape", "The Google transport answered in a shape brain-kit does not read.");
    /**
     * The thread's labels too when anything is hidden: a thread with a hidden
     * label on any message is hidden whole (plan §5). This read is the host's
     * own pre-read for the call already decided, and returns nothing but label
     * ids. A thread whose labels cannot be established is never clean.
     */
    const threadLabels = async (threadId: string, own: readonly string[]): Promise<GogResult<string[]>> => {
      if (hidden.length === 0 || own.some(label => hidden.includes(label))) return { ok: true, value: [...own] };
      if (!isGmailThreadId(threadId)) return { ok: false, error: NOT_FOUND };
      const thread = await transport.execute("gmail.thread.get", { thread_id: threadId });
      // Unknown visibility reads exactly as a miss, so no answer tells a hidden target from a missing one.
      if (!thread.ok || thread.value.id !== threadId) return { ok: false, error: NOT_FOUND };
      return { ok: true, value: [...new Set([...own, ...thread.value.messages.flatMap(message => message.label_ids)])] };
    };
    const admitted = (targets: readonly string[]): GoogleError | null => {
      const after = decide(targets);
      return after.outcome === "admitted" ? null : after.outcome === "refused" ? after.error : error("policy_denied", "needs_card", "This needs an approval brain google cannot ask for.");
    };
    const shape = () => refused(operation, shapeError);
    /**
     * A fetch that failed before the target's labels were seen. While anything
     * is hidden, it reads as a miss unless the failure says nothing about the
     * target (the account is not connected or rate limited, the input or the
     * binary was refused): a timeout, a refusal from Google or an answer the
     * codec cannot read may be the target's own, so no answer tells a hidden
     * target from a missing one.
     */
    const targetIndependent = (failure: GoogleError) =>
      failure.code === "unavailable" || failure.code === "rate_limited" || failure.code === "invalid_input"
      || (failure.code === "transport_incompatible"
        && (failure.reason === "spawn_failed" || failure.reason === "usage" || (GOG_PIN_REFUSALS as readonly string[]).includes(failure.reason ?? "")));
    const fetchFailure = (failure: GoogleError) => hidden.length > 0 && !targetIndependent(failure) ? NOT_FOUND : asMiss(failure);
    const mismatch = () => refused(operation, hidden.length > 0 ? NOT_FOUND : shapeError);
    const ok = (data: unknown): GoogleEnvelope => ({ ok: true, operation, data });

    switch (operation) {
      case "gmail.search": {
        const search = call.call.input as GmailSearchInput;
        const cursors = googleCursorStore(prepared.home, now);
        const alias = policy.account!;
        let pageToken: string | undefined;
        if (search.cursor !== undefined) {
          const resolved = cursors.resolve(alias, search.query, search.cursor);
          if (resolved === null) return refused(operation, error("invalid_input", "cursor", MESSAGES.cursor!));
          pageToken = resolved;
        }
        const limit = search.limit ?? GMAIL_LIMITS.searchDefault;
        // Taken before Google is asked: a connect while this runs voids the next page's cursor.
        const generation = cursors.generation();
        const [page, labels] = await Promise.all([
          transport.execute("gmail.search", { query: search.query, limit, ...(pageToken ? { page_token: pageToken } : {}) }),
          labelDirectory(),
        ]);
        if (!page.ok) return refused(operation, page.error);
        // A thread with a hidden label on any of its messages is not a hit (plan §5); the hit's labels are its messages' union.
        const hits = page.value.hits.filter(hit => !hit.label_ids.some(label => hidden.includes(label)));
        let cursor: string | null = null;
        if (page.value.next_page_token) {
          try { cursor = cursors.mint(alias, search.query, page.value.next_page_token, generation); }
          catch (failure) {
            return refused(operation, failure instanceof GoogleCursorStale
              ? error("unavailable", "connection_changed", MESSAGES.connection_changed!)
              : error("unavailable", "cursor_unwritable", MESSAGES.cursor_unwritable!));
          }
        }
        const filtered = { ...page.value, hits };
        return ok(view === "structured" ? structuredGmailSearch(filtered, { labels, cursor }) : contentGmailSearch(filtered, { labels, cursor }));
      }
      case "gmail.labels.list": {
        const labels = await transport.execute("gmail.labels.list", {});
        if (!labels.ok) return refused(operation, labels.error);
        return ok(structuredGmailLabels(labels.value as GmailLabelRecord[]));
      }
      case "gmail.thread.get": {
        const id = (call.call.input as GmailReadInput).id!;
        const [thread, labels] = await Promise.all([transport.execute("gmail.thread.get", { thread_id: id }), labelDirectory()]);
        if (!thread.ok) return refused(operation, fetchFailure(thread.error));
        if (thread.value.id !== id) return mismatch();
        const refusal = admitted(thread.value.messages.flatMap(message => message.label_ids));
        if (refusal) return refused(operation, asMiss(refusal));
        const result = view === "structured" ? structuredGmailThread(thread.value, { labels }) : contentGmailThread(thread.value, { labels });
        return result ? ok(result) : shape();
      }
      case "gmail.message.get": {
        const id = (call.call.input as GmailReadInput).id!;
        const [message, labels] = await Promise.all([transport.execute("gmail.message.get", { message_id: id }), labelDirectory()]);
        if (!message.ok) return refused(operation, fetchFailure(message.error));
        if (message.value.id !== id) return mismatch();
        const targets = await threadLabels(message.value.thread_id, message.value.label_ids);
        if (!targets.ok) return refused(operation, asMiss(targets.error));
        const refusal = admitted(targets.value);
        if (refusal) return refused(operation, asMiss(refusal));
        const result = view === "structured" ? structuredGmailMessageResult(message.value, { labels }) : contentGmailMessageResult(message.value, { labels });
        return result ? ok(result) : shape();
      }
      case "gmail.draft.get": {
        const id = (call.call.input as GmailReadInput).id!;
        const [draft, labels] = await Promise.all([transport.execute("gmail.draft.get", { draft_id: id }), labelDirectory()]);
        if (!draft.ok) return refused(operation, fetchFailure(draft.error));
        if (draft.value.draft.id !== id) return mismatch();
        const message = draft.value.draft.message;
        // A draft with no message has no labels to establish: with anything hidden, it is not shown.
        if (!message && hidden.length > 0) return refused(operation, NOT_FOUND);
        const targets = message ? await threadLabels(message.thread_id, message.label_ids) : { ok: true as const, value: [] as string[] };
        if (!targets.ok) return refused(operation, asMiss(targets.error));
        const refusal = admitted(targets.value);
        if (refusal) return refused(operation, asMiss(refusal));
        const result = view === "structured" ? structuredGmailDraft(draft.value.draft, { labels }) : contentGmailDraft(draft.value.draft, { labels });
        return result ? ok(result) : shape();
      }
    }
  }

  return { status, connect, read };
}
