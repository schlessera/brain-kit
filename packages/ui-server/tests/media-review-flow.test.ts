/**
 * Media hygiene review end to end (#2783, epic #1777; design rev 4 §10,
 * rev 5 §12, rev 6 §6, rev 6.1 §3). One Odysseus brain with a bare remote,
 * the real offline CLI and `brain sync`, and the real review server as a
 * separate process (`helpers/media-flow.ts`): decisions go over its socket as
 * the browser sends them, and the server is stopped, killed and booted again
 * on the same state. Every step reads the actual file, config, reference,
 * pin and kept-log bytes, and holds the CLI and the server to the same count
 * and the same selection. Offline and keyless.
 */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARGUS, CONFIG, CONFIG_TEXT, COUNTED, HARBOUR, HARBOUR_TO, KEPT, LOOM, LOOM_TO, MEDIA_BYTES, NOTE, NOTE_TEXT, PINS, PINS_TEXT, SHIELD, SKETCH,
  createMediaFlow, initialBytes, noisePng, sha, type MediaFlow, type Parity,
} from "./helpers/media-flow.js";

const flows: MediaFlow[] = [];
afterEach(async () => { for (const f of flows.splice(0)) await f.close(); });
async function flow(media?: readonly string[], boot: Parameters<MediaFlow["boot"]>[0] = {}, config?: string, bytes?: Record<string, Buffer>) {
  const f = createMediaFlow({ media, config, bytes }); flows.push(f);
  await f.boot(boot);
  return f;
}

/** The bytes with the kept log's set to `value`: Undo of a copy leaves the log, without its entry. */
const withKept = (bytes: Record<string, string | null>, value: string | null): Record<string, string | null> => ({ ...bytes, [KEPT]: value });

type Want = { pending: number; dismissed?: number; snoozed?: number; kept?: number };
/**
 * The CLI and the server report one count, one set-aside split and one
 * selection; a sync's report names the count and never a media path.
 */
function agree(p: Parity, want: Want, selection: "selected" | "kept" = "selected") {
  const setAside = { dismissed: want.dismissed ?? 0, snoozed: want.snoozed ?? 0, kept: want.kept ?? 0 };
  expect(p.server.media, "MEDIA_FLOW_SERVER_COUNT").toEqual({ awaitingReview: want.pending, setAside: setAside.dismissed + setAside.snoozed, kept: setAside.kept });
  expect(p.cli.media, "MEDIA_FLOW_CLI_COUNT").toEqual(p.server.media!);
  // Right after the server selects, it selects what the CLI selects. A card an
  // Undo did not replace stays the server's selection, and must still be eligible.
  if (selection === "selected") expect(p.cli.findingId, "MEDIA_FLOW_SELECTION").toBe(p.server.findingId);
  // A finished pass selects nothing until the next one starts.
  else if (p.server.status === "complete") expect(p.server.findingId, "MEDIA_FLOW_SELECTION_COMPLETE").toBeNull();
  else expect(p.eligible, "MEDIA_FLOW_SELECTION_ELIGIBLE").toBe(true);
  if (!p.sync) return;
  expect({ pending: p.sync.pending, setAside: p.sync.setAside }, "MEDIA_FLOW_SYNC_COUNT").toEqual({ pending: want.pending, setAside });
  expect(p.sync.agent, "MEDIA_FLOW_SYNC_NO_AGENT").toEqual({ invoked: false, reason: "not-needed" });
  const line = p.sync.report.split("\n").find(l => l.startsWith("Media awaiting review:"));
  if (want.pending + setAside.dismissed + setAside.snoozed + setAside.kept === 0) expect(line, "MEDIA_FLOW_REPORT_LINE").toBeUndefined();
  else expect(line, "MEDIA_FLOW_REPORT_LINE").toBe([`Media awaiting review: ${want.pending}`,
    ...(setAside.dismissed + setAside.snoozed ? [`${setAside.dismissed + setAside.snoozed} set aside`] : []),
    ...(setAside.kept ? [`${setAside.kept} kept as a copy`] : []), ...(want.pending ? ["review in Actions"] : [])].join(" · "));
  for (const path of [...Object.keys(MEDIA_BYTES), "photos/", "inbox/", ".brain/"]) expect(p.sync.report, "MEDIA_FLOW_REPORT_NO_PATH").not.toContain(path);
}

