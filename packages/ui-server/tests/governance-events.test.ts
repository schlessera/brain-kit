import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import {
  bindTurnEvents,
  GOVERNANCE_EVENT_KINDS,
  GOVERNANCE_EVENT_SCHEMAS,
  GOVERNANCE_PAYLOAD_MAX_BYTES,
  GovernanceEventError,
  queryGovernanceEvents,
  recordGovernanceEvent,
  UNBOUND_GOVERNANCE_RETENTION_MS,
  type GovernanceEventInput,
  type GovernanceEventKind,
  type GovernanceEventPayload,
} from "../src/governance/events.js";
import { httpSpecification } from "./helpers/http-spec";
import { handleTurnTemp } from "@schlessera/brain-ui-sdk/server";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** One valid v1 payload per kind, in the Odysseus world. */
const SAMPLE_PAYLOADS: { [K in GovernanceEventKind]: GovernanceEventPayload<K> } = {
  policy_change: { requestId: "policy-ithaca", baseHash: null, proposedHash: "a".repeat(64), sections: ["profiles.interactive"], outcome: "updated" },
  state_room_warning: { usedBytes: 51 * 1024 * 1024, allowanceBytes: 64 * 1024 * 1024, observedAt: Date.UTC(2026, 6, 12) },
  scratch_overage: { bytes: 1_200_000_000, pinnedFiles: 3, pinnedBytes: 1_200_000_000, overageBytes: 126_258_176 },
  promotion: { source: "/tmp/brain-worker/ithaca-route.pdf", destination: ".brain/scratch/turns/turn-ithaca/ithaca-route.pdf", bytes: 48_213, originalLink: "/tmp/brain-worker/ithaca-route.pdf", rewrittenLink: ".brain/scratch/turns/turn-ithaca/ithaca-route.pdf" },
  promotion_refused: { source: "/tmp/brain-worker/cyclops-cave", originalLink: "/tmp/brain-worker/cyclops-cave", reason: "not_regular_file", bytes: null, limitBytes: null },
  turn_temp_purge: { truncated: false, all: false, force: false, paths: ["brain-worker-scratch/frames"], removedEntries: 41, freedBytes: 96_468_992, skippedLinked: ["/tmp/brain-worker-scratch/ithaca-route.pdf"], skippedOther: 0, usedBytes: 12_288_000, limitBytes: 268_435_456 },
  policy_block: { tool: "Bash", input: "git push --force origin main", inputTruncated: false, rule: { list: "commands.deny", index: 0, pattern: "^git push (-f|--force)", reason: "No force pushes." }, policyHash: "sha256:0f1e" },
  policy_confirm: { tool: "Bash", input: "git push origin main", inputTruncated: false, rule: { list: "commands.confirm", index: 0, pattern: "^git push" }, decision: "declined", policyHash: null },
  read_only_refusal: { path: "context/policies/governance.md", protection: "tier_a", code: "EROFS", tool: "Write", alternative: "Propose the change through the policy approval tool." },
  quarantine: { path: "bunfig.toml", tier: "A", entry: "file", bytes: 120, trigger: "turn_end", objectId: "q-0001" },
  quarantine_reconciliation: { trigger: "boot_recovery", reconciledTurnIds: ["turn-aeolus"], quarantined: 1, masked: [] },
  budget_warning: { scope: "day", unit: "usd", limit: 25, observed: 25.4, source: "policy" },
  budget_block: { scope: "turn", unit: "tokens", limit: 400_000, observed: 401_200, source: "default", stage: "mid_turn" },
  scope_cap: { cap: "tool_calls", limit: 300, observed: 301, overshoot: 1, frozen: false, outcome: "continued", source: "default" },
  egress_denial: { host: "sirens.example", port: 443, method: null, reason: "not_allowlisted", bytes: null },
  strict_fallback: { path: ".claude/settings.json", reason: "symlink" },
  revert_conflict: { conflicts: [{ path: "notes/penelope-loom.md", state: "changed" }], restored: 3 },
  outward_action: { tool: "Bash", input: "gh issue comment 12 --body 'Home soon'", inputTruncated: false, action: "gh_write", target: "github.com", historyRewrite: false, tainted: false, decision: "approved", rule: null },
  steering_change: { path: "AGENTS.md", sequence: 1, beforeHash: null, afterHash: null, taintSourceEventId: null, overlappingTurnIds: [] },
  taint: { source: "web_fetch", tool: "WebFetch", detail: "https://sirens.example/song" },
  provider_unavailable: { provider: "openai", capability: "embeddings", command: "brain search \"Ithaca harbor\"", degradedTo: "keyword_search" },
  resource_limit: { limits: [{ limit: "pids", source: "cgroup", value: 512, events: 3 }], fatal: false },
  roadblock: {
    category: "fs_denied", family: "write", signature: "Write .brain/x EROFS",
    failures: [{ toolCallId: "call-1", signature: "Write .brain/x EROFS", category: "fs_denied" }],
    resolution: { toolCallId: "call-2", signature: "Write .brain/scratch/x" }, remedy: "guidance",
    waste: { tokens: 1200, costUsd: null, ms: 4100 }, eventIds: [],
  },
};

