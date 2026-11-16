/**
 * The established fictional example: Odysseus's raft in Ithaca harbour,
 * `photos/raft-at-ithaca.jpg`, 3024 × 4032 after EXIF orientation 6. Drawn
 * as SVG so the stories need no network and no binary fixture.
 */
import type { Mark } from "../../src/images/markup.js";

export const RAFT_PATH = "photos/raft-at-ithaca.jpg";
export const RAFT_SIZE = { width: 3024, height: 4032 };

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3024" height="4032" viewBox="0 0 3024 4032">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb8d8"/><stop offset="1" stop-color="#e9d9b8"/></linearGradient>
<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f6f8f"/><stop offset="1" stop-color="#16384d"/></linearGradient></defs>
<rect width="3024" height="1900" fill="url(#sky)"/>
<path d="M0 1700 L700 1250 L1300 1600 L2000 1150 L3024 1650 L3024 1900 L0 1900 Z" fill="#6d7f5a"/>
<rect y="1900" width="3024" height="2132" fill="url(#sea)"/>
<g fill="#9b7448" stroke="#5b3f22" stroke-width="18"><rect x="900" y="2900" width="1250" height="260" rx="30"/></g>
<rect x="1480" y="1900" width="40" height="1010" fill="#5b3f22"/>
<path d="M1520 1960 L2250 2700 L1520 2700 Z" fill="#efe6d2" stroke="#b8a888" stroke-width="12"/>
</svg>`;
export const RAFT_SRC = `data:image/svg+xml,${encodeURIComponent(svg)}`;

export const RAFT_MARKS: Mark[] = [
  { id: "s1", kind: "ellipse", color: "red", width: "medium", x: 1450, y: 1900, w: 900, h: 900 },
  { id: "s2", kind: "arrow", color: "yellow", width: "medium", from: { x: 2300, y: 3300 }, to: { x: 1700, y: 3100 } },
  { id: "s3", kind: "arrow", color: "red", width: "thick", from: { x: 600, y: 3600 }, to: { x: 950, y: 3200 } },
  { id: "s4", kind: "pen", color: "cyan", width: "thin", points: [
    { x: 400, y: 2400 }, { x: 600, y: 2300 }, { x: 800, y: 2450 }, { x: 1000, y: 2350 }, { x: 1150, y: 2450 },
  ] },
  { id: "s5", kind: "text", color: "red", at: { x: 1900, y: 1750 }, text: "make the sail red" },
  { id: "s6", kind: "text", color: "yellow", at: { x: 1700, y: 3500 }, text: "move the raft here" },
];

/** The same scene at a quarter of the size, for stories that encode the layer:
 * a 12-megapixel PNG takes a hosted runner seconds to measure (#4098). */
export const RAFT_QUARTER_SIZE = { width: RAFT_SIZE.width / 4, height: RAFT_SIZE.height / 4 };
export const RAFT_QUARTER_MARKS: Mark[] = RAFT_MARKS.map(mark => {
  const q = (p: { x: number; y: number }) => ({ x: p.x / 4, y: p.y / 4 });
  if (mark.kind === "pen") return { ...mark, points: mark.points.map(q) };
  if (mark.kind === "arrow") return { ...mark, from: q(mark.from), to: q(mark.to) };
  if (mark.kind === "ellipse") return { ...mark, x: mark.x / 4, y: mark.y / 4, w: mark.w / 4, h: mark.h / 4 };
  return { ...mark, at: q(mark.at) };
});
