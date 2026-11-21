import { describe, expect, test } from "bun:test";
import {
  decideGoogleCall, GOOGLE_NOT_FOUND_MESSAGE, resolveGooglePolicy,
  type GoogleDecision, type GoogleDecisionCall, type GoogleDecisionFacts, type GooglePolicy, type GooglePolicyInput,
} from "@schlessera/brain-common/internal/google-operations";

// Odysseus's household mail: ids have Gmail's shapes, addresses live on example.com.
const M1 = "18f3a2b4c5d6e7f1";
const M2 = "18f3a2b4c5d6e7f2";
const M3 = "18f3a2b4c5d6e7f3";
const THREAD = "18f3a2b4c5d6e7f0";
const DRAFT = "r-7350000000000000012";
const PENELOPE = "penelope@example.com";
const TELEMACHUS = "telemachus@example.com";
const EUMAEUS = "eumaeus@pylos.example.org";
const FINGERPRINT = "c".repeat(64);

const policy = (block: GooglePolicyInput = {}): GooglePolicy =>
  resolveGooglePolicy({ enabled: true, account: "ithaca", services: ["gmail"], ...block });

/** Facts for an owner's untainted interactive turn that can show a card and routes to Google. */
const facts = (overrides: Partial<GoogleDecisionFacts> = {}): GoogleDecisionFacts => ({
  principal: "owner", posture: "interactive", tainted: false, card_available: true, routing: "allowed", turn_reversible_items: 0,
  ...overrides,
});

const archive = (ids: string[] = [M1, M2]): GoogleDecisionCall => ({ operation: "gmail.modify", input: { message_ids: ids, remove_label_ids: ["INBOX"] } });
const escalated: GoogleDecisionCall = { operation: "gmail.modify", input: { message_ids: [M1], add_label_ids: ["SPAM"] } };
const trash: GoogleDecisionCall = { operation: "gmail.trash", input: { message_ids: [M1] } };
const threadRead: GoogleDecisionCall = { operation: "gmail.thread.get", input: { target: "thread", id: THREAD } };
const send: GoogleDecisionCall = { operation: "gmail.draft.send", input: { draft_id: DRAFT } };
const draftCreate: GoogleDecisionCall = { operation: "gmail.draft.save", input: { action: "create", to: [PENELOPE], subject: "The loom", body: "Tonight." } };
const draftUpdate: GoogleDecisionCall = {
  operation: "gmail.draft.save", input: { action: "update", draft_id: DRAFT, body: "The shroud is finished." },
  facts: { gmail: { draft: { draft_id: DRAFT, created_by_brain_kit: true, current_fingerprint: FINGERPRINT, recorded_fingerprint: FINGERPRINT } } },
};

/** The parts of a decision a table compares. */
interface Verdict { outcome: GoogleDecision["outcome"]; cause?: string; admission?: string; offers?: { allow_always: boolean; allow_for_session: boolean } }
const verdict = (decision: GoogleDecision): Verdict => decision.outcome === "refused"
  ? { outcome: decision.outcome, cause: decision.cause }
  : decision.outcome === "admitted"
    ? { outcome: decision.outcome, admission: decision.admission }
    : { outcome: decision.outcome, cause: decision.cause, offers: decision.offers };

const refusal = (decision: GoogleDecision) => decision.outcome === "refused" ? { cause: decision.cause, ...decision.error } : { outcome: decision.outcome };

// ------------------------------------------------------------------ the decision table

type Mode = "deny" | "ask" | "allow";
type Kind = "read" | "reversible" | "irreversible" | "escalated";
type Taint = boolean | undefined;
type Standing = "none" | "remembered" | "allowance" | "both";
type Posture = GoogleDecisionFacts["posture"];
type Principal = GoogleDecisionFacts["principal"];
type Routing = GoogleDecisionFacts["routing"];

interface Scenario {
  kind: Kind;
  modes: { read: "deny" | "allow"; reversible: Mode; irreversible: "deny" | "ask" };
  override: Mode | null;
  posture: Posture;
  taint: Taint;
  standing: Standing;
  principal: Principal;
  card: boolean | undefined;
  routing: Routing;
  standaloneReversible: "deny" | "allow";
  turnUsed: number | undefined;
}

/**
 * The representative call of each kind, its class and its base class, from
 * the plan's §4 table: a thread read is a read, an archive is reversible,
 * trash is irreversible, and a modify that adds SPAM escalates from
 * reversible to irreversible. Each acts on the items given here.
 */
const KINDS: Record<Kind, { call: GoogleDecisionCall; computed: "read" | "reversible" | "irreversible"; base: "read" | "reversible" | "irreversible"; entity: string | null }> = {
  read: { call: threadRead, computed: "read", base: "read", entity: null },
  reversible: { call: archive(), computed: "reversible", base: "reversible", entity: "archive" },
  irreversible: { call: trash, computed: "irreversible", base: "irreversible", entity: null },
  escalated: { call: escalated, computed: "irreversible", base: "reversible", entity: "label:SPAM" },
};
const ITEMS = 2;
const PER_TURN = 25;

/**
 * What the plan says the decision is, written from its text (§5, §6, §7,
 * §10 and rulings 1, 4 and 6), not from the implementation.
 */
