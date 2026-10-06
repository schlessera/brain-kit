import { expect, test } from "bun:test";
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
