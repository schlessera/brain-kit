import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import { httpContractApp } from "./helpers/http-contract-app.js";
import { createPrincipal } from "../src/db/principals.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";

const SECRET = "odysseus-code-history-cookie-secret-0123456789";
test("mounted owner code revert restores files, preserves later work on retry and shows fresh conflicts", async () => {
  const f = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "fixture-unused", COOKIE_SECRET: SECRET } });
  try {
    const owner = createPrincipal(f.app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
    const cookie = (await generateSignedCookie("brain_ui_session", owner.id, SECRET)).split(";")[0]!;
    createSessionCatalog(() => f.app.db).persistSessionStub("fixture-session", "Ithaca", "fixture", "fixture", owner.id);
    const checkout = join(f.brainPath, "workspaces", "argo"); mkdirSync(checkout, { recursive: true });
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", checkout, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", ...args], { env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    };
    git("init", "-q", "-b", "main"); writeFileSync(join(checkout, "chart.md"), "Ithaca\n"); git("add", "."); git("commit", "-qm", "Set sail");
    const journal = f.app.wsHost.journal!;
    await journal.begin("sail", { sessionId: "fixture-session", actor: "interactive", profile: "governed", model: null, policyHash: null, workspaceReadOnly: false, workspacesWritable: true }, () => {});
    writeFileSync(join(checkout, "chart.md"), "Scheria\n"); writeFileSync(join(checkout, "raft.md"), "The raft\n"); await journal.finish("sail");
    const base = "/api/sessions/fixture-session/turns/sail/journal/code";
    const post = (id: string) => f.fetch(`${base}/revert`, { method: "POST", headers: { cookie, "content-type": "application/json", host: "localhost", origin: "http://localhost" }, body: JSON.stringify({ id, checkout: "workspaces/argo" }) });
    const id = crypto.randomUUID(), response = await post(id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json(), "MOUNTED_CODE_REVERT_EXECUTES_REAL_STAGE").toMatchObject({ id, status: "restored" });
    expect(readFileSync(join(checkout, "chart.md"), "utf8")).toBe("Ithaca\n"); expect(existsSync(join(checkout, "raft.md"))).toBe(false);
    writeFileSync(join(checkout, "chart.md"), "Later owner edit\n");
    expect(await (await post(id)).json(), "REPEATED_CODE_ID_READS_ORIGINAL_RESULT").toMatchObject({ id, status: "restored" });
    expect(readFileSync(join(checkout, "chart.md"), "utf8"), "RETRY_NEVER_REPLAYS_FILESYSTEM_EFFECT").toBe("Later owner edit\n");
    const conflict = await post(crypto.randomUUID());
    expect(conflict.status).toBe(200);
    expect(await conflict.json(), "FRESH_CONFLICT_INCLUDES_CURRENT_DIFF").toMatchObject({ status: "conflict", currentPreview: { inline: true, diff: expect.stringContaining("Later owner edit") } });
    const read = await f.fetch(`${base}/revert/${id}`, { headers: { cookie } });
    expect(await read.json()).toMatchObject({ id, status: "restored" });
    const unauthenticated = await f.fetch(`${base}/revert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), checkout: "workspaces/argo" }) });
    expect(unauthenticated.status, "CODE_REVERT_REQUIRES_AUTHENTICATED_OWNER").toBe(401);
  } finally { await f.close(); }
});
