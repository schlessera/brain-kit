import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "../src/app";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createHostBoundary } from "../src/brain/host-boundary";
import { resolveServerConfig } from "../src/config/env";
import { createRecordingObservability } from "../src/observability";
import { makeFakeBackend } from "./helpers/fake-backend";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(resolve(import.meta.dir, "../../../tmp"), "odysseus-state-layout-"));
  roots.push(root);
  const brain = join(root, "brain");
  const state = join(root, "state");
  mkdirSync(brain); mkdirSync(state);
  const sentinel = join(state, "evaluated");
  mkdirSync(join(brain, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(brain, "node_modules/.bin/brain"), `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(sentinel)}, "evaluated"); console.log("0.42.0");\n`, { mode: 0o755 });
  return { root, brain, state, sentinel };
}

describe("operational state boot refusal (#1649)", () => {
  for (const profile of ["governed", "strict"] as const) {
    for (const layout of ["existing database", "new nested directory", "linked parent", "linked parent traversal", "linked database", "linked new database", "linked quarantine", "private token"] as const) {
      test(`${profile}: refuses ${layout} before opening state or executing the brain`, async () => {
        const f = fixture();
        let dbPath = join(f.brain, "brain-ui.db");
        let token: string | undefined;
        if (layout === "new nested directory") dbPath = join(f.brain, "new/deeper/brain-ui.db");
        if (layout === "linked parent") {
          symlinkSync(f.brain, join(f.state, "alias"));
          dbPath = join(f.state, "alias/new/deeper/brain-ui.db");
        }
        if (layout === "linked parent traversal") {
          mkdirSync(join(f.brain, "sub")); symlinkSync(join(f.brain, "sub"), join(f.state, "traversal"));
          dbPath = `${f.state}/traversal/../brain-ui.db`;
        }
        if (layout === "existing database" || layout === "linked database") {
          const db = new Database(dbPath, { create: true });
          db.exec("CREATE TABLE private_probe (value TEXT); INSERT INTO private_probe VALUES ('Odysseus UI-private row')");
          db.close();
          if (layout === "linked database") { symlinkSync(dbPath, join(f.state, "linked.db")); dbPath = join(f.state, "linked.db"); }
        }
        if (layout === "linked new database") { symlinkSync(dbPath, join(f.state, "new-link.db")); dbPath = join(f.state, "new-link.db"); }
        if (layout === "linked quarantine") { dbPath = join(f.state, "brain-ui.db"); symlinkSync(f.brain, join(f.state, "brain-ui-quarantine")); }
        if (layout === "private token") { dbPath = join(f.state, "brain-ui.db"); token = join(f.brain, "poke-token"); }
        const before = existsSync(dbPath) ? readFileSync(dbPath) : undefined;
        const observability = createRecordingObservability();
        let failure: Error | undefined;
        try {
          const app = await createApp({ workerProfile: profile, observability,
            config: resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", BRAIN_PATH: f.brain, DB_PATH: dbPath,
              BRAIN_UI_INBOX_POKE_TOKEN_FILE: token, BRAIN_UI_PRICING_DISCOVERY: "0" }),
            registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]) });
          await app.close();
        } catch (error) { failure = error as Error; }
        expect(failure?.name, "OPERATIONAL_STATE_BOOT_REFUSAL").toBe("OperationalStateInBrainError");
        expect((failure as Error & { status: unknown }).status).toMatchObject({ available: false,
          reason: layout === "private token" || layout === "linked quarantine" ? "private_state_in_brain" : "database_in_brain" });
        expect(observability.logs.records().some(record => record.body === failure?.message && record.attributes["boot.refusal"] === failure?.name)).toBe(true);
        expect(failure?.message).toContain("move the state directory outside the brain");
        expect(failure?.message).toContain(layout === "private token" ? "BRAIN_UI_INBOX_POKE_TOKEN_FILE" : "DB_PATH");
        expect(existsSync(f.sentinel), "NO_BRAIN_EXECUTION_BEFORE_LAYOUT_REFUSAL").toBe(false);
        if (before) expect(readFileSync(dbPath)).toEqual(before);
        else expect(existsSync(dbPath), "NO_DATABASE_CREATED_ON_REFUSAL").toBe(false);
        if (token) expect(existsSync(token)).toBe(false);
      });
    }
  }

  test("status reports the same database refusal including linked missing parents", () => {
    const f = fixture();
    symlinkSync(f.brain, join(f.state, "alias"));
    const boundary = createHostBoundary({ brainPath: f.brain, dbPath: join(f.state, "alias/new/brain-ui.db"), workerHost: () => ({ ok: true }) });
    const status = boundary.status();
    expect(status, "OPERATIONAL_LAYOUT_STATUS").toMatchObject({ available: false, reason: "database_in_brain" });
    if (!status.available) expect(status.detail).toContain("move the state directory outside the brain");
  });
  test("private-state status uses the boot diagnostic", () => {
    const f = fixture();
    const boundary = createHostBoundary({ brainPath: f.brain, dbPath: join(f.state, "brain-ui.db"),
      privateStatePaths: [{ setting: "BRAIN_UI_INBOX_POKE_TOKEN_FILE", path: join(f.brain, "poke-token") }], workerHost: () => ({ ok: true }) });
    expect(boundary.status()).toMatchObject({ available: false, reason: "private_state_in_brain",
      detail: expect.stringContaining("BRAIN_UI_INBOX_POKE_TOKEN_FILE") });
  });
  test("an in-memory database refuses private quarantine storage inside the brain", async () => {
    const f = fixture();
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = f.brain;
    try {
      await expect(createApp({ config: resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", BRAIN_PATH: f.brain, DB_PATH: ":memory:" }),
        registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]) })).rejects.toThrow("TMPDIR resolves inside the brain");
      expect(existsSync(f.sentinel)).toBe(false);
    } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
  });

  test("status refuses a quarantine sibling linked into the brain", () => {
    const f = fixture(); symlinkSync(f.brain, join(f.state, "brain-ui-quarantine"));
    const boundary = createHostBoundary({ brainPath: f.brain, dbPath: join(f.state, "brain-ui.db"), workerHost: () => ({ ok: true }) });
    expect(boundary.status(), "QUARANTINE_SIBLING_STATUS").toMatchObject({ available: false,
      reason: "private_state_in_brain", detail: expect.stringContaining("DB_PATH quarantine") });
  });
  test("anonymous temporary databases still validate their derived quarantine directory", async () => {
    const f = fixture(); const cwd = process.cwd(); const nested = join(f.brain, "nested"); mkdirSync(nested);
    process.chdir(nested);
    try {
      await expect(createApp({ workerProfile: "strict", dbPath: "", config: resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", BRAIN_PATH: f.brain, DB_PATH: join(f.state, "brain-ui.db") }),
        registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]) }), "ANONYMOUS_DATABASE_QUARANTINE_GUARD")
        .rejects.toThrow("DB_PATH quarantine resolves inside the brain");
      expect(existsSync(f.sentinel)).toBe(false);
    } finally { process.chdir(cwd); }
  });

});
