/**
 * Turns a live page into a simplified style tree.
 *
 * Runs in the browser via Playwright so we read *computed* styles after
 * JavaScript, CSS cascade, media queries and web fonts have all resolved.
 * Parsing the raw HTML/CSS instead would miss almost everything that matters.
 *
 * The output is deliberately lossy: everything invisible, decorative-only or
 * structurally redundant is dropped here, so the mapper downstream deals with
 * a tree that already resembles the Elementor model.
 *
 * Two deliberate choices support the phases downstream:
 *
 * - Every surviving node gets a `ref`, which is also stamped onto the live
 *   element as `data-wpc-ref`. The hybrid mapper can then ask the page for one
 *   section's original markup by ref instead of us carrying every node's
 *   outerHTML in the tree — on a real page the tree is already 3.6MB.
 * - The browser is supplied by the caller (`extractFromPage`) so a crawl of
 *   twenty pages launches Chromium once rather than twenty times.
 */
import { chromium, type Browser, type Page } from "playwright";

/** A node after pruning and simplification, with the styles the mapper needs. */
export type StyleNode = {
  tag: string;
  /** Index of this node in the extraction walk; `data-wpc-ref` in the page. */
  ref: number;
  /** Visible text, for leaf-ish nodes only. */
  text?: string;
  /** Resolved absolute URL for images. */
  src?: string;
  alt?: string;
  /** Resolved absolute URL for links. */
  href?: string;
  /** Layout box, used to infer section boundaries and column widths. */
  rect: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  children: StyleNode[];
};

export type ExtractResult = {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  /** Page-level palette and fonts, ranked by how much area they cover. */
  palette: Array<{ color: string; weight: number }>;
  fonts: Array<{ family: string; weight: number }>;
  tree: StyleNode;
  /** Every image URL seen, for the media upload step. */
  images: string[];
  /** Video and audio sources, which are localized into the theme's assets. */
  media: string[];
  /** Links found on the page, absolute, for the crawler. */
  links: string[];
  /** Present only when no `screenshotPath` was given. */
  screenshot?: Buffer;
  /** Where the full-page screenshot was written, when a path was given. */
  screenshotPath?: string;
};

/**
 * Properties read for every node. Kept to the set the Elementor mapper can
 * actually express — reading all ~340 computed properties makes the payload
 * enormous and tells us nothing extra.
 */
export const STYLE_PROPS = [
  "display", "position", "flex-direction", "flex-wrap", "justify-content",
  "align-items", "gap", "row-gap", "column-gap",
  "grid-template-columns",
  "width", "max-width", "height", "min-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "background-color", "background-image",
  "color", "font-family", "font-size", "font-weight", "font-style",
  "line-height", "letter-spacing", "text-align", "text-transform",
  "border-radius", "border-top-width", "border-color", "border-style",
  "box-shadow", "opacity", "z-index",
] as const;

/** A desktop UA: some sites serve a stripped page to obvious automation. */
export const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type ExtractOptions = {
  /** Desktop width. Elementor's own breakpoints are keyed to this. */
  width?: number;
  height?: number;
  /** Extra wait for lazy content after network idle. */
  settleMs?: number;
  timeoutMs?: number;
  /**
   * Write the full-page screenshot straight to this path instead of returning
   * a Buffer. A full-page PNG runs to several megabytes, so a multi-page crawl
   * that held them all in memory would be wasteful.
   */
  screenshotPath?: string;
};

/** Launch a browser configured the way extraction expects. */
export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ args: ["--disable-dev-shm-usage"] });
}

/**
 * Open a URL in its own context, wait for it to settle, and hand the page to
 * `fn`. The context is always torn down afterwards.
 *
 * Exposed because the capture phase needs the page to stay open past
 * extraction: section markup and stylesheet text are read from the live
 * document, and reopening the page to fetch them would double the work.
 */
export async function withPage<T>(
  browser: Browser,
  url: string,
  options: ExtractOptions,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    viewport: {
      width: options.width ?? 1440,
      height: options.height ?? 900,
    },
    deviceScaleFactor: 1,
    userAgent: DESKTOP_UA,
  });
  try {
    const page = await context.newPage();
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: options.timeoutMs ?? 60_000,
    });
    await settle(page, options.settleMs ?? 800);
    return await fn(page);
  } finally {
    await context.close();
  }
}

/** Run the in-page extraction on a page that has already settled. */
export async function extractOnPage(page: Page) {
  return page.evaluate(extractInPage, {
    props: STYLE_PROPS as unknown as string[],
  });
}

