/**
 * The composer's optional status slot (#3155): the app's compact
 * `StatusIndicator` beside Attach. Omitted, the row renders exactly as
 * before; present, it sits between the attach trigger and the field in a
 * 44px box that takes a 28px place, so the field keeps its height.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer } from "../src/chrome/Composer.js";

const noop = () => {};
const status = <span data-odysseus-status="">⏳</span>;

describe("Composer status slot", () => {
  test("omitted: the row is unchanged", () => {
    const html = renderToStaticMarkup(<Composer onAttach={noop} onSend={noop} value="Ask Aeolus." />);
    expect(html).not.toContain("data-composer-status");
  });

  test("present: attach, then the status, then the field", () => {
    const html = renderToStaticMarkup(<Composer onAttach={noop} onSend={noop} value="Ask Aeolus." status={status} />);
    const attach = html.indexOf('aria-label="Attach');
    const slot = html.indexOf("data-composer-status");
    const field = html.indexOf("<textarea");
    expect(attach).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(attach);
    expect(field).toBeGreaterThan(slot);
    expect(html).toContain("data-odysseus-status");
    // 44px, with -8px margins: a 28px place in the row, like the icons beside it.
    expect(html).toMatch(/data-composer-status="" style="[^"]*width:44px;height:44px;margin:-8px/);
  });

  test("a plain surface draws no status", () => {
    const html = renderToStaticMarkup(<Composer variant="plain" status={status} />);
    expect(html).not.toContain("data-composer-status");
  });
});
