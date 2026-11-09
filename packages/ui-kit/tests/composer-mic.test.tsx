/**
 * The composer's microphone props (#1012): `mic={false}` draws no microphone
 * in any variant, and `micLabel` names the control when the app's capture is
 * not dictation.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer } from "../src/chrome/Composer.js";

const onMic = () => {};
const labels = (html: string) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);

describe("Composer microphone", () => {
  test("a mic is drawn by default, named for dictation", () => {
    expect(labels(renderToStaticMarkup(<Composer onMic={onMic} />))).toContain("Dictate");
    expect(labels(renderToStaticMarkup(<Composer variant="voice" onMic={onMic} />))).toContain("Hold to talk");
    // The icon check below can see one: both variants draw the mic glyph.
    expect(renderToStaticMarkup(<Composer onMic={onMic} />)).toContain("lucide-mic");
    expect(renderToStaticMarkup(<Composer variant="voice" onMic={onMic} />)).toContain("lucide-mic");
  });

  test("micLabel renames it, in the send and the voice variant", () => {
    const html = renderToStaticMarkup(<Composer onMic={onMic} micLabel="Record on this device" />);
    expect(labels(html)).toContain("Record on this device");
    expect(labels(html)).not.toContain("Dictate");
    const voice = renderToStaticMarkup(<Composer variant="voice" onMic={onMic} micLabel="Record on this device" />);
    expect(labels(voice)).toContain("Record on this device");
    expect(labels(voice)).not.toContain("Hold to talk");
  });

  test("mic={false} draws none, in the send and the voice variant", () => {
    for (const variant of ["send", "plain", "voice"] as const) {
      const html = renderToStaticMarkup(<Composer variant={variant} onMic={onMic} mic={false} />);
      expect(labels(html), variant).not.toContain("Dictate");
      expect(labels(html), variant).not.toContain("Hold to talk");
      expect(html.includes("lucide-mic"), `${variant}: no mic icon`).toBe(false);
    }
  });

  test("micUnavailable keeps the mic named and focusable, aria-disabled, and described by its reason", () => {
    const reason = "Dictation isn't set up on this host.";
    for (const variant of ["send", "voice"] as const) {
      const html = renderToStaticMarkup(<Composer variant={variant} onMic={onMic} micUnavailable={reason} />);
      const mic = html.match(/<span[^>]*role="button"[^>]*aria-disabled="true"[^>]*>/)?.[0] ?? "";
      expect(mic, `${variant}: an aria-disabled button`).not.toBe("");
      expect(mic, `${variant}: still reachable by keyboard`).toContain('tabindex="0"');
      const described = mic.match(/aria-describedby="([^"]+)"/)?.[1];
      expect(described, `${variant}: described by its reason`).toBeTruthy();
      expect(html, `${variant}: the reason is the description`).toMatch(new RegExp(`id="${described}"[^>]*>${reason.replace("'", "&#x27;")}<`));
    }
    // Without a reason the mic is an ordinary control.
    expect(renderToStaticMarkup(<Composer onMic={onMic} />)).not.toContain("aria-disabled");
  });
});
