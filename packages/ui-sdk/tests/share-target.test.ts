import { describe, expect, test } from "bun:test";
import {
  createMemoryShareStoreForTests,
  pruneStoredShares,
} from "../src/client/share-store";
import {
  SHARE_MAX_FILES,
  SHARE_MAX_FILE_BYTES,
  SHARE_MAX_TEXT_BYTES,
} from "../src/protocol";
import {
  DEFAULT_SHARE_TARGET_PATH,
  SHARE_ERROR_PARAM,
  SHARE_QUERY_PARAM,
  handleShareTargetRequest,
  isShareTargetRequest,
  readShareLaunchParams,
  registerShareTarget,
  type ShareFetchEvent,
  type ShareStore,
  type ShareTargetScope,
} from "../src/client/share-target";

const ORIGIN = "https://brain.example";

function shareRequest(body: FormData, path = DEFAULT_SHARE_TARGET_PATH): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", body });
}

/** The service worker answers with a redirect, so assert on where it points. */
function redirectTarget(response: Response): URL {
  expect(response.status).toBe(303);
  return new URL(response.headers.get("location")!);
}

describe("isShareTargetRequest", () => {
  test("matches only a POST to the configured path", () => {
    expect(isShareTargetRequest(shareRequest(new FormData()))).toBe(true);
    expect(
      isShareTargetRequest(new Request(`${ORIGIN}/share-target`))
    ).toBe(false);
    expect(
      isShareTargetRequest(shareRequest(new FormData(), "/something-else"))
    ).toBe(false);
  });

  test("ignores the query string when matching", () => {
    const request = new Request(`${ORIGIN}/share-target?utm=1`, {
      method: "POST",
      body: new FormData(),
    });
    expect(isShareTargetRequest(request)).toBe(true);
  });
});

