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
  sendDisabled: boolean;
  sendCount: number;
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
      expect(
        kept.find((r) => r.value.draftId === id)?.value.text,
        "the committed original version survives the atomic stale write"
      ).toBe(ORIGINAL);
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
  expect(await a.call("access", "odysseus")).toBe("PartitionRefusedError");
  await b.call("edit", "Penelope keeps a new local note.");
  expect(await b.call("save")).toBe("PartitionRefusedError");
}, 60000);

test("sending a retained branch never binds subsequent edits to the original session", async (ctx) => {
  const a = await openScene(
    new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
  );
  ctx.onTestFinished(() => a.close());
  await a.call("ready", 320, "dark");
  await a.call("edit", "Odysseus keeps the fleet list.");
  await a.call("save");
  const original = (await view(a)).id;
  const b = await a.sibling();
  ctx.onTestFinished(() => b.close());
  await b.call("ready", 320, "dark");
  await a.call("edit", ORIGINAL);
  await a.call("save");
  await b.call("edit", INCOMING);
  await b.call("save");
  const branch = (await view(b)).id;
  await b.call("send");
  await b.call("save");
  await b.call("edit", `${INCOMING} Bring the bow.`);
  await b.call("save");
  expect((await view(b)).id, "later edits stay on the retained branch").toBe(
    branch
  );
  expect(
    (await rows(b)).find((r) => r.value.draftId === branch)?.value
  ).toMatchObject({ sessionId: null, text: `${INCOMING} Bring the bow.` });
  expect(
    (await rows(b)).find((r) => r.value.draftId === original)?.value.text
  ).toBe(ORIGINAL);
  expect(await rows(b)).toHaveLength(2);
}, 60000);

test("typing during the native fork commit preserves both dirty composers and updates one branch", async (ctx) => {
  const a = await openScene(
    new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
  );
  ctx.onTestFinished(() => a.close());
  await a.call("ready", 320, "dark");
  await a.call("edit", "Odysseus surveys the fleet.");
  await a.call("save");
  const original = (await view(a)).id;
  const b = await a.sibling();
  ctx.onTestFinished(() => b.close());
  await b.call("ready", 320, "dark");
  await a.call("edit", ORIGINAL);
  await a.call("save");
  await b.call("hold");
  await b.call("edit", INCOMING, true);
  await b.call("startSave");
  await b.call("waitHeld");
  await b.call("edit", `${INCOMING} Bring the oars.`);
  await a.call("edit", `${ORIGINAL} Bring the bow.`);
  expect(
    (await view(b)).notice,
    "no kept notice for an open fork transaction"
  ).toBe("");
  await b.call("release");
  await expect.poll(() => b.call("snapshot")).toEqual({ done: true });
  expect(await view(b)).toMatchObject({
    text: `${INCOMING} Bring the oars.`,
    session: "ithaca",
    selection: [3, 9],
    focused: true,
  });
  expect(
    (await view(a)).text,
    "another tab's dirty visible content is untouched"
  ).toBe(`${ORIGINAL} Bring the bow.`);
  await a.call("save");
  const kept = await rows(b);
  expect(kept).toHaveLength(2);
  expect(kept.find((r) => r.value.draftId === original)?.value.text).toBe(
    `${ORIGINAL} Bring the bow.`
  );
  expect(kept.find((r) => r.value.sessionId === null)?.value.text).toBe(
    `${INCOMING} Bring the oars.`
  );
}, 60000);