/** Wait until the server has finished the decision on `cardId` and settled its next selection. */
const settled = (f: MediaFlow, cardId: string) => f.until(r => r.action?.id !== cardId && (r.review.status !== "active" || r.action?.status === "pending"), `card ${cardId} settled`);
/**
 * Leave pending every card until the one at `path`, as a person working
 * through review does, starting the next pass when this one has finished.
 */
async function reach(f: MediaFlow, device: Awaited<ReturnType<MediaFlow["device"]>>, path: string) {
  for (let i = 0; i < 2 * (COUNTED.length + 1); i++) {
    if ((await f.read()).review.status === "complete") expect((await f.command("start")).status).toBe(200);
    const r = await f.until(read => read.action?.status === "pending", "a pending card");
    if (r.action.hygiene.finding.path === path) return r.action;
    device.resolve(r.action.id, "leave-pending");
    await settled(f, r.action.id);
  }
  throw new Error(`review never selected ${path}`);
}
/** Preview a destination for Move or Keep a permanent copy, as the card's input does. */
async function destination(f: MediaFlow, card: any, optionId: string, to: string) {
  const previewed = await f.preview({ itemId: card.id, optionId, expectedVersion: card.version, input: to });
  expect(previewed.status).toBe(200);
  expect(previewed.body.refusals, "MEDIA_FLOW_PREVIEW_REFUSALS").toEqual([]);
  return previewed.body;
}
const receiptOf = async (f: MediaFlow, device: Awaited<ReturnType<MediaFlow["device"]>>, cardId: string) => {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const item = device.item(cardId);
    if (item?.status === "resolved" && item.hygiene?.outcome) return item.hygiene.outcome;
    await Bun.sleep(25);
  }
  throw new Error(`no receipt replicated for ${cardId}`);
};

test("sync reports only the count, and review selects each media finding the CLI selects, with the same count", async () => {
  const f = await flow();
  const before = f.bytes();
  expect(before, "MEDIA_FLOW_FIXTURE_BYTES").toEqual(initialBytes());
  // Before any review: the offline sync and the CLI count the four content files, never the pinned scratch.
  const first = f.sync();
  expect(first.run.leftovers.mediaPending).toBe(COUNTED.length);
  expect(first.run.report.split("\n").at(-1), "MEDIA_FLOW_COUNT_ONLY").toBe("Media awaiting review: 4 · review in Actions");
  expect(first.agent).toEqual({ invoked: false, reason: "not-needed" });
  await f.command("start");
  const device = await f.device();
  const seen: string[] = [];
  // Every media finding is selected once a pass, each where the CLI selects it, and each stays counted.
  for (let i = 0; i < COUNTED.length + 1; i++) {
    const p = await f.parity({ sync: i === 0 });
    agree(p, { pending: COUNTED.length });
    expect(p.server.path).not.toBeNull();
    seen.push(p.server.path!);
    const id = (await f.read()).action.id;
    device.resolve(id, "leave-pending");
    if ((await settled(f, id)).review.status === "complete") break;
  }
  expect([...seen].sort(), "MEDIA_FLOW_EVERY_FINDING").toEqual([...COUNTED, HARBOUR].sort());
  // Leave pending wrote nothing: every byte is the fixture's.
  expect(f.bytes(), "MEDIA_FLOW_LEAVE_PENDING_NO_WRITE").toEqual(before);
  agree(await f.parity(), { pending: COUNTED.length });
  await device.close();
});

/**
 * One action through review: apply it, read every byte, Undo it and read
 * them again, then apply it again on the successor card and let an ordinary
 * sync commit and push the result. `expectApplied` names the bytes after.
 */
