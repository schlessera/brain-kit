import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { commandTaintSource } from "../src/activity/command-taint";
import { recordFirstTaint } from "../src/governance/session-taint";

test("pre-proxy fetching and opaque commands produce taint before their output is trusted", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-command-taint-"));
  try {
    writeFileSync(join(root, "curl"), "#!/bin/sh\nprintf fictional-web-result\n", { mode: 0o700 });
    writeFileSync(join(root, "fetch.sh"), "printf fictional-opaque-result\n");
    for (const [command, source, output] of [
      ["curl https://example.org", "fetching_command", "fictional-web-result"],
      ["sh fetch.sh", "unclassified_command", "fictional-opaque-result"],
    ] as const) {
      const child = Bun.spawn(["/bin/sh", "-c", command!], { cwd: root, env: { PATH: `${root}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe(output!);
      expect(commandTaintSource("Bash", { command }), "G6_PREPROXY_EXECUTED_COMMAND_TAINT").toBe(source);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the first durable session source survives a later turn and independent recorder instance", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE governance_events (id INTEGER PRIMARY KEY, kind TEXT, turn_id TEXT, session_id TEXT, payload TEXT)");
  const write = (event: Parameters<typeof recordFirstTaint>[1]) => {
    db.query("INSERT INTO governance_events (kind,turn_id,session_id,payload) VALUES (?,?,?,?)")
      .run(event.kind, event.turnId ?? null, event.sessionId ?? null, JSON.stringify(event.payload));
  };
  const initial = { kind: "taint" as const, turnId: "odysseus-first", sessionId: "odysseus-session", actor: "interactive" as const, model: null, profile: null, payload: { source: "fetching_command" as const, tool: "Bash", detail: null } };
  try {
    recordFirstTaint(db, initial, write);
    recordFirstTaint(db, { ...initial, turnId: "odysseus-second", payload: { source: "unclassified_command", tool: "bash", detail: null } }, write);
    expect(db.query("SELECT turn_id,payload FROM governance_events").all(), "G6_FIRST_SESSION_SOURCE_IS_STICKY").toEqual([
      { turn_id: "odysseus-first", payload: JSON.stringify(initial.payload) },
    ]);
    recordFirstTaint(db, { ...initial, turnId: "telemachus-first", sessionId: "telemachus-session" }, write);
    expect(db.query("SELECT count(*) AS n FROM governance_events").get()).toEqual({ n: 2 });
    // Anonymous turns deduplicate within their turn, never across all null sessions.
    recordFirstTaint(db, { ...initial, turnId: "anonymous-first", sessionId: null }, write);
    recordFirstTaint(db, { ...initial, turnId: "anonymous-first", sessionId: null }, write);
    recordFirstTaint(db, { ...initial, turnId: "anonymous-second", sessionId: null }, write);
    expect(db.query("SELECT count(*) AS n FROM governance_events").get()).toEqual({ n: 4 });
  } finally { db.close(); }
});

test("failed recording rolls back rather than consuming the first source", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE governance_events (id INTEGER PRIMARY KEY, kind TEXT, turn_id TEXT, session_id TEXT, payload TEXT)");
  const event = { kind: "taint" as const, turnId: "odysseus-first", sessionId: "odysseus-session", actor: "interactive" as const, model: null, profile: null, payload: { source: "fetching_command" as const, tool: "Bash", detail: null } };
  try {
    expect(() => recordFirstTaint(db, event, value => {
      db.query("INSERT INTO governance_events (kind,turn_id,session_id) VALUES (?,?,?)").run(value.kind, value.turnId!, value.sessionId!);
      throw new Error("fixture recording failure");
    })).toThrow("fixture recording failure");
    expect(db.query("SELECT count(*) AS n FROM governance_events").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

test("both backend shell names recognize fetches and conservatively retain opaque syntax", () => {
  for (const tool of ["Bash", "bash"]) {
    for (const command of ["curl https://example.org", "wget https://example.org", "git clone fixture", "git -C workspaces/reference fetch", "brain scrape https://example.org", "brain import fixture", "chromium --headless", "rtk proxy curl https://example.org"]) {
      expect(commandTaintSource(tool, { command }), command).toBe("fetching_command");
    }
    for (const command of ["sh fetch.sh", "python script.py", "ls; curl fixture", "ls $(curl fixture)", "ls > /dev/tcp/example.org/80", "ls\ncurl fixture", "PATH=fixture ls", "brain search query | sh", "brain search `curl fixture`", "ls 'unterminated"]) {
      expect(commandTaintSource(tool, { command }), command).toBe("unclassified_command");
    }
    for (const command of ["ls", "ls -la workspaces", "brain search Ithaca", "rtk proxy ls -la"]) {
      expect(commandTaintSource(tool, { command }), command).toBeNull();
    }
    expect(commandTaintSource(tool, {})).toBe("unclassified_command");
  }
  expect(commandTaintSource("Read", { command: "curl fixture" })).toBeNull();
});