async function divergent(ctx: { onTestFinished(fn: () => unknown): void }) {
  const a = await openScene(
    new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
  );
  ctx.onTestFinished(() => a.close());
  await a.call("ready", 320, "dark");
  await a.call("edit", "Odysseus surveys the fleet.");
  await a.call("save");
  const original = (await view(a)).id;
  const b = await a.sibling();
  ctx.onTestFinished(() => b.close());
  await b.call("ready", 320, "dark");
  await a.call("edit", ORIGINAL);
  await a.call("save");
  await b.call("edit", INCOMING, true);
  return { a, b, original };
}
for (const outcome of ["accept", "refuse"])
  test(`review: pending send ${outcome} settles on the branch`, async (ctx) => {
    const { b, original } = await divergent(ctx);
    const images = (await view(b)).images;
    await b.call("blobPreviews");
    await b.call("send", true);
    const immutable = await b.call<{
      snapshotImages: Array<{ data: string; preview: string }>;
    }>("sendState");
    expect(
      immutable.snapshotImages.length,
      "the input immutable snapshot has nonempty images"
    ).toBeGreaterThan(0);
    await b.call("save");
    const branch = (await view(b)).id;
    await b.call("settleSend", outcome);
    const settlement = await b.call<{
      state: string;
      waiting: string[];
      snapshotImages: Array<{ data: string; preview: string }>;
      editableImages: Array<{ data: string; preview: string }>;
    }>("sendState");
    expect(
      settlement.state,
      "settlement records the actual accepted or refused send"
    ).toBe(outcome === "accept" ? "accepted" : "refused");
    expect(
      settlement.waiting,
      "settlement releases the branch waiting state"
    ).toEqual([]);
    expect(
      settlement.snapshotImages.length,
      "the settled immutable send retains nonempty images"
    ).toBeGreaterThan(0);
    expect(
      settlement.snapshotImages.map((a) => a.data),
      "settlement keeps the immutable send's exact input image bytes"
    ).toEqual(images.map((a) => a.data));
    if (outcome === "refuse") {
      expect(settlement.editableImages.map((a) => a.data)).toEqual(
        settlement.snapshotImages.map((a) => a.data)
      );
      expect(
        settlement.editableImages.map((a) => a.preview),
        "refusal gives the editable branch independent image previews"
      ).not.toEqual(settlement.snapshotImages.map((a) => a.preview));
    }
    await b.call("save");
    expect(
      (await rows(b)).find((r) => r.value.draftId === original)?.value.text,
      "pending-send settlement leaves the newer original untouched"
    ).toBe(ORIGINAL);
    if (outcome === "refuse") {
      expect(
        (await view(b)).text,
        "refusal restores the visible retained branch"
      ).toBe(INCOMING);
      expect((await view(b)).images).toEqual(images);
    }
    await b.call("edit", "Telemachus continues the voyage.");
    await b.call("save");
    expect((await view(b)).id).toBe(branch);
    expect(
      (await rows(b)).find((r) => r.value.draftId === branch)?.value.sessionId
    ).toBeNull();
  }, 60000);

test("review: a rotation during fork commit retains the live successor and its images", async (ctx) => {
  const { b, original } = await divergent(ctx);
  const images = (await view(b)).images;
  await b.call("hold");
  await b.call("startSave");
  await b.call("waitHeld");
  const successor = await b.call<string>("rotate");
  await b.call(
    "edit",
    "Telemachus edits the live successor.",
    false,
    successor
  );
  await b.call("release");
  await expect.poll(() => b.call("snapshot")).toEqual({ done: true });
  expect(
    (await view(b)).text,
    "the live successor stays visible after the fork commit"
  ).toBe("Telemachus edits the live successor.");
  expect((await view(b)).images).toEqual(images);
  const kept = await rows(b);
  expect(kept.filter((r) => r.value.text)).toHaveLength(2);
  expect(kept.find((r) => r.value.draftId === original)?.value.text).toBe(
    ORIGINAL
  );
  await b.call("openOther");
  await b.call("edit", "Penelope edits the opened original.");
  await b.call("save");
  expect(
    (await rows(b)).find((r) => r.value.draftId === original)?.value.text,
    "editing the opened original bypasses its obsolete rotation alias"
  ).toBe("Penelope edits the opened original.");
}, 60000);

test("review: an empty tombstone does not claim the session's next draft", async (ctx) => {
  const a = await openScene(
    new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
  );
  ctx.onTestFinished(() => a.close());
  await a.call("ready", 320, "dark");
  await a.call("edit", ORIGINAL);
  await a.call("save");
  await a.call("empty");
  await a.call("save");
  await a.call("edit", INCOMING);
  await a.call("save");
  expect(
    (await view(a)).notice,
    "clearing and retyping in one tab is not another-tab conflict"
  ).toBe("");
  expect(
    (await rows(a)).find((r) => r.value.text === INCOMING)?.value.sessionId
  ).toBe("ithaca");
}, 60000);

