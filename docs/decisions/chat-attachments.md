# Generic chat attachments

**Decided by the maintainer on 2026-10-29 and 2026-11-02.** The rulings are
linked in each section below. The
[source-backed design](../plans/chat-attachments.md) turns them into routes,
schemas, bounds and proof briefs; its six §13 recommendations were approved
at review on 2026-11-02. Admission, storage, ownership and cleanup are built
([what #3153 built](#what-3153-built)); content reading and the composer are
open work in epic #3150.

## Sources and one pipeline

On phones the attach menu offers three source shortcuts: Photo library, Camera
and unrestricted Files. Desktop offers one unrestricted Files action, Live
conversation when it is available, and non-interactive paste and drop
guidance. There is no Track files entry and no format allowlist. Every source
feeds the same detection and processing pipeline. Images and validated
GPX/KML/GeoJSON tracks keep their existing specialized processing as routes
after selection. The rulings:
[2026-10-29 phone sources](https://github.com/schlessera/brain-kit/issues/3151#issuecomment-6505234880)
and [desktop menu A](https://github.com/schlessera/brain-kit/issues/3155#issuecomment-6568083422).

## Admission and originals

- **A separate neutral composer-upload route.** It reuses the staging
  internals and has no operational inbox, queue or triage side effects.
  `/share` and `/track-upload` keep their documented behavior
  ([A](https://github.com/schlessera/brain-kit/issues/3153#issuecomment-6567518232)).
- **A real file for every attachment.** Every attachment, images included, is
  kept as a byte-identical original on the filesystem, with an authorized,
  stable reference the agent can read from its execution environment. Inline
  frames, previews and extracted text are derived representations. They never
  stand in for the original
  ([reconciliation](https://github.com/schlessera/brain-kit/issues/3151#issuecomment-6567519144)).
- **Stored is not read.** A stored binary is not automatically readable.
  Upload or format recognition never claims its contents were read.

## Ownership, lifetime and limits

- **Who owns an original.** Originals belong to the exact acknowledged draft
  revision. After an accepted send they also belong to the retained
  conversation. A saved draft and its file bindings survive reload, tab close
  and a normal host restart. Sending keeps the originals for later reads, and
  consumes neither newer edits nor another draft. Nothing is filed into
  canonical brain content. Unacknowledged or legacy data never reads as saved.
  Unresolved sends protect their files
  ([lifetime A](https://github.com/schlessera/brain-kit/issues/3153#issuecomment-6567562624)).
  This amends D52's tab-only staged-track exception for the generic path; see
  [D52's amendment](design-kit/sessions-and-drafts.md#generic-attachment-originals-2026-11-02).
- **Per draft or message.** At most 10 attachments in total, 25,000,000
  original bytes per file and 50,000,000 combined, images included. The
  65,536-byte text allowance is kept separately. The old 8,388,608-byte draft
  ceiling no longer stops an eligible batch from being saved. Image,
  provider-frame and track-parser bounds stay as they are, and nothing is
  dropped silently to fit them
  ([envelope A](https://github.com/schlessera/brain-kit/issues/3153#issuecomment-6567594375)).
- **Across the host.** A configurable attachment pool, by default
  1,073,741,824 bytes (1 GiB), covers draft, sent, pending and grace-period
  attachments. It also charges in-flight reservations and any derived storage.
  The 100-draft and 268,435,456-byte draft limits remain as sub-limits inside
  the pool, not on top of it. At capacity the host refuses new work honestly,
  and never purges early to make room
  ([pool A](https://github.com/schlessera/brain-kit/issues/3153#issuecomment-6567685455)).
- **Cleanup.** An upload that was never bound is removed after one hour. An
  original that was once referenced is removed seven days after its last
  reference is authoritatively removed. Saved references, active work and
  unresolved sends protect files. Ownership, identity and every reference are
  rechecked immediately before deletion, and rebinding is coordinated against
  the unlink. If the reference state is unknown, nothing is deleted. Rebinding
  cancels collection. Incidental access or mtime never resets the clock.
  Grace-period storage stays charged. None of this implies an Undo feature
  ([cleanup A](https://github.com/schlessera/brain-kit/issues/3153#issuecomment-6567630852)).

## Reading contents

- **One shared baseline.** A bounded, local, deterministic text and PDF
  extraction path serves both first-party backends. Native readers may
  supplement it but never replace it. There is no OCR, decryption, archive
  expansion, uploaded-code execution or external conversion
  ([baseline A](https://github.com/schlessera/brain-kit/issues/3154#issuecomment-6567748631)).
- **Reference first, contents on demand.** At send, PDF and text files reach
  the provider as references with minimal metadata. Their contents are added
  only when the agent explicitly reads them, at the tail of the conversation.
  Nothing is injected automatically
  ([context A](https://github.com/schlessera/brain-kit/issues/3154#issuecomment-6567796855)).
  [Provider history](provider-history.md) stays append-only.

## Composer behavior

- **Known limits do not block sending.** A stored original remains sendable
  when no reader exists or a read fails, and the limitation is shown. Real
  upload, storage or admission failures still block sending
  ([A](https://github.com/schlessera/brain-kit/issues/3155#issuecomment-6568146411)).
- **Send while uploading.** Pressing Send during uploads holds the exact
  snapshot visibly, with Cancel. It sends once that snapshot's files are
  admitted, without waiting for any content read. An uncertain send is never
  retried automatically
  ([A](https://github.com/schlessera/brain-kit/issues/3155#issuecomment-6568247020)).
  The held snapshot is an outgoing bubble, and a separate new composer
  revision stays available
  ([D1 A](https://github.com/schlessera/brain-kit/issues/3155#issuecomment-6574925674)).
- **Draft status.** It is shown by a compact, animated, color-coded status icon
  with details on hover, tap and keyboard focus. Only active work animates,
  and reduced motion gets static glyphs. #3281 owns the shared component
  ([ruling](https://github.com/schlessera/brain-kit/issues/3155#issuecomment-6575242784)).

## What #3153 built

The server side of admission, storage, ownership and cleanup, as the design's
§4 and §6 describe, with these concrete choices:

- **Records and transactions.** The `attachment_files`, `attachment_refs`,
  `attachment_reservations` and `attachment_receipts` tables sit in the
  operational database beside the drafts, and every mutation runs on the
  draft store's write channel. A save, an acceptance and a sweep mark
  therefore see one serialized state. Reference owners are `draft` and
  `outgoing` (both keyed by the draft id; a draft has at most one outgoing
  snapshot) and `message` (keyed by the session id). The design's compound
  owner ids were simplified this way because a draft id may itself contain
  `:`, and one reference per session protects a file as well as one per turn.
- **References on the wire.** A message names its originals in a new optional
  `chat_message.attachmentRefs` field, not as a new variant of the existing
  `files` union the design sketched. Adding a variant would retype
  `ChatFileAttachment[]` for TypeScript readers, which the contract counts as
  breaking. The separate field is additive and carries the same reference.
- **What the provider sees.** The `<brain-attachments>` block says the
  contents have not been read and that the agent may open an original at its
  path. It does not name `read_attachment`, because that tool belongs to
  #3154 and is not registered yet. Once it is, new messages may name it;
  recorded messages keep the text they were sent with.
- **Accounting.** The pool charges recorded originals in every state,
  reservations and legacy draft image BLOBs. A save charges the draft
  sub-limit only for originals no live draft or snapshot already references.
  A reservation is the declared `Content-Length`, or 25,000,000 bytes without
  one, and the commit replaces it with the real size in the same transaction
  that re-checks the pool.
- **Cleanup safety.** The sweep's mark re-selects by clock and requires no
  reference; a reference insert requires `stored` in its own transaction.
  Rebinding also clears the clock, so two independent guards keep a rebound
  file. The mutation proof in the PR breaks each.
- **Governed read-only mount.** `.brain-ui/attachments/` is mounted read-only
  for governed workers through the same resolver that mounts protected paths,
  but it is not a protected path: no policy names it, the turn manifest does
  not list it, and nothing is quarantined when the host writes it during a
  turn. The ordinary profile relies on the digest check alone.
- **Session deletion.** The store's `releaseSession` removes a chat's
  `message` references and starts their seven-day clocks. Calling it from chat
  deletion belongs to #3231's flow.
- **Kept as before.** `/share`, `/track-upload`, staged-track references,
  inline images and D52's tab-only legacy track path behave as they did.

## Rejected alternatives

The rejected options were offered in the rulings above:

- Reuse `/share` for the composer. It would create operational inbox work.
- Keep tracks tab-only, or bound generic batches by the old 8 MB draft
  ceiling.
- Delete originals immediately when their last reference goes, or clean up
  manually only.
- Native or backend reader first, with a shared fallback.
- Inject excerpts automatically at send.
- Offer duplicate desktop Photo library and Camera shortcuts.
- Block sending solely because contents are unreadable.
- Require a fresh Send after each pending upload.
- Lock the composer while a message is held.
- Use a persistent draft-status text line.

These are rejected in the design, subject to the same review as its
recommendations:

- **Content-addressed deduplication.** It links unrelated owners through one
  file.
- **A public reader registry.** It is a seam with no second implementation
  ([extending](../extending/README.md)).
- **A `brain` CLI reader.** The CLI cannot see host ownership records.
- **A read tool registered only when files are present.** It would change the
  tools within a session.
- **Eager page counts at upload.** That is parsing at upload, which is close to
  eager processing.
- **A persisted derived-text cache in the first delivery.** It adds pool
  accounting for little gain.
