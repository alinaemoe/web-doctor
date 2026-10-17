export type Mode = "broken" | "fixed";

export const CATEGORY_COUNT = 18;

export const categorySlugs = Array.from(
  { length: CATEGORY_COUNT },
  (_, i) => `cat-${String(i + 1).padStart(2, "0")}`,
);
export const categoryPaths = categorySlugs.map((slug) => `/category/${slug}`);

/** HTML pages that a crawler starting at `/` is expected to reach. */
export const crawlablePaths = [
  "/",
  "/categories",
  ...categoryPaths,
  "/products/backpack",
  "/about",
  "/checkout",
  "/cart",
  "/size-guide",
  "/new-arrivals",
  "/flaky",
  /** Linked from nowhere: only the sitemap leads here. */
  "/orphan",
];

export interface RenderContext {
  mode: Mode;
  /** Origin the page is served from, e.g. `http://localhost:4000`. */
  origin: string;
  /** Origin of the "external" server (another port = another origin). */
  extOrigin: string;
}

interface LayoutOptions {
  title: string;
  description?: string;
  canonical?: string;
  head?: string;
  body: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function layout(ctx: RenderContext, o: LayoutOptions): string {
  const broken = ctx.mode === "broken";
  const footerLink = broken ? "/missing-page" : "/about";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
${o.description ? `<meta name="description" content="${esc(o.description)}">` : ""}
${o.canonical ? `<link rel="canonical" href="${o.canonical}">` : ""}
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/storefront.js" defer></script>
${o.head ?? ""}
</head>
<body>
<header>
  <nav aria-label="Main">
    <a href="/">Broken Shop</a>
    <a href="/categories">Categories</a>
    <a href="/products/backpack">Backpack</a>
    <a href="/new-arrivals">New arrivals</a>
    <a href="/flaky">Flash sale</a>
    <a href="/cart">Cart</a>
    <a href="/checkout">Checkout</a>
    <a href="/size-guide">Size guide</a>
    <a href="/about">About</a>
  </nav>
</header>
<main>
${o.body}
</main>
<footer>
  <a href="${footerLink}">Shipping policy</a>
</footer>
</body>
</html>
`;
}

export function renderHome(ctx: RenderContext): string {
  return layout(ctx, {
    title: "Broken Shop — home",
    description: "A demo shop with intentional defects for Web Doctor.",
    canonical: `${ctx.origin}/`,
    body: `<h1>Broken Shop</h1>
<p>Welcome. Browse <a href="/categories">all categories</a> or the <a href="/products/backpack">backpack</a>.</p>`,
  });
}

export function renderCategories(ctx: RenderContext): string {
  const items = categorySlugs
    .map((slug) => `<li><a href="/category/${slug}">Category ${slug.slice(4)}</a></li>`)
    .join("\n");
  return layout(ctx, {
    title: "Categories — Broken Shop",
    description: "All product categories.",
    canonical: `${ctx.origin}/categories`,
    body: `<h1>Categories</h1>\n<ul>\n${items}\n</ul>`,
  });
}

/** Broken: the category template renders no <h1> (one shared template -> 18 affected pages). */
export function renderCategory(ctx: RenderContext, slug: string): string {
  const n = slug.slice(4);
  const heading = ctx.mode === "broken" ? `<h2>Category ${n}</h2>` : `<h1>Category ${n}</h1>`;
  return layout(ctx, {
    title: `Category ${n} — Broken Shop`,
    description: `Products in category ${n}.`,
    canonical: `${ctx.origin}/category/${slug}`,
    body: `${heading}\n<p><a href="/products/backpack">Backpack</a></p>`,
  });
}

export function renderProduct(ctx: RenderContext): string {
  const broken = ctx.mode === "broken";
  const gallery = broken
    ? `<img class="product-gallery__main" src="/img/backpack-missing.jpg" alt="Backpack">`
    : `<img class="product-gallery__main" src="/img/backpack.svg" alt="Green backpack" width="320" height="240">`;
  const badge = broken
    ? `<img class="badge" src="/img/badge.svg">`
    : `<img class="badge" src="/img/badge.svg" alt="Free shipping" width="48" height="48">`;
  const secondHeading = broken ? `<h1>Reviews</h1>` : `<h2>Reviews</h2>`;
  return layout(ctx, {
    title: "Backpack — Broken Shop",
    description: "A sturdy backpack for everyday use.",
    canonical: `${ctx.origin}/products/backpack`,
    body: `<h1>Backpack</h1>
${gallery}
${badge}
${secondHeading}
<p>Great bag.</p>`,
  });
}

export function renderCheckout(ctx: RenderContext): string {
  const broken = ctx.mode === "broken";
  const field = broken
    ? `<input id="email" type="email" name="email">`
    : `<label for="email">Email</label>\n<input id="email" type="email" name="email">`;
  const iconButton = broken
    ? `<button class="icon-btn" type="button"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg></button>`
    : `<button class="icon-btn" type="button" aria-label="Apply coupon"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg></button>`;
  const hintColor = broken ? "#aaaaaa" : "#444444";
  return layout(ctx, {
    title: "Checkout — Broken Shop",
    description: "Complete your order.",
    canonical: `${ctx.origin}/checkout`,
    body: `<h1>Checkout</h1>
<form>
${field}
${iconButton}
<p class="hint" style="color:${hintColor};background:#ffffff">We never share your email.</p>
</form>`,
  });
}

export function renderCart(ctx: RenderContext): string {
  const script =
    ctx.mode === "broken" ? `<script>throw new Error("Cart init failed: id 4821");</script>` : "";
  return layout(ctx, {
    title: "Cart — Broken Shop",
    description: "Your cart.",
    canonical: `${ctx.origin}/cart`,
    body: `<h1>Cart</h1>\n<p>Your cart is empty.</p>\n${script}`,
  });
}

export function renderSizeGuide(ctx: RenderContext): string {
  const width = ctx.mode === "broken" ? "width:900px" : "max-width:100%";
  return layout(ctx, {
    title: "Size guide — Broken Shop",
    description: "How to pick the right size.",
    canonical: `${ctx.origin}/size-guide`,
    body: `<h1>Size guide</h1>\n<div class="size-table" style="${width};background:#eee">Sizes: S, M, L</div>`,
  });
}

export function renderNewArrivals(ctx: RenderContext): string {
  return layout(ctx, {
    title: "New arrivals — Broken Shop",
    description: "Fresh in the shop.",
    canonical: `${ctx.origin}/new-arrivals`,
    body: `<h1>New arrivals</h1>`,
  });
}

export function renderOrphan(ctx: RenderContext): string {
  return layout(ctx, {
    title: "Outlet — Broken Shop",
    description: "A page that only the sitemap knows about.",
    canonical: `${ctx.origin}/orphan`,
    body: `<h1>Outlet</h1>
<p>Nothing links here.</p>`,
  });
}

export function renderFlaky(ctx: RenderContext): string {
  return layout(ctx, {
    title: "Flash sale — Broken Shop",
    description: "Limited-time offers.",
    canonical: `${ctx.origin}/flaky`,
    body: `<h1>Flash sale</h1>`,
  });
}

/**
 * Broken: no meta description, canonical points to a 404, the page links to a 3-hop redirect
 * chain, a redirect loop and an external URL that answers 429.
 */
export function renderAbout(ctx: RenderContext): string {
  const broken = ctx.mode === "broken";
  const oldLink = broken ? "/old" : "/new-arrivals";
  const loopLink = broken ? `<li><a href="/loop-a">Archive</a></li>` : "";
  return layout(ctx, {
    title: "About — Broken Shop",
    description: broken ? undefined : "About the Broken Shop team.",
    canonical: broken ? `${ctx.origin}/gone` : `${ctx.origin}/about`,
    body: `<h1>About</h1>
<ul>
<li><a href="${oldLink}">Old arrivals</a></li>
${loopLink}
<li><a href="${ctx.extOrigin}/limited">Partner site</a></li>
</ul>`,
  });
}

export function renderSitemap(ctx: RenderContext): string {
  const paths = [...crawlablePaths, ...(ctx.mode === "broken" ? ["/gone"] : [])];
  const urls = paths.map((p) => `  <url><loc>${ctx.origin}${p}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function renderRobots(ctx: RenderContext): string {
  return `User-agent: *\nAllow: /\nSitemap: ${ctx.origin}/sitemap.xml\n`;
}

export function renderCss(mode: Mode): string {
  const font =
    mode === "broken"
      ? `@font-face { font-family: "ShopSans"; src: url("/fonts/missing.woff2") format("woff2"); }\nbody { font-family: "ShopSans", sans-serif; }`
      : `body { font-family: system-ui, sans-serif; }`;
  return `${font}
nav a, footer a { margin-right: 12px; }
.product-gallery__main { display: block; }
`;
}

const SCRIPT_BODY = `window.__shop = { ready: true };\n`;

/** Broken: ~450 KB bundle. Fixed: a few bytes. */
export function renderStorefrontJs(mode: Mode): string {
  if (mode === "fixed") return SCRIPT_BODY;
  const padding = "/* " + "x".repeat(1022) + " */\n";
  return SCRIPT_BODY + padding.repeat(450);
}

export const BACKPACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240"><rect width="320" height="240" fill="#4a7c59"/></svg>`;
export const BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="#c0392b"/></svg>`;
