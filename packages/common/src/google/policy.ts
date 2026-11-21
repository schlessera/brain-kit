/**
 * The `google` governance policy block (plan §5, #4204): its strict schema,
 * its bounds and defaults, and the resolved block the decision function reads.
 *
 * The block is a top-level key of `context/policies/governance.md`, beside
 * `apify`. `GovernancePolicySchema` nests {@link GooglePolicySchema} under
 * `google`, so a malformed block invalidates the whole policy like any other
 * key and the host keeps its last valid policy in force. Absent, or without
 * `enabled: true`, Google is disabled.
 *
 * - `account` names the gog alias the host uses, never an address and never
 *   gog's `auto`, which would let gog pick an account itself.
 * - `modes` sets one mode per effect class. `read` takes `deny` or `allow`
 *   (there is no card for a read), `reversible` takes `deny`, `ask` or
 *   `allow`, and `irreversible` takes `deny` or `ask`: an irreversible call
 *   always asks.
 * - `operations` overrides the class mode for one operation id. `allow` on an
 *   operation whose base class is irreversible, and `ask` on a read
 *   operation, are schema errors at the operation's path. An override applies
 *   while the call's computed class is the operation's base class; a call
 *   that escalated uses the class mode instead, or `deny` if the override is
 *   `deny` (see {@link effectiveGoogleMode}).
 * - `gmail.send_to` holds allow-list entries the one address parser reads
 *   (`self`, `*@domain`, or one address). An empty list opens no send.
 * - `gmail.hidden_labels` holds Gmail label ids whose threads no tool may see
 *   or touch.
 * - `standalone.reversible` is what the standalone `brain google` CLI may do
 *   without a card; it admits only where the effective mode is also `allow`.
 * - `limits` bounds ids per call (never above the catalog's own cap) and the
 *   card-less reversible items one turn may use before admission becomes ask.
 *
 * Calendar's `calendar.invite` and the `calendar` service arrive with the
 * Calendar operations (#4221); until then the strict schema refuses both.
 *
 * Pure, like the rest of the module: zod and its own files only.
 */
import { z } from "zod";
import { parseGoogleAllowListEntry } from "./address.js";
import {
  GMAIL_LIMITS, GOOGLE_OPERATION_SPECS, GOOGLE_OPERATIONS, GOOGLE_SERVICES,
  type GoogleEffectClass, type GoogleOperation, type GoogleService,
} from "./catalog.js";
import { isGmailLabelId } from "./ids.js";

/** What a policy may say about a class or an operation. */
export const GOOGLE_POLICY_MODES = ["deny", "ask", "allow"] as const;
export type GooglePolicyMode = typeof GOOGLE_POLICY_MODES[number];

/**
 * The modes each effect class may take, least first. A read never asks, and an
 * irreversible call never runs without a card.
 */
export type GoogleReadMode = "deny" | "allow";
export type GoogleReversibleMode = "deny" | "ask" | "allow";
export type GoogleIrreversibleMode = "deny" | "ask";

export const GOOGLE_CLASS_MODES = Object.freeze({
  read: ["deny", "allow"],
  reversible: ["deny", "ask", "allow"],
  irreversible: ["deny", "ask"],
} as const satisfies { read: readonly GoogleReadMode[]; reversible: readonly GoogleReversibleMode[]; irreversible: readonly GoogleIrreversibleMode[] });

/** The bounds of every list and number in the block. */
export const GOOGLE_POLICY_BOUNDS = Object.freeze({
  /** Entries in `gmail.send_to`. */
  sendTo: 256,
  /** Label ids in `gmail.hidden_labels`. */
  hiddenLabels: 256,
  /** `gmail.max_recipients`: To, Cc and Bcc of one draft at the catalog's per-field cap. */
  maxRecipients: 3 * GMAIL_LIMITS.recipientsPerField,
  /** `limits.items_per_call`: never above the catalog's ids per call. */
  itemsPerCall: GMAIL_LIMITS.idsPerCall,
  /** `limits.reversible_per_turn`. */
  reversiblePerTurn: 1_000,
});

