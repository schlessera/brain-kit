export { default as manifest, configSchema, type DiagramsConfig } from "./module.js";

export { diagramSpecSchema, diagramSpecJsonSchema, type DiagramSpec } from "./spec.js";
export { checkDiagram, type DiagramCheckResult, type DiagramFinding } from "./check.js";

export { buildDiagram, DiagramGeometryError, type DiagramTree, type DiagramElement, type DiagramGeometryOptions, type DiagramGeometryFinding, type DiagramPoint, type DiagramBox, type DiagramSide, type DiagramPort, type DiagramBridge, type DiagramConnector, type DiagramLabelMask, type DiagramEdgeLabel, type DiagramNode, type DiagramGroup } from "./geometry.js";
