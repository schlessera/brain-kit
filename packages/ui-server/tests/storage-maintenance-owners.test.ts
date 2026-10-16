import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createNativeAppFixture } from "./helpers/native-app-fixture";
import { createHostBoundary } from "../src/brain/host-boundary";
import { createBrainClient } from "../src/brain/client";
import { createUiDb } from "../src/db/client";
import { createWriterGate } from "../src/brain/writer-gate";
import { startScratchPrune } from "../src/cron/scratch-prune";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-maintenance-owner-")), brain = join(root, "brain"); mkdirSync(brain);
  writeFileSync(join(brain, "brain.config.ts"), "export default {};\n");
  const core = resolve(import.meta.dir, "../../core/src/cli/brain.ts"), bin = join(brain, "node_modules", ".bin", "brain"); mkdirSync(join(brain, "node_modules", ".bin"), { recursive: true });
  // This unreleased source fixture advertises the new command it actually imports.
  writeFileSync(bin, `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==="--version"){console.log("0.44.0");}else{process.argv=[process.execPath,${JSON.stringify(core)},...args];await import(${JSON.stringify(core)});}\n`); chmodSync(bin, 0o700);
  const native = createNativeAppFixture(brain), db = createUiDb(join(root, "ui.sqlite")), gate = createWriterGate(db, brain, { pollMs: 5 });
  const boundary = createHostBoundary({ brainPath: brain, dbPath: join(root, "ui.sqlite"), gate: () => gate, history: () => true, nativeManager: createNativeBrainManagerClient(native.nativeBrain) });
  const client = createBrainClient({ brainPath: brain, boundary, exec: {} });
  return { root, brain, client, boundary, gate, async close() { db.close(); await native.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("manual scratch pruning refreshes pins and uses the real bounded credential-free CLI worker", async () => {
  const f = fixture(), scratch = join(f.brain, ".brain", "scratch"), pins = join(f.brain, ".brain", "scratch-pins", "pins.json");
  mkdirSync(scratch, { recursive: true }); mkdirSync(join(f.brain, ".brain", "scratch-pins"));
  writeFileSync(join(f.brain, ".brain", "scratch-pins-required"), "required");
  writeFileSync(pins, JSON.stringify({ version: 1, ready: true, sessions: {} }));
  for (const file of ["linked.txt", "old.txt"]) { writeFileSync(join(scratch, file), "Ithaca"); utimesSync(join(scratch, file), 0, 0); }
  let ready = false, refreshes = 0;
  const pruner = startScratchPrune({ brain: f.client, every: () => () => {}, pins: { file: pins, async refresh() { refreshes++; if (!ready) throw Error("pin enumeration incomplete"); writeFileSync(pins, JSON.stringify({ version: 1, ready: true, sessions: { odysseus: [".brain/scratch/linked.txt"] } })); } } });
  try {
    await pruner.tick();
    expect(existsSync(join(scratch, "old.txt")), "STORAGE_FRESH_PINS_BEFORE_DELETE").toBe(true);
    await expect(pruner.run({ bounded: true })).rejects.toThrow("pin enumeration incomplete");
    expect(existsSync(join(scratch, "old.txt")), "STORAGE_MANUAL_PINS_REFRESH_BEFORE_DELETE").toBe(true);
    ready = true;
    const report = JSON.parse(await pruner.run({ bounded: true }));
    expect(report.removed.map((value: {path: string}) => value.path)).toContain(".brain/scratch/old.txt");
    expect(existsSync(join(scratch, "linked.txt")), "STORAGE_MANUAL_PIN_PRESERVED").toBe(true);
    expect(existsSync(join(scratch, "old.txt"))).toBe(false); expect(refreshes).toBeGreaterThanOrEqual(3);
  } finally { await pruner.close(); await f.close(); }
});

test("maintenance revalidates authorization after the real cross-process writer gate admits it", async () => {
  const f = fixture(); let allowed = true;
  const hold = await f.gate.acquire("exclusive", "fixture hold");
  const pending = f.boundary.run({ argv: [process.execPath, "-e", 'await Bun.write(process.env.BRAIN_WORKER_DATA_ROOT+"/started.txt","Ithaca");'], env: { PATH: process.env.PATH, BRAIN_ROOT: f.brain }, credentials: false, gate: "shared", purpose: "Storage guard fixture", outputBytes: 1024, assertAuthorized() { if (!allowed) throw Error("authorization revoked"); } });
  try {
    await Bun.sleep(30); allowed = false; hold.release();
    await expect(pending).rejects.toThrow("authorization revoked");
    expect(existsSync(join(f.brain, "started.txt")), "STORAGE_MAINTENANCE_AFTER_GATE_AUTHORITY").toBe(false);
  } finally { hold.release(); await pending.catch(() => {}); await f.close(); }
});

test("bounded maintenance kills and reaps an actual output-flooding worker", async () => {
  const f = fixture(), marker = crypto.randomUUID();
  try {
    const result = await f.boundary.run({ argv: [process.execPath, "-e", `const marker=${JSON.stringify(marker)};process.stdout.write("x".repeat(8192));setInterval(()=>process.stdout.write(marker),1);`], env: { PATH: process.env.PATH, BRAIN_ROOT: f.brain }, credentials: false, gate: "shared", purpose: "Storage output budget", outputBytes: 1024, timeoutMs: 5000 });
    expect(result.timedOut, "STORAGE_MAINTENANCE_OUTPUT_CEILING").toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1024);
    const alive = readdirSync("/proc").filter(value => /^\d+$/.test(value)).filter(pid => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker); } catch { return false; } });
    expect(alive, "STORAGE_MAINTENANCE_OUTPUT_REAPED").toEqual([]);
  } finally { await f.close(); }
});


test("hosted packing publishes real Git packs while preserving refs and history", async () => {
  const f = fixture();
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", f.brain, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    expect(p.exitCode, p.stderr.toString()).toBe(0); return p.stdout.toString();
  };
  try {
    git("init"); git("config", "user.name", "Odysseus"); git("config", "user.email", "odysseus@example.invalid");
    writeFileSync(join(f.brain, "chart.txt"), "Ithaca"); git("add", "chart.txt", "brain.config.ts"); git("commit", "-m", "Voyage"); git("tag", "departure");
    const refs = git("show-ref"), history = git("log", "--all", "--format=%H"), reflog = git("reflog", "--all", "--format=%H");
    const result = await f.client.storagePack!({ bounded: true });
    expect(result, "STORAGE_HOSTED_PACK_OWNER_COMPLETES").toMatchObject({ action: "pack", state: "complete" });
    expect(readdirSync(join(f.brain, ".git", "objects", "pack")).some(name => name.endsWith(".pack")), "STORAGE_HOSTED_PACK_PUBLISHED").toBe(true);
    expect(git("show-ref")).toBe(refs); expect(git("log", "--all", "--format=%H")).toBe(history); expect(git("reflog", "--all", "--format=%H")).toBe(reflog);
    expect(git("show", "HEAD:chart.txt")).toBe("Ithaca");
  } finally { await f.close(); }
});
