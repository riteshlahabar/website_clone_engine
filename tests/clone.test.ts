/**
 * Regression tests for the clone engine.
 *
 * Every case here is a defect that shipped — a clone of a real page came out
 * three times too tall, with its logo at 1254px, a whole section missing and
 * the hero split into three. The engine had no tests at all, which is how all
 * four survived to a live run. Each test names the symptom it prevents.
 */
import { describe, expect, it } from "vitest";
import { findSections, simplify, type SimpleNode } from "../server/clone/simplify.ts";
import { prepareCss, scopeSelector, SCOPE_CLASS } from "../server/clone/css.ts";
import { mapSection, toHex } from "../server/clone/map.ts";
import { extractMenu } from "../server/clone/theme.ts";
import { sanitizeHtml, mapSectionsHybrid } from "../server/clone/hybrid.ts";
import { describeComparison } from "../server/clone/compare.ts";
import type { StyleNode } from "../server/clone/extract.ts";

let nextRef = 1;

/** Build a style node without repeating the whole shape every time. */
function node(
  tag: string,
  rect: { x?: number; y?: number; width: number; height: number },
  styles: Record<string, string> = {},
  children: StyleNode[] = [],
  extra: Partial<StyleNode> = {},
): StyleNode {
  return {
    tag,
    ref: nextRef++,
    rect: { x: rect.x ?? 0, y: rect.y ?? 0, width: rect.width, height: rect.height },
    styles,
    children,
    ...extra,
  };
}

describe("simplify", () => {
  it("keeps a <section> that wraps a single child", () => {
    // The symptom: the test page's hero was `<section>` around one `<div>`, so
    // it was folded away, and band detection then emitted its <h1> and <p> as
    // two separate full-width bands.
    const tree = node("body", { width: 1440, height: 800 }, {}, [
      node("section", { width: 1440, height: 800 }, { display: "block" }, [
        node("div", { width: 1200, height: 800 }, {}, [
          node("h1", { width: 1200, height: 100 }, {}, [], { text: "Hero" }),
        ]),
      ]),
    ]);

    // `body` and the inner `div` are scaffolding and fold away; the `<section>`
    // must not, so it ends up as the root here.
    expect(simplify(tree)!.tag).toBe("section");
  });

  it("keeps a sticky or fixed wrapper, which is doing layout work", () => {
    const tree = node("body", { width: 1440, height: 400 }, {}, [
      node("div", { width: 1440, height: 83 }, { position: "fixed" }, [
        node("div", { width: 1200, height: 83 }, {}, [], { text: "Nav" }),
      ]),
    ]);

    // `body` is scaffolding and folds away, so the fixed wrapper becomes the
    // root. What matters is that it survived rather than being folded into the
    // div inside it.
    const simplified = simplify(tree)!;
    expect(simplified.styles["position"]).toBe("fixed");
    expect(simplified.children).toHaveLength(1);
  });

  it("still folds a wrapper that is pure scaffolding", () => {
    const tree = node("div", { width: 1440, height: 400 }, { "padding-top": "20px" }, [
      node("p", { width: 1440, height: 400 }, { "padding-top": "10px" }, [], { text: "Copy" }),
    ]);

    const simplified = simplify(tree)!;
    expect(simplified.tag).toBe("p");
    // The wrapper's padding is added to the child's, because the browser
    // applied both.
    expect(simplified.styles["padding-top"]).toBe("30px");
  });
});