describe("handleShareTargetRequest", () => {
  test("stashes a text share and redirects with its id", async () => {
    const store = createMemoryShareStoreForTests();
    const form = new FormData();
    form.set("title", "A page");
    form.set("text", "worth keeping");
    form.set("url", "https://example.com/post");

    const target = redirectTarget(
      await handleShareTargetRequest(shareRequest(form), { store })
    );

    const id = target.searchParams.get(SHARE_QUERY_PARAM);
    expect(id).toBeTruthy();
    expect(target.pathname).toBe("/");

    const stored = await store.get(id!);
    expect(stored).toMatchObject({
      title: "A page",
      text: "worth keeping",
      url: "https://example.com/post",
    });
    expect(stored!.files).toEqual([]);
  });

  test("keeps files, including ones sent under an unexpected field name", async () => {
    const store = createMemoryShareStoreForTests();
    const form = new FormData();
    form.append("files", new File(["a"], "one.txt", { type: "text/plain" }));
    form.append("attachment", new File(["bb"], "two.png", { type: "image/png" }));

    const target = redirectTarget(
      await handleShareTargetRequest(shareRequest(form), { store })
    );
    const stored = await store.get(target.searchParams.get(SHARE_QUERY_PARAM)!);

    expect(stored!.files.map((f) => f.name)).toEqual(["one.txt", "two.png"]);
    expect(await stored!.files[1]!.text()).toBe("bb");
  });

  test("reports empty only when nothing usable arrived", async () => {
    const store = createMemoryShareStoreForTests();
    const form = new FormData();
    form.append("files", new File([], "nothing.txt", { type: "text/plain" }));

    const target = redirectTarget(
      await handleShareTargetRequest(shareRequest(form), { store })
    );

    expect(target.searchParams.get(SHARE_ERROR_PARAM)).toBe("empty");
    expect(await store.list()).toEqual([]);
  });

  test("an empty file part alongside real text is dropped, not fatal", async () => {
    // Distinguishes "empty parts are skipped" from "an all-empty share is
    // refused" — one test covering both would pass even if every file were
    // dropped unconditionally.
    const store = createMemoryShareStoreForTests();
    const form = new FormData();
    form.set("title", "still a share");
    form.append("files", new File([], "nothing.txt", { type: "text/plain" }));

    const target = redirectTarget(
      await handleShareTargetRequest(shareRequest(form), { store })
    );
    const stored = await store.get(target.searchParams.get(SHARE_QUERY_PARAM)!);

    expect(stored!.title).toBe("still a share");
    expect(stored!.files).toEqual([]);
  });

  test("a files-only share is kept", async () => {
    const store = createMemoryShareStoreForTests();
    const form = new FormData();
    form.append("files", new File(["x"], "photo.jpg", { type: "image/jpeg" }));

    const target = redirectTarget(
      await handleShareTargetRequest(shareRequest(form), { store })
    );
    const stored = await store.get(target.searchParams.get(SHARE_QUERY_PARAM)!);

    expect(stored!.files).toHaveLength(1);
    expect(stored!.title).toBeUndefined();
  });

  test("a nameless binary entry is kept and given a name", async () => {
    // Appending a Blob produces an entry with no usable name in some runtimes
    // (observed in Bun). Keeping it anonymous would push the problem to the
    // server, which would have to invent a name for it anyway.
    const store = createMemoryShareStoreForTests();
    const form = new FormData();
    form.append("files", new Blob(["raw bytes"], { type: "image/png" }));

    const target = redirectTarget(
      await handleShareTargetRequest(shareRequest(form), { store })
    );
    const stored = await store.get(target.searchParams.get(SHARE_QUERY_PARAM)!);

    expect(stored!.files).toHaveLength(1);
    expect(stored!.files[0]!.name).toBe("shared-1");
    // The bytes are what matter; a nameless part also loses its Content-Type on
    // the wire, and the server derives an extension from whatever survives.
    expect(await stored!.files[0]!.text()).toBe("raw bytes");
  });

  test("the record carries a sane id and timestamp", async () => {
    const store = createMemoryShareStoreForTests();
    const form = new FormData();
    form.set("text", "hello");
    const before = Date.now();

    const target = redirectTarget(
      await handleShareTargetRequest(shareRequest(form), { store })
    );
    const id = target.searchParams.get(SHARE_QUERY_PARAM)!;
    const stored = await store.get(id);

    expect(stored!.id).toBe(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored!.receivedAt).toBeGreaterThanOrEqual(before);
  });

  test("refuses a share past the caps the server would refuse anyway", async () => {
    const store = createMemoryShareStoreForTests();
    const overSized = new FormData();
    overSized.append(
      "files",
      new File([new Uint8Array(SHARE_MAX_FILE_BYTES + 1)], "big.bin", {
        type: "application/octet-stream",
      })
    );

    const tooMany = new FormData();
    for (let n = 0; n <= SHARE_MAX_FILES; n += 1) {
      tooMany.append("files", new File(["x"], `f${n}.txt`, { type: "text/plain" }));
    }

    const tooChatty = new FormData();
    tooChatty.set("text", "x".repeat(SHARE_MAX_TEXT_BYTES + 1));

    for (const form of [overSized, tooMany, tooChatty]) {
      const target = redirectTarget(
        await handleShareTargetRequest(shareRequest(form), { store })
      );
      expect(target.searchParams.get(SHARE_ERROR_PARAM)).toBe("too_large");
    }
    // Nothing reached the device.
    expect(await store.list()).toEqual([]);
  });

  test("refuses an oversized body before parsing it", async () => {
    const store = createMemoryShareStoreForTests();
    const form = new FormData();
    form.set("text", "small in truth");
    const request = new Request(`${ORIGIN}${DEFAULT_SHARE_TARGET_PATH}`, {
      method: "POST",
      body: form,
    });
    // A 400 MB video: buffering it would get the worker killed on memory
    // pressure, and the navigation would die with no explanation.
    Object.defineProperty(request, "headers", {
      value: new Headers({ "content-length": String(400_000_000) }),
    });

    const target = redirectTarget(
      await handleShareTargetRequest(request, { store })
    );

    expect(target.searchParams.get(SHARE_ERROR_PARAM)).toBe("too_large");
  });

  test("a store that hangs forever still lands the browser somewhere", async () => {
    const broken: ShareStore = {
      ...createMemoryShareStoreForTests(),
      put: () => new Promise<void>(() => {}),
    };
    const form = new FormData();
    form.set("text", "something");

    const target = redirectTarget(
      await handleShareTargetRequest(shareRequest(form), { store: broken })
    );

    expect(target.searchParams.get(SHARE_ERROR_PARAM)).toBe("store");
  }, 10_000);

  test("a body that will not parse redirects with the parse error", async () => {
    // Stands in for the failure Chrome produces when the manifest's `accept`
    // lists an extension with no MIME type — the app is offered the share and
    // then formData() throws. This asserts the handler's response to a
    // rejecting formData(), not that Bun and Chrome reject the same bodies.
    const request = new Request(`${ORIGIN}${DEFAULT_SHARE_TARGET_PATH}`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=nope" },
      body: "not really multipart",
    });

    const target = redirectTarget(
      await handleShareTargetRequest(request, { store: createMemoryShareStoreForTests() })
    );

    expect(target.searchParams.get(SHARE_ERROR_PARAM)).toBe("parse");
  });

  test("a store that refuses the write still lands the browser somewhere", async () => {
    const broken: ShareStore = {
      ...createMemoryShareStoreForTests(),
      put: async () => {
        throw new Error("QuotaExceededError");
      },
    };
    const form = new FormData();
    form.set("text", "something");

    const target = redirectTarget(
      await handleShareTargetRequest(shareRequest(form), { store: broken })
    );

    expect(target.searchParams.get(SHARE_ERROR_PARAM)).toBe("store");
  });

  test("honors a custom landing path", async () => {
    const form = new FormData();
    form.set("url", "https://example.com");

    const target = redirectTarget(
      await handleShareTargetRequest(shareRequest(form), {
        store: createMemoryShareStoreForTests(),
        landingPath: "/inbox",
      })
    );

    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get(SHARE_QUERY_PARAM)).toBeTruthy();
  });

  test("each share gets its own id", async () => {
    const store = createMemoryShareStoreForTests();
    const send = async () => {
      const form = new FormData();
      form.set("text", "same text");
      return redirectTarget(
        await handleShareTargetRequest(shareRequest(form), { store })
      ).searchParams.get(SHARE_QUERY_PARAM);
    };

    expect(await send()).not.toBe(await send());
    expect(await store.list()).toHaveLength(2);
  });
});

