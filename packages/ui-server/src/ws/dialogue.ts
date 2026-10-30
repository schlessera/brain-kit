/** Concrete host journal. Submission order is the shared SQLite writer's commit order. */
import type {
  DialogueEvidence,
  DialoguePage,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import type { SessionCatalog } from "./session-catalog.js";
import type { DialogueOpen, DialogueOwner } from "./dialogue-storage.js";

export class DialogueJournal {
  private readonly sessions = new Map<string, DialogueOwner>();
  private readonly conversations = new Map<string, DialogueOwner>();
  private readonly adopting = new Map<string, DialogueOwner>();
  private readonly offsets = new Map<string, number>();
  private failure: unknown;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, { count: number; bytes: number }>();
  constructor(
    private readonly catalog: SessionCatalog,
    private readonly publish: (page: DialoguePage, principalId: string) => void,
    private readonly failed: (owner: DialogueOwner) => void
  ) {}
  async open(input: DialogueOpen): Promise<DialogueOwner | undefined> {
    if (!this.catalog.dialogueOpen) return;
    const owner = await this.catalog.dialogueOpen(input);
    this.conversations.set(input.conversationId, owner);
    if (owner.session_id) this.rememberSession(owner.session_id, owner);
    return owner;
  }
  private rememberSession(id: string, owner: DialogueOwner): void {
    this.sessions.delete(id);
    this.sessions.set(id, owner);
    if (this.sessions.size > 128)
      this.sessions.delete(this.sessions.keys().next().value!);
  }
  bind(conversationId: string, principalId: string, sessionId: string): void {
    const owner =
      this.conversations.get(conversationId) ??
      this.catalog.dialogueOwnerForConversation?.(conversationId, principalId);
    if (
      !owner ||
      owner.principal_id !== principalId ||
      !this.catalog.dialogueBind
    )
      return;
    // Reserve routing synchronously. The bind is posted before subsequent appends.
    owner.session_id = sessionId;
    this.rememberSession(sessionId, owner);
    const done = this.catalog
      .dialogueBind(conversationId, principalId, sessionId)
      .then((next) => {
        if (next) {
          this.conversations.set(conversationId, next);
          this.rememberSession(sessionId, next);
        }
      });
    this.track(done, owner);
  }
  voice(
    conversationId: string,
    evidence: Extract<DialogueEvidence, { kind: "voice" }>,
    after: () => void
  ): boolean {
    const owner = this.conversations.get(conversationId);
    if (!owner) return false;
    const e = evidence.event;
    const identity = JSON.stringify([
      conversationId,
      evidence.epoch,
      e.kind,
      e.kind === "input_fragment"
        ? e.utteranceId
        : e.kind === "output_transcript"
        ? e.outputId
        : null,
      e.sequence,
    ]);
    this.append(owner, identity, evidence, after);
    return true;
  }
  adoptTurn(turnId: string, ownerId: string, principalId: string): void {
    const owner = this.catalog.dialogueOwnerForId?.(ownerId, principalId);
    if (
      !owner ||
      owner.session_id ||
      [...this.adopting.values()].some((o) => o.id === owner.id)
    )
      throw new Error("Retained conversation is not provisional");
    this.adopting.set(turnId, owner);
  }
  /** Exact UI-only draft target of an authorized provisional adoption. */
  draftSource(turnId: string): string | undefined {
    const owner = this.adopting.get(turnId);
    return owner ? `dialogue:${owner.id}` : undefined;
  }
  retireTurn(turnId: string): void {
    this.adopting.delete(turnId);
  }
  backend(msg: ServerMessage): void {
    if (
      msg.type !== "session_info" &&
      msg.type !== "text_delta" &&
      msg.type !== "result"
    )
      return;
    const { sessionId, turnId } = msg as {
      sessionId?: string;
      turnId?: string;
    };
    if (!sessionId || !turnId) return;
    const adopting = this.adopting.get(turnId);
    if (msg.type === "session_info" && adopting) {
      this.conversations.set(adopting.id, adopting);
      this.bind(adopting.id, adopting.principal_id, sessionId);
      this.adopting.delete(turnId);
      this.conversations.delete(adopting.id);
    }
    const owner =
      this.sessions.get(sessionId) ??
      this.catalog.dialogueOwnerForSession?.(sessionId);
    if (!owner) return;
    if (msg.type === "session_info")
      this.append(owner, `request:${turnId}`, {
        kind: "request",
        turnId: turnId,
        ...(msg.requestId ? { requestId: msg.requestId } : {}),
      });
    if (msg.type === "text_delta") {
      const start = this.offsets.get(turnId) ?? 0,
        end = start + msg.text.length;
      this.offsets.set(turnId, end);
      for (let offset = start; offset < end; offset += 2000) {
        const text = msg.text.slice(offset - start, offset - start + 2000);
        this.append(owner, `text:${turnId}:${offset}`, {
          kind: "backend",
          turnId: turnId,
          start: offset,
          end: offset + text.length,
          text,
          digest: Bun.SHA256.hash(text, "hex"),
        });
      }
    }
    if (msg.type === "result") this.offsets.delete(turnId);
  }
  close(
    conversationId: string,
    principalId: string,
    epoch: number,
    partial: boolean = false
  ): void {
    const done = this.catalog.dialogueClose?.(
      conversationId,
      principalId,
      epoch,
      partial
    );
    const owner = this.conversations.get(conversationId);
    if (done && owner) this.track(done, owner);
    this.conversations.delete(conversationId);
  }
  private append(
    owner: DialogueOwner,
    identity: string,
    evidence: DialogueEvidence,
    after?: () => void
  ): void {
    if (!this.catalog.dialogueAppend) return;
    const q = this.queues.get(owner.id) ?? { count: 0, bytes: 0 };
    const bytes = Buffer.byteLength(JSON.stringify(evidence));
    if (q.count >= 256 || q.bytes + bytes > 1024 * 1024) {
      after?.();
      this.failed(owner);
      return;
    }
    q.count++;
    q.bytes += bytes;
    this.queues.set(owner.id, q);
    const done = this.catalog
      .dialogueAppend({
        ownerId: owner.id,
        principalId: owner.principal_id,
        generation: owner.generation,
        identity,
        evidence,
      })
      .then((record) => {
        this.publish(
          {
            ownerId: owner.id,
            ...(owner.session_id ? { sessionId: owner.session_id } : {}),
            generation: owner.generation,
            through: record.sequence,
            records: [record],
            coverage: owner.coverage,
          },
          owner.principal_id
        );
        after?.();
      })
      .catch((error) => {
        // Preserve locally visible, explicitly unsaved evidence on storage failure.
        after?.();
        throw error;
      })
      .finally(() => {
        q.count--;
        q.bytes -= bytes;
        if (!q.count) this.queues.delete(owner.id);
      });
    this.track(done, owner);
  }
  private track(done: Promise<unknown>, owner: DialogueOwner): void {
    this.pending.add(done);
    void done.then(
      () => this.pending.delete(done),
      (error) => {
        this.failure ??= error;
        this.pending.delete(done);
        this.failed(owner);
      }
    );
  }
  async settled(reportFailure: boolean = false): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    if (reportFailure && this.failure) throw this.failure;
  }
}
