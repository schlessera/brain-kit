---
"@schlessera/brain-ui-react": patch
"@schlessera/brain-ui-kit": patch
---

Every displayed file size follows the kit's one rule (`markupBytesLabel`): bytes below 1,024 as `B`, rounded KB, and MB with one decimal or none when whole (#4735, #4773). Strings that change, old → new:

- File viewer, file panel and binary preview: KB with one decimal and MB with two (`2.0 KB` → `2 KB`, `1.50 MB` → `1.5 MB`, `3.00 MB` → `3 MB`).
- Share messages and share limit texts, track and file chips, the share card and track upload errors: KB with one decimal (`1.5 KB` → `2 KB`, `4.1 KB` → `4 KB`, `640.0 KB` → `640 KB`), and whole MB without a decimal (`25.0 MB` → `25 MB`).
- Image share hints, hygiene media sizes and the image mask card: whole MB without a decimal (`3.0 MB` → `3 MB`).
- Draft save sizes: `1000 bytes` → `1000 B`.
- The recordings tray, the local recording sheet (`… free for audio`), the local capture screen, the connection gate's locked recordings and the passkey sign-out loss list, which printed megabytes whatever the size: a small total now reads in KB or B (`0.0 MB` → `4 KB`), and whole MB without a decimal (`12.0 MB` → `12 MB`).
- The kit's `EffectPreview` "Show all … lines" size: KB with one decimal (`1.5 KB` → `2 KB`), and MB for a large input.

The passkey sign-out dialog now asks again exactly when the size it displays grows, instead of comparing sizes rounded to 0.1 MB. The storage tab, the stats page, the decimal-megabyte limit labels and the Apify limits table keep their own scales.
