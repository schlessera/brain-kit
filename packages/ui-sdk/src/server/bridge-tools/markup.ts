import {
  REQUEST_IMAGE_MARKUP_INPUT_SCHEMA,
  REQUEST_IMAGE_MARKUP_TOOL_NAME,
  type ImageMarkupPayload,
  type RequestImageMarkupInput,
} from "../../tool-contracts/index.js";
import type { BackendBridge } from "../backend.js";

/**
 * `request_image_markup` (#3975): the whole operation is the host's. It opens
 * the editor, receives the layer over its bounded upload route, writes it
 * under `.brain/scratch/markup/` and returns the receipt; the backend never
 * holds the layer's bytes and never names a destination. A host without that
 * route refuses, and there is no fallback writer to try instead.
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
 */
export async function handleRequestImageMarkup(
  input: RequestImageMarkupInput,
  bridge: Pick<BackendBridge, "requestImageMarkup">
): Promise<ImageMarkupPayload> {
  if (!bridge.requestImageMarkup) {
    throw new Error(`The host does not support ${REQUEST_IMAGE_MARKUP_TOOL_NAME} in this session.`);
  }
  return bridge.requestImageMarkup(REQUEST_IMAGE_MARKUP_INPUT_SCHEMA.parse(input));
}
