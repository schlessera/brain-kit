/** Action notice writes keep their transactions on the shared write worker (#3000). */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@opentelemetry/api-logs";
import type { InboxActionItem } from "@schlessera/brain-ui-sdk/protocol";

import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createActivityRuntime } from "../src/activity/runtime.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createActionNotifier } from "../src/inbox/notify.js";
import { watchWriteSites } from "./helpers/write-sites.js";

const AT = Date.UTC(2026, 6, 12, 9), YEAR = 365 * 24 * 60 * 60 * 1000;
const ENDPOINT = "https://push.example.test/ithaca";
const TABLES = ["inbox_notice_batches", "inbox_notice_constituents", "inbox_notice_attempts",
  "inbox_notice_attempt_components", "inbox_notice_clients", "inbox_notice_digests", "inbox_notice_coverage", "push_subscriptions"];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "action-notify-odysseus-"));
  const db = createUiDb(join(root, "ui.db"));
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: YEAR / 1000 });
  const client = { principalId: principal.id, clientId: "ithaca" };
  db.query("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, principal_id) VALUES (?, 'k', 'a', ?, ?)")
    .run(ENDPOINT, AT, principal.id);
  const store = createInboxStore(db, { now: () => AT });
  for (const [id, stakes, type] of [["sail", 3, "approve"], ["rope", 1, "choose"], ["omens", 1, "fyi"]] as const) {
    store.ingest({ threadId: id, itemId: `${id}-triage`, source: "cli", dedupKey: `${id}-triage`, stagingId: `${id}-staging`, expiresAt: AT + YEAR, stakes });
    const item: InboxActionItem = { id, dedupKey: id, threadId: id, queue: "actions", type, status: "pending", version: 1,
      createdAt: AT, updatedAt: AT, expiresAt: AT + YEAR,
      payload: { title: `Odysseus: ${id}`, detail: "Decide before the fleet sails." },
      options: type === "fyi" ? [] : [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }] };
    store.commit([{ kind: "item", item }]);
  }
  // All inbox transitions, episodes and subscriptions precede the connection guard.
  const inline = createActionNotifier(db);
  inline.reportZone(client, "Europe/Athens", ENDPOINT, AT);
  const writer = openSqliteWriter(db);
  const runtime = createActivityRuntime(db, { writer, log: { emit() {} } as unknown as Logger });
  return { db, writer, runtime, inline, client, destination: { endpoint: ENDPOINT, principalId: principal.id },
    notices: runtime.actionNotices,
    async close() { runtime.close(); await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

type Fixture = ReturnType<typeof fixture>;
const writes: Array<{
  name: string;
  prepare?: (f: Fixture) => number | void;
  run: (f: Fixture, id: number | void) => unknown;
  tables: string[];
}> = [
  { name: "ENROLL", run: f => f.notices.enroll(AT), tables: ["inbox_notice_batches", "inbox_notice_constituents"] },
  { name: "BEGIN_ATTEMPT", prepare: f => { f.inline.enroll(AT); },
    run: f => f.notices.beginAttempt(f.destination, AT + 60_000), tables: ["inbox_notice_attempts", "inbox_notice_attempt_components"] },
  { name: "FINISH_ATTEMPT", prepare: f => { f.inline.enroll(AT); return f.inline.beginAttempt(f.destination, AT + 60_000)!.attemptId; },
    run: (f, id) => f.notices.finishAttempt(id!, "success", AT + 60_000), tables: ["inbox_notice_attempts"] },
  { name: "REPORT_ZONE", run: f => f.notices.reportZone(f.client, "UTC", ENDPOINT, AT), tables: ["inbox_notice_clients", "push_subscriptions"] },
  { name: "REPORT_DEVICE_ZONE", run: f => f.notices.reportDeviceZone(f.client.principalId, ENDPOINT, "UTC", AT), tables: ["push_subscriptions"] },
  { name: "DIGEST", run: f => f.notices.digest(f.client, AT), tables: ["inbox_notice_digests", "inbox_notice_coverage"] },
  { name: "DISMISS", run: f => f.notices.dismiss(f.client, AT, AT), tables: ["inbox_notice_clients"] },
  { name: "GENERATE_DUE", run: f => f.notices.generateDue(AT), tables: ["inbox_notice_digests", "inbox_notice_coverage"] },
];

for (const write of writes) test(`action notice ${write.name} commits on the write worker at FULL`, async () => {
  const f = fixture();
  try {
    const id = write.prepare?.(f);
    const sites = await watchWriteSites(f.db, f.writer, TABLES);
    let failure: unknown;
    try { await write.run(f, id); } catch (error) { failure = error; }
    expect(failure, `ACTION_NOTICE_${write.name}_COMMITS_ON_WORKER_AT_FULL`).toBeUndefined();
    expect(new Set(await sites.log()), `ACTION_NOTICE_${write.name}_WRITTEN_TABLES`).toEqual(new Set(write.tables));
  } finally { await f.close(); }
});