function expected(s: Scenario): Verdict {
  const refuse = (cause: string) => ({ outcome: "refused" as const, cause });
  const { computed, base } = KINDS[s.kind];
  // §6 step 1: the caller is the brain's owner (Q9).
  if (s.principal === "not_owner") return refuse("not_owner");
  if (s.principal !== "owner") return refuse("no_principal");
  // §5: an override replaces the class mode while the class is the operation's
  // base; a call that escalated uses the escalated class's mode, or the
  // override if that is deny. Deny refuses before any card (§6 step 5).
  let mode: Mode = s.modes[computed];
  let fromOverride = false;
  if (s.override !== null) {
    if (computed === base) { mode = s.override; fromOverride = true; }
    else if (s.override === "deny") { mode = "deny"; fromOverride = true; }
  }
  if (mode === "deny") return refuse(fromOverride ? "operation_denied" : "class_denied");
  // §6 step 7: above reversible_per_turn card-less items, standing admission stops.
  const withinTurn = s.turnUsed !== undefined && s.turnUsed + ITEMS <= PER_TURN;
  // A standalone call has no session (§10); in a session, unknown taint counts as tainted.
  const tainted = s.posture === "standalone" ? false : s.taint !== false;
  const remembered = s.standing === "remembered" || s.standing === "both";
  const allowance = s.standing === "allowance" || s.standing === "both";
  // §6 step 8 and §10: reads run on policy; irreversible calls always ask;
  // a reversible call is admitted untainted by allow or a remembered approval,
  // tainted only by a session allowance, standalone only under
  // standalone.reversible: allow with mode allow.
  let admission: string | null = null;
  let cardCause = "irreversible";
  if (computed === "read") admission = "policy";
  else if (computed === "reversible") {
    if (!withinTurn) cardCause = "turn_limit";
    else if (s.posture === "standalone") {
      if (s.standaloneReversible === "allow" && mode === "allow") admission = "policy";
    } else if (tainted) {
      if (allowance) admission = "session_allowance"; else cardCause = "tainted";
    } else if (mode === "allow") admission = "policy";
    else if (remembered) admission = "remembered_approval";
    else cardCause = "mode_ask";
  }
  // §6 step 9: autonomous turns refuse; voice never grants (ruling 6); a
  // terminal never shows a card and never runs irreversible (ruling 4).
  if (s.posture === "autonomous") return refuse("autonomous_turn");
  if (admission === null) {
    if (s.posture === "voice") return refuse("voice_posture");
    if (s.posture === "standalone") {
      if (computed === "irreversible") return refuse("standalone_irreversible");
      return refuse(s.standaloneReversible === "allow" ? "standalone_needs_card" : "standalone_not_allowed");
    }
    if (s.card !== true) return refuse("no_approval_surface");
    // §6 step 11: a reversible card offers allow always untainted, allow for the session tainted; irreversible neither.
    return { outcome: "needs_card", cause: cardCause,
      offers: { allow_always: computed === "reversible" && !tainted, allow_for_session: computed === "reversible" && tainted } };
  }
  // §6 step 10: a read or a card-less write is routed to recipient google.
  if (s.routing === "recipient_restricted") return refuse("recipient_restricted");
  if (s.routing !== "allowed") return refuse("recipient_unproven");
  return { outcome: "admitted", admission };
}

function run(s: Scenario): GoogleDecision {
  const { call, entity } = KINDS[s.kind];
  const operation = call.operation as "gmail.modify";
  const records = entity === null ? [] : [{ operation, entity }];
  return decideGoogleCall(
    policy({ modes: s.modes, ...(s.override ? { operations: { [call.operation]: s.override } } : {}), standalone: { reversible: s.standaloneReversible } }),
    call,
    {
      principal: s.principal, posture: s.posture, card_available: s.card, routing: s.routing, turn_reversible_items: s.turnUsed,
      ...(s.taint === undefined ? {} : { tainted: s.taint }),
      ...(s.standing === "remembered" || s.standing === "both" ? { remembered_approvals: records } : {}),
      ...(s.standing === "allowance" || s.standing === "both" ? { session_allowances: records.map(record => ({ ...record, remaining_items: 100 })) } : {}),
    },
  );
}

const MODE_SETS = (["deny", "allow"] as const).flatMap(read => (["deny", "ask", "allow"] as const).flatMap(reversible =>
  (["deny", "ask"] as const).map(irreversible => ({ read, reversible, irreversible }))));
/** The overrides the schema accepts for each kind's operation, and none. */
const OVERRIDES: Record<Kind, (Mode | null)[]> = {
  read: [null, "deny", "allow"], reversible: [null, "deny", "ask", "allow"], irreversible: [null, "deny", "ask"], escalated: [null, "deny", "ask", "allow"],
};
const POSTURES: Posture[] = ["interactive", "voice", "autonomous", "standalone"];
const TAINTS: Taint[] = [false, true, undefined];
const STANDINGS: Standing[] = ["none", "remembered", "allowance", "both"];
const PRINCIPALS: Principal[] = ["owner", "not_owner", "none"];
const describeScenario = (s: Scenario) => JSON.stringify(s);