test("review: host Compare remains reachable on a retained branch", async (ctx) => {
  const { b } = await divergent(ctx);
  await b.call("save");
  await b.call("hostConflict");
  expect(
    await b.call("compare"),
    "the branch exposes the real host comparison dialog"
  ).toContain("Athena keeps the host version");
}, 60000);

test("review: another tab's navigation cannot change a reloaded branch's view", async (ctx) => {
  const { a, b } = await divergent(ctx);
  await b.call("save");
  const branch = (await view(b)).id;
  await a.call("navigate", null);
  await a.call("save");
  await b.reload();
  await b.call("ready", 320, "dark");
  expect(
    await view(b),
    "reload restores this tab's branch and session before selection"
  ).toMatchObject({ id: branch, text: INCOMING, session: "ithaca" });
}, 60000);

test("review: opening the original keeps pending-send settlement on the branch", async (ctx) => {
  const { b, original } = await divergent(ctx);
  await b.call("send", true);
  await b.call("save");
  const branch = (await view(b)).id;
  await b.call("openOther");
  await b.call("settleSend", "refuse");
  await b.call("save");
  expect(
    (await rows(b)).find((r) => r.value.draftId === original)?.value.text,
    "opening another version cannot redirect a late send into the newer original"
  ).toBe(ORIGINAL);
  await b.call("openDraft", branch);
  expect((await view(b)).text).toBe(INCOMING);
}, 60000);

test("review: a rotated branch can still open its original version", async (ctx) => {
  const { b } = await divergent(ctx);
  await b.call("save");
  await b.call("rotate");
  await b.call("save");
  await b.call("openOther");
  expect(
    (await view(b)).text,
    "the action opens the original after branch rotation"
  ).toBe(ORIGINAL);
}, 60000);

test("review: a duplicated tab keeps an independent context through reload", async (ctx) => {
  const a = await openScene(
    new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
  );
  ctx.onTestFinished(() => a.close());
  await a.call("ready", 320, "dark");
  await a.call("edit", "Odysseus surveys the fleet.");
  await a.call("save");
  const original = (await view(a)).id;
  const b = await a.sibling(true);
  ctx.onTestFinished(() => b.close());
  await b.call("ready", 320, "dark");
  await a.call("edit", ORIGINAL);
  await a.call("save");
  await b.call("edit", INCOMING);
  await b.call("save");
  await a.reload();
  await a.call("ready", 320, "dark");
  expect(
    await view(a),
    "duplicating a tab must not share its continuation identity"
  ).toMatchObject({ id: original, text: ORIGINAL });
}, 60000);

test("review: overlapping opens preserve edits made after the first open", async (ctx) => {
  const { b, original } = await divergent(ctx);
  await b.call("save");
  await b.call("doubleOpen");
  await b.call("edit", "Penelope adds another loom order.", true);
  await b.call("releaseRead");
  await expect
    .poll(async () => (await view(b)).text, {
      message: "a late other-version read cannot discard current edits",
    })
    .toBe("Penelope adds another loom order.");
  expect(await b.call("reads"), "overlapping opens share one native read").toBe(
    1
  );
  await b.call("save");
  expect(
    (await rows(b)).find((r) => r.value.draftId === original)?.value.text
  ).toBe("Penelope adds another loom order.");
}, 60000);

async function newChatDivergence(ctx: {
  onTestFinished(fn: () => unknown): void;
}) {
  const a = await openScene(
    new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
  );
  ctx.onTestFinished(() => a.close());
  await a.call("ready", 320, "dark");
  await a.call("navigate", null);
  await a.call("edit", "Odysseus surveys the fleet.");
  await a.call("save");
  const b = await a.sibling();
  ctx.onTestFinished(() => b.close());
  await b.call("ready", 320, "dark");
  await a.call("edit", ORIGINAL);
  await a.call("save");
  await b.call("edit", INCOMING);
  await b.call("send", true);
  return { a, b };
}

