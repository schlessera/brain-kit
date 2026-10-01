// Observe real execution in an isolated CLI, with all adapter pages replaced
// by the existing network-denied fixture. A wrong selection remains observable.
import "./default-boards-preload.js";
import { writeFileSync } from "node:fs";
import { BaseAdapter } from "../../src/adapters/base.js";

const observed: string[] = [];
const scrape = BaseAdapter.prototype.scrape;
BaseAdapter.prototype.scrape = function (ctx, options) {
  observed.push(this.source);
  return scrape.call(this, ctx, options);
};
process.on("exit", () => {
  writeFileSync(process.env.JOBS_SELECTION_RECEIPT!, JSON.stringify({ observed }));
});
