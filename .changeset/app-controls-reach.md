---
"@schlessera/brain-ui-react": patch
---
Controls across chat, voice, activity, files, graph, connectivity, the page-failure screen, the diagnostic review and search no longer draw themselves 44px tall to meet the touch floor. They keep their kit size and, under a touch pointer, reach 44px past their paint. Rows of them that wrap get a wider row gap on touch only, so neighbouring targets never overlap.
