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
      env: { ...process.env, [CHILD_MARKER]: "1" },
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
    expect(`${stdout}${stderr}`).toMatch(/\b4 pass\b/);
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
    const zones: Array<{ timeZone: string; endpoint?: string }> = [];
    const subscribes: Array<{ label?: string; timeZone?: string }> = [];
    const api = {
      pushZone: async (timeZone: string, endpoint?: string) => {
        zones.push({ timeZone, ...(endpoint !== undefined ? { endpoint } : {}) });
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

  function grantPush(endpoint: string) {
    (globalThis as { Notification?: unknown }).Notification = { permission: "granted" };
    const subscription = { endpoint, options: { applicationServerKey: null }, toJSON: () => ({ endpoint }) };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription } }) },
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
    await registration.reportNotificationZone(api);
    grantPush("https://push.example.test/odysseus-phone");
    await registration.reportNotificationZone(api);
    expect(zones).toEqual([
      { timeZone: "Europe/Athens" },
      { timeZone: "Europe/Athens", endpoint: "https://push.example.test/odysseus-phone" },
    ]);
    await registration.rebindPushSubscriptionAfterLogin(api);
    expect(subscribes.map((s) => s.timeZone)).toEqual(["Europe/Athens"]);
  });

  test("an unavailable zone is reported as unusable rather than omitted", async () => {
    const { api, zones } = fakeApi();
    (globalThis as { Notification?: unknown }).Notification = undefined;
    zone = "";
    await registration.reportNotificationZone(api);
    expect(zones).toEqual([{ timeZone: "" }]);
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
