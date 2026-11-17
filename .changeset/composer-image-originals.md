---
"@schlessera/brain-ui-react": minor
---

On a host with composer files, a picked, pasted, dropped or camera image is now uploaded as its exact original through the same route as every other file (#3155). The host's detection names it an image, and the composer derives the inline frame from that original, as before. Sent with the message, the frame names its original (`ChatImageAttachment.fileId`), so the agent gets the image to see and the real file to open, charged once. An image past the per-message frame budget, or one no frame can be made of, is sent as its original only and says `not shown inline`. Image originals bind to the draft like other files, so a draft with images now sends through an outgoing snapshot and comes back after a reload. Legacy draft images of existing drafts, and every image on a host without composer files, keep the old inline path. A sent image's row makes no claim about reading.