test("review: a retained new-chat branch still blocks ordinary duplicate Send", async (ctx) => {
  const { b } = await newChatDivergence(ctx);
  await b.call("save");
  await b.call("edit", "Telemachus keeps subsequent edits.");
  expect((await view(b)).sendCount).toBe(1);
  expect(
    await b.call("ordinarySend"),
    "the real composer blocks a second send while its branch's first send is pending"
  ).toBe(0);
}, 60000);

test("review: acceptance during a native fork keeps subsequent edits in the accepted session view", async (ctx) => {
  const { b } = await newChatDivergence(ctx);
  await b.call("edit", "Telemachus keeps subsequent edits.");
  await b.call("hold");
  await b.call("startSave");
  await b.call("waitHeld");
  await b.call("acceptNew");
  await b.call("release");
  await expect.poll(() => b.call("snapshot")).toEqual({ done: true });
  expect(
    await view(b),
    "acceptance navigation continues on the retained unbound branch"
  ).toMatchObject({
    text: "Telemachus keeps subsequent edits.",
    session: "pylos",
  });
  const branch = (await view(b)).id;
  await b.call("edit", "Telemachus continues from Pylos.");
  await b.call("save");
  expect((await view(b)).id).toBe(branch);
  expect(
    (await rows(b)).find((r) => r.value.draftId === branch)?.value.sessionId
  ).toBeNull();
}, 60000);

test("review: a single delayed other-version read preserves newly edited target text and images", async (ctx) => {
  const { b, original } = await divergent(ctx);
  await b.call("save");
  await b.call("delayedOpen");
  await expect.poll(() => b.call("reads")).toBe(1);
  await b.call("openInMemory", original);
  await b.call("edit", "Penelope adds another loom order.", true);
  await b.call("releaseRead");
  await expect.poll(() => b.call("snapshot")).toEqual({ done: true });
  expect(
    (await view(b)).text,
    "a target changed during an IndexedDB read keeps its editable text"
  ).toBe("Penelope adds another loom order.");
  expect((await view(b)).images).toHaveLength(1);
  await b.call("save");
  expect(
    (await rows(b)).find((r) => r.value.draftId === original)?.value.text
  ).toBe("Penelope adds another loom order.");
}, 60000);

test("review: both unbound Draft entries open and edit their selected version", async (ctx) => {
  const { b } = await newChatDivergence(ctx);
  await b.call("save");
  const original = (await rows(b)).find((r) => r.value.text === ORIGINAL)!.value
    .draftId;
  await b.call("openDraft", original);
  expect(
    (await view(b)).text,
    "the original Draft entry opens the committed original"
  ).toBe(ORIGINAL);
  await b.call("edit", "Penelope adds a loom order.");
  await b.call("save");
  expect(
    (await rows(b)).find((r) => r.value.draftId === original)?.value.text
  ).toBe("Penelope adds a loom order.");
}, 60000);

test("review: unconfirmed session Edit exposes its branch after opening the original", async (ctx) => {
  const { b, original } = await divergent(ctx);
  await b.call("send", true);
  await b.call("save");
  const branch = (await view(b)).id;
  await b.call("openOther");
  await b.call("editUnconfirmed");
  expect(
    await view(b),
    "Edit displays the returned snapshot in its retained session branch"
  ).toMatchObject({ id: branch, text: INCOMING, session: "ithaca" });
  await b.call("save");
  expect(
    (await rows(b)).find((r) => r.value.draftId === original)?.value.text
  ).toBe(ORIGINAL);
}, 60000);

