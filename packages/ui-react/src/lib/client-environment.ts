import type { ClientEnvironment } from "@schlessera/brain-ui-sdk/protocol";

/**
 * What this browser can actually do, measured rather than guessed.
 *
 * The agent is told this so it stops offering things the device can't do —
 * "share that to WhatsApp" on a desktop with no share sheet, "take a photo of
 * it" on a machine with no camera, "I'll check where you are" with
 * geolocation unavailable. Every check is feature detection; nothing here
 * parses a user-agent string, which is both unreliable and a fingerprinting
 * surface we have no use for.
 *
 * Deliberately NOT included: anything that would prompt. Device presence is
 * read from enumerateDevices(), which reports KINDS without permission (labels
 * stay empty) — asking the reader for camera permission in order to write a
 * system prompt would be a hostile trade.
 */

/** Marks the element whose width is the actual reading column. */
export const READING_COLUMN_ATTR = "data-reading-column";

/** Cached device inventory; undefined until the async probe has answered once. */
let mediaKinds: { camera: boolean; microphone: boolean } | undefined;
let probing = false;
let deviceListenerBound = false;

/**
 * Ask which input devices exist. Cheap, permission-free, and async — so it is
 * primed in the background and read synchronously at send time. The first
 * message of a session may go out without the camera/mic facts rather than
 * blocking on a device enumeration.
 */
export async function primeClientEnvironment(force = false): Promise<void> {
  if ((mediaKinds && !force) || probing) return;
  if (typeof navigator === "undefined") return;
  const media = navigator.mediaDevices;
  if (!media || typeof media.enumerateDevices !== "function") return;
  probing = true;
  try {
    const devices = await media.enumerateDevices();
    mediaKinds = {
      camera: devices.some((d) => d.kind === "videoinput"),
      microphone: devices.some((d) => d.kind === "audioinput"),
    };
    // A headset plugged in (or a webcam unplugged) mid-conversation changes
    // the honest answer, so the cache follows the hardware.
    if (!deviceListenerBound && typeof media.addEventListener === "function") {
      deviceListenerBound = true;
      media.addEventListener("devicechange", () => void primeClientEnvironment(true));
    }
  } catch {
    // Enumeration blocked (permissions policy, older browser) — leave the
    // capability unreported rather than guessing it exists.
  } finally {
    probing = false;
  }
}

/** @internal Test seam — drops the cached device inventory. */
export function resetClientEnvironmentCache(): void {
  mediaKinds = undefined;
  probing = false;
  deviceListenerBound = false;
}

export function detectClientEnvironment(): ClientEnvironment | undefined {
  if (typeof window === "undefined" || typeof navigator === "undefined") return undefined;
  // Fire-and-forget: answers by the next message even if this one misses it.
  void primeClientEnvironment();

  const coarse = matches("(pointer: coarse)");
  const env: ClientEnvironment = { formFactor: formFactor(coarse) };

  if (coarse) env.touch = true;
  if (matches("(display-mode: standalone)") || matches("(display-mode: fullscreen)")) {
    env.standalone = true;
  }

  if (mediaKinds?.camera) env.camera = true;
  if (mediaKinds?.microphone) env.microphone = true;
  // getUserMedia and geolocation both require a secure context, which is also
  // what the location tool needs.
  if (navigator.geolocation && window.isSecureContext !== false) env.geolocation = true;

  if (typeof navigator.share === "function") {
    env.share = true;
    // canShare({files}) needs a real File to answer honestly; a 1-byte probe
    // is what the share paths themselves check before offering an image.
    try {
      const probe = new File([new Uint8Array(1)], "probe.png", { type: "image/png" });
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] })) {
        env.shareFiles = true;
      }
    } catch {
      // No File constructor / canShare threw — leave shareFiles unset.
    }
  }

  const column = readingColumnWidth();
  if (column) env.viewportWidth = column;

  // Both are re-validated server-side against the platform's own locale and
  // timezone databases; anything unrecognized is dropped there.
  const locale = navigator.language;
  if (locale && locale.length <= 35) env.locale = locale;
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && zone.length <= 64) env.timeZone = zone;
  } catch {
    // Intl unavailable — omit.
  }

  return env;
}

/**
 * Phone vs tablet from the SHORT edge of the screen, not from the current
 * window width: a phone in landscape is 900+px wide and would otherwise be
 * reported as a tablet, flipping the device description (and busting the
 * prompt cache) every time the reader rotates.
 */
function formFactor(coarse: boolean): ClientEnvironment["formFactor"] {
  if (!coarse) return "desktop";
  const w = window.screen?.width ?? window.innerWidth ?? 0;
  const h = window.screen?.height ?? window.innerHeight ?? 0;
  const shortEdge = w && h ? Math.min(w, h) : w || h;
  return shortEdge && shortEdge >= 600 ? "tablet" : "phone";
}

/**
 * Width of the column text actually renders into — the chat layout caps it far
 * below the window — rounded to 50px so that dragging a window edge does not
 * rewrite the system prompt (and invalidate its cache) on every message.
 */
function readingColumnWidth(): number | undefined {
  const el = document.querySelector(`[${READING_COLUMN_ATTR}]`);
  const measured =
    el?.getBoundingClientRect().width ||
    window.innerWidth ||
    document.documentElement?.clientWidth ||
    0;
  if (!measured) return undefined;
  return Math.max(50, Math.round(measured / 50) * 50);
}

function matches(query: string): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}
