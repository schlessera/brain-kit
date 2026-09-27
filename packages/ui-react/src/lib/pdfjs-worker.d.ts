// pdf.js ships no types for its worker bundle. Only the handler the main-thread
// fallback registers is read from it (see ./pdf.ts).
declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs" {
  export const WorkerMessageHandler: unknown;
}