async function actionRoundTrip(f: MediaFlow, path: string, optionId: string, to: string | undefined, expectApplied: (bytes: Record<string, string | null>) => void, want: { applied: Want; initial: Want }) {
  const device = await f.device();
  await f.command("start");
  const initial = f.bytes();
  let card = await reach(f, device, path);
  agree(await f.parity({ sync: true }), want.initial);
  if (to) await destination(f, card, optionId, to);
  device.resolve(card.id, optionId);
  const receipt = await receiptOf(f, device, card.id);
  expect(receipt.media, "MEDIA_FLOW_APPLIED").toMatchObject({ outcome: optionId === "media-keep-copy" ? "kept" : "applied", undo: { available: true } });
  await settled(f, card.id);
  expectApplied(f.bytes());
  agree(await f.parity({ sync: false }), want.applied);

  // Undo puts back every byte the effect wrote, and the finding is pending again.
  const undone = await f.undo(receipt.media.journalId);
  expect(undone.status).toBe(200);
  expect(undone.body.mediaUndo, "MEDIA_FLOW_UNDONE").toMatchObject({ outcome: "undone" });
  // Undo of a kept copy leaves the kept log without its entry (rev 5 §5.7).
  const keptLog = f.text(KEPT);
  expect(withKept(f.bytes(), initial[KEPT]), "MEDIA_FLOW_UNDO_BYTES").toEqual(initial);
  if (initial[KEPT] === null && keptLog !== null) expect(keptLog, "MEDIA_FLOW_UNDO_KEPT_ENTRY").not.toContain("### media-");
  else expect(f.bytes()[KEPT]).toBe(initial[KEPT]!);
  // A sync after Undo commits none of it.
  const p = await f.parity({ sync: true });
  agree(p, want.initial, "kept");
  for (const file of [path, ...(to ? [to] : [])]) expect(f.remoteFiles(), "MEDIA_FLOW_UNDO_NOT_COMMITTED").not.toContain(file);

  // Apply again, from the card review selects for the restored finding.
  card = await reach(f, device, path);
  if (to) await destination(f, card, optionId, to);
  device.resolve(card.id, optionId);
  expect((await receiptOf(f, device, card.id)).media.outcome).toBe(optionId === "media-keep-copy" ? "kept" : "applied");
  await settled(f, card.id);
  expectApplied(f.bytes());
  agree(await f.parity({ sync: true }), want.applied);
  await device.close();
  return f.remoteFiles();
}

test("Persist here: the config tracks exactly the file, Undo restores its bytes, and the next sync commits the file and the rule", async () => {
  const f = await flow([SHIELD, ARGUS]);
  const tracked = '{ "media": { "ignore": [".brain/scratch/**"], "track": ["photos/achilles-shield.png"] } }\n';
  const remote = await actionRoundTrip(f, SHIELD, "media-persist", undefined, bytes => {
    expect(bytes[CONFIG], "MEDIA_FLOW_PERSIST_CONFIG").toBe(sha(tracked));
    expect(bytes[SHIELD], "MEDIA_FLOW_PERSIST_FILE").toBe(sha(MEDIA_BYTES[SHIELD]!));
  }, { initial: { pending: 2 }, applied: { pending: 1 } });
  expect(remote, "MEDIA_FLOW_PERSIST_COMMITTED").toEqual(expect.arrayContaining([SHIELD, CONFIG]));
  expect(remote).not.toContain(ARGUS);
  expect(f.git("show", `origin/main:${CONFIG}`)).toBe(tracked.trimEnd());
});

test("Move into a tracked folder: the file and its reference move together, Undo restores both, and the next sync commits the moved file and the note", async () => {
  // Move adds no rule: the destination is final because the brain already tracks it.
  const config = '{ "media": { "ignore": [".brain/scratch/**"], "track": ["places/**"] } }\n';
  const f = await flow([LOOM, ARGUS], {}, config);
  const moved = NOTE_TEXT.replace("../photos/penelope-loom.png", "../places/ithaca/penelope-loom.png");
  const remote = await actionRoundTrip(f, LOOM, "media-move", LOOM_TO, bytes => {
    expect(bytes[LOOM], "MEDIA_FLOW_MOVE_SOURCE").toBeNull();
    expect(bytes[LOOM_TO], "MEDIA_FLOW_MOVE_DESTINATION").toBe(sha(MEDIA_BYTES[LOOM]!));
    expect(bytes[NOTE], "MEDIA_FLOW_MOVE_REFERENCE").toBe(sha(moved));
    expect(bytes[CONFIG], "MEDIA_FLOW_MOVE_CONFIG").toBe(sha(config));
  }, { initial: { pending: 2 }, applied: { pending: 1 } });
  expect(remote, "MEDIA_FLOW_MOVE_COMMITTED").toEqual(expect.arrayContaining([LOOM_TO, NOTE]));
  expect(remote).not.toContain(LOOM);
  expect(f.git("show", `origin/main:${NOTE}`) + "\n").toBe(moved);
});