test("review: branch continuation context co-commits when navigation was unchanged", async (ctx) => {
  const a = await openScene(
    new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
  );
  ctx.onTestFinished(() => a.close());
  await a.call("ready", 320, "dark");
  await a.call("edit", "Odysseus surveys the fleet.");
  await a.call("save");
  const b = await a.sibling();
  ctx.onTestFinished(() => b.close());
  await b.call("ready", 320, "dark");
  await b.call("edit", "Odysseus surveys the fleet.");
  await b.call("save");
  await a.call("edit", ORIGINAL);
  await a.call("save");
  await b.call("edit", INCOMING);
  await b.call("stopAfterFork");
  await b.call("save");
  const branch = (await rows(b)).find((r) => r.value.text === INCOMING)!.value
    .draftId;
  const contexts = await b.call<Array<{ value: { draftId: string } }>>(
    "contexts"
  );
  expect(
    contexts.filter((r) => r.value.draftId === branch).length,
    "the native fork also commits its tab continuation before a follow-up snapshot"
  ).toBe(2);
  await b.reload();
  await b.call("ready", 320, "dark");
  expect(await view(b)).toMatchObject({
    id: branch,
    text: INCOMING,
    session: "ithaca",
  });
}, 60000);

test("review: opening a bound other version resumes its conversation", async (ctx) => {
  const { b } = await divergent(ctx);
  await b.call("save");
  const branch = (await view(b)).id;
  await b.call("openDraft", branch);
  await b.call("openOther");
  expect(
    await b.call("resumes"),
    "opening a bound version requests its conversation history"
  ).toEqual(["ithaca"]);
  expect((await view(b)).text).toBe(ORIGINAL);
}, 60000);

test("review: sign-out inventory includes dictation retained in a closed tab context", async (ctx) => {
  const a = await openScene(
    new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
  );
  let closed = false;
  ctx.onTestFinished(() => (closed ? undefined : a.close()));
  await a.call("ready", 320, "dark");
  await a.call("review", "Odysseus reviews the fleet order.");
  await a.call("save");
  const b = await a.sibling();
  ctx.onTestFinished(() => b.close());
  await b.call("ready", 320, "dark");
  await a.close();
  closed = true;
  await b.call("review", "");
  await b.call("save");
  expect(
    (await b.call<{ review: boolean }>("loss")).review,
    "sign-out warns about dictation retained by a closed tab"
  ).toBe(true);
}, 60000);

for (const kind of ["removed", "gone"])
  test(`review: a stale original ${kind} cannot exempt a rotated successor from branching`, async (ctx) => {
    const { b, original } = await divergent(ctx);
    await b.call("removeOriginal", kind);
    await b.call("stopAfterFork");
    await b.call("save");
    const kept = await rows(b);
    const branch = kept.find((r) => r.value.text === INCOMING)!;
    expect(
      branch.value.sessionId,
      "the successor of a stale removal is retained unbound in the native commit"
    ).toBeNull();
    expect(kept.find((r) => r.value.draftId === original)?.value.text).toBe(
      ORIGINAL
    );
    expect(
      kept,
      "one incoming branch and the original co-commit without an extra empty branch"
    ).toHaveLength(2);
    await b.reload();
    await b.call("ready", 320, "dark");
    expect(await view(b)).toMatchObject({
      id: branch.value.draftId,
      text: INCOMING,
      session: "ithaca",
    });
  }, 60000);

test("review: a hidden retained original's host acknowledgement cannot move the active branch", async (ctx) => {
  const { a, b, original } = await divergent(ctx);
  await b.call("save");
  const branch = (await view(b)).id;
  await a.call("edit", "Penelope revises the loom order.");
  await a.call("save");
  await b.call("ackOriginal");
  await b.call("save");
  expect(
    await view(b),
    "a hidden original's divergence keeps the selected branch identity and text"
  ).toMatchObject({ id: branch, text: INCOMING, session: "ithaca" });
  const kept = await rows(b);
  expect(kept.find((r) => r.value.draftId === original)?.value.text).toBe(
    "Penelope revises the loom order."
  );
  expect(kept.filter((r) => r.value.text === INCOMING)).toHaveLength(1);
  expect(
    kept.filter((r) => r.value.text === ORIGINAL),
    "the hidden incoming version is preserved separately"
  ).toHaveLength(1);
  await b.reload();
  await b.call("ready", 320, "dark");
  expect(await view(b)).toMatchObject({ id: branch, text: INCOMING });
}, 60000);

