---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": patch
---

The kit gains the markup editor's parts and the shell it shares with the mask editor (#3983). `ImageEditorFrame` is the fullscreen dark image-editor shell (header with title, context line and close control; stage; error line; toolbar slot), and the mask editor now renders inside it with no visible change. `MarkupEditor` composes it with `MarkupCanvas`, `MarkupToolbar` and `MarkupNoteField`: Pen, Arrow, Ellipse, Text note and Pan; red, yellow and cyan; three widths; undo, redo and clear; pinch, wheel, keyboard and Fit zoom from 1× to 8×. Marks are stored in image coordinates and `exportMarkupPng` rasterises them alone on transparency at the source's displayed size. "Send markup" needs a committed mark, dismissing with marks asks first, and an encoded layer over `MARKUP_MAX_BYTES` (52,428,800 bytes) keeps the editor open with its size. `MarkupResultCard` and `MarkupFallback` state the result. `IconName` gains `pen`, `arrow`, `ellipse`, `text`, `undo`, `redo`, `erase`, `zoom-in`, `zoom-out` and `fit`. The `request_image_markup` tool and its route are #3975.
