/** Exercise the installed bin and bundled migrations from an isolated consumer. */
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
const flag = process.argv.indexOf("--root");
if (flag < 0 || !process.argv[flag + 1]) throw new Error("check-inbox-package requires --root <consumer install>");
const consumer = resolve(process.argv[flag + 1]), probe = mkdtempSync(join(consumer, ".inbox-package-probe-"));
try {
  const script = join(probe, "probe.ts");
  await Bun.write(script, `
import { createUiDb } from "@schlessera/brain-ui-server";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const root = import.meta.dir, source = join(root, "source"), target = join(root, "target");
mkdirSync(source); mkdirSync(target);
const path = join(source, "ui.sqlite"), backup = join(root, "backup.json");
const db = createUiDb(path);
db.query("INSERT INTO inbox_scheduler_heartbeats VALUES ('Odysseus', ?, 7)").run(Date.UTC(2026, 6, 12));
db.close();
async function run(command, dbPath, brainRoot, code = 0) {
  const child = Bun.spawn([${JSON.stringify(join(consumer, "node_modules/.bin/brain-ui-inbox"))}, command,
    "--db", dbPath, "--brain-root", brainRoot, "--file", backup, "--json"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== code || err !== "") throw new Error("Packed inbox command failed: " + out + err);
  return JSON.parse(out);
}
const exported = await run("export", path, source);
if (exported.schema_version !== 1 || !exported.ok || exported.command !== "export" ||
    exported.snapshot.version !== 1 || exported.snapshot.recovery_point_hours !== 24 ||
    !/^[a-f0-9]{64}$/.test(exported.snapshot.checksum)) throw new Error("Packed export contract mismatch");
const image = JSON.parse(readFileSync(backup, "utf8"));
if (image.format !== "brain-ui-operational-backup" || image.checksum !== exported.snapshot.checksum ||
    (statSync(backup).mode & 0o777) !== 0o600) throw new Error("Packed backup artifact mismatch");
const restoredPath = join(target, "ui.sqlite"), restored = await run("restore", restoredPath, target);
if (JSON.stringify(restored) !== JSON.stringify({ schema_version: 1, ok: true, command: "restore", recovered: 0, resumed: false }))
  throw new Error("Packed restore contract mismatch");
const opened = createUiDb(restoredPath);
if (JSON.stringify(opened.query("SELECT * FROM inbox_scheduler_heartbeats").all()) !==
    JSON.stringify([{ name: "Odysseus", tick_at: Date.UTC(2026, 6, 12), change_cursor: 7 }]) ||
    opened.query("SELECT status FROM inbox_recovery_state").get().status !== "ready")
  throw new Error("Packed restore lost the populated heartbeat or left its gate closed");
const refused = await run("restore", restoredPath, target, 1);
if (JSON.stringify(refused) !== JSON.stringify({ schema_version: 1, ok: false, error: { code: "inbox_restore_nonempty" } }))
  throw new Error("Packed nonempty restore was not refused");
opened.close();
console.log("packed inbox export/restore: populated state, versioned JSON and nonempty refusal pass");
`);
  const child = Bun.spawn([process.execPath, script], { cwd: consumer, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  if (await child.exited !== 0) throw new Error("Packed operational recovery runtime failed");
} finally { rmSync(probe, { recursive: true, force: true }); }
