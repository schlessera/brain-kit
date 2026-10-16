import type { DiagramSpec } from "../../src/spec.js";
export function node(id: string, x: number, y: number, width = 148, height = 64) { return { id, label: id === "raft" ? "Odysseus's raft" : id === "ithaca" ? "Ithaca" : "Athena's relay", at: [x, y] as [number, number], size: [width, height] as [number, number] }; }
export function spec(nodes: ReturnType<typeof node>[], edges: { id?: string; from: string; to: string; label?: string; kind?: "primary" | "default" | "async" }[], size: "doc-inline" | "doc-wide" = "doc-inline"): DiagramSpec { return { schema_version: 1, type: "architecture", title: "The homecoming relay", desc: "Odysseus sends word through Athena to Ithaca.", size, nodes, edges }; }
export const cases = {
  orthogonal: spec([node("raft", 40, 40), node("ithaca", 600, 320)], [{ from: "raft", to: "ithaca", label: "WORD" }]),
  vertical: spec([node("raft", 300, 40), node("ithaca", 300, 380)], [{ from: "raft", to: "ithaca", label: "WORD" }]),
  fan: spec([node("raft", 40, 160), node("athena", 600, 40), node("ithaca", 600, 320)], [{ from: "raft", to: "athena" }, { from: "raft", to: "ithaca" }]),
  trunk: spec([node("raft", 40, 40), node("athena", 40, 240), node("ithaca", 640, 360), node("penelope", 640, 160)], [{ from: "raft", to: "ithaca" }, { from: "athena", to: "penelope" }]),
  closeParallel: spec([node("raft", 148, 144, 96), node("athena", 588, 184, 96), node("penelope", 108, 372, 96), node("ithaca", 548, 380, 96)], [{ from: "raft", to: "ithaca" }, { from: "penelope", to: "athena" }, { from: "raft", to: "athena" }]),
  crossing: spec([node("raft", 40, 240, 96), node("ithaca", 720, 240, 96), node("athena", 400, 40, 96), node("penelope", 400, 440, 96)], [{ from: "raft", to: "ithaca", kind: "primary" }, { from: "athena", to: "penelope", kind: "async" }]),
  intervening: spec([node("raft", 40, 160), node("ithaca", 600, 160), node("athena", 300, 140, 160, 104)], [{ from: "raft", to: "ithaca", label: "WORD" }]),
  mask: spec([node("raft", 40, 120), node("ithaca", 600, 120), node("athena", 360, 104, 80, 40)], [{ from: "raft", to: "ithaca", label: "WORD" }]),
  small: spec([node("raft", 40, 160, 148, 40), node("athena", 600, 40), node("ithaca", 600, 320)], [{ from: "raft", to: "athena" }, { from: "raft", to: "ithaca" }]),
  transit: spec([node("raft", 40, 200), node("ithaca", 600, 200), node("athena", 280, 0, 80, 600)], [{ from: "raft", to: "ithaca", label: "WORD" }]),
  panels: spec([node("raft", 40, 40), node("athena", 300, 40), node("penelope", 440, 40), node("ithaca", 700, 40)], [{ from: "raft", to: "athena", label: "WORD" }, { from: "penelope", to: "ithaca", label: "WORD" }], "doc-wide"),
};