describe("findSections", () => {
  /** A page shaped like the test site: nav, four stacked sections, footer. */
  function page(sectionHeights: number[]): SimpleNode {
    let y = 83;
    const sections = sectionHeights.map((height) => {
      const current = y;
      y += height;
      return node("section", { y: current, width: 1440, height }, { display: "block" }, [
        node("div", { y: current, width: 1200, height }, {}, [], { text: "Content" }),
      ]);
    });
    return simplify(
      node("body", { width: 1440, height: y + 500 }, {}, [
        node("div", { width: 1440, height: y + 500 }, { display: "flex", "flex-direction": "column" }, [
          node("nav", { y: 0, width: 1440, height: 83 }, {}, [], { text: "Nav" }),
          node("main", { y: 83, width: 1440, height: y - 83 }, {}, [
            node("div", { y: 83, width: 1440, height: y - 83 }, {}, sections),
          ]),
          node("footer", { y, width: 1440, height: 500 }, {}, [], { text: "Footer" }),
        ]),
      ]),
    )!;
  }

  it("finds one band per section, plus the nav and the footer", () => {
    const bands = findSections(page([700, 240, 900, 930]));
    expect(bands.map((band) => band.tag)).toEqual([
      "nav", "section", "section", "section", "section", "footer",
    ]);
  });

  it("gives the nav and footer their chrome roles", () => {
    const bands = findSections(page([700, 240]));
    expect(bands[0]!.role).toBe("header");
    expect(bands.at(-1)!.role).toBe("footer");
  });

  it("treats a row of cards as one band, not one band per card", () => {
    // The symptom: a four-card grid was descended into, and each card was then
    // dropped for being narrower than 40% of the page — deleting the section.
    const cards = [0, 1, 2, 3].map((index) =>
      node("div", { x: index * 320, y: 750, width: 300, height: 238 }, {}, [], { text: `Card ${index}` }),
    );
    const tree = simplify(
      node("body", { width: 1440, height: 1000 }, {}, [
        node("section", { y: 750, width: 1440, height: 238 }, { display: "block" }, [
          node(
            "div",
            { y: 750, width: 1280, height: 238 },
            { display: "grid", "grid-template-columns": "300px 300px 300px 300px" },
            cards,
          ),
        ]),
      ]),
    )!;

    const bands = findSections(tree);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.tag).toBe("section");
  });

  it("still treats bands that overlap by a negative margin as stacked", () => {
    // `-mt-16` pulling one band up over the hero is a common device and must
    // not be read as "these are layered, so the parent is the band".
    const tree = simplify(
      node("body", { width: 1440, height: 1200 }, {}, [
        node("div", { width: 1440, height: 1200 }, {}, [
          node("section", { y: 0, width: 1440, height: 800 }, { display: "block" }, [
            node("div", { y: 0, width: 1200, height: 800 }, {}, [], { text: "Hero" }),
          ]),
          node("section", { y: 736, width: 1440, height: 400 }, { display: "block" }, [
            node("div", { y: 736, width: 1200, height: 400 }, {}, [], { text: "Cards" }),
          ]),
        ]),
      ]),
    )!;

    expect(findSections(tree)).toHaveLength(2);
  });

  it("never drops a band for being narrow", () => {
    const tree = simplify(
      node("body", { width: 1440, height: 300 }, {}, [
        node("div", { x: 570, width: 300, height: 300 }, { "background-color": "rgb(0, 0, 0)" }, [], {
          text: "Narrow but real",
        }),
      ]),
    )!;

    expect(findSections(tree).length).toBeGreaterThan(0);
  });
});

describe("css scoping", () => {
  it("confines a selector beneath the scope class", () => {
    expect(scopeSelector(".card")).toBe(`.${SCOPE_CLASS} .card`);
  });

  it("rewrites page-level selectors to the wrapper itself", () => {
    expect(scopeSelector("body .card")).toBe(`.${SCOPE_CLASS} .card`);
    expect(scopeSelector(":root")).toBe(`.${SCOPE_CLASS}`);
  });

  it("flattens @layer so cloned rules are not outranked by theme CSS", () => {
    // The symptom: a Tailwind v4 source puts everything in @layer, and an
    // unlayered `img { height: auto }` from hello-elementor beat
    // `.wpc-clone .h-14` no matter how specific it was — the cloned logo
    // rendered at 1254px instead of 56px.
    const { css } = prepareCss(`
      @layer theme, base, utilities;
      @layer theme { :root { --spacing: 0.25rem } }
      @layer utilities { .h-14 { height: calc(var(--spacing) * 14) } }
    `);

    expect(css).not.toMatch(/@layer/);
    expect(css).toContain(`.${SCOPE_CLASS} .h-14`);
    expect(css).toContain(`.${SCOPE_CLASS}`);
  });

  it("leaves @media intact while scoping the rules inside it", () => {
    const { css } = prepareCss("@media (min-width: 768px) { .card { display: flex } }");
    expect(css).toContain("@media (min-width: 768px)");
    expect(css).toContain(`.${SCOPE_CLASS} .card`);
  });

  it("does not scope the inside of @keyframes or @font-face", () => {
    const { css, fontUrls } = prepareCss(`
      @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
      @font-face { font-family: Inter; src: url(/f/inter.woff2) format("woff2") }
    `, { baseUrl: "https://example.com/css/site.css" });

    expect(css).toContain("from {");
    expect(css).not.toContain(`.${SCOPE_CLASS} from`);
    expect(fontUrls).toEqual(["https://example.com/f/inter.woff2"]);
  });
});

