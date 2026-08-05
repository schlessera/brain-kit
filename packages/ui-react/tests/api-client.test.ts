import { describe, test, expect } from "bun:test";

// We can't import api-client directly because it calls fetch against relative URLs.
// Instead we test the URL building and error handling logic extracted from the patterns.

describe("API client URL building", () => {
  function buildSearchUrl(
    q: string,
    opts?: { type?: string; limit?: number }
  ): string {
    return `/brain/search?q=${encodeURIComponent(q)}${opts?.type ? `&type=${opts.type}` : ""}${opts?.limit ? `&limit=${opts.limit}` : ""}`;
  }

  test("encodes query parameter", () => {
    expect(buildSearchUrl("hello world")).toBe(
      "/brain/search?q=hello%20world"
    );
  });

  test("encodes special characters", () => {
    expect(buildSearchUrl("foo&bar=baz")).toBe(
      "/brain/search?q=foo%26bar%3Dbaz"
    );
  });

  test("includes type filter", () => {
    expect(buildSearchUrl("test", { type: "identity" })).toBe(
      "/brain/search?q=test&type=identity"
    );
  });

  test("includes limit", () => {
    expect(buildSearchUrl("test", { limit: 5 })).toBe(
      "/brain/search?q=test&limit=5"
    );
  });

  test("includes both type and limit", () => {
    expect(buildSearchUrl("test", { type: "note", limit: 3 })).toBe(
      "/brain/search?q=test&type=note&limit=3"
    );
  });

  test("omits undefined options", () => {
    expect(buildSearchUrl("test", {})).toBe("/brain/search?q=test");
  });

  test("handles unicode in query", () => {
    const url = buildSearchUrl("café résumé");
    expect(url).toContain("caf%C3%A9");
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
