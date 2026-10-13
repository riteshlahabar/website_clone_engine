/**
 * Decides, section by section, between native Elementor widgets and a block of
 * the original markup.
 *
 * Native widgets are what makes a clone worth having — you can edit them. But
 * forcing every section through the translation table silently loses whatever
 * it cannot express: an SVG icon, a carousel, a table, an embedded map. The
 * mapper already reports what it could not handle, so that report becomes the
 * decision: sections it handled cleanly stay native, sections it would have
 * gutted keep their markup and their looks.
 *
 * The markup path is not a cop-out — it is the only honest way to reproduce a
 * section built from something Elementor has no widget for.
 */
import { randomBytes } from "node:crypto";
import * as cheerio from "cheerio";
import type { ElementorNode } from "../elementor/compose.ts";
import type { CapturedSection } from "./capture.ts";
import { SCOPE_CLASS } from "./css.ts";
import { countWidgets, mapSection } from "./map.ts";
import type { UrlRewriter } from "./css.ts";

/** Elements that never survive translation into Elementor widgets. */
const HARD_DISQUALIFIERS = ["iframe", "canvas", "form", "video", "audio", "object", "embed", "select", "textarea"];

/** Elements that translation loses, weighted rather than fatal. */
const LOSSY_WEIGHTS: Array<{ tag: string; weight: number }> = [
  { tag: "svg", weight: 0.5 },
  { tag: "table", weight: 2 },
  { tag: "picture", weight: 0.25 },
];

export type SectionDecision = {
  role: CapturedSection["role"];
  tag: string;
  mode: "native" | "html";
  /** Why the HTML path was taken, for the fidelity report. */
  reason?: string;
  widgets: number;
  unmapped: number;
  score: number;
};

export type HybridResult = {
  elements: ElementorNode[];
  decisions: SectionDecision[];
  /** Source image URLs needing import, from natively mapped sections. */
  images: string[];
};

function makeId(): string {
  return randomBytes(4).toString("hex").slice(0, 7);
}

/** Count occurrences of a tag in a markup string, cheaply. */
function tagCount(html: string, tag: string): number {
  const matches = html.match(new RegExp(`<${tag}[\\s>]`, "gi"));
  return matches ? matches.length : 0;
}

export type SanitizeOptions = {
  /** Maps a source asset URL to its localized path. */
  rewriteAsset?: UrlRewriter;
  /** Maps a source page URL to the cloned page's local URL. */
  rewriteLink?: UrlRewriter;
  /** Resolves relative URLs in the markup. */
  baseUrl?: string;
};

/**
 * Make one section's markup safe and self-contained.
 *
 * Scripts go, because they would run in the clone against a DOM that no longer
 * matches and reach for a backend that is not there. Asset and link
 * references are redirected at the same time, so a clone survives the original
 * going offline.
 */
