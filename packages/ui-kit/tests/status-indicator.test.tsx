import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StatusIndicator, type StatusIndicatorOperation, type StatusIndicatorState } from "../src/index.js";
import { statusIndicatorLead } from "../src/chrome/StatusIndicator.js";

const op = (id: string, state: StatusIndicatorState, stateLabel = `${id} ${state}`): StatusIndicatorOperation => ({ id, state, stateLabel });
const render = (operations: StatusIndicatorOperation[]) => renderToStaticMarkup(
  <StatusIndicator label="Draft" summary="Odysseus's raft list is being saved." title="Draft status" operations={operations} />);

test("the approved priority is refused, failed, unknown, attention, active, queued, success, idle", () => {
  const order: StatusIndicatorState[] = ["refused", "failed", "unknown", "attention", "active", "queued", "success", "idle"];
  for (let i = 0; i < order.length; i++) {
    const operations = order.slice(i).reverse().map((state, n) => op(`op-${n}`, state));
    expect(statusIndicatorLead(operations)?.state, `lead of ${order.slice(i).join(",")}`).toBe(order[i]);
  }
  // Ties keep the first operation in the consumer's order.
  expect(statusIndicatorLead([op("a", "failed"), op("b", "failed")])?.id).toBe("a");
  expect(statusIndicatorLead([])).toBeUndefined();
});

test("each state has its own existing glyph, tone and accessible name", () => {
  const glyphs = new Set<string>();
  const expected: Record<StatusIndicatorState, string> = { active: "amber", queued: "neutral", success: "teal", attention: "gold", unknown: "gold", failed: "red", refused: "red", idle: "neutral" };
  for (const [state, tone] of Object.entries(expected) as [StatusIndicatorState, string][]) {
    const html = render([op("raft", state, `Raft ${state}`)]);
    expect(html).toContain(`data-status-indicator="${state}"`);
    expect(html).toContain(`data-tone="${tone}"`);
    expect(html).toContain(`aria-label="Draft: Raft ${state}. Details."`);
    glyphs.add(html.match(/<svg[^>]*class="([^"]+)"/)![1]!);
  }
  expect(glyphs.size, "eight distinct glyphs").toBe(8);
});

test("unknown never renders the success glyph", () => {
  const unknown = render([op("raft", "unknown", "Couldn't confirm the draft was saved")]);
  const success = render([op("raft", "success", "Saved")]);
  expect(unknown).toContain("lucide-circle-dashed");
  expect(unknown).not.toContain("lucide-circle-check");
  expect(success).toContain("lucide-circle-check");
});

test("a native named control with no native title, no details or actions until opened", () => {
  const html = renderToStaticMarkup(<StatusIndicator label="Chat deletions" summary="One removal is unconfirmed." title="Chat deletions"
    operations={[{ ...op("del-1", "unknown", "Couldn't confirm removal"), facts: [{ key: "Requested", value: "12 Jul 2026, 09:14" }], actions: <button type="button">Check now</button> }]} />);
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain('type="button"');
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("title=");
  expect(html).not.toContain("Check now");
  expect(html).not.toContain("12 Jul 2026");
  expect(html.match(/aria-live/g)).toHaveLength(1);
});

test("two or more operations show a count; one does not", () => {
  expect(render([op("a", "failed")])).not.toContain("bk-status-count");
  const html = render([op("a", "success"), op("b", "failed", "Retry needed"), op("c", "active")]);
  expect(html).toContain('data-status-indicator="failed"');
  expect(html).toContain('<span class="bk-status-count" aria-hidden="true">3</span>');
  expect(html).toContain('aria-label="Draft: Retry needed; 3 operations. Details."');
});

test("an empty list reserves the slot without a control and is never success", () => {
  const html = render([]);
  expect(html).toContain('data-status-indicator="empty"');
  expect(html).toContain("bk-status-indicator-slot");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("lucide-circle-check");
});

test("announce={false} renders no live region, for a consumer that announces the change itself (#3155)", () => {
  expect(render([op("raft", "failed")])).toContain("data-status-live");
  const quiet = renderToStaticMarkup(<StatusIndicator label="Message 1 of 1" summary="Not sent" title="Unsent message" announce={false} operations={[op("raft", "failed", "Not sent")]} />);
  expect(quiet).not.toContain("data-status-live");
  expect(quiet).not.toContain("aria-live");
  expect(quiet).toContain('aria-label="Message 1 of 1: Not sent. Details."');
});