test("Delete: the file goes, Undo restores its exact bytes, and the next sync has one file fewer to count and nothing to commit for it", async () => {
  const f = await flow([SKETCH, ARGUS]);
  const remote = await actionRoundTrip(f, SKETCH, "media-delete", undefined, bytes => {
    expect(bytes[SKETCH], "MEDIA_FLOW_DELETE_FILE").toBeNull();
    expect(bytes[CONFIG], "MEDIA_FLOW_DELETE_CONFIG").toBe(sha(CONFIG_TEXT));
  }, { initial: { pending: 2 }, applied: { pending: 1 } });
  expect(remote).not.toContain(SKETCH);
});

test("Keep a permanent copy of linked, normally ignored scratch: the original, its pins and link stay, Undo removes the copy, rule and kept entry, and the next sync commits only the copy", async () => {
  const f = await flow([HARBOUR, ARGUS]);
  const tracked = '{ "media": { "ignore": [".brain/scratch/**"], "track": ["places/ithaca/harbour-dawn.png"] } }\n';
  const remote = await actionRoundTrip(f, HARBOUR, "media-keep-copy", HARBOUR_TO, bytes => {
    expect(bytes[HARBOUR], "MEDIA_FLOW_KEEP_ORIGINAL").toBe(sha(MEDIA_BYTES[HARBOUR]!));
    expect(bytes[HARBOUR_TO], "MEDIA_FLOW_KEEP_COPY").toBe(sha(MEDIA_BYTES[HARBOUR]!));
    expect(bytes[PINS], "MEDIA_FLOW_KEEP_PINS").toBe(sha(PINS_TEXT));
    expect(bytes[CONFIG], "MEDIA_FLOW_KEEP_CONFIG").toBe(sha(tracked));
    expect(f.text(KEPT), "MEDIA_FLOW_KEEP_ENTRY").toContain(`- copy: \`${HARBOUR_TO}\`\n- copy-sha256: ${sha(MEDIA_BYTES[HARBOUR]!)}\n`);
    // Pinned scratch is review-only (#2780 ruling): its copy never enters the routine count.
  }, { initial: { pending: 1 }, applied: { pending: 1 } });
  expect(remote, "MEDIA_FLOW_KEEP_COMMITTED").toEqual(expect.arrayContaining([HARBOUR_TO, CONFIG]));
  expect(remote.filter(p => p.startsWith(".brain/")), "MEDIA_FLOW_KEEP_SCRATCH_UNCOMMITTED").toEqual([]);
  // The conversation link still serves the original through the files route.
  const served = await fetch(`${f.url}/api/files/content?path=${encodeURIComponent(HARBOUR)}&raw=1`, { headers: { "x-media-flow-principal": "owner" } });
  expect(served.status).toBe(200);
  expect(sha(Buffer.from(await served.arrayBuffer())), "MEDIA_FLOW_KEEP_LINK_SERVES_ORIGINAL").toBe(sha(MEDIA_BYTES[HARBOUR]!));
});

