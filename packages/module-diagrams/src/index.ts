export { default as manifest, configSchema, type DiagramsConfig } from "./module.js";

export { diagramSpecSchema, diagramSpecJsonSchema, type DiagramSpec } from "./spec.js";
export { checkDiagram, type DiagramCheckResult, type DiagramFinding } from "./check.js";

export { buildDiagram, DiagramGeometryError, type DiagramTree, type DiagramElement, type DiagramGeometryOptions, type DiagramGeometryFinding, type DiagramPoint, type DiagramBox, type DiagramSide, type DiagramPort, type DiagramBridge, type DiagramConnector, type DiagramLabelMask, type DiagramEdgeLabel, type DiagramNode, type DiagramGroup } from "./geometry.js";

export { DIAGRAM_PALETTE, DIAGRAM_TOKEN_CSS, DIAGRAM_TYPE, type DiagramTheme, type DiagramTypeStyle, type DiagramTypeRole, typeWidthBudget, fitDiagramText, diagramNodePaint, diagramEdgePaint, contrastRatio, checkDiagramSkin, diagramInkRamp, type DiagramPaint, type DiagramEdgePaint, type DiagramSkinFinding } from "./skin.js";
export { diagramLayout, buildDiagramLayout, checkDiagramLayouts, type DiagramLayoutFinding } from "./layout.js";
