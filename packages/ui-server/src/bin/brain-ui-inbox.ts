#!/usr/bin/env bun
/** Supported local recovery command; it launches no app, backend or inference. */
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { restoreInboxSnapshot, writeInboxSnapshot } from "../inbox/snapshot.js";

export const USAGE = `usage: brain-ui-inbox export --db <ui.sqlite> --brain-root <directory> --file <backup.json> [--json]
       brain-ui-inbox restore --db <new-ui.sqlite> --brain-root <directory> --file <backup.json> [--json]`;

const [command, ...args] = process.argv.slice(2), json = process.argv.slice(2).includes("--json");
try {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--json") continue;
    const value = args[++i];
    if (!["--db", "--brain-root", "--file"].includes(flag) || values.has(flag) || !value || value.startsWith("--"))
      throw new Error("inbox_usage");
    values.set(flag, value);
  }
  if (!["export", "restore"].includes(command) || values.size !== 3) throw new Error("inbox_usage");
  const dbPath = values.get("--db")!, brainRoot = values.get("--brain-root")!, file = values.get("--file")!;
  let result: Record<string, unknown>;
  if (command === "export") {
    const db = new Database(dbPath, { readonly: true });
    try {
      // Opening a fresh reader can overlap a writer or WAL cleanup. Use the
      // same bounded lock wait as the app before the first recovery query.
      db.exec("PRAGMA busy_timeout = 5000");
      const snapshot = await writeInboxSnapshot(db, brainRoot, file);
      result = { snapshot: { version: snapshot.version, checksum: snapshot.checksum,
        created_at: snapshot.createdAt, recovery_point_hours: snapshot.recoveryPointHours } };
    } finally { db.close(); }
  } else result = await restoreInboxSnapshot(JSON.parse(await readFile(file, "utf8")), dbPath, brainRoot);
  if (json) process.stdout.write(JSON.stringify({ schema_version: 1, ok: true, command, ...result }) + "\n");
  else process.stdout.write(command === "export" ? "Operational backup saved.\n" : "Operational backup restored and reconciled.\n");
} catch (error) {
  const code = error instanceof Error && /^inbox_[a-z_]+$/.test(error.message) ? error.message : "inbox_operation_failed";
  if (json) process.stdout.write(JSON.stringify({ schema_version: 1, ok: false, error: { code } }) + "\n");
  else process.stderr.write(code === "inbox_usage" ? USAGE + "\n" : code + "\n");
  process.exitCode = code === "inbox_usage" ? 2 : 1;
}
