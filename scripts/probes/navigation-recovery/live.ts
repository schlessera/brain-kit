import { createHarness } from "./harness.ts";
const {
  app,
  results,
  reset,
  open,
  summary,
  composer,
  draft,
  palette,
  persist,
  close,
  controls,
  starts,
  requests,
  origin,
} = await createHarness("live");
try {
  for (const width of [390, 900]) {
    for (const path of [
      "disc",
      "drawer-new",
      "palette-new",
      "drawer-resume",
      "drawer-background",
      "files",
      "settings",
      "actions",
      "graph",
    ]) {
      if (width === 390 && path === "palette-new") continue;
      const p = await open(width, width === 390, "dark");
      await reset(p, true);
      await draft(p);
      const before = await composer(p);
      if (!before.text || before.attachments !== 1)
        throw Error("Draft input must be nonempty");
      async function navigate(label: string) {
        if (width === 900) {
          await palette(p, label);
          return;
        }
        if (["Sessions", "Settings"].includes(label)) {
          await p.getByRole("tab", { name: "More", exact: true }).click();
          await p
            .getByRole("dialog", { name: "More" })
            .getByRole("button", { name: new RegExp(label) })
            .click();
        } else await p.getByRole("tab", { name: label, exact: true }).click();
        await p.waitForTimeout(100);
      }
      if (path === "disc")
        await p.getByRole("button", { name: "New chat", exact: true }).click();
      if (path === "drawer-new") {
        await navigate("Sessions");
        await p
          .getByRole("button", { name: "New conversation", exact: true })
          .click();
      }
      if (path === "palette-new") await navigate("New chat");
      if (path === "drawer-resume") {
        await navigate("Sessions");
        await p
          .getByRole("button", { name: /odysseus-B/ })
          .last()
          .click();
      }
      if (path === "drawer-background") {
        await p.evaluate(() =>
          (window as any).probe.frame({
            type: "status",
            status: "thinking",
            sessionId: "odysseus-B",
            turnId: "fixture-background-turn",
          })
        );
        await navigate("Sessions");
        // #950 replaced the single `Session running…` row with the Working group.
        await p.locator('[data-working-row] [role="button"]').first().click();
      }
      if (["files", "settings", "actions", "graph"].includes(path)) {
        await navigate(
          {
            files: "Files",
            settings: "Settings",
            actions: "Actions",
            graph: "Graph",
          }[path]!
        );
        if (["files", "settings"].includes(path))
          await p.keyboard.press("Escape");
        else await navigate("Chat");
      }
      await p.waitForTimeout(200);
      results.draft.push({ width, path, before, after: await composer(p) });
      await persist();
      await p.context().close();
    }
  }
  const p = await open(900, false, "dark");
  await reset(p, false);
  for (const kind of ["running", "approval", "ask", "list", "rank", "form"]) {
    const sid = `odysseus-${kind}`;
    await p.evaluate((id) => (window as any).probe.select(id), sid);
    await p.evaluate(
      ({ sid, kind }) =>
        (window as any).probe.send({
          type: "chat_message",
          text: kind,
          sessionId: sid,
          requestId: `send-${kind}`,
        }),
      { sid, kind }
    );
    await p.waitForFunction(
      (id) => (window as any).probe.state().buffers[id]?.messages.length > 0,
      sid
    );
    if (kind !== "running")
      await p.waitForFunction(
        ({ sid, kind }) => {
          const b = (window as any).probe.state().buffers[sid];
          return kind === "approval"
            ? b.messages
                .flatMap((m: any) => m.toolCalls)
                .some((t: any) => t.status === "pending_approval")
            : !!b.askUser;
        },
        { sid, kind }
      );
    const before = await summary(p);
    await p.evaluate(() => (window as any).probe.select("odysseus-view-B"));
    const switched = await summary(p);
    await p.evaluate(() => (window as any).probe.clear());
    const cleared = await summary(p);
    results.host.push({
      kind,
      transition: "A-to-B/New-chat",
      before,
      switched,
      cleared,
      started: starts.length,
    });
    await persist();
  }
  for (let i = 0; i < 12; i++)
    await p.evaluate(
      (id) => (window as any).probe.select(id),
      `odysseus-idle-${i}`
    );
  results.host.push({
    transition: "over-eight-live-buffers",
    state: await summary(p),
    started: starts.length,
  });
  await persist();
  await p.evaluate(() => (window as any).probe.select("odysseus-running"));
  const socketsBefore = await p.evaluate(
    () => (window as any).probeSockets.length
  );
  await p.evaluate(() => (window as any).probeSockets.at(-1).close());
  await p.waitForFunction(
    (n) =>
      (window as any).probeSockets.length > n && (window as any).probe.ready(),
    socketsBefore
  );
  await p.waitForTimeout(250);
  results.host.push({
    transition: "disconnect/reconnect-multiple-live",
    state: await summary(p),
    started: starts.length,
  });
  await persist();
  await p.evaluate(() => (window as any).probe.fresh());
  await p.waitForFunction("window.probe.ready()");
  await p.waitForTimeout(250);
  results.host.push({
    transition: "fresh-root-multiple-live",
    state: await summary(p),
    started: starts.length,
  });
  await persist();
  await p.reload();
  await p.waitForFunction("window.probe.ready()");
  await p.waitForTimeout(250);
  results.host.push({
    transition: "reload-multiple-live",
    state: await summary(p),
    started: starts.length,
  });
  await persist();
  for (const kind of ["approval", "ask", "list", "rank", "form"]) {
    await p.evaluate(
      (id) =>
        (window as any).probe.send({ type: "session_resume", sessionId: id }),
      `odysseus-${kind}`
    );
    await p.waitForTimeout(50);
  }
  results.host.push({
    transition: "all-background-histories",
    state: await summary(p),
    started: starts.length,
  });
  await persist();
  const startCount = starts.length;
  await p.evaluate(() =>
    (window as any).probe.send({
      type: "session_resume",
      sessionId: "odysseus-ask",
    })
  );
  await p.waitForFunction(
    () =>
      (window as any).probe.state().buffers["odysseus-ask"]?.messages.length > 0
  );
  results.host.push({
    transition: "background-history-replay",
    state: await summary(p),
    startedBefore: startCount,
    startedAfter: starts.length,
  });
  await persist();
  const n = await p.evaluate(() => (window as any).probeSockets.length);
  await p.evaluate(() => (window as any).probeSockets.at(-1).close());
  await p.waitForFunction(
    (n) =>
      (window as any).probeSockets.length > n && (window as any).probe.ready(),
    n
  );
  await p.waitForTimeout(250);
  results.host.push({
    transition: "reconnect-after-background-history",
    state: await summary(p),
    started: starts.length,
  });
  await persist();
  await p.evaluate(() =>
    (window as any).probe.send({
      type: "chat_message",
      text: "queued voyage",
      sessionId: "odysseus-running",
      requestId: "queued-voyage",
    })
  );
  await p.waitForTimeout(100);
  results.host.push({
    transition: "live-queued-followup",
    state: await summary(p),
    activity: await (
      await fetch(`${origin}/api/activity/runs?session=odysseus-running`)
    ).json(),
    catalog: app.db
      .query("SELECT id,last_active_at FROM sessions WHERE id = ?")
      .get("odysseus-running"),
  });
  await persist();
  for (const kind of ["success", "failure"]) {
    const sid = `odysseus-${kind}`;
    await p.evaluate((id) => (window as any).probe.select(id), sid);
    await p.evaluate(
      ({ sid, kind }) =>
        (window as any).probe.send({
          type: "chat_message",
          text: kind,
          sessionId: sid,
        }),
      { sid, kind }
    );
    await p.waitForFunction(
      (id) => (window as any).probe.state().buffers[id]?.messages.length > 0,
      sid
    );
    controls.get(sid)!.finish(kind === "failure");
    await p.waitForFunction(
      (id) => !(window as any).probe.state().runStates[id],
      sid
    );
    await p.waitForTimeout(100);
    results.host.push({
      kind,
      transition: "terminal",
      state: await summary(p),
      activity: await (
        await fetch(`${origin}/api/activity/runs?session=${sid}`)
      ).json(),
    });
    await p.reload();
    await p.waitForFunction("window.probe.ready()");
    await p.waitForTimeout(250);
    results.host.push({
      kind,
      transition: "terminal-reload",
      state: await summary(p),
      started: starts.length,
    });
    await persist();
  }
  await p.evaluate(() =>
    (window as any).probe.send({
      type: "cancel",
      sessionId: "odysseus-approval",
    })
  );
  await p.waitForTimeout(150);
  results.host.push({
    transition: "cancelled-pending-approval",
    state: await summary(p),
    activity: await (
      await fetch(`${origin}/api/activity/runs?session=odysseus-approval`)
    ).json(),
  });
  await persist();
  await p.evaluate(() =>
    (window as any).probe.send({ type: "session_resume", sessionId: "missing" })
  );
  await p.waitForTimeout(200);
  results.host.push({
    transition: "missing-history",
    state: await summary(p),
    wire: await p.evaluate(() =>
      (window as any).probeWire.filter((f: any) => f.type === "error")
    ),
  });
  results.requests = requests;
  results.starts = starts;
  await persist();
  console.log(
    "Live matrix saved",
    results.draft.length,
    results.host.length,
    results.faults
  );
} finally {
  await close();
}
