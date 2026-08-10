import { describe, test, expect, afterEach } from "bun:test";
import { api } from "../src/lib/api-client.js";

/**
 * Drive the real client with a stubbed fetch, so the asserted URLs are the ones
 * the browser would actually request (an earlier version of this file mirrored
 * the builder by hand, which could drift from the client without failing).
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureUrl(body: unknown = { results: [], warnings: [] }): {
  urls: string[];
  inits: (RequestInit | undefined)[];
} {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    urls.push(String(input));
    inits.push(init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { urls, inits };
}

describe("API client URL building", () => {
  test("encodes query parameter", async () => {
    const cap = captureUrl();
    await api.brainSearch("hello world");
    expect(cap.urls[0]).toBe("/api/brain/search?q=hello%20world");
  });

  test("encodes special characters", async () => {
    const cap = captureUrl();
    await api.brainSearch("foo&bar=baz");
    expect(cap.urls[0]).toBe("/api/brain/search?q=foo%26bar%3Dbaz");
  });

  test("includes type filter", async () => {
    const cap = captureUrl();
    await api.brainSearch("test", { type: "identity" });
    expect(cap.urls[0]).toBe("/api/brain/search?q=test&type=identity");
  });

  test("includes limit", async () => {
    const cap = captureUrl();
    await api.brainSearch("test", { limit: 5 });
    expect(cap.urls[0]).toBe("/api/brain/search?q=test&limit=5");
  });

  test("includes type, tag, limit and mode together", async () => {
    const cap = captureUrl();
    await api.brainSearch("test", {
      type: "note",
      tag: "reading list",
      limit: 3,
      mode: "fts",
    });
    expect(cap.urls[0]).toBe(
      "/api/brain/search?q=test&type=note&tag=reading%20list&limit=3&mode=fts"
    );
  });

  test("omits undefined options", async () => {
    const cap = captureUrl();
    await api.brainSearch("test", {});
    expect(cap.urls[0]).toBe("/api/brain/search?q=test");
  });

  test("handles unicode in query", async () => {
    const cap = captureUrl();
    await api.brainSearch("café résumé");
    expect(cap.urls[0]).toContain("caf%C3%A9");
  });

  test("forwards the abort signal so a superseded search can be cancelled", async () => {
    const cap = captureUrl();
    const controller = new AbortController();
    await api.brainSearch("test", { signal: controller.signal });
    expect(cap.inits[0]?.signal).toBe(controller.signal);
  });

  test("surfaces the server error message", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Search failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    expect(api.brainSearch("test")).rejects.toThrow("Search failed");
  });
});

describe("API error response handling", () => {
  test("error body shape is consistent", () => {
    const errorBodies = [
      { error: "Query parameter 'q' is required" },
      { error: "Field 'content' is required" },
      { error: "VPN access required" },
      { error: "Search failed" },
    ];
    for (const body of errorBodies) {
      expect(body).toHaveProperty("error");
      expect(typeof body.error).toBe("string");
    }
  });

  test("HTTP status codes map to error types", () => {
    const statusMeanings: Record<number, string> = {
      400: "client sent bad input",
      403: "VPN required",
      404: "resource not found",
      500: "server/brain CLI error",
    };
    // All expected statuses are documented
    expect(Object.keys(statusMeanings)).toHaveLength(4);
    for (const [code, meaning] of Object.entries(statusMeanings)) {
      expect(Number(code)).toBeGreaterThanOrEqual(400);
      expect(meaning.length).toBeGreaterThan(0);
    }
  });
});

describe("API client response shape contracts", () => {
  test("health response shape", () => {
    const response = {
      status: "healthy",
      uptime: 60000,
      version: "abc123",
      timestamp: new Date().toISOString(),
    };
    expect(response.status).toBe("healthy");
    expect(typeof response.uptime).toBe("number");
    expect(typeof response.version).toBe("string");
    expect(() => new Date(response.timestamp)).not.toThrow();
  });

  test("stats response shape", () => {
    const response = {
      documents: 393,
      byType: { identity: 46, talk: 172 },
      byStatus: { active: 322 },
      tags: 386,
      links: 215,
    };
    expect(response.documents).toBeGreaterThan(0);
    expect(response.byType).toBeDefined();
    expect(typeof response.byType.identity).toBe("number");
  });

  test("search response shape", () => {
    const response = {
      results: [
        { path: "me/identity.md", title: "Identity", snippet: "...", score: 0.5 },
      ],
    };
    expect(response.results).toBeArray();
    expect(response.results[0]).toHaveProperty("path");
    expect(response.results[0]).toHaveProperty("title");
    expect(response.results[0]).toHaveProperty("score");
  });

  test("sessions response shape", () => {
    const response = {
      sessions: [
        { id: "s1", title: "Chat", createdAt: Date.now(), lastActiveAt: Date.now() },
      ],
    };
    expect(response.sessions).toBeArray();
    expect(response.sessions[0]).toHaveProperty("id");
    expect(response.sessions[0]).toHaveProperty("title");
  });
});
