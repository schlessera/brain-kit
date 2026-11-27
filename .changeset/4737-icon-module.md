---
"@schlessera/brain-ui-react": patch
---

Internal: ui-react imports its lucide glyphs from one re-export module, and a lint gate refuses any other `lucide-react` import in the package (#4737). The two deprecated alias names it used (`AlertTriangle`, `BarChart3`) are now the canonical `TriangleAlert` and `ChartColumn`, the same glyphs. No glyph, size, class or export changes.
