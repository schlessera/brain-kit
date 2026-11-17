// `request_image_markup` in the app (#3975): the frame opens the editor, the
// layer is uploaded rather than sent on the socket, closing declines, and the
// transcript shows the receipt or the refusal in the result's own words.
import { unregisterImageMarkupDom } from "./image-markup-dom.js";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ServerMarkupRequest } from "@schlessera/brain-ui-sdk/protocol";
import type { ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { MARKUP_CLOSED, MARKUP_NOT_RENDERED, type MarkupExport } from "@schlessera/brain-ui-kit";

import { resolveToolRenderer } from "../../../ui-sdk/src/client/renderers.js";
import { registerBuiltinRenderers, GENERIC_RENDERER } from "../../src/components/chat/renderers";
import { ImageMarkupCard, ImageMarkupFallback } from "../../src/components/chat/tool-cards/image-markup-card.js";
import { MarkupEditorHost, uploadMarkupLayer } from "../../src/components/images/markup-editor.js";
import { dispatchServerMessage } from "../../src/hooks/websocket-handlers/index.js";
import type { DispatchContext } from "../../src/hooks/websocket-handlers/types.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { MarkupRequest } from "../../src/stores/markup-state.js";

afterEach(cleanup);
afterAll(unregisterImageMarkupDom);
beforeAll(() => registerBuiltinRenderers());

const payload = {
  imagePath: "photos/raft-at-ithaca.jpg",
  markupPath: ".brain/scratch/markup/raft-at-ithaca.3f9a1c2e.markup.png",
  width: 3024, height: 4032, bytes: 212 * 1024,
  marks: { pen: 0, arrow: 2, ellipse: 1, text: 1 },
  notes: ["move the raft here"],
  note: "Pass this layer to `brain image --ref <imagePath> --markup <markupPath>`.",
};
const call = (name: string, extra: Partial<ToolCallView> = {}): ToolCallView =>
  ({ id: "k1", name, input: { imagePath: payload.imagePath }, output: JSON.stringify(payload), ...extra });

const request: MarkupRequest = {
  requestId: "markup-6a7f0c52-1d8e-4b2a-9e3f-0c1d2e3f4a5b", imagePath: payload.imagePath, instruction: "mark what should move and where",
  width: 3024, height: 4032, maxBytes: 52_428_800, uploadPath: "/markup/markup-6a7f0c52-1d8e-4b2a-9e3f-0c1d2e3f4a5b",
  sourcePath: "/markup/markup-6a7f0c52-1d8e-4b2a-9e3f-0c1d2e3f4a5b/source", turnId: "raft-turn",
};
const layer: MarkupExport = {
  png: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }),
  bytes: 8, width: 3024, height: 4032, counts: { pen: 0, arrow: 2, ellipse: 1, text: 1 }, notes: ["move the raft here"],
};

describe("request_image_markup renderer", () => {
  test.each([
    ["request_image_markup", "pi"],
    ["mcp__brain-ui__request_image_markup", "claude"],
  ])("%s on %s resolves to the markup receipt", (name, backend) => {
    const renderer = resolveToolRenderer(call(name), backend);
    expect(renderer).not.toBe(GENERIC_RENDERER);
    expect(renderer?.label).toBe("Markup");
    expect(renderer?.summary?.(call(name))).toBe(payload.imagePath);
    expect(renderer?.meta?.(call(name))).toBe(`markup ${payload.markupPath}`);
  });

  test("the receipt states the drawing, the size match and the saved layer, drawn over the hatch", () => {
    const { getByText, container, queryByText } = render(<ImageMarkupCard {...payload} />);
    expect(getByText("Markup drawn")).toBeTruthy();
    expect(getByText("2 arrows · 1 ellipse · 1 note")).toBeTruthy();
    expect(getByText("“move the raft here”")).toBeTruthy();
    expect(getByText("3024 × 4032 px · matches source")).toBeTruthy();
    expect(getByText(`${payload.markupPath} · 212 KB`)).toBeTruthy();
    const overlay = container.querySelector("img[data-markup-overlay]") as HTMLImageElement;
    expect(overlay.getAttribute("src")).toContain(encodeURIComponent(payload.markupPath));
    expect(overlay.getAttribute("src")).toContain("raw=1");
    fireEvent.error(overlay);
    expect(queryByText(MARKUP_NOT_RENDERED)).toBeTruthy();
  });

  test("a closed editor or a refusal is stated from the result's own words", () => {
    const errored = call("request_image_markup", { output: MARKUP_CLOSED, isError: true });
    expect(resolveToolRenderer(errored, "pi")?.summary?.(errored)).toBeNull();
    const { container } = render(<ImageMarkupFallback tool={errored} />);
    expect(container.textContent).toBe(`no markup drawn on ${payload.imagePath} · ${MARKUP_CLOSED}`);
  });
});