test("restart and reconnect mid-pass keep the deferrals, set-aside dispositions and counts, and a new pass selects deferred media again", async () => {
  const f = await flow([LOOM, SHIELD, SKETCH, ARGUS]);
  const before = f.bytes();
  let device = await f.device();
  await f.command("start");
  // Dismiss one file and snooze another: both set aside, so neither is awaiting review.
  const dismissed = await f.until(r => r.action?.status === "pending", "a pending card");
  device.resolve(dismissed.action.id, "dismiss");
  const snoozed = await settled(f, dismissed.action.id);
  device.resolve(snoozed.action.id, "later");
  const third = await settled(f, snoozed.action.id);
  agree(await f.parity({ sync: true }), { pending: 2, dismissed: 1, snoozed: 1 });
  // Leave one pending: it still counts, and is skipped for the rest of the pass.
  device.resolve(third.action.id, "leave-pending");
  const fourth = await settled(f, third.action.id);
  expect(fourth.review.deferred.map((d: { findingId: string }) => d.findingId), "MEDIA_FLOW_DEFERRED").toEqual([third.action.hygiene.findingId]);
  agree(await f.parity({ sync: false }), { pending: 2, dismissed: 1, snoozed: 1 });

  // The host dies mid-pass: nothing is closed. The same state boots again on the same port.
  const port = Number(new URL(f.url).port);
  await f.kill();
  await f.boot({ port });
  const rebooted = await f.read();
  expect(rebooted.review.pendingActionId, "MEDIA_FLOW_RESTART_SAME_CARD").toBe(fourth.review.pendingActionId);
  expect(rebooted.review.deferred, "MEDIA_FLOW_RESTART_DEFERRALS").toEqual(fourth.review.deferred);
  expect(rebooted.review.media, "MEDIA_FLOW_RESTART_COUNTS").toEqual(fourth.review.media);
  agree(await f.parity({ sync: true }), { pending: 2, dismissed: 1, snoozed: 1 });
  // A device reconnects and receives the same card; a clean stop and start keep it too.
  await device.close();
  device = await f.device();
  await f.until(() => device.item(fourth.review.pendingActionId)?.status === "pending", "the reconnected device holds the pending card");
  await f.stop();
  await f.boot({ port });
  device = await f.device();
  expect((await f.read()).review.deferred).toEqual(fourth.review.deferred);
  device.resolve(fourth.review.pendingActionId, "leave-pending");
  const finished = await settled(f, fourth.review.pendingActionId);
  expect(finished.review.status, "MEDIA_FLOW_PASS_COMPLETE").toBe("complete");
  agree(await f.parity({ sync: true }), { pending: 2, dismissed: 1, snoozed: 1 });
  // Nothing was written to the brain's media, config or references.
  expect(withKept(f.bytes(), null), "MEDIA_FLOW_DISPOSITIONS_NO_MEDIA_WRITE").toEqual(before);

  // The next pass forgets the deferrals and selects both deferred files again.
  const next = (await f.command("start")).body;
  expect(next.review.pass, "MEDIA_FLOW_NEW_PASS").toBe(2);
  expect(next.review.deferred).toEqual([]);
  agree(await f.parity({ sync: false }), { pending: 2, dismissed: 1, snoozed: 1 });
  expect([third.action.hygiene.findingId, fourth.action.hygiene.findingId], "MEDIA_FLOW_NEW_PASS_RESELECTS").toContain(next.action.hygiene.findingId);
  await device.close();
});

test("capacity: a capture that cannot fit the change journal refuses before any write, and nothing changes in either count", async () => {
  // A 1.4 MB sketch against a 1 MiB journal: its pre-image cannot be captured.
  const f = await flow([SKETCH, ARGUS], { capBytes: 1024 * 1024 }, undefined, { [SKETCH]: noisePng(700) });
  const device = await f.device();
  await f.command("start");
  const before = f.bytes();
  const card = await reach(f, device, SKETCH);
  device.resolve(card.id, "media-delete");
  const receipt = (await f.until(r => r.action?.hygiene?.outcome && r.action.hygiene.outcome.status !== "applying", "a refused outcome")).action.hygiene.outcome;
  expect(receipt, "MEDIA_FLOW_CAPACITY_REFUSED").toMatchObject({ status: "refused", reason: "capture-capacity", media: { outcome: "refused", reason: "capture-capacity" } });
  expect(f.bytes(), "MEDIA_FLOW_CAPACITY_NO_WRITE").toEqual(before);
  agree(await f.parity({ sync: true }), { pending: 2 }, "kept");
  await device.close();
});

test("stale premise: a config edited after the Move preview makes the apply stale, with nothing moved or rewritten", async () => {
  const config = '{ "media": { "ignore": [".brain/scratch/**"], "track": ["places/**"] } }\n';
  const f = await flow([LOOM, ARGUS], {}, config);
  const device = await f.device();
  await f.command("start");
  const card = await reach(f, device, LOOM);
  await destination(f, card, "media-move", LOOM_TO);
  // Penelope adds an unrelated standing rule on another device before Odysseus confirms.
  const edited = '{ "media": { "ignore": [".brain/scratch/**", "*.psd"], "track": ["places/**"] } }\n';
  writeFileSync(join(f.root, CONFIG), edited);
  const before = f.bytes();
  device.resolve(card.id, "media-move");
  await f.until(() => !!device.item(card.id)?.hygiene?.outcome && device.item(card.id).hygiene.outcome.status !== "applying", "the card's outcome");
  const outcome = device.item(card.id).hygiene.outcome;
  expect(outcome, "MEDIA_FLOW_STALE_OUTCOME").toMatchObject({ status: "stale", media: { outcome: "stale", reason: "premise-changed" } });
  expect(f.bytes(), "MEDIA_FLOW_STALE_NO_WRITE").toEqual(before);
  expect(f.text(NOTE), "MEDIA_FLOW_STALE_REFERENCE").toBe(NOTE_TEXT);
  agree(await f.parity({ sync: false }), { pending: 2 }, "kept");
  await device.close();
});

