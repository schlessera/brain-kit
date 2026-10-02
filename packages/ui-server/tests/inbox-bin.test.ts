import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function command(args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/bin/brain-ui-inbox.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { value: JSON.parse(out), err, code };
}
test("recovery command JSON reports a populated export, restored state and refusal without private exception details", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-inbox-bin-")); roots.push(root);
  const source = join(root, "source"), target = join(root, "target"); mkdirSync(source); mkdirSync(target);
  const path = join(source, "ui.sqlite"), file = join(root, "backup.json");
  const db = createUiDb(path);
  db.query("INSERT INTO inbox_scheduler_heartbeats VALUES ('Odysseus', ?, 7)").run(Date.UTC(2026, 6, 12));
  db.close();
  const exported = await command(["export", "--db", path, "--brain-root", source, "--file", file, "--json"]);
  const snapshot = JSON.parse(readFileSync(file, "utf8"));
  expect(exported).toEqual({ code: 0, err: "", value: { schema_version: 1, ok: true, command: "export", snapshot: {
    version: 1, checksum: snapshot.checksum, created_at: snapshot.createdAt, recovery_point_hours: 24 } } });
  const restoredPath = join(target, "ui.sqlite"), args = ["restore", "--db", restoredPath, "--brain-root", target, "--file", file, "--json"];
  expect(await command(args)).toEqual({ code: 0, err: "", value: { schema_version: 1, ok: true, command: "restore", recovered: 0, resumed: false } });
  const restored = createUiDb(restoredPath);
  try { expect(restored.query("SELECT * FROM inbox_scheduler_heartbeats").all()).toEqual([{ name: "Odysseus", tick_at: Date.UTC(2026, 6, 12), change_cursor: 7 }]); }
  finally { restored.close(); }
  expect(await command(args)).toEqual({ code: 1, err: "", value: { schema_version: 1, ok: false, error: { code: "inbox_restore_nonempty" } } });
  expect(await command(["export", "--db", join(root, "missing.sqlite"), "--brain-root", source, "--file", file, "--json"]))
    .toEqual({ code: 1, err: "", value: { schema_version: 1, ok: false, error: { code: "inbox_operation_failed" } } });
});
test("usage failures retain the JSON error envelope and exit 2", async () => {
  expect(await command(["--json"])).toEqual({ code: 2, err: "", value: { schema_version: 1, ok: false, error: { code: "inbox_usage" } } });
});
