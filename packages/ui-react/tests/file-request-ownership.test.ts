import { afterEach, describe, expect, test } from "bun:test";
import { useFileStore } from "../src/stores/file-store";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; useFileStore.getState().reset(); });

function setup() {
  useFileStore.getState().reset();
  const requests: Array<{ signal: AbortSignal; resolve: (r: Response) => void }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://example.test");
    if (url.pathname.endsWith("/resolve")) return Response.json({ ancestors: [], exists: true });
    if (url.pathname.endsWith("/tree")) return Response.json({ entries: [] });
    return new Promise<Response>((resolve) => requests.push({ signal: init!.signal!, resolve }));
  }) as typeof fetch;
  return requests;
}
const content = (text: string) => Response.json({ path: "a.md", kind: "markdown", content: text });

describe("file request ownership", () => {
  test("A-B-A navigation ignores stale success and aborts superseded requests", async () => {
    const requests = setup();
    const first = useFileStore.getState().openFile("a.md");
    const second = useFileStore.getState().openFile("b.md");
    const third = useFileStore.getState().openFile("a.md");
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests[1]!.signal.aborted).toBe(true);
    requests[2]!.resolve(content("new")); await third;
    requests[0]!.resolve(content("old")); await first;
    requests[1]!.resolve(content("wrong")); await second;
    expect(useFileStore.getState().currentContent?.content).toBe("new");
  });

  test("close/reset invalidate old errors even after reopening the same file", async () => {
    for (const action of ["closeFile", "reset"] as const) {
      const requests = setup();
      const old = useFileStore.getState().openFile("a.md");
      useFileStore.getState()[action]();
      expect(requests[0]!.signal.aborted).toBe(true);
      expect(useFileStore.getState().contentLoading).toBe(false);
      const current = useFileStore.getState().openFile("a.md");
      requests[1]!.resolve(content("new")); await current;
      requests[0]!.resolve(Response.json({ error: "old failure" }, { status: 500 })); await old;
      expect(useFileStore.getState().contentError).toBeNull();
      expect(useFileStore.getState().currentContent?.content).toBe("new");
    }
  });
});