/**
 * A gog account alias: letters, digits, dots, dashes and underscores, starting
 * with a letter or digit. An address has an `@` and is refused: the address
 * behind the alias lives only in the host's gog home.
 */
export const GOOGLE_ACCOUNT_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const accountAlias = z.string()
  .regex(GOOGLE_ACCOUNT_ALIAS_PATTERN, "Use the gog account alias the host uses (letters, digits, dots, dashes and underscores, at most 64), never an address")
  .refine(alias => alias.toLowerCase() !== "auto", "auto is refused: name the one account alias the host uses");

const sendToEntry = z.string().superRefine((entry, context) => {
  const parsed = parseGoogleAllowListEntry(entry);
  if (!parsed.ok) context.addIssue({ code: "custom", message: `Use self, *@domain for exactly one domain, or one plain address (refused: ${parsed.reason})` });
});

const hiddenLabel = z.string().max(80).refine(isGmailLabelId, "Use a Gmail label id (INBOX, Label_123, …), never a label name");

const count = (max: number) => z.number().int().min(0).max(max);

/**
 * One mode per operation id. The value set is checked against the
 * operation's base class here rather than per key, so the error names the
 * operation and the rule.
 */
const operations = z.partialRecord(z.enum(GOOGLE_OPERATIONS, { error: "Use an operation id from the Google catalog, such as gmail.modify" }), z.enum(GOOGLE_POLICY_MODES))
  .superRefine((overrides, context) => {
    for (const [operation, mode] of Object.entries(overrides) as [GoogleOperation, GooglePolicyMode][]) {
      const base = GOOGLE_OPERATION_SPECS[operation].base;
      if ((GOOGLE_CLASS_MODES[base] as readonly string[]).includes(mode)) continue;
      context.addIssue({ code: "custom", path: [operation], message: base === "irreversible"
        ? `${operation} is irreversible: use deny or ask (an irreversible call always asks)`
        : `${operation} is a read: use deny or allow (a read has no card to ask with)` });
    }
  });

export const GooglePolicySchema = z.strictObject({
  enabled: z.boolean().optional(),
  account: accountAlias.optional(),
  services: z.array(z.enum(GOOGLE_SERVICES, { error: `Use a service with Google operations: ${GOOGLE_SERVICES.join(", ")}` })).max(GOOGLE_SERVICES.length * 4).optional(),
  modes: z.strictObject({
    read: z.enum(GOOGLE_CLASS_MODES.read, { error: "Use deny or allow: a read has no card to ask with" }).optional(),
    reversible: z.enum(GOOGLE_CLASS_MODES.reversible).optional(),
    irreversible: z.enum(GOOGLE_CLASS_MODES.irreversible, { error: "Use deny or ask: an irreversible call always asks, so allow is not accepted" }).optional(),
  }).optional(),
  operations: operations.optional(),
  gmail: z.strictObject({
    send_to: z.array(sendToEntry).max(GOOGLE_POLICY_BOUNDS.sendTo).optional(),
    max_recipients: count(GOOGLE_POLICY_BOUNDS.maxRecipients).optional(),
    hidden_labels: z.array(hiddenLabel).max(GOOGLE_POLICY_BOUNDS.hiddenLabels).optional(),
  }).optional(),
  standalone: z.strictObject({ reversible: z.enum(["deny", "allow"]).optional() }).optional(),
  limits: z.strictObject({
    items_per_call: count(GOOGLE_POLICY_BOUNDS.itemsPerCall).optional(),
    reversible_per_turn: count(GOOGLE_POLICY_BOUNDS.reversiblePerTurn).optional(),
  }).optional(),
});
export type GooglePolicyInput = z.output<typeof GooglePolicySchema>;

/** The resolved block: every field present, defaults filled in. */
export interface GooglePolicy {
  enabled: boolean;
  /** The gog alias, or null when the block names none (Google is then unavailable). */
  account: string | null;
  services: GoogleService[];
  modes: { read: GoogleReadMode; reversible: GoogleReversibleMode; irreversible: GoogleIrreversibleMode };
  operations: Partial<Record<GoogleOperation, GooglePolicyMode>>;
  gmail: { send_to: string[]; max_recipients: number; hidden_labels: string[] };
  standalone: { reversible: "deny" | "allow" };
  limits: { items_per_call: number; reversible_per_turn: number };
}