describe("map", () => {
  it("lays a CSS grid out as a row, not a stack", () => {
    // The symptom: `display: grid` carried no `flex-direction`, so every grid
    // became a column and the cloned page came out three times too tall.
    const grid = node(
      "div",
      { width: 1200, height: 240 },
      { display: "grid", "grid-template-columns": "1fr 1fr 1fr" },
      [0, 1, 2].map((index) =>
        node("div", { x: index * 400, width: 380, height: 240 }, {}, [], { text: `Card ${index}` }),
      ),
    );

    const { elements } = mapSection(grid as SimpleNode);
    expect(elements[0]!.settings.flex_direction).toBe("row");
    expect(elements[0]!.settings.flex_wrap).toBe("wrap");
  });

  it("gives a row's children their real width share, never zero", () => {
    // The symptom: the width was written as a literal `size: 0`, so every
    // column claimed 0% and Elementor rendered slivers.
    const row = node(
      "div",
      { width: 1200, height: 240 },
      { display: "flex", "flex-direction": "row" },
      [
        // Containers, not leaves: a leaf carrying text becomes a widget, and
        // only containers take a width.
        node("div", { width: 800, height: 240 }, {}, [
          node("p", { width: 800, height: 40 }, {}, [], { text: "Wide" }),
        ]),
        node("div", { width: 400, height: 240 }, {}, [
          node("p", { width: 400, height: 40 }, {}, [], { text: "Narrow" }),
        ]),
      ],
    );

    const container = mapSection(row as SimpleNode).elements[0]!;
    const widths = container.elements.map(
      (child) => (child.settings.width as { size: number } | undefined)?.size,
    );
    expect(widths).toEqual([66.7, 33.3]);
  });

  it("keeps a background image that sits over a background colour", () => {
    const hero = node(
      "section",
      { width: 1440, height: 800 },
      {
        "background-color": "rgb(18, 12, 6)",
        "background-image": 'url("https://example.com/hero.jpg")',
      },
      [node("h1", { width: 600, height: 80 }, {}, [], { text: "Title" })],
    );

    const settings = mapSection(hero as SimpleNode).elements[0]!.settings;
    expect(settings.background_color).toBe("#120C06");
    expect(settings.background_image).toEqual({ url: "https://example.com/hero.jpg", id: "" });
  });

  it("reports a gradient it cannot express rather than dropping it silently", () => {
    const band = node(
      "section",
      { width: 1440, height: 400 },
      { "background-image": "linear-gradient(to right, rgb(0,0,0), rgb(255,255,255))" },
      [node("p", { width: 600, height: 40 }, {}, [], { text: "Copy" })],
    );

    expect(mapSection(band as SimpleNode).unmapped).toContainEqual({
      tag: "section",
      reason: "css gradient background",
    });
  });

  it("converts rgb to the hex Elementor stores, and drops fully transparent", () => {
    expect(toHex("rgb(178, 135, 52)")).toBe("#B28734");
    expect(toHex("rgba(0, 0, 0, 0)")).toBeUndefined();
  });
});

