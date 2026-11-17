---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-common": patch
"@schlessera/brain-module-images": patch
---

Agents can ask the user to mark up an image (#3975). `request_image_markup` opens a markup editor in the browser, where the user draws arrows, ellipses, freehand strokes and short notes on the image. The host saves the drawing as a transparent PNG layer, sized exactly like the displayed image (after EXIF rotation), under `.brain/scratch/markup/`. The tool returns the layer's path, its size, the mark counts and the note texts, ready for `brain image --ref <image> --markup <layer>`. A mask says where pixels may change; markup says what should change.

- **The layer can use the CLI's full 52,428,800 bytes (50 MiB).** It is uploaded over its own bounded route (`POST /api/markup/:requestId`), not the 12,000,000-byte WebSocket frame. The browser measures the PNG before sending it, and the server enforces the same limit: exactly 50 MiB is accepted, one byte more is refused, and the editor stays open with the reason.
- **The host writes the file, never the agent.** It picks the name `<image>.<hash>.markup.png`, adds `-2`, `-3` for repeat submissions instead of overwriting, and refuses to write through links. Before writing, it rechecks under the lock:
  - the image's hash and size;
  - the directory chain;
  - protected paths;
  - turn authority, membership and cancellation.
- **The editor needs a screen.** Voice and no-grant turns refuse the tool, as does a host without a browser that can show the editor; nothing is written. Closing the editor returns "The user closed the markup editor".
- **Both chat backends register it** in their stable tool roster, after `request_image_mask`. `request_image_mask`, its 8 MiB cap and the general frame limit are unchanged.
- **The transcript shows a receipt:** the layer over the image placeholder, the marks, the notes, the size and both paths. A refusal is stated in the result's own words.

The images module's PNG, JPEG and WebP header reader now lives in `@schlessera/brain-common/internal/image-header`, so the server and the CLI read sizes with the same code. The module still exports it under its existing names.
