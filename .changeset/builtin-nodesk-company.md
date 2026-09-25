---
"@schlessera/brain-module-jobs": patch
---

The Built In and NoDesk boards now read the company from each job card instead of storing it as `Unknown`. Built In reads the card's company link; NoDesk reads the result card's company heading and no longer takes a neighbouring card's company. Rows already stored pick up the company on the next scrape.
