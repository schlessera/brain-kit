// Byte ranges on the raw file route (#529). iOS Safari plays a video or audio
// file only when the server answers `Range` with a 206, and probes with
// `bytes=0-1` before it plays anything.
//
// Two paths, because they fail differently. `app.fetch` reaches the route with
// no server in between, so it pins the route's own range handling: Bun.serve
// slices a `Bun.file` body by itself, which would hide a route that ignored
// the header. The served app pins what a browser actually receives, after
// every middleware has run.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";

import { createTestApp, type TestApp } from "./helpers/test-app";

// Large enough that Bun sends a stream body chunked, without Content-Length.
const SIZE = 64 * 1024;
const BYTES = Uint8Array.from({ length: SIZE }, (_, i) => i % 251);
const URL_PATH = "/api/files/content?path=clip.mp4&raw=1";

let app: TestApp;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  app = createTestApp();
  writeFileSync(join(app.brainPath, "clip.mp4"), BYTES);
  writeFileSync(join(app.brainPath, "empty.mp4"), new Uint8Array(0));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req, srv) => app.app.fetch(req, srv as never) });
});

afterAll(async () => {
  server.stop(true);
  await app.teardown();
});

const inProcess = (range?: string) => app.fetch(URL_PATH, range ? { headers: { Range: range } } : {});
const overHttp = (range?: string) =>
  fetch(`http://127.0.0.1:${server.port}${URL_PATH}`, range ? { headers: { Range: range } } : {});

async function bytesOf(response: Response): Promise<number[]> {
  return [...new Uint8Array(await response.arrayBuffer())];
}

