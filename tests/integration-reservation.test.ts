import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertLease, emptyReservation, GitReservationStore, LEASE_MS, MAX_MS, RENEW_MS,
  parseReservation, reservationServerTime, reservationTransition } from "../scripts/integration-reservation";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const candidate = { repository: "https://github.com/odysseus/brain-kit", pr: 7, head: "a".repeat(40), base: "b".repeat(40) };
const acquire = (id = "1".repeat(32)) => ({ kind: "acquire" as const, candidate, id });

test("renewal preserves the hard cap, missed heartbeats expire, and stale owners cannot revive or alter successors", () => {
  expect(RENEW_MS).toBe(60_000); expect(LEASE_MS).toBe(300_000); expect(MAX_MS).toBe(3_600_000);
  let state = reservationTransition(emptyReservation(), acquire(), 101, 0);
  expect(() => reservationTransition(state, acquire("2".repeat(32)), 202, 1)).toThrow("Integration busy");
  state = reservationTransition(state, { kind: "renew", id: "1".repeat(32) }, 101, RENEW_MS);
  expect(state.active!.expires).toBe(RENEW_MS + LEASE_MS); expect(state.active!.cap).toBe(MAX_MS);
  expect(() => reservationTransition(state, { kind: "renew", id: "1".repeat(32) }, 101, state.active!.expires)).toThrow("expired");
  state = reservationTransition(state, acquire("2".repeat(32)), 202, state.active!.expires);
  for (const kind of ["renew", "release"] as const) expect(() => reservationTransition(state, { kind, id: "1".repeat(32) }, 101, state.updated)).toThrow();
  expect(() => assertLease(state, "1".repeat(32), 101, candidate, state.updated)).toThrow("superseded");
  expect(() => assertLease(state, state.active!.id, 202, { ...candidate, head: "c".repeat(40) }, state.updated)).toThrow("mismatched");
  const start = state.active!.acquired;
  expect(() => reservationTransition(state, { kind: "renew", id: state.active!.id }, 202, start + MAX_MS - 1)).toThrow("expired");
  // The old lease expired long before this renewal; no activity revives it.
});

test("continuous minute heartbeats reach but never reset the sixty-minute cap", () => {
  let state = reservationTransition(emptyReservation(), acquire(), 101, 0);
  for (let now = RENEW_MS; now < MAX_MS; now += RENEW_MS) state = reservationTransition(state, { kind: "renew", id: state.active!.id }, 101, now);
  expect(state.active!.cap).toBe(MAX_MS); expect(state.active!.expires).toBe(MAX_MS);
  expect(() => reservationTransition(state, { kind: "renew", id: state.active!.id }, 101, MAX_MS)).toThrow("expired");
  expect(() => assertLease(state, state.active!.id, 101, candidate, MAX_MS)).toThrow("expired");
});

test("revocation records actor, time, reason and identity and immediately fences the old owner", () => {
  let state = reservationTransition(emptyReservation(), acquire(), 101, 0);
  expect(() => reservationTransition(state, { kind: "revoke", maintainer: false, reason: "Release abandoned proof" }, 202, 1)).toThrow("Maintainer");
  expect(() => reservationTransition(state, { kind: "revoke", maintainer: true, reason: "" }, 202, 1)).toThrow("reason");
  state = reservationTransition(state, { kind: "revoke", maintainer: true, reason: "Release abandoned proof" }, 202, 1);
  expect(state.last).toMatchObject({ actor: 202, at: 1, action: "revoke", reason: "Release abandoned proof", previous: { id: "1".repeat(32) } });
  expect(() => assertLease(state, "1".repeat(32), 101, candidate, 1)).toThrow();
  state = reservationTransition(state, acquire("2".repeat(32)), 202, 2);
  expect(() => reservationTransition(state, { kind: "release", id: "1".repeat(32) }, 101, 3)).toThrow("does not own");
});

test("the authoritative clock rejects missing, stale, malformed and failed HTTP evidence", () => {
  const date = "Sun, 12 Jul 2026 00:00:00 GMT";
  expect(reservationServerTime(`HTTP/2.0 200 OK\r\nDate: ${date}\r\n\r\n{}`)).toBe(Date.parse(date));
  for (const response of ["", `HTTP/2.0 200 OK\n\n{}`, `HTTP/2.0 403 Forbidden\nDate: ${date}\n\n{}`, `HTTP/2.0 200 OK\nDate: invalid\n\n{}`, `HTTP/2.0 200 OK\nDate: ${date}\nAge: 1\n\n{}`]) expect(() => reservationServerTime(response)).toThrow("clock unavailable");
});

test("real concurrent acquisition snapshots cannot both publish ownership through the remote CAS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-integration-cas-")); dirs.push(dir);
  const remote = join(dir, "remote.git");
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  };
  git("init", "--bare", remote);
  for (const name of ["one", "two"]) { mkdirSync(join(dir, name)); git("init", join(dir, name)); const result = Bun.spawnSync(["git", "remote", "add", "origin", remote], { cwd: join(dir, name), stdout: "pipe", stderr: "pipe" }); expect(result.exitCode).toBe(0); }
  const script = join(dir, "contender.ts"), source = resolve(import.meta.dir, "../scripts/integration-reservation.ts");
  writeFileSync(script, `import { existsSync, writeFileSync } from "node:fs";
    import { GitReservationStore, reservationTransition } from ${JSON.stringify(source)};
    const [root, number, barrier]=process.argv.slice(2), store=new GitReservationStore(root), snapshot=store.read();
    writeFileSync(barrier+number,"ready");while(!existsSync(barrier+"1")||!existsSync(barrier+"2"))await Bun.sleep(5);
    if(number==="2")while(!existsSync(barrier+"published"))await Bun.sleep(5);
    const state=reservationTransition(snapshot.state,{kind:"acquire",candidate:${JSON.stringify(candidate)},id:number.repeat(32)},Number(number),0);
    const published=store.publish(snapshot,state);if(number==="1")writeFileSync(barrier+"published","done");
    console.log(JSON.stringify({published}));`);
  const children = ["1", "2"].map((id, index) => Bun.spawn([process.execPath, script, join(dir, index ? "two" : "one"), id, join(dir, "barrier-")], { stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async child => {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err).toBe(0); return JSON.parse(out).published as boolean;
  }));
  expect(results, "ONLY_ONE_REMOTE_ACQUISITION_SUCCEEDS").toEqual([true, false]);
  expect(new GitReservationStore(join(dir, "two")).read().state.active?.actor).toBe(1);
});

test("shared state refuses malformed ownership and missing or corrupt revocation audit", () => {
  const acquired = reservationTransition(emptyReservation(), acquire(), 101, 0);
  const revoked = reservationTransition(acquired, { kind: "revoke", maintainer: true, reason: "Abandon proof" }, 202, 1);
  for (const state of [ { ...acquired, active: false }, { ...acquired, last: null },
    { ...revoked, last: { ...revoked.last, actor: 0 } }, { ...revoked, last: { ...revoked.last, at: 2 } },
    { ...revoked, last: { ...revoked.last, reason: "" } }, { ...revoked, last: { ...revoked.last, previous: null } } ]) {
    expect(() => parseReservation(JSON.stringify(state))).toThrow();
  }
  expect(parseReservation(JSON.stringify(revoked))).toEqual(revoked);
});
