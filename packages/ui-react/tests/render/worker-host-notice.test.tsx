// The worker host notice (#1632): while the server's latest probe says its
// host cannot run agent turns, the composer shows why, links the fix and
// offers a re-check, without blocking a send. Mounted on a root whose
// transport is a stub, so every request the notice makes is observed.
import { unregisterWorkerHostNoticeDom } from "./worker-host-notice-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { WorkerHostStatus } from "@schlessera/brain-ui-sdk/protocol";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ROOT_SERVER_DOCS_URL, WORKER_HOST_DOCS_URL, WorkerHostNotice } from "../../src/components/chat/worker-host-notice.js";
import { failurePresentation } from "../../src/lib/turn-failure.js";

afterEach(cleanup);
afterAll(unregisterWorkerHostNoticeDom);

const FRESH_PROC = "the kernel refused the worker a fresh /proc because the parent /proc has masked or covered paths;"
  + " in Docker, run the container with --security-opt systempaths=unconfined";
const DOWN: WorkerHostStatus = { ordinary: { available: false, requirement: FRESH_PROC, checkedAt: "2026-07-12T08:00:00.000Z", trigger: "boot" } };
const UP: WorkerHostStatus = { ordinary: { available: true, checkedAt: "2026-07-12T08:05:00.000Z", trigger: "check" } };

function mount(answers: { status: () => WorkerHostStatus | undefined; check?: () => WorkerHostStatus }) {
  const calls: string[] = [];
  const root: BrainUiRoot = createBrainUiRoot({ storage: null, request: async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/status/worker-host") && init?.method === "POST") return Response.json(answers.check?.() ?? UP);
    if (url.endsWith("/api/status")) {
      const workerHost = answers.status();
      return Response.json({ healthy: true, ...(workerHost ? { runtime: { boot: [], workerHost } } : {}) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } });
  const view = render(<BrainUiProvider root={root}><WorkerHostNotice /></BrainUiProvider>);
  return { root, view, calls };
}

describe("the worker host notice", () => {
  test("names the requirement, links the container guide, and Check again clears it once the host passes", async () => {
    const { view, calls } = mount({ status: () => DOWN });
    const notice = await waitFor(() => view.getByRole("status"));
    expect(notice.textContent).toContain("This server can't run agent turns.");
    expect(notice.querySelector("[data-worker-host-requirement]")!.textContent).toBe(FRESH_PROC);
    const link = view.getByRole("link");
    expect(link.getAttribute("href")).toBe(WORKER_HOST_DOCS_URL);
    expect(WORKER_HOST_DOCS_URL).toEndWith("#running-the-server-in-a-docker-container");
    expect(link.textContent).toContain("Fix the host");
    fireEvent.click(view.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(view.queryByRole("status") === null, "WORKER_HOST_NOTICE_CLEARS_AFTER_SUCCESSFUL_CHECK").toBe(true));
    expect(calls).toEqual(["GET /api/status", "POST /api/status/worker-host"]);
  });

  test("a check that still fails keeps the notice, with the newest requirement", async () => {
    const { view } = mount({ status: () => DOWN, check: () => ({ ordinary: { available: false, requirement: "bubblewrap is missing", checkedAt: "2026-07-12T08:06:00.000Z", trigger: "check" } }) });
    await waitFor(() => view.getByRole("status"));
    fireEvent.click(view.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(view.container.querySelector("[data-worker-host-requirement]")!.textContent).toBe("bubblewrap is missing"));
  });

  test("draws nothing while the host passes, or for a server that does not report it", async () => {
    for (const status of [() => UP, () => undefined]) {
      const { view, calls } = mount({ status });
      await waitFor(() => expect(calls).toEqual(["GET /api/status"]));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(view.container.innerHTML).toBe("");
      cleanup();
    }
  });

  test("a root-run server keeps a notice that names what agent turns can reach, with no re-check (#1638)", async () => {
    const warning = "The server runs as root (uid 0), so its agent workers do too.";
    const { view } = mount({ status: () => ({ ...UP, rootServer: { warning } }) });
    const notice = await waitFor(() => view.getByRole("status"));
    expect(notice.hasAttribute("data-root-server-notice")).toBe(true);
    expect(notice.textContent).toContain("This server runs as root.");
    expect(notice.textContent).toContain("read root-owned files and connect to root-owned and abstract Unix sockets");
    const link = view.getByRole("link");
    expect(link.getAttribute("href")).toBe(ROOT_SERVER_DOCS_URL);
    expect(ROOT_SERVER_DOCS_URL).toEndWith("#running-the-server-as-root");
    expect(view.queryByRole("button")).toBeNull();
  });

  test("a root-run server whose host also fails shows both notices", async () => {
    const { view } = mount({ status: () => ({ ...DOWN, rootServer: { warning: "root" } }) });
    await waitFor(() => expect(view.getAllByRole("status")).toHaveLength(2));
    expect(view.container.querySelector("[data-worker-host-requirement]")!.textContent).toBe(FRESH_PROC);
  });

  test("a turn refused for the host re-reads the status, so the notice appears without a reload", async () => {
    let status: WorkerHostStatus = UP;
    const { root, view, calls } = mount({ status: () => status });
    await waitFor(() => expect(calls).toHaveLength(1));
    status = DOWN;
    act(() => {
      const chat = root.stores.chat.getState();
      chat.addUserMessage(null, "Where is Ithaca?");
      chat.startAssistantMessage(null);
      chat.failAssistantMessage(null, { errorClass: "worker_host_unsupported", message: `Agent worker boundary unavailable: ${FRESH_PROC}.` });
    });
    await waitFor(() => view.getByRole("status"));
    expect(calls).toEqual(["GET /api/status", "GET /api/status"]);
  });
});

describe("a turn refused for the host", () => {
  test("says the server cannot run it, offers no retry or bug report, and names the requirement", () => {
    const presentation = failurePresentation({ errorClass: "worker_host_unsupported", message: FRESH_PROC });
    expect(presentation).toMatchObject({ headline: "This server can't run agent turns.", operator: true, retry: false, report: false });
  });
});
