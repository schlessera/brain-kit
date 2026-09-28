# Media in your brain

A brain is a text knowledge base. Markdown diffs well, compresses well and
costs almost nothing to keep in git forever. Binaries do not: screenshots,
exported slides, audio notes and rendered images arrive in a brain all the
time, and git stores every version of every one of them for good. This page
is about deciding which of them belong in the repository.

## Why the history is the expensive part

Git never forgets a committed file. Delete a 20 MB render tomorrow and every
clone still downloads it, because it is in the history. Replace it with a new
version and you now carry both. A folder of iteration renders, where each
version was committed on its way to the final one, can outweigh the entire
text corpus. It then makes every clone, every `brain sync` and every hosted
copy slow.

GitHub warns on a file over 50 MiB and refuses a file over 100 MiB, and it
recommends keeping a repository under 1 GB ([About large files on
GitHub](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)).
A brain usually hits the pain well before those limits.

## What belongs in git

- **Yes:** small, final media that a note refers to. A diagram, a photo of a
  whiteboard, a scanned receipt, a cover image. The rule of thumb is anything
  under a few megabytes that you would want on a new laptop.
- **No:** iterations and intermediates, such as renders, exports, drafts and
  the ten versions before the one you kept. Keep the final one and leave the
  rest out.
- **Not as plain git:** large masters you really do need, such as raw
  recordings, high-resolution originals or video. Use Git LFS (below), or keep
  them outside the brain and link to where they live.

## What brain-kit does about it

- **`brain sync assess`** classes a new binary (an image, PDF, audio, video or
  office file) as `MEDIA`, and any file over the size limit as `LARGE`, each
  with its size in bytes. A presentation (`.pptx`) is media like any other.
  `brain sync run` never commits either: it leaves them untouched and lists
  them in its report. When bare `brain sync` runs with a terminal and an
  agent, it hands them to the `/sync` skill, which asks you. Nothing is
  committed silently.
- **`brain doctor`** has a `tracked-media` check. It lists the five largest
  binaries already tracked, and warns when any tracked file is over the limit.
  It weighs the blobs in git's index, which is what a clone downloads, not
  the copies in your working folder. A file in Git LFS counts as its small
  pointer, and a symlink as the link. If git cannot read an object, or a merge
  is unresolved, the check warns rather than passing on partial figures.
- **The `media` block in `brain.config.ts`** sets the limit and your standing
  decisions, so the skill does not ask about the same files twice:

  ```ts
  media: {
    maxTrackedBytes: 5 * 1024 * 1024,     // the LARGE limit (default 5 MiB)
    track: ["me/*.jpg"],                  // always commit these
    ignore: ["assets/renders/*"],         // never commit these
  }
  ```

  A glob's `*` matches any run of characters. A glob with no `/` also matches
  the file name alone. `ignore` wins over `track`, and a secret-shaped name is
  never tracked, whatever `track` says. See
  [configuration.md](configuration.md#media).
- **The template's `.gitignore`** has a commented media section to start from.

## Git LFS for large masters

[Git LFS](https://git-lfs.com/) keeps large files out of the git history.
The repository stores a small pointer, and the file itself lives on the LFS
server of your git host. Clones fetch only the versions they check out. It is
the supported route for large binaries that must travel with the brain:

```sh
git lfs install
git lfs track "*.mov" "*.wav"
git add .gitattributes
```

LFS storage and bandwidth count against your git host's plan, so it is not
free space. brain-kit does not manage LFS for you, and it adds no pointer files
of its own.

## A file you already committed

Untracking a file (`git rm --cached <file>`, then add it to `.gitignore` or a
`media.ignore` glob) stops it growing further. It does not remove it from the
history. Shrinking history means rewriting it, which changes every commit
since and needs every clone to re-clone. brain-kit never does that for you.