function db(): Database {
  return createUiDb(":memory:");
}

function session(d: Database, id: string): void {
  d.query("INSERT INTO sessions (id, title, created_at, last_active_at) VALUES (?, 'Voyage', ?, ?)").run(id, NOW, NOW);
}

function event<K extends GovernanceEventKind>(kind: K, over: Partial<GovernanceEventInput<K>> = {}): GovernanceEventInput<K> {
  return { kind, payload: SAMPLE_PAYLOADS[kind], sessionId: "sess-ithaca", turnId: "turn-ithaca", actor: "interactive", model: "claude-opus-5", profile: "governed", at: NOW, ...over };
}

function count(d: Database): number {
  return (d.query("SELECT COUNT(*) AS n FROM governance_events").get() as { n: number }).n;
}

describe("governance event writer", () => {
  test("a real turn-temp purge persists its matching validated governance receipt", () => {
    const parent = join(import.meta.dir, "../../../tmp");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "purge-governance-"));
    const d = db();
    try {
      session(d, "sess-ithaca");
      writeFileSync(join(root, "report.md"), "Odysseus returns.");
      writeFileSync(join(root, "draft.md"), "The voyage draft.");
      handleTurnTemp({ action: "purge", all: true }, { root: () => root, allowanceBytes: 256 * 1024 * 1024,
        scratch: "/tmp/brain-worker-scratch", exclude: [], keep: [], linkedText: () => "[Report](/tmp/report.md)" }, e => {
          const { kind, ...payload } = e;
          recordGovernanceEvent(d, event(kind, { payload }));
        });
      expect(readFileSync(join(root, "report.md"), "utf8")).toBe("Odysseus returns.");
      expect(existsSync(join(root, "draft.md"))).toBe(false);
      const records = queryGovernanceEvents(d, { limit: 10 });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ kind: "turn_temp_purge", schemaVersion: 1,
        payload: { truncated: false, all: true, removedEntries: 1, skippedLinked: ["/tmp/report.md"], skippedOther: 0 } });
    } finally { d.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("every kind accepts its documented sample and stores kind, version and attribution", () => {
    const d = db();
    session(d, "sess-ithaca");
    for (const kind of GOVERNANCE_EVENT_KINDS) {
      expect(recordGovernanceEvent(d, event(kind)).recorded).toBe(true);
    }
    const events = queryGovernanceEvents(d, { limit: 100 });
    expect(events.map((e) => e.kind)).toEqual(GOVERNANCE_EVENT_KINDS);
    for (const e of events) {
      expect(e).toMatchObject({ sessionId: "sess-ithaca", turnId: "turn-ithaca", at: NOW, actor: "interactive", model: "claude-opus-5", profile: "governed", schemaVersion: 1 });
      expect(e.payload).toEqual(SAMPLE_PAYLOADS[e.kind as GovernanceEventKind]);
    }
  });

  test("an unknown kind throws and stores nothing", () => {
    const d = db();
    for (const kind of ["cyclops", "", "__proto__", "toString"]) {
      expect(() => recordGovernanceEvent(d, { ...event("taint"), kind } as never)).toThrow(GovernanceEventError);
    }
    expect(() => recordGovernanceEvent(d, { ...event("taint"), kind: undefined } as never)).toThrow("Unknown governance event kind");
    expect(count(d)).toBe(0);
  });

  test("a payload that does not match its kind's schema throws and stores nothing", () => {
    const d = db();
    const bad: Array<[GovernanceEventKind, unknown]> = [
      // Another kind's payload.
      ["promotion", SAMPLE_PAYLOADS.taint],
      // A wrong type, a missing field, an unknown key, an out-of-set value.
      ["promotion", { ...SAMPLE_PAYLOADS.promotion, bytes: "48213" }],
      ["budget_block", { ...SAMPLE_PAYLOADS.budget_warning }],
      ["scope_cap", { ...SAMPLE_PAYLOADS.scope_cap, note: "extra" }],
      ["policy_block", { ...SAMPLE_PAYLOADS.policy_block, rule: { ...SAMPLE_PAYLOADS.policy_block.rule, list: "commands.confirm" } }],
      ["budget_warning", { ...SAMPLE_PAYLOADS.budget_warning, observed: Number.NaN }],
      ["roadblock", { ...SAMPLE_PAYLOADS.roadblock, failures: [] }],
      ["taint", null],
      ["taint", "web_fetch"],
    ];
    for (const [kind, payload] of bad) {
      expect(() => recordGovernanceEvent(d, { ...event(kind), payload } as never)).toThrow(`Invalid ${kind} payload`);
    }
    expect(count(d)).toBe(0);
  });

  test("bad attribution and oversized payloads throw", () => {
    const d = db();
    expect(() => recordGovernanceEvent(d, event("taint", { actor: "odysseus" as never }))).toThrow("attribution");
    expect(() => recordGovernanceEvent(d, event("taint", { profile: "lockdown" as never }))).toThrow("attribution");
    expect(() => recordGovernanceEvent(d, { ...event("taint"), extra: 1 } as never)).toThrow("attribution");
    const conflicts = Array.from({ length: 1000 }, (_, i) => ({ path: `notes/${"wine-dark-sea-".repeat(6)}${i}.md`, state: "changed" as const }));
    expect(Buffer.byteLength(JSON.stringify({ conflicts, restored: 0 }))).toBeGreaterThan(GOVERNANCE_PAYLOAD_MAX_BYTES);
    expect(() => recordGovernanceEvent(d, event("revert_conflict", { payload: { conflicts, restored: 0 } }))).toThrow("exceeds");
    expect(count(d)).toBe(0);
  });

  test("recorded tool inputs have credentials redacted before storage", () => {
    const d = db();
    const input = "curl -H 'Authorization: Bearer aeolus-bag-of-winds' -X POST https://ithaca.example/api";
    recordGovernanceEvent(d, event("outward_action", { payload: { ...SAMPLE_PAYLOADS.outward_action, input } }));
    const stored = (d.query("SELECT payload FROM governance_events").get() as { payload: string }).payload;
    expect(stored).not.toContain("aeolus-bag-of-winds");
    expect(JSON.parse(stored).input).toBe("curl -H 'Authorization: [redacted] -X POST https://ithaca.example/api");
  });

  test("a dedupe key records one row per kind and key", () => {
    const d = db();
    session(d, "sess-ithaca");
    const first = recordGovernanceEvent(d, event("budget_warning", { dedupeKey: "sess-ithaca:day:usd" }));
    const again = recordGovernanceEvent(d, event("budget_warning", { dedupeKey: "sess-ithaca:day:usd", at: NOW + 1 }));
    expect(again).toEqual({ id: first.id, recorded: false });
    // The same key under another kind is a different event.
    expect(recordGovernanceEvent(d, event("budget_block", { dedupeKey: "sess-ithaca:day:usd" })).recorded).toBe(true);
    expect(count(d)).toBe(2);
  });
});

