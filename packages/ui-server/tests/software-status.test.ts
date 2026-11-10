import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createUiDb } from "../src/db/client";
import { createJournalAccounting } from "../src/brain/journal-accounting";
import { expect, spyOn, test } from "bun:test";
import type { SystemStatus } from "@schlessera/brain-ui-sdk/protocol";
import { version } from "@schlessera/brain-ui-server/package.json";
import { createTestApp } from "./helpers/test-app";

test("mounted status reports the installed release and preserves the application commit", async () => {
  const t = await createTestApp({ env: { SOURCE_COMMIT: "a".repeat(40) } });
  try {
    const response = await t.fetch("/api/status");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.software).toEqual({ release: version, sourceCommit: "a".repeat(40) });
    expect(body.version).toBe("a".repeat(40));
    const health = await (await t.fetch("/api/health")).json();
    expect(Object.keys(health).sort()).toEqual(["status", "timestamp", "uptime"]);
  } finally { await t.teardown(); }
});

// The SDK's SystemStatus declares `software` (#598): the typed field a client
// reads is the object the mounted route serves, with exactly these keys.
test("the status envelope carries the typed SystemStatus software object", async () => {
  const t = await createTestApp({ env: { SOURCE_COMMIT: "b".repeat(40) } });
  try {
    const body = (await (await t.fetch("/api/status")).json()) as SystemStatus;
    const software: { release: string; sourceCommit: string } = body.software;
    expect(Object.keys(software).sort()).toEqual(["release", "sourceCommit"]);
    expect(software.release).toBe(version);
    expect(software.release).not.toBe(body.version);
    expect(software.sourceCommit).toBe(body.version);
    expect(typeof body.healthy).toBe("boolean");
    expect(typeof body.uptime).toBe("number");
    expect(Array.isArray(body.cronJobs)).toBe(true);
    expect(typeof body.activeSession).toBe("boolean");
  } finally { await t.teardown(); }
});


test.each([0, 4096, null, "quarantine blocks allowance" as const])("mounted authenticated status exposes native quarantine with charge %s while public health stays minimal", async stagingChargedBytes => {
  const fixtures = await import("./helpers/native-journal-fixture.js");
  const create = fixtures.createNativeJournalFixture;
  const recovery = {quarantinedIntents:1,stagingChargedBytes: typeof stagingChargedBytes === "string" ? 4096 : stagingChargedBytes,...(typeof stagingChargedBytes === "string" ? {stagingRefusal:"Quarantined storage requires repair and manager restart."} : {}),diagnosticsPath:"/native-fixture/recovery-diagnostics"};
  const fault = spyOn(fixtures,"createNativeJournalFixture").mockImplementation((...args) => {
    const fixture = create(...args), ready = fixture.client.ready;
    fixture.client.ready = async () => ({...await ready(),recovery});
    return fixture;
  });
  const t = await createTestApp({env:{AUTH_MODE:"password",BRAIN_UI_PASSWORD_HASH:await Bun.password.hash("Odysseus"),COOKIE_SECRET:"odysseus-cookie-secret-1792000000000000"}}).finally(() => fault.mockRestore());
  try {
    expect((await t.fetch("/api/status")).status, "NATIVE_DIAGNOSTICS_REQUIRE_AUTH").toBe(401);
    const login = await t.fetch("/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:"Odysseus"})});
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const status = await t.fetch("/api/status",{headers:{cookie}});
    expect(status.status).toBe(200);
    const body = await status.json();
    expect(body.nativeRecovery, "NATIVE_QUARANTINE_VISIBLE_TO_OWNER").toEqual(recovery);
    expect(body.healthy, "NATIVE_UNBOUNDED_QUARANTINE_IS_UNHEALTHY").toBe(stagingChargedBytes !== null && typeof stagingChargedBytes !== "string");
    expect(Object.keys(await (await t.fetch("/api/health")).json()).sort()).toEqual(["status","timestamp","uptime"]);
  } finally { await t.teardown(); }
});


test("mounted authenticated status exposes real write-worker journal I/O recovery", async () => {
  const hash = "a".repeat(64);
  const t = await createTestApp({
    env: {AUTH_MODE:"password",BRAIN_UI_PASSWORD_HASH:await Bun.password.hash("Odysseus"),COOKIE_SECRET:"odysseus-cookie-secret-1792000000000000"},
    prepare(_brain, dbPath) {
      const db = createUiDb(dbPath), ledger = createJournalAccounting(db, dbPath);
      try {
        ledger.write(() => {
          db.query("INSERT INTO turn_journal_objects VALUES (?,8,'pending')").run(hash);
          for (const id of ["odysseus", "athena"]) db.query("INSERT INTO turn_journal_reservations (id,bytes,pid,pid_start,created_at,hash) VALUES (?,8,?,'gone',0,?)").run(id,process.pid,hash);
        });
        // O_NOFOLLOW produces real ELOOP in the separate write worker. No
        // process-local spy can substitute the app's recovery result.
        mkdirSync(`${dbPath}.journal`, {recursive:true,mode:0o700});
        symlinkSync(hash, join(`${dbPath}.journal`, hash));
      } finally { db.close(); }
    },
  });
  try {
    const unauthenticated = await t.fetch("/api/status");
    expect(unauthenticated.status, "JOURNAL_RECOVERY_REQUIRES_AUTH").toBe(401);
    expect(await unauthenticated.text()).not.toContain(hash);
    const login = await t.fetch("/api/auth/login", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:"Odysseus"})});
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const body = await (await t.fetch("/api/status", {headers:{cookie}})).json();
    expect(body.journalRecovery, "JOURNAL_RECOVERY_VISIBLE_TO_OWNER").toEqual({unresolvedRecords:2, firstCause:{reservationId:expect.any(String),hash,at:expect.any(Number),errorClass:"Error",message:expect.stringContaining("ELOOP"),site:"journal-accounting.recover"}});
    expect(body.healthy, "JOURNAL_UNRESOLVED_STATUS_IS_UNHEALTHY").toBe(false);
    const rows = t.app.db.query("SELECT bytes,recovery_failure FROM turn_journal_reservations ORDER BY id").all() as {bytes:number;recovery_failure:string}[];
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.bytes), "JOURNAL_STATUS_DOES_NOT_RELEASE_CHARGES").toEqual([8,8]);
    expect(rows.map(row => JSON.parse(row.recovery_failure))).toContainEqual(body.journalRecovery.firstCause);
    expect(Object.keys(await (await t.fetch("/api/health")).json()).sort()).toEqual(["status","timestamp","uptime"]);
  } finally { await t.teardown(); }
});
