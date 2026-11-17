import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { body, captureOffline, history, identical, main, messages, pairs, system, type Captures } from "../../../tests/helpers/provider-history.js";
import { LOG_FACT, PERMIT_FACT } from "../../ui-server/tests/fixtures/attachment-host-fixture.js";

let captures: Captures & { attachmentOutcome?: { calls: string[][]; ids: string[] } };
beforeAll(async () => { captures = await captureOffline(join(import.meta.dir, "fixtures/provider-history-attachment-probe.ts")) as typeof captures; }, 180_000);

// #3154: a native Pi worker reads attachments through read_attachment over the
// worker pipe; the host's production reader and PDF extractor answer. The fact
// only the PDF's second page states reaches the provider through the tool
// output, never through the first message, and a later turn rereads it.
// Tools, instructions and every earlier input item stay byte-identical.
test("Pi reads a PDF page and a text original on demand, with tools, instructions and history stable", () => {
  const capture = captures.attachment!, outcome = captures.attachmentOutcome!;
  const [permit, log] = outcome.ids;
  expect(capture.sessions).toHaveLength(3);
  expect(new Set(capture.sessions).size).toBe(1);
  expect(main(capture).map(e => e.turn), "READ_ATTACHMENT_PI_EVERY_TURN_READS").toEqual([0, 0, 1, 1, 2, 2]);
  expect(capture.calls, "READ_ATTACHMENT_PI_HOST_RECEIVES_PARSED_INPUT").toEqual([{ id: permit, pages: "2" }, { id: log }, { id: permit, pages: "2" }]);
  expect(outcome.calls, "READ_ATTACHMENT_PI_HOST_RECORDS_READS").toEqual([[permit, "read"], [log, "read"], [permit, "read"]]);
  const first = JSON.stringify(messages(main(capture)[0]!));
  expect(first).toContain("<brain-attachments>");
  expect(first).toContain(permit);
  expect(first).toContain("Call read_attachment with an id");
  expect(first, "READ_ATTACHMENT_PI_ABSENT_AT_SEND").not.toContain(PERMIT_FACT);
  expect(first).not.toContain(LOG_FACT);
  const results = main(capture).filter((_, index) => index % 2 === 1);
  const latest = results.map(exchange => JSON.stringify(messages(exchange).at(-1)));
  const earlier = results.map(exchange => JSON.stringify(messages(exchange).slice(0, -1)));
  expect(latest[0], "READ_ATTACHMENT_PI_FACT_VIA_TOOL").toContain(PERMIT_FACT);
  expect(earlier[0]).not.toContain(PERMIT_FACT);
  expect(latest[1], "READ_ATTACHMENT_PI_TEXT_VIA_TOOL").toContain(LOG_FACT);
  expect(latest[2], "READ_ATTACHMENT_PI_LATER_TURN_REREAD").toContain(PERMIT_FACT);
  expect(latest[0]).toContain("attachment-data-");
  for (const [a, b] of pairs(capture)) {
    identical(body(a).tools, body(b).tools, "READ_ATTACHMENT_PI_TOOLS_STABLE");
    identical(system(a), system(b), "READ_ATTACHMENT_PI_INSTRUCTIONS_STABLE");
    history(a, b);
  }
  expect(body(main(capture)[0]!).tools.map((tool: { name: string }) => tool.name)).toContain("read_attachment");
});
