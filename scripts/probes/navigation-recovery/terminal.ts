import { createHarness } from "./harness.ts";
const { app, results, reset, open, persist, close, controls, origin } =
  await createHarness("terminal");
try {
  const p = await open(900, false, "dark");
  await reset(p, false);
  const sid = "odysseus-terminal-proof";
  await p.evaluate((id) => (window as any).probe.select(id), sid);
  await p.evaluate(
    (id) =>
      (window as any).probe.send({
        type: "chat_message",
        text: "first voyage",
        sessionId: id,
      }),
    sid
  );
  await p.waitForFunction(
    (id) => (window as any).probe.state().buffers[id]?.messages.length > 0,
    sid
  );
  const activeCatalog = app.db
    .query("SELECT last_active_at AS lastActiveAt FROM sessions WHERE id = ?")
    .get(sid);
  const wire = await p.evaluate(
    (id) => (window as any).probeWire.filter((f: any) => f.sessionId === id),
    sid
  );
  const live = await (
    await fetch(`${origin}/api/activity/runs?session=${sid}`)
  ).json();
  controls.get(sid)!.finish();
  await p.waitForFunction(
    (id) => !(window as any).probe.state().runStates[id],
    sid
  );
  await p.waitForTimeout(50);
  const terminal = await (
    await fetch(`${origin}/api/activity/runs?session=${sid}`)
  ).json();
  await p.evaluate(
    (id) =>
      (window as any).probe.send({
        type: "chat_message",
        text: "second voyage",
        sessionId: id,
      }),
    sid
  );
  await p.waitForFunction(
    (id) => !!(window as any).probe.state().runStates[id],
    sid
  );
  await p.waitForTimeout(50);
  const nextCatalog = app.db
    .query("SELECT last_active_at AS lastActiveAt FROM sessions WHERE id = ?")
    .get(sid);
  const nextRuns = await (
    await fetch(`${origin}/api/activity/runs?session=${sid}`)
  ).json();
  results.host.push({
    transition: "last-active-terminal-proof",
    activeCatalog,
    wire,
    live,
    terminal,
    nextCatalog,
    nextRuns,
  });
  const historyRun = terminal.history[0].runId;
  app.db
    .query(
      "DELETE FROM activity_events WHERE span_id IN (SELECT span_id FROM activity_spans WHERE run_id = ?)"
    )
    .run(historyRun);
  app.db.query("DELETE FROM activity_spans WHERE run_id = ?").run(historyRun);
  app.db
    .query("UPDATE activity_run_rollups SET detail_pruned = 1 WHERE run_id = ?")
    .run(historyRun);
  const pruned = await fetch(`${origin}/api/activity/runs/${historyRun}`);
  const missing = await fetch(`${origin}/api/activity/runs/never-existed`);
  results.host.push({
    transition: "pruned-and-missing",
    prunedStatus: pruned.status,
    pruned: await pruned.json(),
    missingStatus: missing.status,
    missing: await missing.json(),
  });
  await persist();
  console.log("Terminal proof", results.host.length, results.faults);
} finally {
  await close();
}
