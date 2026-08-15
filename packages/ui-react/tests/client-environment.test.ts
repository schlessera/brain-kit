import { afterEach, describe, expect, test } from "bun:test";
import {
  detectClientEnvironment,
  primeClientEnvironment,
  resetClientEnvironmentCache,
  READING_COLUMN_ATTR,
} from "../src/lib/client-environment.js";

/**
 * The detector reads globals directly (that IS the API surface it measures),
 * so the tests install fake ones. Each case describes a real device rather
 * than a flag combination — the point of the module is that a phone, a tablet
 * and a desktop come out looking different.
 */
function install(opts: {
  queries?: string[];
  width?: number;
  /** Physical screen, which is what the phone/tablet split reads. */
  screen?: { width: number; height: number };
  columnWidth?: number;
  devices?: MediaDeviceInfo["kind"][];
  geolocation?: boolean;
  share?: boolean;
  canShareFiles?: boolean;
  locale?: string;
}) {
  const queries = new Set(opts.queries ?? []);
  const width = opts.width ?? 1440;
  (globalThis as Record<string, unknown>).window = {
    innerWidth: width,
    isSecureContext: true,
    screen: opts.screen ?? { width, height: 900 },
    matchMedia: (q: string) => ({ matches: queries.has(q) }),
  };
  (globalThis as Record<string, unknown>).document = {
    documentElement: { clientWidth: width },
    querySelector: (sel: string) =>
      sel === `[${READING_COLUMN_ATTR}]` && opts.columnWidth
        ? { getBoundingClientRect: () => ({ width: opts.columnWidth }) }
        : null,
  };
  (globalThis as Record<string, unknown>).navigator = {
    language: opts.locale ?? "en-GB",
    ...(opts.devices
      ? {
          mediaDevices: {
            getUserMedia: () => {},
            enumerateDevices: async () => opts.devices!.map((kind) => ({ kind })),
          },
        }
      : {}),
    ...(opts.geolocation ? { geolocation: {} } : {}),
    ...(opts.share ? { share: () => {}, canShare: () => opts.canShareFiles === true } : {}),
  };
}

afterEach(() => {
  for (const key of ["window", "document", "navigator"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
  // The device inventory is cached module-wide (one page = one device); each
  // test installs a different machine, so drop it between them.
  resetClientEnvironmentCache();
});

describe("detectClientEnvironment", () => {
  test("an installed phone PWA reports touch, standalone and its capabilities", async () => {
    install({
      queries: ["(pointer: coarse)", "(display-mode: standalone)"],
      width: 390,
      screen: { width: 390, height: 844 },
      devices: ["videoinput", "audioinput"],
      geolocation: true,
      share: true,
      canShareFiles: true,
    });
    await primeClientEnvironment();
    expect(detectClientEnvironment()).toEqual({
      formFactor: "phone",
      touch: true,
      standalone: true,
      camera: true,
      microphone: true,
      geolocation: true,
      share: true,
      shareFiles: true,
      viewportWidth: 400,
      locale: "en-GB",
      timeZone: expect.any(String),
    });
  });

  test("a phone in landscape is still a phone", () => {
    // 932px wide with a coarse pointer — classifying on window width would
    // flip the reported device (and the system prompt) on every rotation.
    install({
      queries: ["(pointer: coarse)"],
      width: 932,
      screen: { width: 430, height: 932 },
    });
    expect(detectClientEnvironment()?.formFactor).toBe("phone");
  });

  test("a coarse pointer on a genuinely large screen is a tablet", () => {
    install({
      queries: ["(pointer: coarse)"],
      width: 1024,
      screen: { width: 820, height: 1180 },
    });
    expect(detectClientEnvironment()?.formFactor).toBe("tablet");
  });

  test("reports the reading column, not the window, rounded for cache stability", () => {
    install({ width: 1440, columnWidth: 766 });
    expect(detectClientEnvironment()?.viewportWidth).toBe(750);
    install({ width: 1440, columnWidth: 768 });
    expect(detectClientEnvironment()?.viewportWidth).toBe(750);
  });

  test("a camera-less desktop does not claim a camera", async () => {
    install({ width: 1440, devices: ["audioinput"] });
    await primeClientEnvironment();
    const env = detectClientEnvironment();
    expect(env?.camera).toBeUndefined();
    expect(env?.microphone).toBe(true);
  });

  test("a desktop reports no touch and omits absent capabilities entirely", () => {
    install({ width: 1440 });
    const env = detectClientEnvironment();
    expect(env?.formFactor).toBe("desktop");
    expect(env?.touch).toBeUndefined();
    expect(env?.share).toBeUndefined();
    expect(env?.camera).toBeUndefined();
    expect(env?.geolocation).toBeUndefined();
  });

  test("a share sheet that refuses files is reported as share-without-files", () => {
    install({ width: 1440, share: true, canShareFiles: false });
    const env = detectClientEnvironment();
    expect(env?.share).toBe(true);
    expect(env?.shareFiles).toBeUndefined();
  });

  test("an over-long locale is dropped (the server re-validates the rest)", () => {
    install({ width: 1440, locale: "x".repeat(64) });
    expect(detectClientEnvironment()?.locale).toBeUndefined();
  });

  test("returns undefined without a DOM (SSR / tests)", () => {
    expect(detectClientEnvironment()).toBeUndefined();
  });
});
