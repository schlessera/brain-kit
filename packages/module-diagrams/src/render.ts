import type { StaticRendererPack, ContentRendererTheme } from "@schlessera/brain-ui-sdk/render";
import { DIAGRAM_DRAWING_CSS } from "./drawing-style.js";
import { DIAGRAM_TOKEN_CSS } from "./skin.js";
import { diagramSvgModel, parseDiagram, escapeSvg, serializePrimitive } from "./svg-model.js";

/** Browser-free, data-only SVG. Static output has no interactive links. */
export async function toStatic(source: string, options: { theme: ContentRendererTheme; path?: string }): Promise<string> {
 if (!["light","dark","print"].includes(options.theme)) throw Error("Unknown diagram theme");
 const spec=parseDiagram(source), model=diagramSvgModel(spec), {width,height}=model.tree.viewBox;
 return `<svg xmlns="http://www.w3.org/2000/svg" class="bk-diagram" data-theme="${options.theme}" role="img" aria-label="${escapeSvg(spec.title)}" aria-description="${escapeSvg(spec.desc)}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><title>${escapeSvg(spec.title)}</title><desc>${escapeSvg(spec.desc)}</desc><style data-content-renderer-tokens="">${DIAGRAM_TOKEN_CSS}</style><style>${DIAGRAM_DRAWING_CSS}</style>${model.elements.map(serializePrimitive).join("")}</svg>`;
}
export const diagramsStaticPack: StaticRendererPack = {renderers:[{languages:["diagram"],extensions:[".diagram.yaml"],needsBrowser:false,toStatic}]};
export default diagramsStaticPack;
