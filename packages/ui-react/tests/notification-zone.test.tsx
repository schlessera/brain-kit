// Client-local Action notice timing (#683): the client reports its IANA zone on
// registration/rebind, the first authenticated probe, reconnection, foreground
// return and a detected zone change. Runs in a child process with happy-dom
// registered, so its DOM globals never reach another test file.
import { expect, spyOn, test } from "bun:test";

const CHILD_MARKER = "BRAIN_UI_REACT_NOTIFICATION_ZONE_CHILD";

if (!process.env[CHILD_MARKER]) {
  test("notification zone lifecycle passes in an isolated process", async () => {
    const proc = Bun.spawn(["bun", "test", import.meta.path, "--timeout", "30000"], {
      cwd: import.meta.dir,
      // A fixed local zone for the child, so slot timing is deterministic.
      env: { ...process.env, [CHILD_MARKER]: "1", TZ: "Europe/Athens" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`Isolated notification zone tests failed (${exitCode})\n${stdout}${stderr}`);
    // A child that registered no tests also exits 0.
    expect(`${stdout}${stderr}`).toMatch(/\b9 pass\b/);
  });
} else {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const { act, renderHook } = await import("@testing-library/react");
  const registration = await import("../src/lib/push-registration.js");
  const { useNotificationZoneRefresh } = await import("../src/hooks/use-notification-zone.js");
  type Api = Parameters<typeof registration.rebindPushSubscriptionAfterLogin>[0];

  let zone = "Europe/Athens";
  const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...resolved.call(this), timeZone: zone };
  });

  function fakeApi() {
    const zones: Array<{ timeZone: string; endpoint?: string; clientId?: string }> = [];
    const subscribes: Array<{ label?: string; timeZone?: string }> = [];
    const api = {
      pushZone: async (timeZone: string, endpoint?: string, clientId?: string) => {
        zones.push({ timeZone, ...(endpoint !== undefined ? { endpoint } : {}), ...(clientId ? { clientId } : {}) });
        return { ok: true as const, timeZone };
      },
      pushSubscribe: async (_subscription: unknown, label?: string, timeZone?: string) => {
        subscribes.push({ label, timeZone });
        return { ok: true as const };
      },
      pushPublicKey: async () => ({ publicKey: "unused" }),
    } as unknown as Api;
    return { api, zones, subscribes };
  }

  function grantPush(endpoint: string | null) {
    (globalThis as { Notification?: unknown }).Notification = { permission: "granted" };
    const subscription = endpoint && { endpoint, options: { applicationServerKey: null }, toJSON: () => ({ endpoint }) };
    const registration = endpoint ? { pushManager: { getSubscription: async () => subscription } } : undefined;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        // A shell without an active worker: `ready` never settles.
        ready: registration ? Promise.resolve(registration) : new Promise(() => {}),
        getRegistration: async () => registration,
      },
    });
  }

  test("the refresher reports on lifecycle events and otherwise only on a changed zone", async () => {
    const reports: string[] = [];
    let fail = false;
    const refresher = registration.createZoneRefresher(async () => {
      if (fail) throw new Error("offline");
      reports.push(zone);
      return zone;
    });
    zone = "Europe/Athens";
    expect(await refresher.refresh()).toBe(true);
    expect(await refresher.refresh()).toBe(false);
    zone = "Asia/Tokyo";
    expect(await refresher.refresh()).toBe(true);
    refresher.markLifecycle();
    expect(await refresher.refresh()).toBe(true);
    // A failed report stays owed until one succeeds.
    refresher.markLifecycle();
    fail = true;
    expect(await refresher.refresh()).toBe(false);
    fail = false;
    expect(await refresher.refresh()).toBe(true);
    expect(reports).toEqual(["Europe/Athens", "Asia/Tokyo", "Asia/Tokyo", "Asia/Tokyo"]);
  });

  test("zone reports name the browser's own push endpoint, and rebind carries the zone", async () => {
    const { api, zones, subscribes } = fakeApi();
    zone = "Europe/Athens";
    (globalThis as { Notification?: unknown }).Notification = undefined;
    let reported = 0;
    const stop = registration.onNotificationZoneReported(api, () => { reported++; });
    await registration.reportNotificationZone(api);
    grantPush("https://push.example.test/odysseus-phone");
    await registration.reportNotificationZone(api);
    stop();
    // The browser's persisted context identifier rides along, stable across reports.
    const clientId = registration.noticeClientId();
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(zones).toEqual([
      { timeZone: "Europe/Athens", clientId },
      { timeZone: "Europe/Athens", endpoint: "https://push.example.test/odysseus-phone", clientId },
    ]);
    // Listeners (the digest card) refetch after each successful report.
    expect(reported).toBe(2);
    await registration.rebindPushSubscriptionAfterLogin(api);
    expect(subscribes.map((s) => s.timeZone)).toEqual(["Europe/Athens"]);
  });

  test("a granted page without an active service worker still reports its zone", async () => {
    const { api, zones } = fakeApi();
    grantPush(null);
    const done = registration.reportNotificationZone(api);
    const outcome = await Promise.race([done.then(() => "reported"), new Promise((resolve) => setTimeout(() => resolve("hung"), 500))]);
    expect(outcome).toBe("reported");
    expect(zones.map((z) => z.timeZone)).toEqual(["Europe/Athens"]);
  });

  test("an unavailable zone is reported as unusable rather than omitted", async () => {
    const { api, zones } = fakeApi();
    (globalThis as { Notification?: unknown }).Notification = undefined;
    zone = "";
    await registration.reportNotificationZone(api);
    expect(zones.map((z) => z.timeZone)).toEqual([""]);
    zone = "Europe/Athens";
  });

  test("the gate hook refreshes on first probe, zone change, reconnection, foreground and a new socket", async () => {
    const { api, zones } = fakeApi();
    (globalThis as { Notification?: unknown }).Notification = undefined;
    zone = "Europe/Athens";
    const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const { rerender, unmount } = renderHook(
      (signals: { successfulProbeCount: number; connected: boolean; socketOpens: number }) => useNotificationZoneRefresh(api, signals),
      { initialProps: { successfulProbeCount: 0, connected: false, socketOpens: 0 } }
    );
    await settle();
    expect(zones).toHaveLength(0);
    rerender({ successfulProbeCount: 1, connected: true, socketOpens: 1 });
    await settle();
    expect(zones).toHaveLength(1);
    // An ordinary poll with an unchanged zone stays quiet.
    rerender({ successfulProbeCount: 2, connected: true, socketOpens: 1 });
    await settle();
    expect(zones).toHaveLength(1);
    // Detected change on the next probe.
    zone = "Asia/Tokyo";
    rerender({ successfulProbeCount: 3, connected: true, socketOpens: 1 });
    await settle();
    expect(zones.map((z) => z.timeZone)).toEqual(["Europe/Athens", "Asia/Tokyo"]);
    // Reconnection after an unreachable reading.
    rerender({ successfulProbeCount: 3, connected: false, socketOpens: 1 });
    await settle();
    rerender({ successfulProbeCount: 4, connected: true, socketOpens: 1 });
    await settle();
    expect(zones).toHaveLength(3);
    // Foreground return.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await settle();
    expect(zones).toHaveLength(4);
    // A replacement socket.
    rerender({ successfulProbeCount: 4, connected: true, socketOpens: 2 });
    await settle();
    expect(zones).toHaveLength(5);
    unmount();
    zone = "Europe/Athens";
  });
}