/** Rows that disagree with the plan, with both sides. */
function mismatches(scenarios: Scenario[]): string[] {
  return scenarios.flatMap(s => {
    const want = expected(s);
    const got = verdict(run(s));
    return JSON.stringify(got) === JSON.stringify(want) ? [] : [`${describeScenario(s)}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
  });
}

describe("decision table: mode × class × posture × taint × standing admission × principal", () => {
  for (const kind of Object.keys(KINDS) as Kind[]) {
    for (const posture of POSTURES) {
      test(`${kind} calls in the ${posture} posture decide as the plan says`, () => {
        const scenarios = MODE_SETS.flatMap(modes => OVERRIDES[kind].flatMap(override => TAINTS.flatMap(taint => STANDINGS.flatMap(standing =>
          PRINCIPALS.map((principal): Scenario => ({ kind, modes, override, posture, taint, standing, principal,
            card: true, routing: "allowed", standaloneReversible: "allow", turnUsed: 0 }))))));
        expect(scenarios.length).toBe(MODE_SETS.length * OVERRIDES[kind].length * TAINTS.length * STANDINGS.length * PRINCIPALS.length);
        expect(mismatches(scenarios)).toEqual([]);
      });
    }
  }
});

describe("decision table: card availability × routing × standalone key × turn count", () => {
  for (const kind of Object.keys(KINDS) as Kind[]) {
    for (const posture of POSTURES) {
      test(`${kind} calls in the ${posture} posture decide as the plan says`, () => {
        const scenarios = MODE_SETS.flatMap(modes => TAINTS.flatMap(taint => STANDINGS.flatMap(standing =>
          [true, false, undefined].flatMap(card => (["allowed", "recipient_restricted", "recipient_unproven", undefined] as Routing[]).flatMap(routing =>
            (["deny", "allow"] as const).flatMap(standaloneReversible => [0, PER_TURN - ITEMS, PER_TURN - ITEMS + 1, undefined].map((turnUsed): Scenario =>
              ({ kind, modes, override: null, posture, taint, standing, principal: "owner", card, routing, standaloneReversible, turnUsed }))))))));
        expect(scenarios.length).toBe(MODE_SETS.length * TAINTS.length * STANDINGS.length * 3 * 4 * 2 * 4);
        expect(mismatches(scenarios)).toEqual([]);
      });
    }
  }

  test("the table reaches every outcome the plan names", () => {
    const seen = new Set<string>();
    for (const kind of Object.keys(KINDS) as Kind[]) for (const posture of POSTURES) for (const taint of TAINTS) for (const standing of STANDINGS)
      for (const modes of MODE_SETS) for (const turnUsed of [0, undefined]) for (const standaloneReversible of ["deny", "allow"] as const) {
        const got = verdict(run({ kind, modes, override: null, posture, taint, standing, principal: "owner", card: true, routing: "allowed", standaloneReversible, turnUsed }));
        seen.add(`${got.outcome}:${got.cause ?? got.admission}`);
      }
    expect([...seen].sort()).toEqual([
      "admitted:policy", "admitted:remembered_approval", "admitted:session_allowance",
      "needs_card:irreversible", "needs_card:mode_ask", "needs_card:tainted", "needs_card:turn_limit",
      "refused:autonomous_turn", "refused:class_denied", "refused:standalone_irreversible", "refused:standalone_needs_card",
      "refused:standalone_not_allowed", "refused:voice_posture",
    ]);
  });
});

// ------------------------------------------------------------------ overrides

describe("an operation override is capped by the computed class", () => {
  const block = { modes: { reversible: "ask", irreversible: "ask" }, operations: { "gmail.modify": "allow" } } as const;

  test("reversible: ask with gmail.modify: allow admits a reversible modify without a card", () => {
    const decision = decideGoogleCall(policy(block), archive(), facts());
    expect(verdict(decision)).toEqual({ outcome: "admitted", admission: "policy" });
    expect([decision.mode, decision.mode_source, decision.effect]).toEqual(["allow", "operation", "reversible"]);
  });

  test("the same policy still asks for a reversible draft, which has no override", () => {
    expect(verdict(decideGoogleCall(policy(block), draftCreate, facts()))).toEqual(
      { outcome: "needs_card", cause: "mode_ask", offers: { allow_always: true, allow_for_session: false } });
  });

  test("a modify that escalated to irreversible uses modes.irreversible: ask asks", () => {
    const decision = decideGoogleCall(policy(block), escalated, facts());
    expect(verdict(decision)).toEqual({ outcome: "needs_card", cause: "irreversible", offers: { allow_always: false, allow_for_session: false } });
    expect([decision.mode, decision.mode_source, decision.effect]).toEqual(["ask", "class", "irreversible"]);
  });

  test("a modify that escalated to irreversible uses modes.irreversible: deny refuses", () => {
    expect(refusal(decideGoogleCall(policy({ ...block, modes: { reversible: "ask", irreversible: "deny" } }), escalated, facts()))).toMatchObject(
      { cause: "class_denied", code: "policy_denied" });
  });

  test("an override of deny refuses the escalated call too", () => {
    expect(refusal(decideGoogleCall(policy({ operations: { "gmail.modify": "deny" } }), escalated, facts()))).toMatchObject(
      { cause: "operation_denied", code: "policy_denied", reason: "operation_denied" });
  });

  test("an override of deny refuses an operation whose class mode allows", () => {
    expect(refusal(decideGoogleCall(policy({ modes: { read: "allow" }, operations: { "gmail.thread.get": "deny" } }), threadRead, facts()))).toMatchObject(
      { cause: "operation_denied", code: "policy_denied" });
  });

  test("an override of allow opens one read operation under read: deny", () => {
    const opened = policy({ modes: { read: "deny" }, operations: { "gmail.labels.list": "allow" } });
    expect(verdict(decideGoogleCall(opened, { operation: "gmail.labels.list", input: { target: "labels" } }, facts()))).toEqual({ outcome: "admitted", admission: "policy" });
    expect(refusal(decideGoogleCall(opened, threadRead, facts()))).toMatchObject({ cause: "class_denied", code: "policy_denied" });
  });

  test("an allow that reaches an irreversible call by hand is capped to ask", () => {
    const widened = { ...policy(), modes: { read: "allow", reversible: "ask", irreversible: "allow" } } as unknown as GooglePolicy;
    expect(verdict(decideGoogleCall(widened, trash, facts()))).toEqual({ outcome: "needs_card", cause: "irreversible", offers: { allow_always: false, allow_for_session: false } });
    const overridden = { ...policy(), operations: { "gmail.trash": "allow" } } as unknown as GooglePolicy;
    expect(verdict(decideGoogleCall(overridden, trash, facts()))).toEqual({ outcome: "needs_card", cause: "irreversible", offers: { allow_always: false, allow_for_session: false } });
  });
});

// ------------------------------------------------------------------ entities: send_to and self

describe("send recipients", () => {
  const sendTo = (send_to: string[], extra: GooglePolicyInput["gmail"] = {}) => policy({ gmail: { send_to, ...extra } });

  test("an empty send_to refuses every send, whatever the recipients", () => {
    for (const recipients of [[PENELOPE], [TELEMACHUS, PENELOPE], [EUMAEUS], ["Penelope <penelope@example.com>"]]) {
      expect(refusal(decideGoogleCall(sendTo([]), send, facts({ recipients, self_addresses: [PENELOPE] }))), JSON.stringify(recipients)).toMatchObject(
        { cause: "send_to_empty", code: "policy_denied" });
    }
  });

  test("a send whose every recipient matches asks once, with no standing choice", () => {
    expect(verdict(decideGoogleCall(sendTo(["*@example.com"]), send, facts({ recipients: [PENELOPE, "Telemachus <telemachus@example.com>"] })))).toEqual(
      { outcome: "needs_card", cause: "irreversible", offers: { allow_always: false, allow_for_session: false } });
  });

  test("one recipient outside send_to refuses the send", () => {
    expect(refusal(decideGoogleCall(sendTo(["*@example.com"]), send, facts({ recipients: [PENELOPE, EUMAEUS] })))).toMatchObject(
      { cause: "recipient_not_allowed", code: "policy_denied" });
    // No subdomain match.
    expect(refusal(decideGoogleCall(sendTo(["*@example.com"]), send, facts({ recipients: ["argos@kennel.example.com"] })))).toMatchObject(
      { cause: "recipient_not_allowed" });
  });

  test("self matches only the addresses the host resolved", () => {
    const selfOnly = sendTo(["self"]);
    expect(verdict(decideGoogleCall(selfOnly, send, facts({ recipients: [PENELOPE], self_addresses: [PENELOPE] }))).outcome).toBe("needs_card");
    expect(refusal(decideGoogleCall(selfOnly, send, facts({ recipients: [PENELOPE], self_addresses: [TELEMACHUS] })))).toMatchObject({ cause: "recipient_not_allowed" });
    expect(refusal(decideGoogleCall(selfOnly, send, facts({ recipients: [PENELOPE], self_addresses: [] })))).toMatchObject({ cause: "recipient_not_allowed" });
    expect(refusal(decideGoogleCall(selfOnly, send, facts({ recipients: [PENELOPE] })))).toMatchObject({ cause: "recipient_not_allowed" });
    // The literal word is not an address a recipient can spell.
    expect(refusal(decideGoogleCall(selfOnly, send, facts({ recipients: ["self"], self_addresses: [PENELOPE] })))).toMatchObject({ cause: "recipient_not_allowed" });
  });

  test("max_recipients bounds a send: at the limit it asks, one above refuses", () => {
    const two = sendTo(["*@example.com"], { max_recipients: 2 });
    expect(verdict(decideGoogleCall(two, send, facts({ recipients: [PENELOPE, TELEMACHUS] }))).outcome).toBe("needs_card");
    expect(refusal(decideGoogleCall(two, send, facts({ recipients: [PENELOPE, TELEMACHUS, "eurycleia@example.com"] })))).toMatchObject(
      { cause: "too_many_recipients", code: "policy_denied" });
  });

  test("recipients the host could not read, or none, refuse the send", () => {
    const open = sendTo(["*@example.com"]);
    expect(refusal(decideGoogleCall(open, send, facts()))).toMatchObject({ cause: "recipients_unknown", code: "policy_denied" });
    expect(refusal(decideGoogleCall(open, send, facts({ recipients: [PENELOPE, 7] as never })))).toMatchObject({ cause: "recipients_unknown" });
    expect(refusal(decideGoogleCall(open, send, facts({ recipients: [] })))).toMatchObject({ cause: "no_recipients" });
  });

  test("a recipient the strict parser refuses matches nothing", () => {
    expect(refusal(decideGoogleCall(sendTo(["*@example.com"]), send, facts({ recipients: ["suitors: antinous@example.com;"] })))).toMatchObject(
      { cause: "recipient_not_allowed" });
  });
});

// ------------------------------------------------------------------ entities: hidden labels

describe("hidden labels", () => {
  const hidden = policy({ modes: { reversible: "allow" }, gmail: { send_to: ["*@example.com"], hidden_labels: ["Label_7"] } });
  const targets: [string, GoogleDecisionCall][] = [
    ["a thread read", threadRead],
    ["a message read", { operation: "gmail.message.get", input: { target: "message", id: M1 } }],
    ["a draft read", { operation: "gmail.draft.get", input: { target: "draft", id: DRAFT } }],
    ["a modify", archive()],
    ["a trash", trash],
    ["a reply", { operation: "gmail.draft.save", input: { action: "reply", message_id: M1, body: "Home soon." } }],
    ["a quoting draft", { operation: "gmail.draft.save", input: { action: "create", to: [PENELOPE], subject: "Fwd", body: "See below.", quote_message_id: M1 } }],
    ["a draft update", draftUpdate],
    ["a draft delete", { operation: "gmail.draft.delete", input: { action: "delete", draft_id: DRAFT } }],
    ["a send", send],
  ];

  test("every call whose target carries a hidden label refuses exactly as a missing one does", () => {
    const answers = targets.map(([name, call]) => [name, refusal(decideGoogleCall(hidden, call, facts({ target_label_ids: ["INBOX", "Label_7"], recipients: [PENELOPE] })))]);
    expect(answers).toEqual(targets.map(([name]) => [name, { cause: "hidden_label", code: "not_found", reason: null, message: GOOGLE_NOT_FOUND_MESSAGE }]));
  });

  test("the same calls proceed when no target label is hidden", () => {
    const outcomes = targets.map(([name, call]) => [name, decideGoogleCall(hidden, call, facts({ target_label_ids: ["INBOX", "Label_8"], recipients: [PENELOPE] })).outcome]);
    expect(outcomes.filter(([, outcome]) => outcome === "refused")).toEqual([]);
    expect(outcomes.length).toBe(10);
  });

  test("targets whose labels the host did not supply refuse while a label is hidden", () => {
    expect(refusal(decideGoogleCall(hidden, threadRead, facts()))).toMatchObject({ cause: "target_labels_unknown", code: "policy_denied" });
    expect(refusal(decideGoogleCall(hidden, archive(), facts({ target_label_ids: "Label_8" as never })))).toMatchObject({ cause: "target_labels_unknown" });
  });

  test("a search, the label list and a fresh draft have no target, so need no labels", () => {
    for (const call of [{ operation: "gmail.search", input: { query: "from:penelope@example.com" } }, { operation: "gmail.labels.list", input: { target: "labels" } }, draftCreate]) {
      expect(decideGoogleCall(hidden, call, facts()).outcome, call.operation).toBe("admitted");
    }
  });

  test("without hidden labels a target needs no label facts", () => {
    expect(verdict(decideGoogleCall(policy(), threadRead, facts()))).toEqual({ outcome: "admitted", admission: "policy" });
  });

  test("a hidden target is refused before its recipients are judged", () => {
    expect(refusal(decideGoogleCall(policy({ gmail: { hidden_labels: ["Label_7"] } }), send, facts({ target_label_ids: ["Label_7"], recipients: [EUMAEUS] })))).toMatchObject(
      { cause: "hidden_label", code: "not_found" });
  });
});

// ------------------------------------------------------------------ limits

describe("limits", () => {
  const allow = (limits: GooglePolicyInput["limits"] = {}) => policy({ modes: { reversible: "allow" }, limits });

  test("reversible_per_turn: card-less items up to the limit admit, one above asks", () => {
    expect(verdict(decideGoogleCall(allow({ reversible_per_turn: 5 }), archive(), facts({ turn_reversible_items: 3 })))).toEqual({ outcome: "admitted", admission: "policy" });
    expect(verdict(decideGoogleCall(allow({ reversible_per_turn: 5 }), archive(), facts({ turn_reversible_items: 4 })))).toEqual(
      { outcome: "needs_card", cause: "turn_limit", offers: { allow_always: true, allow_for_session: false } });
  });

  test("reversible_per_turn: 0 makes every reversible call ask", () => {
    expect(verdict(decideGoogleCall(allow({ reversible_per_turn: 0 }), draftCreate, facts())).outcome).toBe("needs_card");
  });

  test("an unknown or malformed turn count stops standing admission", () => {
    for (const turn_reversible_items of [undefined, -1, 1.5, "0"] as never[]) {
      expect(verdict(decideGoogleCall(allow(), archive(), facts({ turn_reversible_items }))), String(turn_reversible_items)).toEqual(
        { outcome: "needs_card", cause: "turn_limit", offers: { allow_always: true, allow_for_session: false } });
    }
  });

  test("the turn limit stops a session allowance too", () => {
    const allowance = { session_allowances: [{ operation: "gmail.modify" as const, entity: "archive", remaining_items: 100 }] };
    expect(verdict(decideGoogleCall(allow({ reversible_per_turn: 2 }), archive(), facts({ tainted: true, ...allowance, turn_reversible_items: 0 }))).outcome).toBe("admitted");
    expect(verdict(decideGoogleCall(allow({ reversible_per_turn: 2 }), archive(), facts({ tainted: true, ...allowance, turn_reversible_items: 1 })))).toMatchObject(
      { outcome: "needs_card", cause: "turn_limit" });
  });

  test("items_per_call: ids up to the limit proceed, one above refuses", () => {
    expect(decideGoogleCall(allow({ items_per_call: 3 }), archive([M1, M2, M3]), facts()).outcome).toBe("admitted");
    expect(refusal(decideGoogleCall(allow({ items_per_call: 2 }), archive([M1, M2, M3]), facts()))).toMatchObject({ cause: "items_per_call", code: "policy_denied" });
    expect(refusal(decideGoogleCall(allow({ items_per_call: 2 }), { operation: "gmail.trash", input: { message_ids: [M1, M2, M3] } }, facts()))).toMatchObject(
      { cause: "items_per_call" });
  });

  test("a thread target counts the messages the host resolved", () => {
    const threads: GoogleDecisionCall = { operation: "gmail.modify", input: { thread_ids: [THREAD], remove_label_ids: ["INBOX"] } };
    expect(refusal(decideGoogleCall(allow({ items_per_call: 3 }), threads, facts({ items: 4 })))).toMatchObject({ cause: "items_per_call" });
    const admitted = decideGoogleCall(allow({ items_per_call: 3 }), threads, facts({ items: 3 }));
    expect([admitted.outcome, admitted.items]).toEqual(["admitted", 3]);
    expect(refusal(decideGoogleCall(allow(), threads, facts()))).toMatchObject({ cause: "item_count_unknown", code: "policy_denied" });
  });

  test("a resolved count never lowers the ids given", () => {
    expect(refusal(decideGoogleCall(allow({ items_per_call: 2 }), archive([M1, M2, M3]), facts({ items: 1 })))).toMatchObject({ cause: "items_per_call" });
  });
});

// ------------------------------------------------------------------ standing admission

describe("standing admission", () => {
  const ask = policy({ modes: { reversible: "ask" } });
  const remembered = (entities: string[], operation = "gmail.modify") => ({ remembered_approvals: entities.map(entity => ({ operation, entity })) as never });
  const allowances = (entities: string[], remaining_items = 100, operation = "gmail.modify") =>
    ({ session_allowances: entities.map(entity => ({ operation, entity, remaining_items })) as never });

  test("taint switches standing admission from remembered approvals to session allowances", () => {
    const both = { ...remembered(["archive"]), ...allowances(["archive"]) };
    expect(verdict(decideGoogleCall(ask, archive(), facts({ tainted: false, ...remembered(["archive"]) })))).toEqual({ outcome: "admitted", admission: "remembered_approval" });
    expect(verdict(decideGoogleCall(ask, archive(), facts({ tainted: true, ...remembered(["archive"]) })))).toEqual(
      { outcome: "needs_card", cause: "tainted", offers: { allow_always: false, allow_for_session: true } });
    expect(verdict(decideGoogleCall(ask, archive(), facts({ tainted: true, ...allowances(["archive"]) })))).toEqual({ outcome: "admitted", admission: "session_allowance" });
    expect(verdict(decideGoogleCall(ask, archive(), facts({ tainted: false, ...allowances(["archive"]) })))).toEqual(
      { outcome: "needs_card", cause: "mode_ask", offers: { allow_always: true, allow_for_session: false } });
    expect(verdict(decideGoogleCall(ask, archive(), facts({ tainted: true, ...both }))).admission).toBe("session_allowance");
  });

  test("policy allow admits untainted and asks tainted", () => {
    const allow = policy({ modes: { reversible: "allow" } });
    expect(verdict(decideGoogleCall(allow, archive(), facts({ tainted: false })))).toEqual({ outcome: "admitted", admission: "policy" });
    expect(verdict(decideGoogleCall(allow, archive(), facts({ tainted: true })))).toMatchObject({ outcome: "needs_card", cause: "tainted" });
  });

  test("a standing record must cover every action of a modify", () => {
    const archiveAndRead: GoogleDecisionCall = { operation: "gmail.modify", input: { message_ids: [M1], remove_label_ids: ["INBOX", "UNREAD"] } };
    expect(decideGoogleCall(ask, archiveAndRead, facts()).entities).toEqual(["archive", "mark_read"]);
    expect(verdict(decideGoogleCall(ask, archiveAndRead, facts(remembered(["archive"])))).outcome).toBe("needs_card");
    expect(verdict(decideGoogleCall(ask, archiveAndRead, facts(remembered(["archive", "mark_read"])))).admission).toBe("remembered_approval");
    expect(verdict(decideGoogleCall(ask, archiveAndRead, facts({ tainted: true, ...allowances(["mark_read"]) }))).outcome).toBe("needs_card");
    expect(verdict(decideGoogleCall(ask, archiveAndRead, facts({ tainted: true, ...allowances(["archive", "mark_read"]) }))).admission).toBe("session_allowance");
  });

  test("a standing record for another operation or entity admits nothing", () => {
    expect(verdict(decideGoogleCall(ask, archive(), facts(remembered(["archive"], "gmail.trash")))).outcome).toBe("needs_card");
    expect(verdict(decideGoogleCall(ask, archive(), facts(remembered(["unarchive"])))).outcome).toBe("needs_card");
    expect(verdict(decideGoogleCall(ask, draftCreate, facts(remembered(["drafts"], "gmail.draft.save")))).admission).toBe("remembered_approval");
  });

  test("a session allowance admits only with room for every item", () => {
    const tainted = { tainted: true };
    expect(verdict(decideGoogleCall(ask, archive([M1, M2]), facts({ ...tainted, ...allowances(["archive"], 2) }))).admission).toBe("session_allowance");
    expect(verdict(decideGoogleCall(ask, archive([M1, M2]), facts({ ...tainted, ...allowances(["archive"], 1) })))).toMatchObject({ outcome: "needs_card", cause: "tainted" });
    for (const remaining of [101, -1, 2.5, "50"] as never[]) {
      expect(verdict(decideGoogleCall(ask, archive(), facts({ ...tainted, ...allowances(["archive"], remaining) }))).outcome, String(remaining)).toBe("needs_card");
    }
  });

  test("irreversible calls ask whatever is remembered or allowed", () => {
    const allowTrash = { ...remembered([""], "gmail.trash"), ...allowances([""], 100, "gmail.trash") };
    expect(verdict(decideGoogleCall(policy(), trash, facts(allowTrash)))).toMatchObject({ outcome: "needs_card", cause: "irreversible" });
    expect(verdict(decideGoogleCall(policy(), escalated, facts(remembered(["label:SPAM"]))))).toMatchObject({ outcome: "needs_card", cause: "irreversible" });
  });
});

// ------------------------------------------------------------------ postures

describe("postures", () => {
  const allow = policy({ modes: { reversible: "allow" }, standalone: { reversible: "allow" } });

  test("voice runs what standing admission admits, a session allowance included", () => {
    const voice = facts({ posture: "voice" });
    expect(verdict(decideGoogleCall(policy(), threadRead, voice))).toEqual({ outcome: "admitted", admission: "policy" });
    expect(verdict(decideGoogleCall(allow, archive(), voice))).toEqual({ outcome: "admitted", admission: "policy" });
    expect(verdict(decideGoogleCall(policy(), archive(), { ...voice, tainted: true, session_allowances: [{ operation: "gmail.modify", entity: "archive", remaining_items: 10 }] })))
      .toEqual({ outcome: "admitted", admission: "session_allowance" });
  });

  test("voice refuses a call that needs a card, as GitHub writes do", () => {
    for (const call of [archive(), trash, draftCreate]) {
      expect(refusal(decideGoogleCall(policy(), call, facts({ posture: "voice" }))), call.operation).toMatchObject(
        { cause: "voice_posture", code: "approval_declined", reason: "voice_posture" });
    }
  });

  test("an autonomous turn refuses reads and writes", () => {
    for (const call of [threadRead, archive(), trash]) {
      expect(refusal(decideGoogleCall(allow, call, facts({ posture: "autonomous" }))), call.operation).toMatchObject({ cause: "autonomous_turn", code: "policy_denied" });
    }
  });

  test("standalone admits a reversible call only under standalone.reversible: allow with mode allow", () => {
    const terminal = facts({ posture: "standalone" });
    expect(verdict(decideGoogleCall(allow, archive(), terminal))).toEqual({ outcome: "admitted", admission: "policy" });
    expect(refusal(decideGoogleCall(policy({ modes: { reversible: "allow" } }), archive(), terminal))).toMatchObject({ cause: "standalone_not_allowed", code: "policy_denied" });
    expect(refusal(decideGoogleCall(policy({ modes: { reversible: "ask" }, standalone: { reversible: "allow" } }), archive(), terminal))).toMatchObject(
      { cause: "standalone_needs_card", code: "policy_denied" });
  });

  test("standalone never runs an irreversible call", () => {
    for (const call of [trash, escalated]) {
      expect(refusal(decideGoogleCall(allow, call, facts({ posture: "standalone" }))), call.operation).toMatchObject({ cause: "standalone_irreversible" });
    }
    expect(refusal(decideGoogleCall(policy({ gmail: { send_to: ["*@example.com"] }, standalone: { reversible: "allow" } }), send,
      facts({ posture: "standalone", recipients: [PENELOPE] })))).toMatchObject({ cause: "standalone_irreversible" });
  });

  test("standalone has no taint and no standing approvals", () => {
    const decision = decideGoogleCall(allow, archive(), facts({ posture: "standalone", tainted: true }));
    expect([decision.outcome, decision.tainted]).toEqual(["admitted", false]);
    const remembered = { remembered_approvals: [{ operation: "gmail.modify" as const, entity: "archive" }], session_allowances: [{ operation: "gmail.modify" as const, entity: "archive", remaining_items: 100 }] };
    expect(refusal(decideGoogleCall(policy({ standalone: { reversible: "allow" } }), archive(), facts({ posture: "standalone", ...remembered })))).toMatchObject(
      { cause: "standalone_needs_card" });
  });

  test("standalone escalates a draft update whatever the host's draft facts say", () => {
    expect(verdict(decideGoogleCall(allow, draftUpdate, facts())).outcome).toBe("admitted");
    const terminal = decideGoogleCall(allow, draftUpdate, facts({ posture: "standalone" }));
    expect([refusal(terminal), terminal.effect]).toEqual([expect.objectContaining({ cause: "standalone_irreversible" }), "irreversible"]);
  });

  test("standalone reads run on their mode", () => {
    expect(verdict(decideGoogleCall(policy(), threadRead, facts({ posture: "standalone" })))).toEqual({ outcome: "admitted", admission: "policy" });
    expect(refusal(decideGoogleCall(policy({ modes: { read: "deny" } }), threadRead, facts({ posture: "standalone" })))).toMatchObject({ cause: "class_denied" });
  });

  test("an interactive turn that cannot show a card refuses what needs one", () => {
    expect(refusal(decideGoogleCall(policy(), archive(), facts({ card_available: false })))).toMatchObject({ cause: "no_approval_surface", code: "policy_denied" });
    expect(refusal(decideGoogleCall(policy(), archive(), facts({ card_available: undefined })))).toMatchObject({ cause: "no_approval_surface" });
    expect(verdict(decideGoogleCall(allow, archive(), facts({ card_available: false })))).toEqual({ outcome: "admitted", admission: "policy" });
  });
});

// ------------------------------------------------------------------ routing

describe("routing", () => {
  const allow = policy({ modes: { reversible: "allow" } });

  test("a read and a card-less write are routed to recipient google", () => {
    for (const call of [threadRead, archive()]) {
      expect(refusal(decideGoogleCall(allow, call, facts({ routing: "recipient_restricted" }))), call.operation).toMatchObject({ cause: "recipient_restricted", code: "policy_denied" });
      expect(refusal(decideGoogleCall(allow, call, facts({ routing: "recipient_unproven" }))), call.operation).toMatchObject({ cause: "recipient_unproven" });
      expect(refusal(decideGoogleCall(allow, call, facts({ routing: undefined }))), call.operation).toMatchObject({ cause: "recipient_unproven" });
    }
  });

  test("a write whose exact payload is on a card is gated by the card, not routed", () => {
    expect(verdict(decideGoogleCall(policy(), archive(), facts({ routing: "recipient_restricted" }))).outcome).toBe("needs_card");
    expect(verdict(decideGoogleCall(policy(), trash, facts({ routing: undefined }))).outcome).toBe("needs_card");
  });
});

// ------------------------------------------------------------------ cards

describe("card offers", () => {
  test("a reversible card offers allow always untainted and allow for the session tainted, an irreversible card neither", () => {
    const offers = (call: GoogleDecisionCall, tainted: boolean | undefined) => {
      const decision = decideGoogleCall(policy({ gmail: { send_to: ["*@example.com"] } }), call, { ...facts({ recipients: [PENELOPE] }), tainted });
      return decision.outcome === "needs_card" ? decision.offers : decision.outcome;
    };
    expect([offers(archive(), false), offers(archive(), true), offers(archive(), undefined), offers(draftCreate, false), offers(draftCreate, true)]).toEqual([
      { allow_always: true, allow_for_session: false }, { allow_always: false, allow_for_session: true }, { allow_always: false, allow_for_session: true },
      { allow_always: true, allow_for_session: false }, { allow_always: false, allow_for_session: true },
    ]);
    const deleteDraft = { operation: "gmail.draft.delete", input: { action: "delete", draft_id: DRAFT } };
    for (const call of [trash, escalated, send, deleteDraft]) {
      for (const tainted of [false, true]) expect(offers(call, tainted), `${call.operation} ${tainted}`).toEqual({ allow_always: false, allow_for_session: false });
    }
  });

  test("a card names the entities a standing choice would cover", () => {
    const decision = decideGoogleCall(policy(), { operation: "gmail.modify", input: { message_ids: [M1], add_label_ids: ["Label_3", "STARRED"] } }, facts());
    expect([decision.outcome, decision.entities, decision.items]).toEqual(["needs_card", ["label:Label_3", "star"], 1]);
  });
});

// ------------------------------------------------------------------ availability and input

describe("availability", () => {
  test("an absent or disabled block leaves Google unavailable", () => {
    for (const block of [undefined, null, resolveGooglePolicy(), resolveGooglePolicy({ enabled: false, account: "ithaca", services: ["gmail"] })]) {
      expect(refusal(decideGoogleCall(block, threadRead, facts()))).toMatchObject({ cause: "not_enabled", code: "unavailable" });
    }
  });

  test("an enabled block without an account or with the service unlisted is unavailable", () => {
    expect(refusal(decideGoogleCall(resolveGooglePolicy({ enabled: true, services: ["gmail"] }), threadRead, facts()))).toMatchObject({ cause: "no_account", code: "unavailable" });
    expect(refusal(decideGoogleCall(resolveGooglePolicy({ enabled: true, account: "ithaca" }), threadRead, facts()))).toMatchObject(
      { cause: "service_not_enabled", code: "unavailable", message: "Gmail is not enabled: the policy's google.services does not list it." });
  });

  test("a block that cannot be read is unavailable rather than read loosely", () => {
    const base = policy({ modes: { reversible: "allow" } });
    for (const broken of [
      { ...base, limits: { ...base.limits, items_per_call: "lots" } },
      { ...base, limits: { ...base.limits, reversible_per_turn: 5_000 } },
      { ...base, gmail: { ...base.gmail, send_to: "*@example.com" } },
      { ...base, gmail: { ...base.gmail, hidden_labels: undefined } },
      { ...base, account: "auto" },
      { ...base, services: ["gmail", "calendar"] },
      { ...base, operations: { "gmail.filters.create": "allow" } },
      "enabled",
    ]) {
      expect(refusal(decideGoogleCall(broken as never, archive(), facts())), JSON.stringify(broken).slice(0, 80)).toMatchObject({ cause: "policy_invalid", code: "unavailable" });
    }
  });

  test("only the owner may call", () => {
    expect(refusal(decideGoogleCall(policy(), threadRead, facts({ principal: "not_owner" })))).toMatchObject({ cause: "not_owner", code: "policy_denied" });
    for (const principal of ["none", undefined, "admin"] as never[]) {
      expect(refusal(decideGoogleCall(policy(), threadRead, facts({ principal }))), String(principal)).toMatchObject({ cause: "no_principal", code: "policy_denied" });
    }
    expect(refusal(decideGoogleCall(policy(), threadRead, null as never))).toMatchObject({ cause: "no_principal" });
  });

  test("an unknown posture refuses, never admits", () => {
    expect(refusal(decideGoogleCall(policy(), threadRead, facts({ posture: "dictation" as never })))).toMatchObject({ cause: "posture_unknown", code: "policy_denied" });
  });
});

describe("input", () => {
  test("an unknown operation, a refused input and an input naming another operation are invalid input", () => {
    expect(refusal(decideGoogleCall(policy(), { operation: "gmail.filters.create", input: {} }, facts()))).toMatchObject({ cause: "unknown_operation", code: "invalid_input" });
    expect(refusal(decideGoogleCall(policy(), { operation: "gmail.search", input: { query: "is:unread", raw: true } }, facts()))).toMatchObject({ cause: "schema", code: "invalid_input" });
    expect(refusal(decideGoogleCall(policy(), { operation: "gmail.draft.save", input: { action: "delete", draft_id: DRAFT } }, facts()))).toMatchObject(
      { cause: "operation_mismatch", code: "invalid_input" });
  });

  test("a class the host supplies can only raise the computed class", () => {
    const allow = policy({ modes: { reversible: "allow" } });
    expect(decideGoogleCall(allow, { ...archive(), effect: "read" }, facts()).effect).toBe("reversible");
    expect(verdict(decideGoogleCall(allow, { ...archive(), effect: "irreversible" }, facts()))).toMatchObject({ outcome: "needs_card", cause: "irreversible" });
    expect(decideGoogleCall(allow, { ...archive(), effect: "harmless" as never }, facts()).effect).toBe("irreversible");
  });

  test("a failure to decide refuses instead of throwing", () => {
    const hostile = { ...facts(), get tainted(): never { throw new Error("session store unreadable"); } };
    expect(refusal(decideGoogleCall(policy(), threadRead, hostile))).toMatchObject({ cause: "decision_error", code: "unavailable" });
  });
});
