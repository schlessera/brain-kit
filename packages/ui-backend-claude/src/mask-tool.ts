import { mkdirSync, writeFileSync } from "fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "path";

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * `request_image_mask` — in-process MCP tool that asks the user to paint over
 * part of an image.
 *
 * A mask is a person pointing at a region, so there is no server-side
 * substitute for it: the handler emits a `mask_request` over the wire protocol,
 * the browser opens a canvas on the image, and the painted PNG comes back. Same
 * bridge shape as `get_current_location`, for the same reason.
 *
 * The mask is written next to its image and the path returned, because the
 * thing that consumes it is `brain image --mask <path>`, which reads from disk.
 */

/** Bridges the tool to the host's mask provider (`BackendBridge.requestMask`). */
export type MaskHandler = (imagePath: string, instruction?: string) => Promise<Uint8Array>;

/** Repo-relative path, contained — a tool argument must not escape the brain. */
function safeJoin(root: string, rel: string): string | null {
  if (rel.includes("\0") || isAbsolute(rel)) return null;
  const abs = resolve(root, rel);
  const rootResolved = resolve(root);
  return abs === rootResolved || abs.startsWith(rootResolved + sep) ? abs : null;
}

export function createMaskTool(handler: MaskHandler, brainPath: string) {
  return tool(
    "request_image_mask",
    [
      "Ask the user to mark the region of an image that should change, by painting over it in their browser.",
      "Use before editing part of an image — replacing an object, changing a background, removing something — when which region is meant is the user's call rather than yours. Writes a mask PNG next to the image and returns its path, which you then pass to `brain image --mask <path>` along with the image as `--ref`.",
      "The user may decline, in which case this returns an error: fall back to describing the change in words instead of retrying.",
      "Only mask-capable models accept it (OpenAI's image models); `brain image` routes there automatically when a mask is present.",
    ].join("\n"),
    {
      imagePath: z
        .string()
        .describe("Repo-relative path of the image to mark up, e.g. assets/images/house.png"),
      instruction: z
        .string()
        .optional()
        .describe(
          "What you intend to change, shown to the user as guidance while they paint, e.g. 'mark the sky'"
        ),
    },
    async (args) => {
      const imageAbs = safeJoin(brainPath, args.imagePath);
      if (!imageAbs) {
        return {
          content: [{ type: "text" as const, text: `Path escapes the brain: ${args.imagePath}` }],
          isError: true,
        };
      }
      try {
        const png = await handler(args.imagePath, args.instruction);
        const base = args.imagePath.slice(0, args.imagePath.length - extname(args.imagePath).length);
        const maskRel = `${base}-mask.png`;
        const maskAbs = safeJoin(brainPath, maskRel);
        if (!maskAbs) {
          return {
            content: [{ type: "text" as const, text: `Cannot write a mask for ${args.imagePath}` }],
            isError: true,
          };
        }
        mkdirSync(dirname(maskAbs), { recursive: true });
        writeFileSync(maskAbs, png);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  maskPath: relative(brainPath, maskAbs).split(sep).join("/"),
                  imagePath: args.imagePath,
                  bytes: png.byteLength,
                  note: "Transparent pixels mark the editable region. Pass this to `brain image --mask`, with the image as `--ref`.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: (e as Error).message }],
          isError: true,
        };
      }
    }
  );
}

export const MASK_TOOL_NAME = "mcp__brain-ui__request_image_mask";
