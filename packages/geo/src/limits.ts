/**
 * The largest route or track input the parsers accept, in bytes. First-party
 * hosts share it so their own size checks agree with the parser's; it is
 * exported from `./internal`, not from the public entry (#1053).
 */
export const MAX_ROUTE_BYTES = 20 * 1024 * 1024;
