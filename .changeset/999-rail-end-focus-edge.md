---
"@schlessera/brain-ui-kit": patch
---

Keep the last rail destination whole when End scrolls a short rail to it. After a touch pan that stopped without a fling, Chromium could draw End's scroll one pixel short for a frame, and with only one pixel of trailing room that cut half a pixel off the bottom of the focused row. The scrolling part of the rail now leaves two pixels below its last item.
