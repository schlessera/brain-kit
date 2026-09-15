(() => {
  const KEYS = ["display","alignItems","justifyContent","gap","flex","boxSizing",
    "padding","borderRadius","borderTopWidth","borderTopStyle","borderTopColor","borderLeftWidth","borderLeftStyle","borderLeftColor",
    "backgroundColor","backgroundImage","color","fontFamily","fontSize","fontWeight","lineHeight",
    "letterSpacing","textTransform","whiteSpace","marginLeft","marginTop","overflow","animationName","animationDuration","animationDelay","position","left","top","textAlign","wordBreak","transition"];
  // The DC runtime wraps every component in div.sc-host and every scalar text
  // hole in span.sc-interp. Neither exists in the React port by design, so both
  // are transparent here and the walk descends through them.
  const skip = (el) => el.classList && (el.classList.contains("sc-host") || el.classList.contains("sc-interp"));
  const walk = (el, depth) => {
    if (depth > 12 || !el) return [];
    const kids = [...el.children].flatMap((c) => walk(c, depth + 1));
    if (skip(el)) return kids;
    const cs = getComputedStyle(el);
    const row = { tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 24) };
    for (const k of KEYS) row[k] = cs[k];
    return [row, ...kids];
  };
  const root = document.querySelector(ROOT_SELECTOR);
  return JSON.stringify(walk(root, 0));
})()
