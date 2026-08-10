import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import {
  getBackendForProfile,
  listAllProviders,
  resetBackendForTests,
  setBackendsForTests,
} from "../src/agent/backend";
import { closeDb } from "../src/db/client";
import { getHiddenModelIds } from "../src/db/settings";
import { modelRoutes } from "../src/routes/models";
import { providerRoutes } from "../src/routes/providers";
import { makeFakeBackend } from "./helpers/fake-backend";

const TEST_DB = `/tmp/brain-ui-models-routes-${process.pid}.db`;

function removeTestDb() {
  for (const suffix of ["", "-shm", "-wal"]) {
    const path = TEST_DB + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
}

/** Two profiles on one backend, so hiding one still leaves a picker entry. */
function installBackend() {
  setBackendsForTests([
    makeFakeBackend({
      id: "claude",
      profiles: [
        { id: "claude-opus-5", label: "Claude Opus 5", vendor: "anthropic" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", vendor: "anthropic" },
      ],
    }),
  ]);
}

beforeEach(() => {
  closeDb();
  removeTestDb();
  process.env.DB_PATH = TEST_DB;
  resetBackendForTests();
  installBackend();
});

afterEach(() => {
  resetBackendForTests();
  closeDb();
  removeTestDb();
  delete process.env.DB_PATH;
});

describe("model catalog routes", () => {
  test("GET /models lists every profile, none hidden by default", async () => {
    const response = await modelRoutes.request("/models");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models.map((m: { id: string }) => m.id)).toEqual([
      "claude-opus-5",
      "claude-haiku-4-5",
    ]);
    expect(body.models.every((m: { hidden: boolean }) => !m.hidden)).toBe(true);
    // No model source on a fake backend — discovery reports itself unavailable
    // rather than pretending it refreshed.
    expect(body.refreshedAt).toBeNull();
    expect(body.discovery.enabled).toBe(false);
  });

  test("PUT /models/hidden persists the set and drops it from the picker", async () => {
    const response = await modelRoutes.request("/models/hidden", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden: ["claude-haiku-4-5"] }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.models.find((m: { id: string }) => m.id === "claude-haiku-4-5").hidden
    ).toBe(true);
    expect(getHiddenModelIds()).toEqual(["claude-haiku-4-5"]);

    // The picker route reflects it immediately — the profile memo is dropped on
    // write, so this must not need a restart.
    const providers = await (
      await providerRoutes.request("/providers")
    ).json();
    expect(providers.providers.map((p: { id: string }) => p.id)).toEqual([
      "claude-opus-5",
    ]);
  });

  test("a hidden profile still resolves for sessions pinned to it", async () => {
    await modelRoutes.request("/models/hidden", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden: ["claude-haiku-4-5"] }),
    });

    expect(await getBackendForProfile("claude-haiku-4-5")).toBeDefined();
    expect(
      (await listAllProviders({ includeHidden: true })).map((p) => p.id)
    ).toContain("claude-haiku-4-5");
  });

  test("unhiding restores the profile to the picker", async () => {
    await modelRoutes.request("/models/hidden", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden: ["claude-haiku-4-5"] }),
    });
    await modelRoutes.request("/models/hidden", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden: [] }),
    });

    expect(getHiddenModelIds()).toEqual([]);
    expect((await listAllProviders()).map((p) => p.id)).toEqual([
      "claude-opus-5",
      "claude-haiku-4-5",
    ]);
  });

  test("PUT /models/hidden rejects a malformed body", async () => {
    for (const body of ['{"hidden":"claude-opus-5"}', '{"hidden":[1,2]}', "{}"]) {
      const response = await modelRoutes.request("/models/hidden", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
    }
    expect(getHiddenModelIds()).toEqual([]);
  });

  test("POST /models/refresh answers 409 when the backend has no discovery", async () => {
    const response = await modelRoutes.request("/models/refresh", {
      method: "POST",
    });
    expect(response.status).toBe(409);
  });
});