test("review: a decoding image follows its branch even after opening the original", async (ctx) => {
  const { b, original } = await divergent(ctx);
  const incomingImages = (await view(b)).images;
  await b.call("startDelayedImage");
  await expect.poll(() => b.call("imageHeld")).toBe(true);
  await b.call("save");
  const branch = (await view(b)).id;
  await b.call("openOther");
  await b.call("releaseImage");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await b.call("save");
  const kept = await rows(b);
  expect(
    kept.find((r) => r.value.draftId === branch)?.value.attachments.length,
    "the image decoded for the stale writer lands in its retained branch"
  ).toBe(incomingImages.length + 1);
  expect(
    kept.find((r) => r.value.draftId === original)?.value.attachments,
    "the committed original keeps its empty image set"
  ).toEqual([]);
  await b.reload();
  await b.call("ready", 320, "dark");
  await b.call("openDraft", branch);
  expect((await view(b)).images).toHaveLength(incomingImages.length + 1);
}, 60000);

test("review: the incoming unbound branch exclusively owns its staged track queue", async (ctx) => {
  const { b } = await newChatDivergence(ctx);
  const original = (await view(b)).id;
  expect(await b.call("stageTrack")).toEqual([]);
  await b.call("save");
  const branch = (await view(b)).id;
  expect(await b.call("tracks", branch)).toEqual(["ithaca.gpx"]);
  await b.call("openOther");
  expect(
    await b.call("tracks", original),
    "opening the committed original cannot expose the stale writer's staged track"
  ).toEqual([]);
  expect(await b.call("tracks", branch)).toEqual(["ithaca.gpx"]);
}, 60000);

test("review: a queued transcript Add stays with its retained branch after opening the original", async (ctx) => {
  const { b } = await newChatDivergence(ctx);
  const original = (await view(b)).id;
  await b.call("save");
  const branch = (await view(b)).id;
  await b.call("edit", INCOMING);
  await b.call("save");
  await b.call("startAdd", original);
  await expect.poll(() => b.call("reads")).toBe(1);
  await b.call("openDraft", original);
  await b.call("releaseRead");
  await expect.poll(() => b.call("snapshot")).toEqual({ done: true });
  await b.call("save");
  const kept = await rows(b);
  expect(
    kept.find((r) => r.value.draftId === original)?.value.text,
    "a queued Add cannot append to the other committed version"
  ).toBe(ORIGINAL);
  expect(kept.find((r) => r.value.draftId === branch)?.value.text).toBe(
    `${INCOMING}\nBring the oars.`
  );
  expect(
    await b.call("receipt"),
    "cleanup is authorized only for the branch holding the accepted transcript"
  ).toMatchObject({ draftId: branch, finalized: true });
}, 60000);

test("review: typing during cold restore stays visible instead of selecting the saved branch", async (ctx) => {
  const { b } = await divergent(ctx);
  await b.call("save");
  const branch = (await view(b)).id;
  await b.call("holdRestore");
  await b.reload();
  await b.call("coldReady");
  await expect.poll(() => b.call("reads")).toBe(1);
  const typed = "Odysseus adds a fresh fleet order.";
  await b.call("edit", typed, true);
  const images = (await view(b)).images;
  await b.call("releaseRead");
  await b.call("restored");
  expect(
    await view(b),
    "late restore cannot hide the reader's newly typed text and images"
  ).toMatchObject({
    text: typed,
    images,
    selection: [3, 9],
    session: "ithaca",
  });
  expect((await view(b)).id).not.toBe(branch);
  await b.call("save");
  expect(
    (await rows(b)).some(
      (r) => r.value.draftId === branch && r.value.text === INCOMING
    )
  ).toBe(true);
  await b.reload();
  await b.call("ready", 320, "dark");
  expect((await view(b)).text).toBe(typed);
}, 60000);

