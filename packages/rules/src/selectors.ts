/**
 * Turns a CSS selector into one that survives a redeploy, so the same element is recognized in the
 * next scan (fingerprints) and the same kind of element groups together.
 *
 * Removed: scoped-style hashes (`[data-v-1a2b3c]`), lazy-load/state attributes, CSS-in-JS class
 * names (`.css-1x2y3z`, `.sc-abc`, `.jsx-123`) and positional pseudo-classes. What is kept —
 * tags, ids and meaningful class names — is what a developer would search for in the code.
 */
export function stabilizeSelector(selector: string): string {
  return (
    selector
      .replace(/\[data-v-[0-9a-f]{6,}(?:=""|="[^"]*")?\]/gi, "")
      .replace(/\[lazy="[^"]*"\]/g, "")
      .replace(
        /\[(?:aria-(?:expanded|selected|pressed|checked|hidden|current|busy|disabled)|data-(?:state|status|active|open|loaded))="[^"]*"\]/g,
        "",
      )
      .replace(/\.(?:css|sc|jsx|emotion|styled)-[A-Za-z0-9_-]{4,}/g, "")
      // state classes that come and go while the page is used (sliders, menus, routers)
      .replace(
        /\.(?:swiper-slide-(?:active|next|prev|duplicate[\w-]*|visible)|swiper-container-[\w-]+|router-link-(?:exact-)?active|(?:is-|has-)?(?:active|open|opened|hover|focus|focused|selected|current|visible|loading|loaded|expanded|collapsed))(?![\w-])/g,
        "",
      )
      .replace(/:nth-(?:child|of-type|last-child|last-of-type)\(\d+\)/g, "")
      .replace(/(?:\s*>\s*){2,}/g, " > ")
      .replace(/\s{2,}/g, " ")
      .replace(/^\s*>\s*|\s*>\s*$/g, "")
      .trim()
  );
}

/**
 * The last few steps of a selector: what a developer would search for. Long absolute paths such as
 * `#app > div > .main-container > header > ... > .language-select` differ between copies of the
 * same component (and between the live DOM and a prerendered copy) while the tail does not.
 */
export function shortSelector(selector: string, steps = 2): string {
  const parts = stabilizeSelector(selector)
    .split(/\s*>\s*/)
    .filter(Boolean);
  return parts.slice(-steps).join(" > ");
}
