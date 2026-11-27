/** Storage maintenance bounds, shared by the host and its write procedures (#4818). */
export const STORAGE_MAINTENANCE_LIMITS = Object.freeze({ receipts: 1024, receiptBytes: 65_536, items: 200, milliseconds: 300_000 });