describe("the markup editor's upload", () => {
  test("posts the layer and its summary as form data to the request's own route, with its turn", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    await uploadMarkupLayer({ apiBase: () => "/api", request: async (url, init) => { seen.push({ url, init }); return Response.json({ accepted: true }, { status: 202 }); } },
      request, layer);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`/api${request.uploadPath}?turnId=raft-turn`);
    expect(seen[0]!.init?.method).toBe("POST");
    const body = seen[0]!.init?.body as FormData;
    expect(JSON.parse(body.get("summary") as string)).toEqual({ marks: layer.counts, notes: layer.notes });
    expect((body.get("layer") as Blob).size).toBe(8);
  });

  test("a refused upload rejects with the server's own reason, which the editor shows", async () => {
    const refusing = { apiBase: () => "/api", request: async () => Response.json({ error: "markup_too_large", limit: 52_428_800,
      message: "This markup is 52428801 bytes; the limit is 52428800 bytes (50 MiB)." }, { status: 413 }) };
    await expect(uploadMarkupLayer(refusing, request, layer)).rejects.toThrow("the limit is 52428800 bytes (50 MiB)");
    const offline = { apiBase: () => "/api", request: async () => { throw new TypeError("network"); } };
    await expect(uploadMarkupLayer(offline, request, layer)).rejects.toThrow("could not be sent");
  });
});

describe("the markup editor's lifecycle", () => {
  let root: BrainUiRoot;
  beforeAll(() => { root = createBrainUiRoot({ storage: null, request: async () => Response.json({}) }); });

  test("a markup_request opens the editor at the server's size; closing it declines and closes", async () => {
    const frame: ServerMarkupRequest = { type: "markup_request", ...request, sessionId: "s1" };
    dispatchServerMessage(frame, { stores: root.stores } as unknown as DispatchContext);
    const opened = root.stores.markup.getState().request!;
    expect([opened.requestId, opened.width, opened.height, opened.uploadPath, opened.sourcePath, opened.turnId])
      .toEqual([request.requestId, 3024, 4032, request.uploadPath, request.sourcePath, "raft-turn"]);
    const declined: [string, string][] = [];
    const view = render(<BrainUiProvider root={root}><MarkupEditorHost onDecline={(r, message) => declined.push([r.requestId, message])} /></BrainUiProvider>);
    const close = await view.findByRole("button", { name: "Close" });
    await act(async () => { fireEvent.click(close); });
    expect(declined).toEqual([[request.requestId, MARKUP_CLOSED]]);
    expect(root.stores.markup.getState().request).toBeNull();
  });

  test("a second request waits behind the open one; each closes only itself", () => {
    const markup = () => root.stores.markup.getState();
    markup().open({ ...request, requestId: "markup-first" });
    markup().open({ ...request, requestId: "markup-second" });
    expect(markup().request?.requestId, "the open editor is not discarded").toBe("markup-first");
    markup().close("markup-second");
    expect(markup().request?.requestId).toBe("markup-first");
    markup().open({ ...request, requestId: "markup-second" });
    markup().close("markup-first");
    expect(markup().request?.requestId, "the waiting request opens next").toBe("markup-second");
    markup().close("markup-second");
    expect(markup().request).toBeNull();
  });
});
