/**
 * A caller-drawn mic in the composer (#3727): `micControl` takes the mic slot
 * of the `send` and `plain` field, and the kit mic's own props (`mic`,
 * `onMic`, `micLabel`, `micTip`, `micUnavailable`) no longer apply. Without
 * it the composer is the one it always was, which the visual baselines prove
 * pixel for pixel; this file holds the markup half, so a default composer that
 * picked up the last-line alignment fails here by name.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer } from "../src/chrome/Composer.js";
import { MicButton } from "../src/voice/MicButton.js";

const noop = () => {};
const labels = (html: string) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
const fieldStyle = (html: string) => html.match(/<div style="([^"]*)" class="bk-field">/)?.[1] ?? "";
const mic = <MicButton name="Dictate" onClick={noop} onTalkLive={noop} />;

describe("Composer micControl", () => {
  test("absent, the field centres its controls and nothing is lifted", () => {
    for (const html of [
      renderToStaticMarkup(<Composer onAttach={noop} onMic={noop} onSend={noop} />),
      renderToStaticMarkup(<Composer state="streaming" onAttach={noop} onMic={noop} onStop={noop} />),
      renderToStaticMarkup(<Composer variant="plain" />),
      renderToStaticMarkup(<Composer micControl={null} onAttach={noop} onMic={noop} onSend={noop} />),
    ]) {
      expect(fieldStyle(html)).toContain("align-items:center");
      expect(html).not.toContain("margin-bottom");
      expect(html).not.toContain("data-composer-mic");
    }
  });

  test("set, the caller's mic replaces the kit's, and the kit mic's props are ignored", () => {
    for (const html of [
      renderToStaticMarkup(<Composer micControl={mic} onAttach={noop} onMic={noop} micLabel="Record on this device" onSend={noop} />),
      renderToStaticMarkup(<Composer micControl={mic} mic={false} onAttach={noop} onSend={noop} />),
      renderToStaticMarkup(<Composer micControl={mic} micTip micUnavailable="Dictation isn’t set up on this host." onAttach={noop} onSend={noop} />),
    ]) {
      expect(labels(html)).toEqual(["Attach — photo, camera, files", "Ask your brain anything…", "Dictate", "Send"]);
      expect(html).toContain("Talk live…");
      expect(html).toContain('<span data-composer-mic="" style="display:flex;flex:none;margin-block:-4px">');
    }
  });

  test("set, the field aligns to its last line and centres the 28px controls and the text on the mic", () => {
    const html = renderToStaticMarkup(<Composer micControl={mic} value={"two\nlines"} onChange={noop} onAttach={noop} onSend={noop} />);
    expect(fieldStyle(html)).toContain("align-items:flex-end");
    // (36 - 28) / 2 for attach and Send; (36 - 13.5 × 1.45) / 2 for the text's last line.
    expect(html.match(/margin-bottom:4px/g)).toHaveLength(2);
    expect(html).toContain("margin:0 0 8.2125px");
  });

  test("set while streaming, Stop sits on the last line as Send would", () => {
    const html = renderToStaticMarkup(<Composer state="streaming" micControl={mic} onStop={noop} />);
    expect(html).toContain('aria-label="Stop generating"');
    expect(html.match(/margin-bottom:4px/g)).toHaveLength(2);
  });

  test("the voice variant keeps its own hold-to-talk disc", () => {
    const html = renderToStaticMarkup(<Composer variant="voice" micControl={mic} onMic={noop} />);
    expect(html).not.toContain("data-composer-mic");
    expect(labels(html)).toContain("Hold to talk");
    expect(fieldStyle(html)).toContain("align-items:center");
  });
});