/** Run until the server halts at its interrupt step, then kill it there and boot it again. */
async function interrupted(f: MediaFlow, port: number, decide: () => void) {
  decide();
  const end = Date.now() + 10_000;
  while (!f.interrupted() && Date.now() < end) await Bun.sleep(25);
  expect(f.interrupted(), "MEDIA_FLOW_INTERRUPTED").toBe(true);
  const written = f.bytes();
  await f.kill();
  await f.boot({ port });
  return written;
}

test("interruption: a host killed between the copy and its kept entry is compensated at boot, and nothing is kept or committed", async () => {
  const f = await flow([HARBOUR, ARGUS], { interrupt: "keep-copy" });
  const port = Number(new URL(f.url).port);
  const device = await f.device();
  await f.command("start");
  const before = f.bytes();
  const card = await reach(f, device, HARBOUR);
  await destination(f, card, "media-keep-copy", HARBOUR_TO);
  const written = await interrupted(f, port, () => device.resolve(card.id, "media-keep-copy"));
  // Step 6 wrote the copy and its rule; step 6b, the kept entry, never ran.
  expect(written[HARBOUR_TO], "MEDIA_FLOW_INTERRUPTED_COPY_WRITTEN").toBe(sha(MEDIA_BYTES[HARBOUR]!));
  expect(written[KEPT]).toBeNull();
  expect(f.bytes(), "MEDIA_FLOW_INTERRUPTED_COPY_COMPENSATED").toEqual(before);
  const recovered = await f.until(r => r.action?.hygiene?.outcome?.media, "the recovered receipt");
  expect(recovered.action.hygiene.outcome, "MEDIA_FLOW_INTERRUPTED_COPY_RECEIPT").toMatchObject({ status: "check_failed", media: { outcome: "compensated", action: "keep-copy" } });
  agree(await f.parity({ sync: true }), { pending: 1 }, "kept");
  expect(f.remoteFiles(), "MEDIA_FLOW_INTERRUPTED_COPY_UNCOMMITTED").not.toContain(HARBOUR_TO);
  await device.close().catch(() => {});
});

test("interruption: a host killed after a Move wrote the file and its reference is compensated at boot and never re-applied", async () => {
  const f = await flow([LOOM, ARGUS], { interrupt: "media" }, '{ "media": { "ignore": [".brain/scratch/**"], "track": ["places/**"] } }\n');
  const port = Number(new URL(f.url).port);
  const device = await f.device();
  await f.command("start");
  const before = f.bytes();
  const card = await reach(f, device, LOOM);
  await destination(f, card, "media-move", LOOM_TO);
  const written = await interrupted(f, port, () => device.resolve(card.id, "media-move"));
  expect(written[LOOM_TO], "MEDIA_FLOW_INTERRUPTED_MOVE_WRITTEN").toBe(sha(MEDIA_BYTES[LOOM]!));
  expect(written[LOOM]).toBeNull();
  expect(f.bytes(), "MEDIA_FLOW_INTERRUPTED_MOVE_COMPENSATED").toEqual(before);
  expect(f.text(NOTE)).toBe(NOTE_TEXT);
  const recovered = await f.until(r => r.action?.hygiene?.outcome?.media, "the recovered receipt");
  expect(recovered.action.hygiene.outcome, "MEDIA_FLOW_INTERRUPTED_MOVE_RECEIPT").toMatchObject({ status: "check_failed", media: { outcome: "compensated", action: "move" } });
  agree(await f.parity({ sync: true }), { pending: 2 }, "kept");
  expect(f.remoteFiles()).not.toContain(LOOM_TO);
  await device.close().catch(() => {});
});