test("review: repeated native forks keep the incoming session view past thirty-two continuations", async (ctx) => {
  const { a, b, original } = await divergent(ctx);
  await b.call("save");
  for (let i = 1; i <= 35; i++) {
    const current = (await view(b)).id;
    await a.call("openStored", current);
    await a.call("edit", `Penelope commits loom revision ${i}.`);
    await a.call("save");
    const incoming = `Telemachus keeps harbour revision ${i}.`;
    await b.call("edit", incoming, true);
    await b.call("save");
    expect(
      await view(b),
      "every native fork keeps the newest incoming text, selection and session visible"
    ).toMatchObject({ text: incoming, selection: [3, 9], session: "ithaca" });
  }
  expect(
    (await rows(b)).find((r) => r.value.draftId === original)?.value.text
  ).toBe(ORIGINAL);
  expect(
    await rows(b),
    "each separate divergence creates exactly one branch"
  ).toHaveLength(37);
  await b.reload();
  await b.call("ready", 320, "dark");
  expect((await view(b)).text).toBe("Telemachus keeps harbour revision 35.");
}, 120000);

test("review: explicitly adopting a skipped cold-restore original lets it be cleared durably", async (ctx) => {
  const { b, original } = await divergent(ctx);
  await b.call("save");
  await b.call("holdRestore");
  await b.reload();
  await b.call("coldReady");
  await expect.poll(() => b.call("reads")).toBe(1);
  const incoming = "Odysseus writes a fresh fleet order.";
  await b.call("edit", incoming, true);
  await b.call("releaseRead");
  await b.call("restored");
  await b.call("save");
  const branch = (await view(b)).id;
  await b.call("openOther");
  expect((await view(b)).text).toBe(ORIGINAL);
  await b.call("empty");
  await b.call("save");
  expect(
    (await rows(b)).find((r) => r.value.draftId === original)?.value.text,
    "an adopted original's intentional clearing is committed instead of treated as unadopted work"
  ).toBe("");
  expect(
    (await rows(b)).find((r) => r.value.draftId === branch)?.value.text
  ).toBe(incoming);
  await b.reload();
  await b.call("ready", 320, "dark");
  expect((await view(b)).text).toBe("");
  await b.call("openDraft", branch);
  expect((await view(b)).text).toBe(incoming);
}, 60000);

test("review: a stale source and a colliding session owner both survive continued native saves", async (ctx) => {
  const a = await openScene(
    new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
  );
  ctx.onTestFinished(() => a.close());
  await a.call("ready", 320, "dark");
  await a.call("navigate", null);
  await a.call("edit", "Odysseus shares the harbour plan.");
  await a.call("save");
  const original = (await view(a)).id;
  const b = await a.sibling();
  ctx.onTestFinished(() => b.close());
  await b.call("ready", 320, "dark");
  expect((await view(b)).id).toBe(original);
  await a.call("send", true);
  await a.call("edit", ORIGINAL, true);
  const originalImages = (await view(a)).images;
  await a.call("acceptIn", "pylos");
  await a.call("save");
  await b.call("pauseSnapshot");
  await b.call("send", true);
  await b.call("edit", INCOMING, true);
  const incomingImages = (await view(b)).images;
  await b.call("acceptIn", "ithaca");
  await b.call("startSave");
  await expect.poll(() => b.call("snapshotWaiting")).toBe(true);
  const c = await a.sibling();
  ctx.onTestFinished(() => c.close());
  await c.call("ready", 320, "dark");
  await c.call("navigate", "ithaca");
  await c.call("edit", "Athena keeps the third tab's chart.", true);
  await c.call("save");
  const third = (await view(c)).id;
  const thirdImages = (await view(c)).images;
  expect(third).not.toBe(original);
  await b.call("releaseSnapshot");
  await expect.poll(() => b.call("snapshot")).toEqual({ done: true });
  const branch = (await view(b)).id;
  expect(branch).not.toBe(original);
  await b.call("edit", `${INCOMING} Bring the oars.`);
  await b.call("save");
  const kept = await rows(b);
  expect(
    kept.find((r) => r.value.draftId === original)?.value.text,
    "the omitted committed source survives the follow-up native snapshot"
  ).toBe(ORIGINAL);
  expect(kept.find((r) => r.value.draftId === original)?.value).toMatchObject({
    sessionId: "pylos",
    attachments: originalImages,
  });
  expect(kept.find((r) => r.value.draftId === third)?.value).toMatchObject({
    sessionId: "ithaca",
    text: "Athena keeps the third tab's chart.",
    attachments: thirdImages,
  });
  expect(kept.find((r) => r.value.draftId === branch)?.value).toMatchObject({
    sessionId: null,
    text: `${INCOMING} Bring the oars.`,
    attachments: incomingImages,
  });
  expect(kept).toHaveLength(3);
  await b.reload();
  await b.call("ready", 320, "dark");
  expect((await view(b)).text).toBe(`${INCOMING} Bring the oars.`);
  await b.call("openStored", original);
  expect((await view(b)).text).toBe(ORIGINAL);
  await b.call("openStored", third);
  expect((await view(b)).text).toBe("Athena keeps the third tab's chart.");
}, 60000);

