/** Worker egress socket paths in a leaf, so the in-sandbox bootstraps load none of the host-side proxy. */
export const WORKER_EGRESS_DIR = "/run/brain-egress";
export const WORKER_EGRESS_SOCKET = `${WORKER_EGRESS_DIR}/proxy.sock`;
