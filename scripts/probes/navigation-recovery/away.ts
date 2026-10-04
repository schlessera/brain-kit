import { createHarness } from "./harness.ts";
const {
  results,
  reset,
  open,
  summary,
  persist,
  close,
  controls,
  starts,
  origin,
} = await createHarness("away");
try {
  const p = await open(900, false, "dark");
  await reset(p, false);
  for (const sid of [
    "odysseus-away-success",
    "odysseus-away-failure",
    "odysseus-still-running",
  ]) {
    await p.evaluate((id) => (window as any).probe.select(id), sid);
    await p.evaluate(
      (id) =>
        (window as any).probe.send({
          type: "chat_message",
          text: id,
          sessionId: id,
        }),
      sid
    );
    await p.waitForFunction(
      (id) => (window as any).probe.state().buffers[id]?.messages.length > 0,
      sid
    );
  }
  const before = await summary(p);
  const n = await p.evaluate(() => (window as any).probeSockets.length);
  await p.evaluate(() => (window as any).probeSockets.at(-1).close());
  await p.waitForTimeout(50);
  controls.get("odysseus-away-success")!.finish();
  controls.get("odysseus-away-failure")!.finish(true);
  await p.waitForFunction(
    (n) =>
      (window as any).probeSockets.length > n && (window as any).probe.ready(),
    n
  );
  await p.waitForTimeout(150);
  const after = await summary(p);
  const activity = await (await fetch(`${origin}/api/activity/runs`)).json();
  results.host.push({
    transition: "background-success-and-failure-while-disconnected",
    before,
    after,
    activity,
    starts,
  });
  for (const sid of ["odysseus-away-success", "odysseus-away-failure"])
    await p.evaluate(
      (id) =>
        (window as any).probe.send({ type: "session_resume", sessionId: id }),
      sid
    );
  await p.waitForTimeout(150);
  results.host.push({
    transition: "explicit-background-recovery-after-offline-terminal",
    state: await summary(p),
    starts,
  });
  await persist();
  console.log("Away cases", results.host.length, results.faults);
} finally {
  await close();
}