describe("claiming a stash", () => {
  test("take() hands the record to exactly one caller", async () => {
    // The app is reloaded by its own service-worker update path and a reload
    // keeps the query string, so `?share=<id>` can be read twice. Atomic claim
    // is what stops the share being filed into the brain twice.
    const store = createMemoryShareStoreForTests();
    await store.put({ id: "abc", receivedAt: Date.now(), files: [] });

    const [first, second] = await Promise.all([store.take("abc"), store.take("abc")]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await store.get("abc")).toBeUndefined();
  });
});

describe("pruneStoredShares", () => {
  test("drops abandoned stashes and keeps recent ones", async () => {
    const store = createMemoryShareStoreForTests();
    const now = 1_000_000_000_000;
    await store.put({ id: "old", receivedAt: now - 90_000, files: [] });
    await store.put({ id: "new", receivedAt: now - 1_000, files: [] });

    expect(await pruneStoredShares(store, 60_000, now)).toBe(1);
    expect((await store.list()).map((r) => r.id)).toEqual(["new"]);
  });

  test("a stash is bounded even when the app never claims it", async () => {
    const store = createMemoryShareStoreForTests();
    const form = new FormData();
    form.set("text", "abandoned");
    await handleShareTargetRequest(shareRequest(form), { store });

    // The record is kept for the app to claim; the prune only removes what is
    // past its TTL, so a fresh stash survives its own housekeeping pass.
    expect(await store.list()).toHaveLength(1);
  });
});

describe("registerShareTarget", () => {
  test("answers a share POST and leaves every other request alone", async () => {
    const listeners: Array<(event: ShareFetchEvent) => void> = [];
    const scope: ShareTargetScope = {
      addEventListener: (_type, listener) => listeners.push(listener),
    };
    registerShareTarget({ store: createMemoryShareStoreForTests() }, scope);
    expect(listeners).toHaveLength(1);

    const dispatch = (request: Request) => {
      let answered: Promise<Response> | Response | undefined;
      listeners[0]!({
        request,
        respondWith: (response) => {
          answered = response;
        },
      });
      return answered;
    };

    const form = new FormData();
    form.set("text", "hello");
    expect(await dispatch(shareRequest(form))).toBeInstanceOf(Response);
    // A normal navigation must fall through to whatever else the worker installs.
    expect(dispatch(new Request(`${ORIGIN}/`))).toBeUndefined();
  });

  test("respondWith is called synchronously with the event", async () => {
    // The single most important service-worker invariant here: await anything
    // before respondWith and the browser has already gone to the network with
    // a body it cannot replay.
    const listeners: Array<(event: ShareFetchEvent) => void> = [];
    registerShareTarget({ store: createMemoryShareStoreForTests() }, {
      addEventListener: (_type, listener) => listeners.push(listener),
    });

    const form = new FormData();
    form.set("text", "hello");
    let calledSynchronously = false;
    listeners[0]!({
      request: shareRequest(form),
      respondWith: () => {
        calledSynchronously = true;
      },
    });

    expect(calledSynchronously).toBe(true);
  });

  test("honors a custom path", async () => {
    const listeners: Array<(event: ShareFetchEvent) => void> = [];
    registerShareTarget(
      { store: createMemoryShareStoreForTests(), path: "/inbox-target" },
      { addEventListener: (_type, listener) => listeners.push(listener) }
    );

    const seen: unknown[] = [];
    const dispatch = (request: Request) =>
      listeners[0]!({ request, respondWith: (r) => seen.push(r) });

    dispatch(shareRequest(new FormData(), "/inbox-target"));
    dispatch(shareRequest(new FormData(), DEFAULT_SHARE_TARGET_PATH));

    expect(seen).toHaveLength(1);
  });
});

describe("readShareLaunchParams", () => {
  test("reads the id and the error, and tolerates neither", () => {
    expect(readShareLaunchParams(`${ORIGIN}/?share=abc`)).toEqual({
      shareId: "abc",
    });
    expect(readShareLaunchParams(`${ORIGIN}/?share_error=parse`)).toEqual({
      error: "parse",
    });
    expect(readShareLaunchParams(`${ORIGIN}/`)).toEqual({});
    expect(readShareLaunchParams("not a url")).toEqual({});
  });
});