describe("the raw file route answers a byte range", () => {
  test("with a 206 carrying exactly the requested bytes", async () => {
    const response = await inProcess("bytes=100-109");

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 100-109/${SIZE}`);
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(await bytesOf(response)).toEqual([...BYTES.slice(100, 110)]);
  });

  test("an open-ended range runs to the last byte", async () => {
    const response = await inProcess(`bytes=${SIZE - 5}-`);

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${SIZE - 5}-${SIZE - 1}/${SIZE}`);
    expect(await bytesOf(response)).toEqual([...BYTES.slice(SIZE - 5)]);
  });

  test("a suffix range is the last N bytes", async () => {
    const response = await inProcess("bytes=-4");

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${SIZE - 4}-${SIZE - 1}/${SIZE}`);
    expect(await bytesOf(response)).toEqual([...BYTES.slice(SIZE - 4)]);
  });

  test("a suffix longer than the file is the whole file", async () => {
    const response = await inProcess(`bytes=-${SIZE + 500}`);

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-${SIZE - 1}/${SIZE}`);
    expect((await bytesOf(response)).length).toBe(SIZE);
  });

  test("an end past the file is clamped to the last byte", async () => {
    const response = await inProcess(`bytes=${SIZE - 2}-${SIZE + 5000}`);

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${SIZE - 2}-${SIZE - 1}/${SIZE}`);
    expect(await bytesOf(response)).toEqual([...BYTES.slice(SIZE - 2)]);
  });

  test("a range that starts past the end is a 416 naming the size", async () => {
    const response = await inProcess(`bytes=${SIZE}-`);

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${SIZE}`);
  });

  test("several ranges, or a malformed one, get the whole file", async () => {
    for (const range of ["bytes=0-1,5-6", "bytes=9-3", "items=0-1", "bytes=-"]) {
      const response = await inProcess(range);
      expect(response.status).toBe(200);
      expect((await bytesOf(response)).length).toBe(SIZE);
    }
  });

  test("a HEAD request ignores Range, which applies to GET only", async () => {
    const response = await app.fetch(URL_PATH, { method: "HEAD", headers: { Range: "bytes=0-1" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
  });

  test("an If-Range never matches, since the route sends no validator, so the whole file comes back", async () => {
    const response = await app.fetch(URL_PATH, { headers: { Range: "bytes=0-1", "If-Range": '"some-etag"' } });

    expect(response.status).toBe(200);
    expect((await bytesOf(response)).length).toBe(SIZE);
  });

  test("an empty file answers a suffix range with its whole, empty self and anything else with 416", async () => {
    const empty = (range: string) => app.fetch("/api/files/content?path=empty.mp4&raw=1", { headers: { Range: range } });

    const suffix = await empty("bytes=-5");
    expect(suffix.status).toBe(200);
    expect((await bytesOf(suffix)).length).toBe(0);
    expect((await empty("bytes=-0")).status).toBe(416);
    expect((await empty("bytes=0-")).status).toBe(416);
  });

  /**
   * Stand in for a writer that cuts `shrinking.mp4` to `keep` bytes between
   * the route's size check and its first read. The read itself is real.
   * With `alwaysShort`, every read comes back cut short instead, as from a
   * file that keeps changing.
   */
  function shrinkOnRead(keep: number, alwaysShort = false) {
    const realFile = Bun.file;
    let cut = false;
    return spyOn(Bun, "file").mockImplementation(((path: string, ...rest: never[]) => {
      const real = realFile(path, ...rest);
      if (!path.endsWith("shrinking.mp4")) return real;
      return Object.assign(Object.create(real), {
        slice: (start: number, end: number) => ({
          bytes: async () => {
            if (alwaysShort) return BYTES.slice(start, start + keep);
            if (!cut) {
              writeFileSync(path, BYTES.slice(0, keep));
              cut = true;
            }
            return realFile(path, ...rest).slice(start, end).bytes();
          },
        }),
      });
    }) as typeof Bun.file);
  }

  const shrinking = (range: string) => {
    writeFileSync(join(app.brainPath, "shrinking.mp4"), BYTES);
    return app.fetch("/api/files/content?path=shrinking.mp4&raw=1", { headers: { Range: range } });
  };

  test("a file that shrank after it was measured is answered at its new size", async () => {
    const file = shrinkOnRead(4);
    try {
      const response = await shrinking("bytes=0-99");

      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 0-3/4");
      expect(response.headers.get("content-length")).toBe("4");
      expect(await bytesOf(response)).toEqual([...BYTES.slice(0, 4)]);
    } finally {
      file.mockRestore();
    }
  });

  test("a suffix range the shrunk file still has is served from it", async () => {
    const file = shrinkOnRead(4);
    try {
      const response = await shrinking("bytes=-4");

      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 0-3/4");
      expect(await bytesOf(response)).toEqual([...BYTES.slice(0, 4)]);
    } finally {
      file.mockRestore();
    }
  });

  test("a range that starts past the shrunk file is a 416 naming its new size", async () => {
    const file = shrinkOnRead(4);
    try {
      const response = await shrinking("bytes=500-599");

      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */4");
      expect(await bytesOf(response)).toEqual([]);
    } finally {
      file.mockRestore();
    }
  });

  test("a file still changing on the second read gets what was read, total unknown", async () => {
    const file = shrinkOnRead(4, true);
    try {
      const response = await shrinking("bytes=0-99");

      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 0-3/*");
      expect(response.headers.get("content-length")).toBe("4");
      expect(await bytesOf(response)).toEqual([...BYTES.slice(0, 4)]);
    } finally {
      file.mockRestore();
    }
  });

  test("a request without Range gets the whole file and learns ranges are accepted", async () => {
    const response = await inProcess();

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect((await bytesOf(response)).length).toBe(SIZE);
  });
});

describe("over HTTP, through every middleware", () => {
  test("Safari's two-byte probe gets a 206 with its length, and the frame headers", async () => {
    const response = await overHttp("bytes=0-1");

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-1/${SIZE}`);
    expect(response.headers.get("content-length")).toBe("2");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await bytesOf(response)).toEqual([...BYTES.slice(0, 2)]);
  });

  test("a range the size of the whole file keeps its length and its bytes", async () => {
    const response = await overHttp("bytes=0-");

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 0-${SIZE - 1}/${SIZE}`);
    expect(response.headers.get("content-length")).toBe(String(SIZE));
    expect(await bytesOf(response)).toEqual([...BYTES]);
  });

  test("an If-Range gets the whole file here too", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}${URL_PATH}`, { headers: { Range: "bytes=0-1", "If-Range": '"some-etag"' } });

    expect(response.status).toBe(200);
    expect((await bytesOf(response)).length).toBe(SIZE);
  });

  test("a range in the middle carries only its own bytes", async () => {
    const response = await overHttp("bytes=100-109");

    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await bytesOf(response)).toEqual([...BYTES.slice(100, 110)]);
  });
});
