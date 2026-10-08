import { expect, test } from "vitest";
import { openScene, type SceneHandle } from "./offline/scene.ts";

type Row = {
  key: string;
  value: {
    draftId: string;
    sessionId: string | null;
    text: string;
    attachments: Array<{ data: string }>;
  };
};
type View = {
  id: string;
  text: string;
  session: string | null;
  selection: number[];
  focused: boolean;
  notice: string;
  failed: boolean;
  width: number;
  overflow: boolean;
  images: Row["value"]["attachments"];
  action: { width: number; height: number };
};
const ORIGINAL = "Penelope keeps the loom order.";
const INCOMING = "Telemachus checks the harbour route.";
const view = (s: SceneHandle) => s.call<View>("view");
const rows = (s: SceneHandle) => s.call<Row[]>("rows");

for (const width of [320, 1280])
  for (const theme of ["dark", "light"]) {
    test(`two real tabs atomically keep the incoming branch and continue it at ${width}px ${theme}`, async (ctx) => {
      const a = await openScene(
        new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
      );
      ctx.onTestFinished(() => a.close());
      await a.viewport(width, 900);
      await a.call("ready", width, theme);
      await a.call("edit", "Odysseus surveys the fleet.");
      expect(await a.call("save")).toBe("ok");
      const id = (await view(a)).id;
      const b = await a.sibling();
      ctx.onTestFinished(() => b.close());
      await b.viewport(width, 900);
      await b.call("ready", width, theme);
      expect((await view(b)).id).toBe(id);
      await a.call("hold");
      await a.call("edit", ORIGINAL, true);
      await a.call("startSave");
      await a.call("waitHeld");
      await b.call("edit", INCOMING, true);
      const incomingImages = (await view(b)).images;
      await b.call("startSave");
      expect(await a.call("snapshot")).toEqual({ done: false });
      expect((await view(b)).notice, "no retention claim before commit").toBe(
        ""
      );
      await a.call("release");
      await expect.poll(() => a.call("snapshot")).toEqual({ done: true });
      await expect
        .poll(async () => (await b.call<{ done: boolean }>("snapshot")).done)
        .toBe(true);
      const kept = await rows(b);
      expect(kept.find(r => r.value.draftId === id)?.value.text, "the committed original version survives the atomic stale write").toBe(ORIGINAL);
      const branch = kept.find((r) => r.value.text === INCOMING);
      expect(
        branch,
        "the incoming stale text has a durable distinct branch"
      ).toBeDefined();
      expect(kept).toHaveLength(2);
      expect(kept.find((r) => r.value.draftId === id)?.value).toMatchObject({
        sessionId: "ithaca",
        text: ORIGINAL,
      });
      expect(branch!.value.sessionId).toBeNull();
      expect(branch!.value.draftId).not.toBe(id);
      expect(branch!.value.attachments[0]!.data.length).toBeGreaterThan(0);
      expect(branch!.value.attachments).toEqual(incomingImages);
      expect(branch!.value.attachments).not.toEqual(
        kept.find((r) => r.value.draftId === id)!.value.attachments
      );
      expect(await view(b)).toMatchObject({
        id: branch!.value.draftId,
        text: INCOMING,
        session: "ithaca",
        selection: [3, 9],
        focused: true,
      });
      expect((await view(b)).width).toBe(width);
      expect((await view(b)).overflow).toBe(false);
      expect((await view(b)).action.height).toBeGreaterThanOrEqual(44);
      expect((await view(b)).action.width).toBeGreaterThanOrEqual(44);
      expect((await view(b)).notice).toContain(
        "Another tab changed this draft · Both versions kept"
      );
      expect((await view(a)).text).toBe(ORIGINAL);
      await b.call("edit", `${INCOMING} Bring the oars.`);
      expect(await b.call("save")).toBe("ok");
      expect(await rows(b)).toHaveLength(2);
      expect(
        (await rows(b)).find((r) => r.value.draftId === id)!.value.text
      ).toBe(ORIGINAL);
      await a.reload();
      await a.viewport(width, 900);
      await a.call("ready", width, theme);
      await b.reload();
      await b.viewport(width, 900);
      await b.call("ready", width, theme);
      expect(await rows(a)).toHaveLength(2);
      expect((await view(b)).text).toBe(`${INCOMING} Bring the oars.`);
      const c = await a.sibling();
      ctx.onTestFinished(() => c.close());
      await c.viewport(width, 900);
      await c.call("ready", width, theme);
      expect((await rows(c)).map((r) => r.value.text).sort()).toEqual(
        [ORIGINAL, `${INCOMING} Bring the oars.`].sort()
      );
      await c.call("openDraft", branch!.value.draftId);
      expect((await view(c)).text).toBe(`${INCOMING} Bring the oars.`);
      await b.call("openOther");
      expect((await view(b)).text).toBe(ORIGINAL);
      expect(await b.call("access", "telemachus")).toBe(
        "PartitionRefusedError"
      );
    }, 60000);
  }

