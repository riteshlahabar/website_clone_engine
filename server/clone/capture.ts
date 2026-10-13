/**
 * Captures everything one page visit can give us, in a single visit.
 *
 * Extraction, section segmentation, original markup and stylesheet text all
 * come from the same loaded document. Doing them in separate passes would mean
 * loading a heavy page two or three times, and a twenty-page crawl cannot
 * afford that.
 *
 * The browser belongs to the session, not to a page: Chromium launches once
 * for the whole crawl.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  DESKTOP_UA,
  extractOnPage,
  launchBrowser,
  screenshotPage,
  withPage,
  type ExtractOptions,
  type StyleNode,
} from "./extract.ts";
import { findSections, simplify, treeStats, type Section } from "./simplify.ts";
import { PATHS } from "../lib/env.ts";
import type { JobLogger } from "../lib/jobs.ts";

/** A detected band, with the markup it came from for the HTML fallback. */
export type CapturedSection = Section & {
  /** The source element's outerHTML, as rendered. */
  html: string;
};

export type CapturedStylesheet = {
  /** Null for an inline <style> block. */
  href: string | null;
  css: string;
};

/**
 * The element chain wrapping the page's bands, as opening and closing tags.
 *
 * A band's markup alone is not enough to reproduce it. Modern CSS routinely
 * styles an element through its ancestors — `.flex > *`, `.group:hover .icon`,
 * a `:root` custom property, or simply a layout the parent establishes. Lift a
 * band out of that chain and those rules stop matching.
 *
 * The test page is a plain example: its bands sit inside
 * `div.min-h-screen.bg-beige-50.flex.flex-col.pt-[83px]`, and that `pt-[83px]`
 * is the only thing keeping content from sliding under the fixed navbar.
 *
 * Two chains, because the generated theme has two places to put them:
 * `page` wraps everything (header.php opens it, footer.php closes it) and
 * `main` wraps just the page body, between the chrome.
 */
export type CapturedShell = {
  page: { open: string[]; close: string[] };
  main: { open: string[]; close: string[] };
};

/**
 * Runs in the page. Walks up from the captured bands to find the chain each
 * one hangs off, and serialises it as bare open/close tags.
 */
function collectShellInPage({ allRefs, bodyRefs }: { allRefs: number[]; bodyRefs: number[] }) {
  const elementFor = (ref: number) => document.querySelector(`[data-wpc-ref="${ref}"]`);

  /** body → node, exclusive of body, inclusive of node. */
  const chainOf = (node: Element): Element[] => {
    const out: Element[] = [];
    let current: Element | null = node;
    while (current && current !== document.body) {
      out.unshift(current);
      current = current.parentElement;
    }
    return out;
  };

  /** The deepest element that is an ancestor of every ref given. */
  const commonParent = (refs: number[]): Element[] => {
    const chains = refs
      .map(elementFor)
      .filter((node): node is Element => node !== null)
      .map((node) => chainOf(node).slice(0, -1)); // the band itself is not a wrapper
    if (chains.length === 0) return [];
    let shared = chains[0]!;
    for (const chain of chains.slice(1)) {
      let index = 0;
      while (index < shared.length && index < chain.length && shared[index] === chain[index]) {
        index += 1;
      }
      shared = shared.slice(0, index);
    }
    return shared;
  };

  const openTag = (node: Element): string => {
    const attributes = Array.from(node.attributes)
      .filter((attribute) => attribute.name !== "data-wpc-ref")
      .map((attribute) => ` ${attribute.name}="${attribute.value.replace(/"/g, "&quot;")}"`)
      .join("");
    return `<${node.tagName.toLowerCase()}${attributes}>`;
  };

  const serialize = (nodes: Element[]) => ({
    open: nodes.map(openTag),
    close: nodes.map((node) => `</${node.tagName.toLowerCase()}>`).reverse(),
  });

  const pageChain = commonParent(allRefs);
  const bodyChain = commonParent(bodyRefs);
  // The body chain extends the page chain; only the extra levels belong to main.
  const extra = bodyChain.slice(pageChain.length);

  return { page: serialize(pageChain), main: serialize(extra) };
}

export type CapturedPage = {
  url: string;
  slug: string;
  title: string;
  viewport: { width: number; height: number };
  palette: Array<{ color: string; weight: number }>;
  fonts: Array<{ family: string; weight: number }>;
  images: string[];
  media: string[];
  links: string[];
  sections: CapturedSection[];
  shell: CapturedShell;
  stylesheets: CapturedStylesheet[];
  screenshotPath: string;
  stats: { nodes: number; depth: number; collapsed: number };
};