export function sanitizeHtml(html: string, options: SanitizeOptions = {}): string {
  const $ = cheerio.load(html, null, false);

  // `<style>` and `<link rel=stylesheet>` go too, and not only for tidiness:
  // the capture already read every stylesheet the document had and scoped it
  // into the bundle, so leaving these inline would re-admit the same rules
  // *unscoped* — free to restyle the WordPress admin bar and the theme.
  $("script, noscript, template, style, link").remove();

  const absolute = (value: string): string => {
    if (!options.baseUrl) return value;
    try {
      return new URL(value, options.baseUrl).toString();
    } catch {
      return value;
    }
  };

  const asset = (value: string): string => {
    const resolved = absolute(value.trim());
    return options.rewriteAsset?.(resolved) ?? resolved;
  };

  $("*").each((_, element) => {
    const node = $(element);

    // The extraction marker is ours and has no business in the output.
    node.removeAttr("data-wpc-ref");

    // Inline handlers cannot work in the clone and are an obvious hazard.
    const attribs = (element as { attribs?: Record<string, string> }).attribs ?? {};
    for (const name of Object.keys(attribs)) {
      if (/^on/i.test(name)) node.removeAttr(name);
    }

    // Lazy-loading puts the real image in a data attribute; promote it or the
    // clone shows blank boxes or placeholder pixels.
    for (const lazy of ["data-src", "data-lazy-src", "data-original"]) {
      const value = node.attr(lazy);
      if (value && !node.attr("src")) {
        node.attr("src", value);
        node.removeAttr(lazy);
      }
    }
    const lazySrcset = node.attr("data-srcset");
    if (lazySrcset && !node.attr("srcset")) {
      node.attr("srcset", lazySrcset);
      node.removeAttr("data-srcset");
    }

    const src = node.attr("src");
    if (src && !src.startsWith("data:")) node.attr("src", asset(src));

    // A `<video poster>` is an image like any other, and on a hero it is the
    // frame everyone sees before the video decodes.
    const poster = node.attr("poster");
    if (poster && !poster.startsWith("data:")) node.attr("poster", asset(poster));

    const srcset = node.attr("srcset");
    if (srcset) {
      node.attr(
        "srcset",
        srcset
          .split(",")
          .map((candidate) => {
            const parts = candidate.trim().split(/\s+/);
            const url = parts[0];
            if (!url || url.startsWith("data:")) return candidate.trim();
            return [asset(url), ...parts.slice(1)].join(" ");
          })
          .join(", "),
      );
    }

    const style = node.attr("style");
    if (style) {
      node.attr(
        "style",
        style.replace(
          /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
          (whole, quote: string, url: string) =>
            url.startsWith("data:") ? whole : `url(${quote}${asset(url)}${quote})`,
        ),
      );
    }

    const href = node.attr("href");
    if (href && node.is("a")) {
      if (/^(mailto:|tel:|#|javascript:)/i.test(href)) {
        if (/^javascript:/i.test(href)) node.attr("href", "#");
      } else {
        const resolved = absolute(href);
        node.attr("href", options.rewriteLink?.(resolved) ?? resolved);
      }
    }
  });

  return $.html();
}

/**
 * One Elementor HTML widget carrying a section's markup.
 *
 * The wrapper class is what the scoped stylesheet hangs off — without it the
 * cloned CSS matches nothing. See css.ts for why scoping works this way.
 */
export function htmlWidgetFor(html: string): ElementorNode {
  return {
    id: makeId(),
    elType: "widget",
    widgetType: "html",
    settings: {
      html: `<div class="${SCOPE_CLASS}">${html}</div>`,
    },
    elements: [],
  };
}

export type HybridOptions = {
  /** See `fidelitySchema.mode` in shared/clone.ts. Defaults to `auto`. */
  mode?: "exact" | "auto" | "editable";
  /**
   * `auto` only. How much of a section may fail to map before the whole section
   * falls back to markup. 0 forces native everywhere, 1 never falls back.
   */
  threshold: number;
  sanitize?: SanitizeOptions;
};

/** Score one section: 0 means translated cleanly, 1 means nothing survived. */
export function scoreSection(
  section: CapturedSection,
  widgets: number,
  unmapped: number,
): { score: number; blocker?: string } {
  for (const tag of HARD_DISQUALIFIERS) {
    if (tagCount(section.html, tag) > 0) {
      return { score: 1, blocker: `contains <${tag}>` };
    }
  }
  if (widgets === 0) return { score: 1, blocker: "nothing could be mapped" };

  let lossy = 0;
  for (const { tag, weight } of LOSSY_WEIGHTS) {
    lossy += tagCount(section.html, tag) * weight;
  }

  const lost = unmapped + lossy;
  const total = widgets + lost;
  return { score: total === 0 ? 0 : lost / total };
}

/**
 * Map every section, choosing a path for each. Sections arrive in document
 * order and leave in document order, which is what makes the result a page.
 */
export function mapSectionsHybrid(
  sections: CapturedSection[],
  options: HybridOptions,
): HybridResult {
  const elements: ElementorNode[] = [];
  const decisions: SectionDecision[] = [];
  const images: string[] = [];

  const mode = options.mode ?? "auto";

  for (const section of sections) {
    // `exact` never consults the translation table — not even to score — so a
    // page of markup costs nothing to produce.
    if (mode === "exact" && section.html.trim().length > 0) {
      elements.push(htmlWidgetFor(sanitizeHtml(section.html, options.sanitize)));
      decisions.push({
        role: section.role,
        tag: section.tag,
        mode: "html",
        reason: "exact mode",
        widgets: 0,
        unmapped: 0,
        score: 0,
      });
      continue;
    }

    const mapped = mapSection(section);
    const widgets = countWidgets(mapped.elements);
    const { score, blocker } = scoreSection(section, widgets, mapped.unmapped.length);

    const useHtml =
      mode !== "editable" && (blocker !== undefined || score > options.threshold);

    if (useHtml && section.html.trim().length > 0) {
      elements.push(htmlWidgetFor(sanitizeHtml(section.html, options.sanitize)));
      decisions.push({
        role: section.role,
        tag: section.tag,
        mode: "html",
        reason: blocker ?? `${Math.round(score * 100)}% of content would be lost`,
        widgets,
        unmapped: mapped.unmapped.length,
        score,
      });
      continue;
    }

    // Nothing mapped and no markup to fall back on: there is no section here.
    if (mapped.elements.length === 0) continue;

    elements.push(...mapped.elements);
    images.push(...mapped.images);
    decisions.push({
      role: section.role,
      tag: section.tag,
      mode: "native",
      widgets,
      unmapped: mapped.unmapped.length,
      score,
    });
  }

  return { elements, decisions, images: [...new Set(images)] };
}

/** A one-line summary of the native/markup mix, for the job log. */
export function summarizeDecisions(decisions: SectionDecision[]): string {
  const native = decisions.filter((entry) => entry.mode === "native").length;
  const html = decisions.length - native;
  const widgets = decisions.reduce((total, entry) => total + entry.widgets, 0);
  return `${decisions.length} section(s): ${native} native (${widgets} widgets), ${html} as markup`;
}