test("isolation: another owner device cannot undo Odysseus's effect, and a delegated agent can neither start, preview, apply nor undo", async () => {
  const f = await flow([SKETCH, ARGUS]);
  const device = await f.device();
  await f.command("start");
  const card = await reach(f, device, SKETCH);
  device.resolve(card.id, "media-delete");
  const receipt = await receiptOf(f, device, card.id);
  expect(receipt.media.outcome).toBe("applied");
  await settled(f, card.id);
  const deleted = f.bytes();
  // Penelope's tablet is an owner too, but the receipt is Odysseus's.
  expect((await f.undo(receipt.media.journalId, "penelope")).status, "MEDIA_FLOW_ISOLATION_OTHER_OWNER_UNDO").toBe(500);
  expect(f.bytes(), "MEDIA_FLOW_ISOLATION_OTHER_OWNER_NO_WRITE").toEqual(deleted);

  // The delegated research agent has no review authority at all.
  const pending = (await f.until(r => r.action?.status === "pending", "the next card")).action;
  expect((await f.command("start", "agent")).status, "MEDIA_FLOW_ISOLATION_AGENT_START").toBe(403);
  expect((await f.preview({ itemId: pending.id, optionId: "media-delete", expectedVersion: pending.version, input: null }, "agent")).status, "MEDIA_FLOW_ISOLATION_AGENT_PREVIEW").toBe(403);
  expect((await f.undo(receipt.media.journalId, "agent")).status, "MEDIA_FLOW_ISOLATION_AGENT_UNDO").toBe(403);
  const agent = await f.device("agent");
  agent.resolve(pending.id, "media-delete");
  await Bun.sleep(500);
  expect((await f.read()).action, "MEDIA_FLOW_ISOLATION_AGENT_CARD").toEqual(pending);
  expect(f.bytes(), "MEDIA_FLOW_ISOLATION_AGENT_NO_WRITE").toEqual(deleted);
  agree(await f.parity({ sync: false }), { pending: 1 });

  // Odysseus's own Undo still works.
  expect((await f.undo(receipt.media.journalId)).body.mediaUndo.outcome).toBe("undone");
  expect(f.bytes()[SKETCH]).toBe(sha(MEDIA_BYTES[SKETCH]!));
  await agent.close();
  await device.close();
});

test("in maintenance workers: the review's CLI runs behind the native manager boundary, Keep a permanent copy applies and Undo restores, and the counts agree", async () => {
  // Every brain command the server issues runs in a credential-free maintenance
  // worker, with no host fallback; the copied checkpoints are the test-only broker's.
  const f = await flow([HARBOUR, ARGUS], { execution: "worker" });
  expect(f.hostExecution, "MEDIA_FLOW_WORKER_EXECUTION").toBe("worker");
  // The boundary qualified a maintenance worker at boot, as the app requires before admission.
  expect(f.governed, "MEDIA_FLOW_WORKER_QUALIFIED").toMatchObject({ available: true });
  const device = await f.device();
  const before = f.bytes();
  expect((await f.command("start")).status, "MEDIA_FLOW_WORKER_START").toBe(200);
  const card = await reach(f, device, HARBOUR);
  await destination(f, card, "media-keep-copy", HARBOUR_TO);
  device.resolve(card.id, "media-keep-copy");
  const receipt = await receiptOf(f, device, card.id);
  expect(receipt.media, "MEDIA_FLOW_WORKER_KEPT").toMatchObject({ outcome: "kept", undo: { available: true } });
  await settled(f, card.id);
  const kept = f.bytes();
  expect(kept[HARBOUR_TO], "MEDIA_FLOW_WORKER_COPY").toBe(sha(MEDIA_BYTES[HARBOUR]!));
  expect(kept[HARBOUR]).toBe(before[HARBOUR]!);
  expect(kept[PINS]).toBe(before[PINS]!);
  expect(f.text(KEPT), "MEDIA_FLOW_WORKER_KEPT_ENTRY").toContain(`- copy: \`${HARBOUR_TO}\``);
  agree(await f.parity({ sync: false }), { pending: 1 });
  const undone = await f.undo(receipt.media.journalId);
  expect(undone.body.mediaUndo, "MEDIA_FLOW_WORKER_UNDONE").toMatchObject({ outcome: "undone" });
  expect(withKept(f.bytes(), null), "MEDIA_FLOW_WORKER_UNDO_BYTES").toEqual(before);
  agree(await f.parity({ sync: true }), { pending: 1 }, "kept");
  await device.close();
});