/**
 * Read every stylesheet the document has. Runs in the page, so it sees the
 * cascade as applied — including sheets injected by scripts.
 *
 * A cross-origin sheet throws on `cssRules` access, so it is reported as
 * blocked and fetched over HTTP from node instead.
 */
function collectStylesheetsInPage() {
  const sheets: Array<{ href: string | null; css: string | null; blocked: boolean }> = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let css: string | null = null;
    let blocked = false;
    try {
      css = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
    } catch {
      // Cross-origin: the rules are unreadable from script.
      blocked = true;
    }
    sheets.push({ href: sheet.href ?? null, css, blocked });
  }
  return sheets;
}

/** Fetch a stylesheet node could not read from inside the page. */
async function fetchStylesheet(href: string): Promise<string | null> {
  try {
    const response = await fetch(href, {
      headers: { "user-agent": DESKTOP_UA, accept: "text/css,*/*" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** Pull the original markup for a set of node refs, in one round trip. */
async function markupForRefs(page: Page, refs: number[]): Promise<Map<number, string>> {
  const pairs = await page.evaluate((wanted: number[]) => {
    return wanted.map((ref) => {
      const element = document.querySelector(`[data-wpc-ref="${ref}"]`);
      return [ref, element ? element.outerHTML : ""] as [number, string];
    });
  }, refs);
  return new Map(pairs);
}

export type CaptureSession = {
  capture(url: string, slug: string): Promise<CapturedPage>;
  close(): Promise<void>;
};

export type CaptureOptions = ExtractOptions & {
  /** Where source screenshots are written. Defaults to out/screenshots. */
  screenshotDir?: string;
};

/**
 * Open a capture session. The caller must `close()` it, which shuts the
 * browser down — a leaked Chromium keeps running after the job ends.
 */
export async function openCaptureSession(
  options: CaptureOptions,
  logger: JobLogger,
): Promise<CaptureSession> {
  const screenshotDir = options.screenshotDir ?? PATHS.screenshots;
  await mkdir(screenshotDir, { recursive: true });

  logger.log("Starting Chromium…");
  const browser: Browser = await launchBrowser();

  return {
    async capture(url: string, slug: string): Promise<CapturedPage> {
      const screenshotPath = path.join(screenshotDir, `${slug}-source.png`);

      return withPage(browser, url, options, async (page) => {
        const extracted = await extractOnPage(page);
        const title = await page.title();

        // Segmentation happens here, while the page is still open, because the
        // next step asks that same document for each section's markup.
        const simplified = simplify(extracted.tree as StyleNode);
        const sections = simplified ? findSections(simplified) : [];
        const markup = await markupForRefs(
          page,
          sections.map((section) => section.ref),
        );

        // The role split is a good enough proxy for chrome here: `detectChrome`
        // runs in the pipeline and importing it would close a cycle, and a
        // mis-split only costs a wrapper being in the outer chain instead of
        // the inner one.
        const shell = await page.evaluate(collectShellInPage, {
          allRefs: sections.map((section) => section.ref),
          bodyRefs: sections
            .filter((section) => section.role === "section")
            .map((section) => section.ref),
        });

        const rawSheets = await page.evaluate(collectStylesheetsInPage);
        const stylesheets: CapturedStylesheet[] = [];
        let blockedCount = 0;
        for (const sheet of rawSheets) {
          if (sheet.css !== null && sheet.css.trim().length > 0) {
            stylesheets.push({ href: sheet.href, css: sheet.css });
            continue;
          }
          if (sheet.blocked && sheet.href) {
            const fetched = await fetchStylesheet(sheet.href);
            if (fetched) {
              stylesheets.push({ href: sheet.href, css: fetched });
            } else {
              blockedCount += 1;
            }
          }
        }
        if (blockedCount > 0) {
          logger.warn(
            `${blockedCount} stylesheet(s) could not be read for ${url} — ` +
              `some styling may be missing.`,
          );
        }

        await screenshotPage(page, screenshotPath);

        const stats = simplified
          ? treeStats(simplified)
          : { nodes: 0, depth: 0, collapsed: 0 };

        return {
          url,
          slug,
          title,
          viewport: {
            width: options.width ?? 1440,
            height: options.height ?? 900,
          },
          palette: extracted.palette,
          fonts: extracted.fonts,
          images: extracted.images,
          media: extracted.media,
          links: extracted.links,
          sections: sections.map((section) => ({
            ...section,
            html: markup.get(section.ref) ?? "",
          })),
          shell,
          stylesheets,
          screenshotPath,
          stats,
        };
      });
    },

    async close(): Promise<void> {
      await browser.close();
    },
  };
}