describe("governance event retention", () => {
  test("events survive the Activity span-detail prune", () => {
    const d = db();
    const store = createActivityStore(d, { writer: "governance-test" });
    session(d, "sess-ithaca");
    store.startSpan({ spanId: "root", runId: "turn-ithaca", name: "invoke_agent", kind: "turn", origin: "session", sessionId: "sess-ithaca", startedAt: NOW - DAY });
    store.endSpan("root", { outcome: "success" });
    store.rollupRun("turn-ithaca");
    recordGovernanceEvent(d, event("promotion"));
    recordGovernanceEvent(d, event("policy_block"));

    const pruned = store.prune({ digestFloorAt: NOW + 1, detailRetentionMs: 0, hardCeilingMs: 0, now: NOW + 1 });
    expect(pruned.runsPruned).toBe(1);
    expect(store.snapshotRun("turn-ithaca")).toBeNull();
    expect(queryGovernanceEvents(d, { sessionId: "sess-ithaca", limit: 10 }).map((e) => e.kind)).toEqual(["promotion", "policy_block"]);
  });

  test("deleting a session deletes its events and only its events", () => {
    const d = db();
    session(d, "sess-ithaca");
    session(d, "sess-troy");
    recordGovernanceEvent(d, event("promotion"));
    recordGovernanceEvent(d, event("taint"));
    recordGovernanceEvent(d, event("taint", { sessionId: "sess-troy", turnId: "turn-troy" }));
    d.query("DELETE FROM sessions WHERE id = 'sess-ithaca'").run();
    expect(queryGovernanceEvents(d, { limit: 10 }).map((e) => e.sessionId)).toEqual(["sess-troy"]);
  });

  test("an event recorded before its session's row exists binds to it on session_info", () => {
    const d = db();
    recordGovernanceEvent(d, event("strict_fallback", { sessionId: null, turnId: "turn-new" }));
    // A session id named before the catalog row exists is not attached yet.
    recordGovernanceEvent(d, event("taint", { sessionId: "sess-new", turnId: "turn-new" }));
    recordGovernanceEvent(d, event("taint", { sessionId: null, turnId: "turn-other" }));
    expect(queryGovernanceEvents(d, { turnId: "turn-new", limit: 10 }).map((e) => e.sessionId)).toEqual([null, null]);
    expect(bindTurnEvents(d, "turn-new", "sess-new")).toBe(0);

    const catalog = createSessionCatalog(() => d);
    catalog.persistSessionStub("sess-new", "Plot a course home", null, "claude");
    catalog.bindGovernanceEvents!("turn-new", "sess-new");
    expect(queryGovernanceEvents(d, { sessionId: "sess-new", limit: 10 }).map((e) => e.kind)).toEqual(["strict_fallback", "taint"]);
    expect(queryGovernanceEvents(d, { turnId: "turn-other", limit: 10 })[0]!.sessionId).toBeNull();

    d.query("DELETE FROM sessions WHERE id = 'sess-new'").run();
    expect(queryGovernanceEvents(d, { limit: 10 }).map((e) => e.turnId)).toEqual(["turn-other"]);
  });

  test("session-less events expire after the unbound retention; bound events never do", () => {
    const d = db();
    session(d, "sess-ithaca");
    const old = NOW - UNBOUND_GOVERNANCE_RETENTION_MS - 1;
    recordGovernanceEvent(d, event("budget_block", { sessionId: null, turnId: "turn-refused", at: old }));
    recordGovernanceEvent(d, event("budget_block", { at: old }));
    recordGovernanceEvent(d, event("budget_block", { sessionId: null, turnId: "turn-recent", at: NOW - DAY }));
    recordGovernanceEvent(d, event("taint", { at: NOW }));
    expect(queryGovernanceEvents(d, { limit: 10 }).map((e) => e.turnId)).toEqual(["turn-ithaca", "turn-recent", "turn-ithaca"]);
  });
});

