import { createHarness } from "./harness.ts";
const { results, reset, open, summary, composer, draft, persist, close, gate } =
  await createHarness("races");
try {
  for (const path of [
    "edit-newer",
    "new-chat",
    "new-chat-then-stats",
    "new-chat-second-send",
  ]) {
    const p = await open(900, false, "dark");
    await reset(p, false);
    await draft(p);
    const before = await composer(p);
    gate.hold = true;
    await p.locator("textarea").press("Enter");
    await p.waitForTimeout(100);
    const submitted = await summary(p);
    if (!submitted.pendingDraftId) throw Error("Pending draft must exist");
    if (path !== "edit-newer")
      await p.getByRole("button", { name: "New chat", exact: true }).click();
    await p.locator("textarea").fill("Newer unsent sail plan");
    if (path === "new-chat-then-stats") {
      await p.getByRole("button", { name: "Brain stats", exact: true }).click();
      await p.waitForTimeout(250);
    }
    if (path === "new-chat-second-send") {
      await p.locator("textarea").press("Enter");
      await p.waitForTimeout(100);
    }
    const changed = { composer: await composer(p), state: await summary(p) };
    gate.hold = false;
    const frameCount = gate.held.length;
    for (const send of gate.held.splice(0)) send();
    await p.waitForTimeout(250);
    results.draft.push({
      path,
      before,
      submitted,
      changed,
      after: { composer: await composer(p), state: await summary(p) },
      heldFrames: frameCount,
    });
    await persist();
    await p.context().close();
  }
  console.log("Race cases", results.draft.length, results.faults);
} finally {
  await close();
}