/**
 * The defaults. Disabled, no account, no service, no recipient and no hidden
 * label: enabling Google needs `enabled: true`, an account and a service, and
 * sending needs a `send_to` entry. The modes read, ask and ask; standalone
 * writes are denied.
 */
export const GOOGLE_POLICY_DEFAULTS: Readonly<GooglePolicy> = Object.freeze({
  enabled: false,
  account: null,
  services: [],
  modes: { read: "allow", reversible: "ask", irreversible: "ask" },
  operations: {},
  gmail: { send_to: [], max_recipients: 10, hidden_labels: [] },
  standalone: { reversible: "deny" },
  limits: { items_per_call: GMAIL_LIMITS.idsPerCall, reversible_per_turn: 25 },
} satisfies GooglePolicy);

/** The block with its defaults filled in, per field; absent, the defaults. Never shares an array with its input or the defaults. */
export function resolveGooglePolicy(block?: GooglePolicyInput): GooglePolicy {
  const defaults = GOOGLE_POLICY_DEFAULTS;
  return {
    enabled: block?.enabled ?? defaults.enabled,
    account: block?.account ?? defaults.account,
    services: [...(block?.services ?? defaults.services)],
    modes: { ...defaults.modes, ...block?.modes },
    operations: { ...block?.operations },
    gmail: {
      send_to: [...(block?.gmail?.send_to ?? defaults.gmail.send_to)],
      max_recipients: block?.gmail?.max_recipients ?? defaults.gmail.max_recipients,
      hidden_labels: [...(block?.gmail?.hidden_labels ?? defaults.gmail.hidden_labels)],
    },
    standalone: { ...defaults.standalone, ...block?.standalone },
    limits: { ...defaults.limits, ...block?.limits },
  };
}

const MODE_ORDER: readonly GooglePolicyMode[] = GOOGLE_POLICY_MODES;
const stricter = (a: GooglePolicyMode, b: GooglePolicyMode): GooglePolicyMode => MODE_ORDER.indexOf(a) <= MODE_ORDER.indexOf(b) ? a : b;

/** A mode capped by what a class may take: an irreversible `allow` becomes `ask`, a read `ask` becomes `deny`, anything unknown `deny`. */
function capped(mode: unknown, effect: GoogleEffectClass): GooglePolicyMode {
  if (!(GOOGLE_POLICY_MODES as readonly unknown[]).includes(mode)) return "deny";
  const allowed: readonly GooglePolicyMode[] = GOOGLE_CLASS_MODES[effect];
  if (allowed.includes(mode as GooglePolicyMode)) return mode as GooglePolicyMode;
  return effect === "irreversible" ? "ask" : "deny";
}

/** Where a call's effective mode came from. */
export type GoogleModeSource = "class" | "operation";

/**
 * Plan §6 step 5: the operation override if there is one, else the class
 * mode, capped by the call's computed class (§5).
 *
 * - While the computed class is the operation's base class, an override
 *   replaces the class mode.
 * - A call that escalated above its base uses the mode of the class it
 *   escalated to, or `deny` if the override is `deny`: with
 *   `reversible: ask` and `gmail.modify: allow`, an archive runs without a
 *   card, and a modify that escalated to irreversible uses
 *   `modes.irreversible`.
 * - The result is always one the computed class may take, so an irreversible
 *   call is never `allow`.
 */
export function effectiveGoogleMode(policy: Pick<GooglePolicy, "modes" | "operations">, operation: GoogleOperation, effect: GoogleEffectClass): { mode: GooglePolicyMode; source: GoogleModeSource } {
  const classMode = capped(policy.modes[effect], effect);
  const override = policy.operations[operation];
  if (override === undefined) return { mode: classMode, source: "class" };
  if (effect === GOOGLE_OPERATION_SPECS[operation].base) return { mode: capped(override, effect), source: "operation" };
  const mode = stricter(capped(override, effect), classMode);
  return { mode, source: mode === classMode && override !== "deny" ? "class" : "operation" };
}
