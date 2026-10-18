import { describe, expect, it } from "vitest";
import { shortSelector, stabilizeSelector } from "./selectors";

describe("stabilizeSelector", () => {
  it("drops scoped-style hashes, lazy-load state and positions", () => {
    expect(
      stabilizeSelector('.card-container[lazy="loaded"][data-v-c6f22230=""]:nth-child(1)'),
    ).toBe(".card-container");
    expect(stabilizeSelector('.a[data-v-1a2b3c4d]:nth-of-type(3) > .b[data-v-0f0f0f0f=""]')).toBe(
      ".a > .b",
    );
  });

  it("drops CSS-in-JS class names but keeps meaningful ones", () => {
    expect(stabilizeSelector(".css-1x2y3z.nav-item")).toBe(".nav-item");
    expect(stabilizeSelector("div.sc-AbCdEf > a.jsx-12345.link")).toBe("div > a.link");
    expect(stabilizeSelector("#main .product-card")).toBe("#main .product-card");
  });

  it("drops transient ARIA/state attributes", () => {
    expect(stabilizeSelector('.menu[aria-expanded="true"] > .item[aria-selected="false"]')).toBe(
      ".menu > .item",
    );
  });

  it("keeps ids, tags and ordinary attributes", () => {
    expect(stabilizeSelector('input[type="checkbox"]')).toBe('input[type="checkbox"]');
    expect(stabilizeSelector("html")).toBe("html");
    expect(stabilizeSelector('a[target="_blank"]:nth-child(3)')).toBe('a[target="_blank"]');
  });

  it("does not leave dangling combinators behind", () => {
    expect(stabilizeSelector('.a > [data-v-1a2b3c4d=""] > .b')).toBe(".a > .b");
    expect(stabilizeSelector("")).toBe("");
  });

  it("gives the same result for the same element across builds", () => {
    const build1 = '.card[data-v-aaaaaaaa=""][lazy="loaded"]:nth-child(2)';
    const build2 = '.card[data-v-bbbbbbbb=""][lazy="loading"]:nth-child(9)';
    expect(stabilizeSelector(build1)).toBe(stabilizeSelector(build2));
  });
});

describe("stabilizeSelector: state classes", () => {
  it("drops classes that appear and disappear while the page is used", () => {
    expect(stabilizeSelector(".swiper-slide-next.swiper-slide > .card-container")).toBe(
      ".swiper-slide > .card-container",
    );
    expect(stabilizeSelector(".nav a.router-link-active.is-active.link")).toBe(".nav a.link");
    expect(
      stabilizeSelector(
        ".swiper-container.swiper-container-initialized.swiper-container-horizontal",
      ),
    ).toBe(".swiper-container");
  });

  it("keeps classes that merely start with a state word", () => {
    expect(stabilizeSelector(".active-users .opened-by")).toBe(".active-users .opened-by");
  });
});

describe("shortSelector", () => {
  it("keeps the last steps, so copies of one component look the same", () => {
    const a =
      '#app > div > .main-container > header > nav > .right-nav > .language-select[data-type="select-one"]';
    const b =
      '#prerender-content > div > .main-container > header > nav > .right-nav > .language-select[data-type="select-one"]';
    expect(shortSelector(a)).toBe('.right-nav > .language-select[data-type="select-one"]');
    expect(shortSelector(a)).toBe(shortSelector(b));
    expect(shortSelector(".language-select", 2)).toBe(".language-select");
    expect(shortSelector("a > b > c > d", 3)).toBe("b > c > d");
  });
});
