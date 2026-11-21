/** Concrete journal/scope/relay wiring, outside the public WsHost.journal type. */
interface JournalInference {
  flushDeferred(): Promise<void>;
  relayStarted(turnId: string, transport: { eligible(): boolean; allowed(): boolean }, signal: AbortSignal): () => void;
  routes(turnId: string, paths: readonly string[]): void;
  requestStarted(turnId: string): {
    prepare(path: string, body: Uint8Array): Promise<boolean>;
    dispatch(): boolean;
    responseReady(): Promise<boolean>;
    close(): void;
  };
  settleScope?: () => Promise<void>;
}
const journals = new WeakMap<object, JournalInference>();
export function retainJournalInference(journal: object, control: JournalInference): void { journals.set(journal, control); }
export function journalInference(journal: object): JournalInference | undefined { return journals.get(journal); }
