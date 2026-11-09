# Generic chat attachments

**Decided by the maintainer on 2026-10-29 and 2026-11-02.** The rulings are
linked in each section below. The
[source-backed design](../plans/chat-attachments.md) turns them into routes,
schemas, bounds and proof briefs; its six §13 recommendations were approved
at review on 2026-11-02. Admission, storage, ownership and cleanup are built
([what #3153 built](#what-3153-built)), and so is reading contents
([what #3154 built](#what-3154-built)). The composer's first slice is built
([what #3155 built so far](#what-3155-built-so-far)); the rest is open work in
epic #3150.

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
  `outgoing` (both keyed by the draft id) and `message` (keyed by the session
  id). #3153 shipped one outgoing slot per draft; #3588 replaced it with the
  list described below, and the `outgoing` owner now covers every file of the
  draft's snapshots. The design's compound
  owner ids were simplified this way because a draft id may itself contain
  `:`, and one reference per session protects a file as well as one per turn.
- **References on the wire.** A message names its originals in a new optional
  `chat_message.attachmentRefs` field, not as a new variant of the existing
  `files` union the design sketched. Adding a variant would retype
  `ChatFileAttachment[]` for TypeScript readers, which the contract counts as
  breaking. The separate field is additive and carries the same reference.
- **What the provider sees.** The `<brain-attachments>` block says the
  contents have not been read and that the agent may open an original at its
  path. #3153 did not name `read_attachment`, which was not registered yet;
  #3154 changed new messages' wording, and recorded messages keep theirs.
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

## What #3588 built

The G1 A snapshot list
([ruling](https://github.com/schlessera/brain-kit/issues/3155#issuecomment-6591807939)),
replacing #3153's single slot:

- **A column, not a table.** The list is one JSON column on the draft row
  (`outgoing_snapshots`, migration 079), so a save checks and writes it in the
  draft's own immediate transaction. Migration 079 turns a saved slot into the
  first snapshot, with its request id as its `snapshotId`. The ruling rejected
  a send-intent table.
- **A chat is its session.** The capacity count sums the snapshots of every
  live draft bound to the same `sessionId`, which is what one chat's tabs and
  devices share; a draft with no session is a chat of its own. Only a save
  that adds a `snapshotId` is counted against the ten.
- **The whole list on every save.** `snapshots` replaces the draft's list
  under `If-Match`, as `PUT` replaces the rest of the draft. The host refuses
  any change but an allowed state move or a held snapshot's files, and refuses
  to drop anything but a `returned` snapshot. The save body bound rose to
  4,390,912 bytes so ten snapshot texts fit at JSON's worst escapes.
- **Additive compatibility.** Retyping `outgoing` would break readers, so it
  stays: `Draft.outgoing` shows the newest held or unconfirmed snapshot in the
  old shape, and the old write creates or dispatches the snapshot of its
  request, or removes the one it shows.
- **Nothing evicted by a send or a delete.** An acceptance that consumes a
  draft still holding other snapshots keeps the row at the next revision with
  an empty composer instead of a tombstone. A `DELETE` that would drop a held
  or unconfirmed snapshot is `409 DRAFT_OUTGOING_PENDING`.
- **The composer keeps its envelope.** An upload's per-draft count now covers
  the current revision and unbound uploads only. A snapshot's files are
  checked against the per-message envelope when a save lists it, and stay in
  the draft sub-limit and the pool.

## What #3154 built

The shared reader of the design's §7, with these concrete choices:

- **One tool, every interactive session.** `read_attachment` is a host bridge
  tool on both backends, registered with the stable roster whether or not a
  session has attachments. A turn may read only originals a `message`
  reference of its own session names; draft and outgoing bindings grant no
  read. Every call re-checks the record, the link-free path, the size and
  the SHA-256 through the same `readVerified` the routes use, and taints the
  session as `chat_attachment`. Authority is the host's, so the tool is
  auto-allowed and shows no card. A third-party backend does not get it: like
  the other host tools, it is offered to the first-party backends, whose
  every bridge call the host re-authorizes.
- **The block names the tool.** New messages say `Call read_attachment with
  an id to read PDF or text`. A message recorded with #3153's wording still
  replays and retries, because both wordings are matched byte for byte
  (`isChatFilesPrompt`, `includesAttachments`).
- **The extractor gets bytes, not a descriptor.** The design passed the
  verified original as a file descriptor. The host already holds the exact
  bytes it just verified, so the child reads them on stdin: it opens no path,
  and nothing can change between the check and the read. It runs with
  `PATH` as its only environment. The installed pdf.js 6.3.289 has no
  `isEvalSupported` option and no eval path; `useWorkerFetch: false` and
  `disableFontFace: true` remain.
- **Bounds, measured.** The design's values stand: 20 pages and 65,536 bytes
  per call, 262,144 bytes per turn, 30 s wall clock, `RLIMIT_CPU` 20 s,
  `RLIMIT_DATA` 1 GiB, two children per host with the rest queued, and turn
  cancellation killing a running child and dropping a queued one. On a
  24,376,768-byte, 500-page Odysseus logbook (560 lines a page, Bun 1.4.4,
  16 cores), reading pages 1–20, 241–260 or 481–500 stopped at the output
  bound after 8 pages in 0.61–0.63 s wall, 0.70–0.72 s CPU and 110 MiB peak
  RSS; parsing all of 481–500 without an output bound took 1.29 s wall,
  1.53 s CPU and 120 MiB. That leaves about 13 times the CPU and 8 times
  the memory. A single pass over all 500 pages, which no call can request,
  was killed by the 20 s CPU limit. Without `prlimit` only the wall clock
  applies. A child killed by `SIGXCPU`, `SIGKILL` or an aborted allocation
  under the limits reads as `failed: resource_limit`.
- **Text and tracks.** Text, and a validated track's text, are read in place
  by byte range with a strict UTF-8 decode, cut on a code point; the cursor
  is the next byte offset. Images, archives and binaries are `unavailable`
  with copy saying why. Cursors carry the first 12 hex digits of the file's
  digest, so a cursor never continues another file.
- **Clipped results say so.** A PDF result names the pages it covers and, when
  that is not the whole document, its page count. Truncation names `next`,
  and the turn-budget cut says to continue in a later turn.
- **Read records.** `attachment_reads` (migration 078) keeps one row per call
  that reached an authorized original: file, session, turn, outcome and
  scope, never text. It drives #3155's sent-row status and never reaches a
  provider. Session release and the sweep's forget remove a session's or a
  file's rows. There is no derived cache, so nothing new is charged to the
  pool.
- **Delivering reads (#3589).** The records reach the browser two ways. A
  route, `GET /api/sessions/:id/attachment-reads`, returns a session's reads
  when its view opens. A capability-gated `attachment_read` frame carries a
  read recorded during a live turn. The frame is sent with `sendToCapable`,
  which bypasses the dialogue recorder, so it never joins a transcript or a
  replay. Both return only reads of files that a `message` reference of the
  same session still names. They use the history replay's authorization,
  which is a usable principal of this host's shared namespace; the route adds
  no ownership rule that a replay does not have. A replay field was not used:
  the native transcript, not the host, owns a replayed message.
- **Adding a reader.** A reader is concrete code, not a registry: add a rule
  to `detectKind` (`packages/ui-server/src/attachments/detect.ts`) and a
  `reader` value to `AttachmentReader` and migration 077's check; route it in
  `createAttachmentReader` (`packages/ui-server/src/attachments/read.ts`),
  with a case in the extractor child
  (`packages/ui-server/src/attachments/extract-worker.ts`) when it needs
  parsing; then add an Odysseus fixture and its outcome tests. The composer's
  Files picker has no `accept` filter, so it does not change.

## What #3155 built so far

The composer's Files source, its upload queue and the draft binding of
originals, on a host that advertises `composerFiles`:

- **Menus as ruled.** Desktop shows Files… and paste-or-drop guidance, and no
  Photo library or Camera. A phone keeps both beside Files. The Files input
  has no `accept`, and paste and drop feed the same pipeline. A host without
  `composerFiles` keeps the old menu and D52's tab-only track queue.
- **One route for everything but images.** Every file that is not an image
  goes to `POST /api/drafts/:draftId/files` as its raw bytes. The client
  never routes by MIME type or extension; detection is the host's. Images
  keep their existing frame processing. They do not upload an original yet,
  so the image half of "a real file for every attachment" is still open.
- **A queue item keeps one key for its whole life.** The idempotency key is
  minted once per item. A lost answer becomes `unknown`, never "not stored".
  It is uploaded again with the same key once on reconnect, or through
  **Upload again**. A `503` waits and retries with that key. Only a received
  `4xx` says *not stored*. `fetch` reports no upload progress, so the chip
  says `uploading…` rather than invent a percentage.
- **Stored originals are draft content.** A stored original joins
  `ComposerDraft.files`, together with the draft id it was uploaded to (its
  lineage). It is saved as `fileIds`, and it reads as saved only when an
  acknowledged revision lists it. A file carried to another draft id, by a
  rotation or a kept copy, cannot be bound there. It shows *not attached*,
  blocks Send and is never listed in that id's save. The device copy of a
  draft (#1014) keeps the references, so a restore cannot unbind them.
- **Send waits for the binding.** Send holds while an upload or the save
  that binds the originals is pending, and then sends `attachmentRefs` with
  the acknowledged `draftRef`. A refused or failed upload, or a detached
  file, blocks Send with a reason. Unread contents, and kinds with no
  reader, never block it. On a host without the snapshot list this is the
  composer's tab-local hold; with it, it is a held snapshot (below).
- **Every send is a snapshot (#3588's list).** On a host that advertises
  `composerFiles`, `chatRequestAck` and
  `sessionDraftLimits.maxOutgoingSnapshots`, Send writes one snapshot in the
  save that clears the composer. It is `held` while any of its uploads runs,
  else `dispatched`. Its uploads leave the composer with it, and each stored
  one joins the snapshot's files in a save. Once all are stored it moves to
  `dispatched`, and the `chat_message` goes once, with its own text and
  files, under a revision that holds it. A draft with legacy inline images,
  or a host without the limit, keeps the tab-local path, because a snapshot
  cannot hold an inline image.
  - **Acceptance drops it here at once.** The host releases an accepted
    snapshot in place, without a revision (#3733). So the client removes it
    from both its list and its copy of the host's before the next save, and
    holds a draft's saves while one of its sends is pending. When other
    snapshots remain, the host keeps the row at the next revision with an
    empty composer, and the client saves over that revision instead of
    rotating the draft.
  - **Send waits on no timer.** The save that creates a send's snapshot,
    and a held snapshot's move to `dispatched`, go out in a microtask rather
    than on the draft client's save timer, and the frame follows the save's
    acknowledgement directly. Pressing Send therefore reaches the host as
    directly as it did before snapshots, even in a page whose clock is
    paused. Typing keeps its save pause, and retries keep their backoff.
  - **A full chat sends nothing.** `409 DRAFT_OUTGOING_FULL` gives the text
    and files back to the composer and shows the notice with **Show**. Until
    the save that creates a snapshot is acknowledged, the field takes no new
    edits. That window is one save, and it means a refusal gives the text back
    alone, never joined to newer words (rev 4 correction 3). Only
    Send waits. Drafting and every bubble action stay available, and Cancel
    never asks for a slot. The notice clears when this tab frees one: a
    Delete…, an Edit, or an acceptance. When another tab or device frees a
    slot, a bounded re-read clears it (maintainer ruling A, 2026-11-08; there
    is no draft change frame). While the notice shows and the tab is visible,
    the draft client lists the host's drafts every 15 s, reads each one of
    that chat, and counts their snapshots. It also re-reads at once on focus,
    `online` and hello. These are reads only; the notice clears when the
    count is below the limit
    ([decision request](https://github.com/schlessera/brain-kit/issues/3155#issuecomment-6723796317)).
  - **Bubbles in the transcript (G2 A).** Held, returned and unconfirmed
    snapshots render after the last accepted message in creation order. Each
    has its own `StatusIndicator` and actions keyed by `snapshotId`, and its
    copy and actions follow rev 5 §2. A dispatched snapshot whose answer this
    tab is waiting for is the transcript's own optimistic row. It is not
    drawn a second time, so the rev 5 *Sending…* state shows only in the
    moment before its frame leaves. On this host the bubble replaces D52's
    review block for that send. With no bubble to draw the list adds nothing
    to the transcript, not even an empty row and its divider: the last
    message stays the reading column's last node, as #1013 measures, and the
    polite region that speaks background changes sits outside the column.
  - **Reload.** A held snapshot comes back *Paused after reload*, and only
    its Send sends it. A dispatched one comes back unconfirmed, with
    **Check** (one recovery read) and **Send again**. A returned one comes
    back *Not sent*. The reason it returned lives in the tab only, so after a
    reload it says no more than that.
  - **Check proves little.** The recovery envelope names only a session's
    latest accepted request. Check shows acceptance when that request is
    this one. It shows non-acceptance only when the envelope holds no
    accepted work at all (`revision` 0), and then moves the snapshot to
    `returned`. Anything else stays *Couldn't confirm*, with the reason.
  - **Send again is two saves.** Only a returned snapshot may be left out.
    So the old one moves to `returned` in place, and the next save drops it
    while it creates the successor under a new `snapshotId` and
    `requestId`. The slot passes straight across, even at 10 of 10.
  - **A session switch sends nothing elsewhere.** A snapshot stays with its
    draft. A session's held snapshot still sends once its files are stored,
    into its own chat. A new chat's snapshot sends only while that new chat
    is in view.
  - **Focus and speech.** Cancel, Edit and Delete… move focus as rev 5 §3
    says. A background change, such as an upload not stored or a send left
    unconfirmed, is announced once in one polite region, and focus stays
    where it is. The indicators pass `announce={false}`, so nothing is spoken
    twice.
- **Tracks follow the host.** On a host with `composerFiles` a picked track
  is a generic original: the host detects it, the draft binds it and a reload
  restores it, so it is not a tab-only staged track and the #1150 leave guard
  no longer applies once its binding is acknowledged. D52's tab-only path
  remains for a host without `composerFiles`. The mounted-app suites that
  prove it (#1112, #1150, #1018) remove that capability from the real host's
  hello so they keep proving it. The drop-and-reconnect suite (#1013) runs
  the generic path against the real host.
- **Sent rows say what was read, from the records only.** A sent message
  lists its originals by name, kind and size, and the host's read records
  (#3589) add the design's §8.4 read state. The client declares
  `attachmentReads`, reads a session's records when its view opens and after
  each hello, and appends each `attachment_read` frame. Three choices the
  records force:
  - **Scopes combine.** Pages or bytes read across several calls are joined,
    so a later range never hides an earlier one. A failure shows only when
    nothing was read, and a changed original always shows.
  - **What a record cannot say is not said.** A record keeps an outcome and a
    scope, not `pagesWithoutText` or a failure's reason. A partial PDF read is
    *partly read p. 1–3* rather than *3 of 12 pages had text*, and a failed
    one is *couldn't read* rather than *took too long*.
  - **Unknown is not unread.** Until a session's records arrive, or on a host
    without `attachmentReads`, a row claims neither *read* nor *not read yet*.
    An image never reads as *not read yet*: it reaches the agent as a frame.
- **The draft indicator replaces the save line (rev 4 §1, E1 A).** The
  composer's draft status is the kit `StatusIndicator`, placed beside
  Attach: attach · indicator · field · mic · send. Its 44px box takes a 28px
  place in the row, so it touches its neighbours' boxes without growing the
  field. An empty draft keeps the slot with no control. D52's persistent line
  is gone from the composer; `DraftSaveLine` stays for the voice strip.
  - **Success is one fact.** The host acknowledged this exact edit, with
    every original bound and nothing of the draft still uploading. An
    acknowledgement of an older edit never shows ✓; the indicator stays
    active until the newer one is acknowledged.
  - **The other states keep their facts.** These states come from rev 4 §1:
    queued while a file uploads, attention when offline (*Last saved* or
    *never*), unknown when a save's answer was lost, failed or unknown for an
    upload, and refused for a space refusal (**Open Storage**). D52's too
    large, host full and unavailable become refused or attention states. A
    conflict keeps **Compare drafts**, and another tab's version keeps **Open
    other version**. Both are now detail actions.
  - **Check again is a read.** A save whose answer was lost is kept in the
    tab. Check again reads the draft once (`GET /api/drafts/:draftId`, rev 5
    §1). If the host's revision is the one that save would make, with the
    same text, images, `files[].fileId` and snapshot list, the save is
    acknowledged. Anything else changes nothing. It never saves; the save's
    own idempotent retries go on as before.
  - **Quiet, and still where it was.** Opening details reads and writes
    nothing. Closing them returns focus to the indicator. Only active work
    animates, and reduced motion keeps the glyph still. The indicator passes
    `announce={false}`: saving was silent before, and upload outcomes keep
    the composer's own announcement.
  - **The leave guards are unchanged.** Every state but saved and hidden is
    at risk. An unacknowledged draft still holds the update reload
    (`holdsUnsaved`), and a queued upload still arms the browser's leave
    prompt.
  - **An upload cut off by a reload is named, not restored (rev 5 §1).** The
    device-kept work context (#1014) records the names of files still
    uploading, never their bytes. After a cold reload their chips are gone.
    That draft's composer then says *{name} was still uploading when the page
    closed. It isn't attached. Choose it again to attach it.* until it is
    dismissed. The notice says nothing about storage or cleanup. The host's
    own references decide that: 1 hour for a file never bound, 7 days from the
    last reference otherwise.


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