describe("sanitizeHtml", () => {
  it("strips style and link, which the bundle already carries scoped", () => {
    // Leaving them inline re-admitted the same rules unscoped, free to restyle
    // the WordPress admin bar and the theme.
    const html = sanitizeHtml(
      `<div><style>body{color:red}</style><link rel="stylesheet" href="/a.css"><p>Hi</p></div>`,
    );
    expect(html).not.toMatch(/<style|<link/i);
    expect(html).toContain("<p>Hi</p>");
  });

  it("removes scripts and inline handlers", () => {
    const html = sanitizeHtml(`<div onclick="go()"><script>go()</script><p>Hi</p></div>`);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
  });

  it("redirects assets, a video poster and internal links", () => {
    const html = sanitizeHtml(
      `<div><video poster="/p.jpg" src="/v.mp4"></video><a href="/about">About</a></div>`,
      {
        baseUrl: "https://example.com/",
        rewriteAsset: (url) => `/local/${url.split("/").pop()}`,
        rewriteLink: (url) =>
          url === "https://example.com/about" ? "http://localhost/clone/about/" : null,
      },
    );
    expect(html).toContain('poster="/local/p.jpg"');
    expect(html).toContain('src="/local/v.mp4"');
    expect(html).toContain('href="http://localhost/clone/about/"');
  });
});

describe("extractMenu", () => {
  it("swaps a <ul> nav for wp_nav_menu, keeping its classes", () => {
    const { html, items } = extractMenu(
      `<nav><ul class="menu flex"><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul></nav>`,
    );
    expect(items).toEqual([
      { title: "A", url: "/a" },
      { title: "B", url: "/b" },
    ]);
    expect(html).toContain("wp_nav_menu");
    expect(html).toContain("'menu_class' => 'menu flex'");
  });

  it("reads a nav built from bare anchors but leaves its markup alone", () => {
    // `wp_nav_menu()` emits `<ul><li><a>`. Substituting that for a flex row of
    // anchors carrying icons replaces a nav that renders perfectly with one
    // that does not, so these are read for the WordPress menu only.
    const source = `<nav class="flex gap-6"><a href="/a">A</a><a href="/b">B</a></nav>`;
    const { html, items } = extractMenu(source);
    expect(items).toHaveLength(2);
    expect(html).toBe(source);
  });

  it("returns nothing for markup with no navigation", () => {
    expect(extractMenu("<div><p>No nav here</p></div>").items).toEqual([]);
  });
});

describe("mapSectionsHybrid", () => {
  const band = {
    ...node("section", { width: 1440, height: 400 }, {}, [], { text: "Copy" }),
    role: "section" as const,
    html: "<section><p>Copy</p></section>",
  };

  it("exact mode keeps every band as markup", () => {
    const result = mapSectionsHybrid([band], { mode: "exact", threshold: 0.25 });
    expect(result.decisions.map((d) => d.mode)).toEqual(["html"]);
    expect(result.elements[0]!.widgetType).toBe("html");
    expect(result.elements[0]!.settings.html).toContain(SCOPE_CLASS);
  });

  it("editable mode never falls back to markup", () => {
    const withVideo = { ...band, html: "<section><video src='/v.mp4'></video></section>" };
    const result = mapSectionsHybrid([withVideo], { mode: "editable", threshold: 0.25 });
    expect(result.decisions.every((d) => d.mode === "native")).toBe(true);
  });

  it("auto mode keeps markup for a band holding something unmappable", () => {
    const withForm = { ...band, html: "<section><form><input></form></section>" };
    const result = mapSectionsHybrid([withForm], { mode: "auto", threshold: 0.25 });
    expect(result.decisions[0]!.mode).toBe("html");
    expect(result.decisions[0]!.reason).toContain("<form>");
  });
});

describe("describeComparison", () => {
  const base = {
    sourceUrl: "https://example.com/",
    cloneUrl: "http://localhost/clone/",
    source: { width: 1440, height: 3500 },
    clone: { width: 1440, height: 3500 },
  };

  it("calls out a collapsed layout by its height, not its pixels", () => {
    const text = describeComparison({ ...base, heightRatio: 2.45, difference: 0.3 });
    expect(text).toContain("stacked vertically");
  });

  it("distinguishes a matching layout that is painted wrong", () => {
    const text = describeComparison({ ...base, heightRatio: 1.0, difference: 0.55 });
    expect(text).toContain("stylesheet");
  });

  it("reports a close match plainly", () => {
    const text = describeComparison({ ...base, heightRatio: 1.0, difference: 0.08 });
    expect(text).toContain("8.0% of pixels differ");
    expect(text).not.toContain("stacked");
  });
});
