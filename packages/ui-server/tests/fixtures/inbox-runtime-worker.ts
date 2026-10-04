import { existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createUiDb } from "../../src/db/client.js";
import { createInboxRuntime } from "../../src/inbox/runtime.js";

const [mode, path, ready, gate, clock] = process.argv.slice(2);
if (mode === "serve") {
  const { createApp } = await import("../../src/app.js");
  const { resolveServerConfig } = await import("../../src/config/env.js");
  const { createStaticBackendRegistry } = await import("../../src/agent/backend.js");
  const { createRecordingObservability } = await import("../../src/observability/index.js");
  const { makeFakeBackend } = await import("../helpers/fake-backend.js");
  const backend = makeFakeBackend({ id: "fixture" });
  const app = await createApp({ config: resolveServerConfig({
    AUTH_MODE: "password", HOST: "127.0.0.1", DB_PATH: path!, BRAIN_PATH: dirname(path!),
    BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0",
    BRAIN_UI_PASSWORD_HASH: await Bun.password.hash("fixture-password"),
    COOKIE_SECRET: "fixture-cookie-secret-for-inbox-only",
    BRAIN_UI_INBOX_POKE_TOKEN_FILE: join(dirname(path!), "process.token"),
  }), registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  // The parent parses this receipt as soon as its final path exists.
  writeFileSync(`${ready!}.partial`, JSON.stringify({ port: server.port }));
  renameSync(`${ready!}.partial`, ready!);
  while (!existsSync(gate!)) await Bun.sleep(5);
  server.stop(true); await app.close();
  process.exit(0);
}
const db = createUiDb(path!);
if (mode === "hold") {
  db.exec("BEGIN IMMEDIATE");
  db.query("UPDATE inbox_scheduler_heartbeats SET tick_at = tick_at + 1").run();
  writeFileSync(ready!, "ready");
  while (!existsSync(gate!)) await Bun.sleep(5);
  await Bun.sleep(300);
  db.exec("COMMIT");
} else {
  const runtime = createInboxRuntime(db, {
    now: () => Number(clock), log: { emit() {}, enabled: () => false },
    budget: { config: { spendUsd: 5, turns: mode === "budget" ? 10 : 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing: { resolve: () => mode === "budget" ? { input: 0.003, output: 0.003, cacheRead: 0.003, cacheWrite: 0.003, estimate: false, source: "snapshot" } : null } },
    operation: (item) => ({ runId: `${item.id}-${item.attempts + 1}`, principalId: "fixture", model: "fixture", billingMode: mode === "budget" ? "api" : "subscription", purpose: "triage",
      maximumTokens: mode === "budget" ? { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } : undefined }),
    dispatch: async (item) => { process.stdout.write(JSON.stringify(item) + "\n"); },
  });
  writeFileSync(ready!, "ready");
  while (!existsSync(gate!)) await Bun.sleep(5);
  await runtime.tick();
  await runtime.close();
}
db.close();