for (const operation of ["empty", "send"])
  test(`stale ${operation} cannot erase the newer committed version`, async (ctx) => {
    const a = await openScene(
      new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
    );
    ctx.onTestFinished(() => a.close());
    await a.call("ready", 320, "dark");
    await a.call("edit", "Odysseus keeps the fleet list.");
    await a.call("save");
    const id = (await view(a)).id;
    const b = await a.sibling();
    ctx.onTestFinished(() => b.close());
    await b.call("ready", 320, "dark");
    await a.call("edit", ORIGINAL, true);
    await a.call("save");
    await b.call(operation);
    expect(await b.call("save")).toBe("ok");
    expect(
      (await rows(a)).find((r) => r.value.draftId === id)?.value
    ).toMatchObject({ sessionId: "ithaca", text: ORIGINAL });
    expect(
      (await view(b)).text,
      "empty/send keeps the visible field empty"
    ).toBe("");
    await b.call("edit", INCOMING);
    await b.call("save");
    expect(
      (await rows(a)).find((r) => r.value.draftId === id)?.value.text
    ).toBe(ORIGINAL);
    const branches = (await rows(a)).filter((r) => r.value.sessionId === null);
    expect(branches).toHaveLength(1);
    expect(branches[0]!.value.text).toBe(INCOMING);
  }, 60000);

test("quota abort during a fork retains editable text and gives no kept claim; retry creates one branch", async (ctx) => {
  const a = await openScene(
    new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
  );
  ctx.onTestFinished(() => a.close());
  await a.call("ready", 320, "light");
  await a.call("edit", "Odysseus keeps the fleet list.");
  await a.call("save");
  const id = (await view(a)).id;
  const b = await a.sibling();
  ctx.onTestFinished(() => b.close());
  await b.call("ready", 320, "light");
  await a.call("edit", ORIGINAL);
  await a.call("save");
  await b.call("quota");
  await b.call("edit", INCOMING, true);
  expect(await b.call("save")).toBe("QuotaExceededError");
  expect(await view(b)).toMatchObject({
    id,
    text: INCOMING,
    selection: [3, 9],
    notice: "",
    failed: true,
  });
  expect(await rows(a)).toHaveLength(1);
  expect((await rows(a))[0]!.value.text).toBe(ORIGINAL);
  await b.call("recoverStorage");
  expect(await b.call("save")).toBe("ok");
  expect(await rows(a)).toHaveLength(2);
  await b.call("edit", `${INCOMING} Bring the bow.`);
  await b.call("save");
  expect(await rows(a)).toHaveLength(2);
  await b.call("clearAccount");
  expect(
    await rows(a).then(
      () => "read",
      (e) => e.name
    )
  ).toBe("PartitionRefusedError");
  expect(await b.call("save")).not.toBe("ok");
}, 60000);
