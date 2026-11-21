/** Native managed-policy qualification; no model request may escape the production gate. */
process.env.REQUEST_SHAPE_MANAGED_GATEWAY = "1";
await import("./provider-request-shape-probe.js");
export {};