describe("governance event queries", () => {
  test("filters by session, turn and kind, and pages by id", () => {
    const d = db();
    session(d, "sess-ithaca");
    session(d, "sess-troy");
    recordGovernanceEvent(d, event("taint"));
    recordGovernanceEvent(d, event("policy_block"));
    recordGovernanceEvent(d, event("policy_block", { turnId: "turn-ithaca-2" }));
    recordGovernanceEvent(d, event("policy_block", { sessionId: "sess-troy", turnId: "turn-troy" }));
    const kinds = (q: Parameters<typeof queryGovernanceEvents>[1]) => queryGovernanceEvents(d, q).map((e) => `${e.sessionId}/${e.turnId}/${e.kind}`);
    expect(kinds({ sessionId: "sess-ithaca", limit: 10 })).toEqual(["sess-ithaca/turn-ithaca/taint", "sess-ithaca/turn-ithaca/policy_block", "sess-ithaca/turn-ithaca-2/policy_block"]);
    expect(kinds({ turnId: "turn-ithaca", limit: 10 })).toEqual(["sess-ithaca/turn-ithaca/taint", "sess-ithaca/turn-ithaca/policy_block"]);
    expect(kinds({ kinds: ["policy_block"], limit: 10 })).toHaveLength(3);
    expect(kinds({ sessionId: "sess-ithaca", kinds: ["policy_block", "taint"], turnId: "turn-ithaca-2", limit: 10 })).toEqual(["sess-ithaca/turn-ithaca-2/policy_block"]);
    const first = queryGovernanceEvents(d, { limit: 2 });
    expect(queryGovernanceEvents(d, { after: first.at(-1)!.id, limit: 2 }).map((e) => e.turnId)).toEqual(["turn-ithaca-2", "turn-troy"]);
  });
});

