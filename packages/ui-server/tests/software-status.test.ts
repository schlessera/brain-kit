import { expect, test } from "bun:test";
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
