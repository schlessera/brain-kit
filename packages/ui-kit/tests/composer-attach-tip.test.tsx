/**
 * The composer's attach trigger names its menu (#3045): `attachLabel` is the
 * accessible name and the tooltip paints the same string, `aria-hidden`, so a
 * screen reader hears it once. An inert trigger — no handler, or a dictating
 * composer — has neither. The tooltip's timing and touch gating are CSS, and
 * are proven in the browser (`conversation-controls.offline.tsx`).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer } from "../src/chrome/Composer.js";

const onAttach = () => {};
const tip = (html: string) => html.match(/<span class="bk-tip" data-composer-tip="" aria-hidden="true">([^<]*)<\/span>/)?.[1];

describe("Composer attach tooltip", () => {
  test("the default names the capture menu, and the tooltip paints that name", () => {
    const html = renderToStaticMarkup(<Composer onAttach={onAttach} />);
    expect(html).toContain('aria-label="Attach — photo, camera, files"');
    expect(tip(html)).toBe("Attach — photo, camera, files");
    expect(html).toContain("bk-tip-host");
  });

  test("attachLabel renames the trigger and its tooltip together", () => {
    const label = "Attach — live conversation, photo, camera, files";
    const html = renderToStaticMarkup(<Composer onAttach={onAttach} attachLabel={label} />);
    expect(html).toContain(`aria-label="${label}"`);
    expect(tip(html)).toBe(label);
  });

  test("an inert trigger has no name and no tooltip", () => {
    for (const html of [
      renderToStaticMarkup(<Composer />),
      renderToStaticMarkup(<Composer state="dictating" onAttach={onAttach} attachLabel="Attach — live conversation, photo, camera, files" />),
    ]) {
      expect(html).not.toContain("Attach —");
      expect(html).not.toContain("bk-tip");
    }
  });

  test("the microphone has no tooltip", () => {
    const html = renderToStaticMarkup(<Composer onMic={() => {}} />);
    expect(html).not.toContain("bk-tip");
  });
});