test("the kinds and their fields are exactly the ones docs/http-api.md specifies", () => {
  const start = httpSpecification.indexOf("### Governance event kinds");
  expect(start).toBeGreaterThan(-1);
  const section = httpSpecification.slice(start);
  const rows = [...section.matchAll(/^\| `([a-z_]+)` \| (\d+) \| ([^|]+) \|/gm)];
  expect(rows.map((r) => r[1])).toEqual(GOVERNANCE_EVENT_KINDS);
  for (const [, kind, version, fields] of rows) {
    const spec = GOVERNANCE_EVENT_SCHEMAS[kind as GovernanceEventKind];
    expect({ kind, version: Number(version) }).toEqual({ kind: kind!, version: spec.version });
    const documented = [...fields!.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]).sort();
    expect({ kind, fields: documented }).toEqual({ kind: kind!, fields: Object.keys(spec.payload.shape).sort() });
  }
});

test("migration 038 applies over a populated catalog and cascades from it", () => {
  const dir = join(import.meta.dir, "../migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const d = new Database(":memory:");
  d.exec("PRAGMA foreign_keys = ON");
  for (const file of files.filter((f) => f < "038")) d.exec(readFileSync(join(dir, file), "utf8"));
  session(d, "sess-ithaca");
  const rest = files.filter((f) => f >= "038");
  expect(rest[0]).toBe("038_governance_events.sql");
  for (const file of rest) d.exec(readFileSync(join(dir, file), "utf8"));
  recordGovernanceEvent(d, event("taint"));
  expect(() => d.query("INSERT INTO governance_events (at, kind, schema_version, actor, payload) VALUES (1, 'taint', 1, 'odysseus', '{}')").run()).toThrow();
  expect(() => d.query("INSERT INTO governance_events (at, kind, schema_version, actor, payload) VALUES (1, 'taint', 1, 'user', '[]')").run()).toThrow();
  d.query("DELETE FROM sessions WHERE id = 'sess-ithaca'").run();
  expect(count(d)).toBe(0);
});