/**
 * Stop everything that moves, so two screenshots of the same page are the same
 * picture.
 *
 * Without this the visual check measures the clock as much as the clone: the
 * test page has two background videos, and comparing a source screenshot with
 * a clone screenshot taken seconds later reported ~18% of pixels different
 * when the pages were in fact laid out identically. Videos are rewound to
 * their first frame and CSS animation is disabled; both pages get the same
 * treatment, so the comparison stays fair.
 */
async function freezeMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-play-state: paused !important;
      animation-delay: -1ms !important;
      animation-duration: 1ms !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      scroll-behavior: auto !important;
      caret-color: transparent !important;
    }`,
  });
  await page.evaluate(async () => {
    const media = Array.from(document.querySelectorAll("video, audio"));
    for (const element of media as HTMLMediaElement[]) {
      try {
        element.pause();
        element.currentTime = 0;
      } catch {
        // A media element that is not ready cannot be seeked; leave it.
      }
    }
    // One frame, so the paused frame is painted before the shot.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

/** Full-page screenshot, written to disk when a path is given. */
export async function screenshotPage(
  page: Page,
  screenshotPath?: string,
): Promise<Buffer> {
  await freezeMotion(page);
  return page.screenshot({
    fullPage: true,
    type: "png",
    ...(screenshotPath ? { path: screenshotPath } : {}),
  });
}

/**
 * Extract one page using a browser the caller owns. Navigation happens here
 * because extraction depends on the page having settled.
 */
export async function extractFromPage(
  browser: Browser,
  url: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const width = options.width ?? 1440;
  const height = options.height ?? 900;

  return withPage(browser, url, options, async (page) => {
    const extracted = await extractOnPage(page);
    const screenshot = await screenshotPage(page, options.screenshotPath);
    return {
      url,
      title: await page.title(),
      viewport: { width, height },
      ...extracted,
      ...(options.screenshotPath
        ? { screenshotPath: options.screenshotPath }
        : { screenshot }),
    };
  });
}

/**
 * One-shot extraction: launches and closes its own browser. Convenient for a
 * single page; a crawl should reuse one browser via `extractFromPage`.
 */
export async function extractPage(
  url: string,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const browser = await launchBrowser();
  try {
    return await extractFromPage(browser, url, options);
  } finally {
    await browser.close();
  }
}

/**
 * Scroll the full height to trigger lazy-loaded images and reveal animations,
 * then return to the top before measuring.
 */
async function settle(page: Page, settleMs: number): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let y = 0;
      const step = () => {
        y += window.innerHeight;
        window.scrollTo(0, y);
        if (y < document.body.scrollHeight) {
          setTimeout(step, 100);
        } else {
          window.scrollTo(0, 0);
          setTimeout(resolve, 400);
        }
      };
      step();
    });
  });
  await page.waitForTimeout(settleMs);
}

/**
 * Runs inside the page. Must be self-contained — it is serialised across the
 * boundary, so it cannot reference anything from module scope.
 */
function extractInPage({ props }: { props: string[] }) {
  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "meta", "link", "head", "title",
    "svg", "path", "iframe", "template", "br", "hr",
  ]);

  const colorWeights = new Map<string, number>();
  const fontWeights = new Map<string, number>();
  const images: string[] = [];
  const media: string[] = [];
  const links: string[] = [];
  let nextRef = 0;

  const isVisible = (element: Element, style: CSSStyleDeclaration): boolean => {
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    // Zero-area nodes carry no layout meaning. Sticky headers can legitimately
    // sit off-screen vertically, so only width is treated as disqualifying.
    return rect.width > 0 && rect.height > 0;
  };

  const ownText = (element: Element): string => {
    let text = "";
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
    }
    return text.replace(/\s+/g, " ").trim();
  };

  const record = (style: CSSStyleDeclaration, area: number) => {
    const background = style.backgroundColor;
    if (background && !/rgba\(0, 0, 0, 0\)|transparent/.test(background)) {
      colorWeights.set(background, (colorWeights.get(background) ?? 0) + area);
    }
    const color = style.color;
    if (color) colorWeights.set(color, (colorWeights.get(color) ?? 0) + area * 0.2);

    const family = (style.fontFamily ?? "").split(",")[0]?.replace(/["']/g, "").trim();
    if (family) fontWeights.set(family, (fontWeights.get(family) ?? 0) + area);
  };

  type Node_ = {
    tag: string;
    ref: number;
    text?: string;
    src?: string;
    alt?: string;
    href?: string;
    rect: { x: number; y: number; width: number; height: number };
    styles: Record<string, string>;
    children: Node_[];
  };

  const walk = (element: Element, depth: number): Node_ | null => {
    const tag = element.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;
    if (depth > 40) return null;

    const style = window.getComputedStyle(element);
    if (!isVisible(element, style)) return null;

    const box = element.getBoundingClientRect();
    const rect = {
      x: Math.round(box.x),
      y: Math.round(box.y + window.scrollY),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
    record(style, rect.width * rect.height);

    const styles: Record<string, string> = {};
    for (const property of props) {
      const value = style.getPropertyValue(property);
      if (value) styles[property] = value;
    }

    const children: Node_[] = [];
    for (const child of Array.from(element.children)) {
      const mapped = walk(child, depth + 1);
      if (mapped) children.push(mapped);
    }

    // The ref is stamped on the element so a later pass can ask for this
    // node's outerHTML by selector, without us serialising all the markup.
    const ref = nextRef;
    nextRef += 1;
    element.setAttribute("data-wpc-ref", String(ref));

    const node: Node_ = { tag, ref, rect, styles, children };

    const text = ownText(element);
    if (text) node.text = text;

    if (tag === "img") {
      const image = element as HTMLImageElement;
      const source = image.currentSrc || image.src;
      if (source) {
        node.src = source;
        images.push(source);
      }
      node.alt = image.alt ?? "";

      // Every `srcset` candidate, not just the one this viewport chose. Taking
      // only `currentSrc` left the other candidates pointing at the source
      // host, so a clone viewed at a different width silently fetched its
      // images from the original site — and broke outright once that site went
      // away. `<picture>` sources are read the same way.
      const sets = [image.getAttribute("srcset")];
      const picture = element.parentElement;
      if (picture && picture.tagName.toLowerCase() === "picture") {
        for (const candidate of Array.from(picture.querySelectorAll("source"))) {
          sets.push(candidate.getAttribute("srcset"));
        }
      }
      for (const set of sets) {
        if (!set) continue;
        for (const candidate of set.split(",")) {
          const url = candidate.trim().split(/\s+/)[0];
          if (url && !url.startsWith("data:")) {
            images.push(new URL(url, location.href).href);
          }
        }
      }
    }

    // Video and audio. Their `<source>` children are zero-area, so the walk
    // never reaches them — they are read here or not at all, and a hero with a
    // background video would otherwise keep streaming from the original host.
    if (tag === "video" || tag === "audio") {
      const own = (element as HTMLMediaElement).currentSrc ||
        element.getAttribute("src") || "";
      if (own && !own.startsWith("data:")) media.push(new URL(own, location.href).href);
      const poster = element.getAttribute("poster");
      if (poster && !poster.startsWith("data:")) {
        images.push(new URL(poster, location.href).href);
      }
      for (const source of Array.from(element.querySelectorAll("source"))) {
        const value = source.getAttribute("src");
        if (value && !value.startsWith("data:")) {
          media.push(new URL(value, location.href).href);
        }
      }
    }

    // A CSS background image is a real image for our purposes.
    const background = styles["background-image"];
    if (background && background !== "none") {
      const match = /url\(["']?(.*?)["']?\)/.exec(background);
      if (match?.[1] && !match[1].startsWith("data:")) {
        images.push(new URL(match[1], location.href).href);
      }
    }

    if (tag === "a") {
      const href = (element as HTMLAnchorElement).href;
      if (href) {
        node.href = href;
        links.push(href);
      }
    }

    // Drop containers that hold neither content nor visible styling.
    const hasContent = Boolean(node.text || node.src || children.length > 0);
    if (!hasContent) {
      const paints =
        (styles["background-color"] &&
          !/rgba\(0, 0, 0, 0\)|transparent/.test(styles["background-color"])) ||
        (background && background !== "none");
      if (!paints) return null;
    }

    return node;
  };

  const root = walk(document.body, 0);

  const rank = (map: Map<string, number>) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([value, weight]) => ({ value, weight: Math.round(weight) }));

  return {
    palette: rank(colorWeights).map((entry) => ({
      color: entry.value,
      weight: entry.weight,
    })),
    fonts: rank(fontWeights).map((entry) => ({
      family: entry.value,
      weight: entry.weight,
    })),
    tree: root ?? {
      tag: "body",
      ref: -1,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      styles: {},
      children: [],
    },
    images: [...new Set(images)],
    media: [...new Set(media)],
    links: [...new Set(links)],
  };
}
