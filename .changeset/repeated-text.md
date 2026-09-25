---
"@schlessera/brain": minor
---

`brain audit` reports a paragraph copied into many documents. A generated set tends to repeat the same boilerplate (a disclaimer, a method note) in every file, and each copy is chunked, contextualised and embedded on its own, so near-identical vectors crowd the results of any query they match. The new corpus-wide `repeated-text` check reports, as one `info` issue with `path: "(corpus)"`, each paragraph of at least 200 characters that at least 5 documents carry. It names the document count, the first three paths and the paragraph's opening. Paragraphs are compared with whitespace collapsed, and text inside code is not counted. The check only reports; it never edits.