if (process.env[CHILD_MARKER]) {
  const { act, render, cleanup } = await import("@testing-library/react");
  const { BrainUiProvider } = await import("../src/root-context.js");
  const { createBrainUiRoot } = await import("../src/root.js");
  const { DigestCard, msUntilNextSlot } = await import("../src/components/activity/digest-card.js");
  const registration = await import("../src/lib/push-registration.js");
  const summaryOf = (title: string, generatedAt: number) => ({ generatedAt, slotAt: generatedAt, timeZone: "Europe/Athens", updates: [],
    waiting: [{ episodeId: `${title}#1`, itemId: title, threadId: "ogygia", title }] });
  function cardApi(next: () => unknown) {
    return {
      activityDigest: async () => ({ digest: null, dismissedAt: 0, actions: next() }),
      activityDigestDismiss: async () => ({ ok: true }),
      pushZone: async () => ({ ok: true, timeZone: "Europe/Athens" }),
    } as unknown as Parameters<typeof registration.reportNotificationZone>[0];
  }
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  test("a read in flight when the card is dismissed cannot bring it back; a zone report re-arms the slot timer", async () => {
    let release: (() => void) | undefined;
    let reads = 0;
    const ready = { status: "ready", timeZone: "Europe/Athens", latest: summaryOf("Answer the Cyclops", 5), dismissedAt: null };
    const api = {
      activityDigest: async () => {
        reads++;
        if (reads === 2) await new Promise<void>((resolve) => { release = resolve; });
        return { digest: null, dismissedAt: 0, actions: ready };
      },
      activityDigestDismiss: async () => ({ ok: true }),
      pushZone: async () => ({ ok: true, timeZone: "Europe/Athens" }),
    } as unknown as Parameters<typeof registration.reportNotificationZone>[0];
    const timers: number[] = [];
    const real = globalThis.setTimeout;
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay?: number) => {
      if ((delay ?? 0) > 60_000) { timers.push(delay!); return 0 as unknown as ReturnType<typeof setTimeout>; }
      return real(run, delay);
    }) as typeof setTimeout);
    try {
      (globalThis as { Notification?: unknown }).Notification = undefined;
      const view = render(<BrainUiProvider root={createBrainUiRoot({ api, storage: null })}><DigestCard /></BrainUiProvider>);
      await flush();
      expect(view.container.textContent).toContain("Answer the Cyclops");
      // A zone report starts a second read (held open) and re-arms the timer.
      await act(async () => { await registration.reportNotificationZone(api); });
      expect(timers).toHaveLength(2);
      const dismissButton = [...view.container.querySelectorAll("[role=button]")].find((b) => b.textContent?.includes("Dismiss")) as HTMLElement;
      await act(async () => { dismissButton.click(); });
      expect(view.container.textContent).not.toContain("Answer the Cyclops");
      await act(async () => { release!(); });
      await flush();
      expect(view.container.textContent).not.toContain("Answer the Cyclops");
      cleanup();
    } finally { spy.mockRestore(); }
  });

  test("the next local slot is 09:00 or 17:00 in this runtime's zone", () => {
    const athens = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, 3 + day, hour - 3, minute);
    expect(msUntilNextSlot(athens(0, 8, 59))).toBe(60_000);
    expect(msUntilNextSlot(athens(0, 9))).toBe(8 * 3_600_000);
    expect(msUntilNextSlot(athens(0, 17, 30))).toBe(15.5 * 3_600_000);
  });

  test("an open card reads again after the local slot and hides when nothing is fresh", async () => {
    let response: unknown = { status: "ready", timeZone: "Europe/Athens", latest: summaryOf("Answer the Cyclops", 5), dismissedAt: null };
    const api = cardApi(() => response);
    const timers: Array<{ run: () => void; delay: number }> = [];
    const real = globalThis.setTimeout;
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, delay?: number) => {
      if ((delay ?? 0) > 60_000) { timers.push({ run, delay: delay! }); return 0 as unknown as ReturnType<typeof setTimeout>; }
      return real(run, delay);
    }) as typeof setTimeout);
    try {
      const view = render(<BrainUiProvider root={createBrainUiRoot({ api, storage: null })}><DigestCard /></BrainUiProvider>);
      await flush();
      expect(view.container.textContent).toContain("Answer the Cyclops");
      expect(timers).toHaveLength(1);
      // The 17:00 summary has nothing new: the stale card goes away.
      response = { status: "ready", timeZone: "Europe/Athens", latest: { ...summaryOf("x", 9), waiting: [] }, dismissedAt: null };
      await act(async () => { timers[0]!.run(); });
      await flush();
      expect(view.container.textContent).not.toContain("Answer the Cyclops");
      expect(timers).toHaveLength(2);
      // The next slot brings a new decision onto the still-open screen.
      response = { status: "ready", timeZone: "Europe/Athens", latest: summaryOf("Pass Scylla", 12), dismissedAt: null };
      await act(async () => { timers[1]!.run(); });
      await flush();
      expect(view.container.textContent).toContain("Pass Scylla");
      cleanup();
    } finally { spy.mockRestore(); }
  });

  test("the digest card refetches after a first zone report and shows this client's new Actions", async () => {
    const summary = { generatedAt: 2, slotAt: 1, timeZone: "Europe/Athens", updates: [],
      waiting: [{ episodeId: "raft#1", itemId: "raft", threadId: "ogygia", title: "Build the raft before the swell?" }] };
    let zoneKnown = false;
    const requests: string[] = [];
    const api = {
      activityDigest: async (clientId?: string) => {
        requests.push(clientId ?? "");
        return { digest: null, dismissedAt: 0, actions: zoneKnown
          ? { status: "ready", timeZone: "Europe/Athens", latest: summary, dismissedAt: null }
          : { status: "zone_required" } };
      },
      activityDigestDismiss: async () => ({ ok: true }),
      pushZone: async () => ({ ok: true, timeZone: "Europe/Athens" }),
    } as unknown as Parameters<typeof registration.reportNotificationZone>[0];
    const root = createBrainUiRoot({ api, storage: null });
    (globalThis as { Notification?: unknown }).Notification = undefined;
    const view = render(<BrainUiProvider root={root}><DigestCard /></BrainUiProvider>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(view.container.textContent).not.toContain("Waiting on you");
    zoneKnown = true;
    await act(async () => { await registration.reportNotificationZone(api); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(view.container.textContent).toContain("Build the raft before the swell?");
    // Both reads name this browser's persisted context.
    expect(requests).toHaveLength(2);
    expect(new Set(requests)).toEqual(new Set([registration.noticeClientId()]));
    cleanup();
  });
}
