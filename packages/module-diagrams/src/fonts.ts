import {readFileSync} from "node:fs";
/** Normal faces used by the shared diagram type roles; licensed, locked bytes. */
const faces=[{file:2,family:"JetBrains Mono",weight:400},{file:4,family:"JetBrains Mono",weight:600},{file:6,family:"Plus Jakarta Sans",weight:500},{file:7,family:"Plus Jakarta Sans",weight:600}] as const;
let cached:string|undefined;
export function diagramFontCss():string{
 return cached??=faces.map(face=>`@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight};src:url(data:font/ttf;base64,${readFileSync(new URL(`../assets/fonts/${face.file}.ttf`,import.meta.url)).toString("base64")}) format("truetype");}`).join("");
}
/** Data-only faces travel with SVG, so external viewers and raster output agree. */
export function embedDiagramFonts(svg:string):string{return svg.replace(/(<svg[^>]*>)/,`$1<style data-diagram-fonts="">${diagramFontCss()}</style>`);}