for (const mode of ["owned", "foreign", "clean"] as const)
  test(`review: collision restoration preserves late edits and honest baselines (${mode})`, async (ctx) => {
    const a = await openScene(
      new URL("./offline/scenes/draft-branches.scene.tsx", import.meta.url)
    );
    ctx.onTestFinished(() => a.close());
    await a.call("ready", 320, "dark");
    await a.call("navigate", "pylos");
    await a.call("edit", ORIGINAL, true);
    await a.call("save");
    const original = (await view(a)).id;
    const b = await a.sibling();
    ctx.onTestFinished(() => b.close());
    await b.call("ready", 320, "dark");
    await b.call("pauseSnapshot");
    await b.call("navigate", null);
    await b.call("edit", "Odysseus starts a voyage.");
    await b.call("send", true);
    await b.call("edit", INCOMING, true);
    const incomingImages = (await view(b)).images;
    await b.call("navigate", "pylos");
    if (mode === "owned")
      await b.call("edit", "Penelope adds a pre-commit correction.", true);
    await b.call("acceptIn", "pylos");
    await b.call("hold");
    await b.call("startSave");
    await expect.poll(() => b.call("snapshotWaiting")).toBe(true);
    const foreign = "Penelope changes the saved chart.";
    if (mode !== "owned") {
      await a.call("edit", foreign, true);
      await a.call("save");
    }
    const committedImages = (await view(a)).images;
    await b.call("releaseSnapshot");
    await b.call("waitHeld");
    const late = "Telemachus corrects Penelope's chart during commit.";
    if (mode !== "clean") await b.call("edit", late, true, original);
    const lateImages = (await view(b)).images;
    await b.call("release");
    await expect.poll(() => b.call("snapshot")).toEqual({ done: true });
    expect(
      (await view(b)).text,
      "collision restoration preserves a late edit or refreshes the clean other version"
    ).toBe(mode === "clean" ? INCOMING : late);
    if (mode === "clean") {
      const memory = await b.call<{
        drafts: Array<{ id: string; text: string }>;
      }>("view");
      expect(
        memory.drafts.find((d) => d.id === original)?.text,
        "a clean collision owner adopts the actual committed version"
      ).toBe(foreign);
    }
    await b.call("save");
    const kept = await rows(b);
    if (mode === "foreign") {
      expect(
        kept.find((r) => r.value.draftId === original)?.value,
        "an unadopted foreign baseline cannot be overwritten by the next dirty snapshot"
      ).toMatchObject({
        text: foreign,
        sessionId: "pylos",
        attachments: committedImages,
      });
      expect(kept.find((r) => r.value.text === late)?.value).toMatchObject({
        sessionId: null,
        attachments: lateImages,
      });
    } else
      expect(
        kept.find((r) => r.value.draftId === original)?.value
      ).toMatchObject({
        text: mode === "clean" ? foreign : late,
        sessionId: "pylos",
        attachments: mode === "clean" ? committedImages : lateImages,
      });
    expect(kept.find((r) => r.value.text === INCOMING)?.value).toMatchObject({
      sessionId: null,
      attachments: incomingImages,
    });
    expect(kept).toHaveLength(mode === "foreign" ? 3 : 2);
    const active = (await view(b)).id;
    await b.reload();
    await b.call("ready", 320, "dark");
    expect((await view(b)).id).toBe(active);
    expect((await view(b)).text).toBe(mode === "clean" ? INCOMING : late);
  }, 60000);
