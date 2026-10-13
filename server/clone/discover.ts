/**
 * Works out which pages a site has, before anything is captured.
 *
 * Discovery runs on plain `fetch` + cheerio rather than the browser: finding
 * links does not need a render, and launching Chromium per candidate would
 * make a twenty-page crawl take minutes. The capture phase pays for the
 * browser once it knows what is worth loading.
 *
 * Two sources are combined — `sitemap.xml`, which is authoritative when a site
 * publishes one, and a breadth-first walk of same-site links, which is the
 * fallback. Results are capped, because "clone this site" on a shop with
 * 4,000 product pages is never what anyone means.
 */
import * as cheerio from "cheerio";
import { DESKTOP_UA } from "./extract.ts";
import type { JobLogger } from "../lib/jobs.ts";
import type { DiscoveredPage } from "../shared/clone.ts";

/** Query parameters that identify a campaign, not a distinct page. */
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "mc_cid", "mc_eid", "ref", "_ga",
];

/** Paths that are never a content page on a WordPress-shaped site. */
const SKIP_PATH = /\/(wp-admin|wp-login|wp-json|xmlrpc\.php|feed|cart|checkout|my-account)(\/|$)/i;

/** Extensions that are assets or downloads rather than pages. */
const SKIP_EXTENSION =
  /\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|pdf|zip|gz|rar|mp4|webm|mp3|wav|woff2?|ttf|eot|docx?|xlsx?|pptx?)$/i;

/**
 * Canonical form of a URL, so the same page found by three routes counts once.
 * Drops the fragment and tracking parameters, lowercases the host, and removes
 * a trailing slash from everything but the root.
 */
export function normalizeUrl(input: string, base?: string): string | null {
  let parsed: URL;
  try {
    parsed = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  parsed.hash = "";
  for (const param of TRACKING_PARAMS) parsed.searchParams.delete(param);
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  // Sort the remaining query so ?a=1&b=2 and ?b=2&a=1 are one page.
  parsed.searchParams.sort();
  return parsed.toString();
}

/** `www.example.com` and `example.com` are the same site for our purposes. */
function sameSite(a: URL, b: URL): boolean {
  const strip = (host: string) => host.replace(/^www\./i, "").toLowerCase();
  return strip(a.hostname) === strip(b.hostname);
}

/** Is this URL worth fetching as a page at all? */
export function isCrawlable(url: string, origin: URL): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!sameSite(parsed, origin)) return false;
  if (SKIP_PATH.test(parsed.pathname)) return false;
  if (SKIP_EXTENSION.test(parsed.pathname)) return false;
  return true;
}

/**
 * A WordPress page slug derived from the URL path.
 *
 * The whole path becomes the slug (`/services/pricing` → `services-pricing`)
 * rather than just the last segment, because last segments collide constantly
 * on real sites and a collision would silently overwrite a page. Internal
 * links are rewritten from an explicit URL map, so slug shape costs nothing.
 */
export function slugForUrl(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const slug = pathname
    .toLowerCase()
    .replace(/\.(html?|php|aspx?)$/i, "")
    .split("/")
    .filter(Boolean)
    .join("-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "home";
}

type RobotsRules = {
  disallow: string[];
  allow: string[];
  sitemaps: string[];
};

/**
 * A deliberately small robots.txt reader: the `*` group plus any group naming
 * us, with `*` and `$` wildcards. Enough to honour a site's stated wishes
 * without pulling in a parser dependency.
 */
export function parseRobots(text: string): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], sitemaps: [] };
  let applies = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = (rawKey ?? "").trim().toLowerCase();
    const value = rest.join(":").trim();
    if (!value && key !== "disallow") continue;

    if (key === "user-agent") {
      applies = value === "*" || /claude|wp-site-builder/i.test(value);
      continue;
    }
    if (key === "sitemap") {
      rules.sitemaps.push(value);
      continue;
    }
    if (!applies) continue;
    if (key === "disallow" && value) rules.disallow.push(value);
    if (key === "allow" && value) rules.allow.push(value);
  }
  return rules;
}

/** Does a robots pattern match this path? Supports `*` and a trailing `$`. */
function matchesPattern(pattern: string, pathname: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`).test(pathname);
}

/** robots.txt allows the longest matching rule to win, Allow breaking ties. */
export function robotsAllows(rules: RobotsRules, url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return true;
  }
  const longest = (patterns: string[]) =>
    patterns
      .filter((pattern) => matchesPattern(pattern, pathname))
      .reduce((best, pattern) => Math.max(best, pattern.length), -1);

  const disallowed = longest(rules.disallow);
  if (disallowed < 0) return true;
  return longest(rules.allow) >= disallowed;
}

async function fetchText(url: string, timeoutMs = 20_000): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": DESKTOP_UA, accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** Follow a sitemap, including a sitemap index pointing at more sitemaps. */
async function collectSitemap(
  url: string,
  depth: number,
  seen: Set<string>,
): Promise<string[]> {
  if (depth > 2 || seen.has(url)) return [];
  seen.add(url);

  const xml = await fetchText(url);
  if (!xml) return [];

  const $ = cheerio.load(xml, { xmlMode: true });
  const nested = $("sitemap > loc").map((_, el) => $(el).text().trim()).get();
  const pages = $("url > loc").map((_, el) => $(el).text().trim()).get();

  const results = [...pages];
  for (const child of nested) {
    results.push(...(await collectSitemap(child, depth + 1, seen)));
  }
  return results;
}

/** Extract same-site page links from a fetched HTML document. */
function linksFrom(html: string, pageUrl: string, origin: URL): string[] {
  const $ = cheerio.load(html);
  const found: string[] = [];
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const normalized = normalizeUrl(href, pageUrl);
    if (normalized && isCrawlable(normalized, origin)) found.push(normalized);
  });
  return [...new Set(found)];
}

export type DiscoverOptions = {
  maxPages: number;
  respectRobots: boolean;
};

/**
 * Find the pages to clone, starting from one URL.
 *
 * The starting URL is always first and always the front page, whatever
 * discovery turns up afterwards.
 */
export async function discoverPages(
  sourceUrl: string,
  options: DiscoverOptions,
  logger: JobLogger,
): Promise<DiscoveredPage[]> {
  const start = normalizeUrl(sourceUrl);
  if (!start) throw new Error(`"${sourceUrl}" is not a usable URL.`);
  const origin = new URL(start);

  logger.step(`Discovering pages on ${origin.hostname}…`);

  let rules: RobotsRules = { disallow: [], allow: [], sitemaps: [] };
  const robotsText = await fetchText(new URL("/robots.txt", origin).toString());
  if (robotsText) {
    rules = parseRobots(robotsText);
    logger.log(
      `robots.txt: ${rules.disallow.length} disallow rule(s), ` +
        `${rules.sitemaps.length} sitemap reference(s).`,
    );
  } else {
    logger.log("No robots.txt — treating the whole site as crawlable.");
  }

  const allowed = (url: string): boolean =>
    !options.respectRobots || robotsAllows(rules, url);
  if (!options.respectRobots) {
    logger.warn("robots.txt is being ignored at your request.");
  }

  // Sitemaps first: a site that publishes one is telling us its page list.
  const sitemapCandidates = [
    ...rules.sitemaps,
    new URL("/sitemap.xml", origin).toString(),
    new URL("/sitemap_index.xml", origin).toString(),
    new URL("/wp-sitemap.xml", origin).toString(),
  ];
  const fromSitemap: string[] = [];
  const seenSitemaps = new Set<string>();
  for (const candidate of sitemapCandidates) {
    if (fromSitemap.length >= options.maxPages * 3) break;
    const urls = await collectSitemap(candidate, 0, seenSitemaps);
    if (urls.length > 0) {
      logger.log(`Sitemap ${candidate} listed ${urls.length} URL(s).`);
      fromSitemap.push(...urls);
    }
  }

  const queue: Array<{ url: string; depth: number }> = [{ url: start, depth: 0 }];
  const enqueued = new Set<string>([start]);

  for (const raw of fromSitemap) {
    const normalized = normalizeUrl(raw);
    if (!normalized || enqueued.has(normalized)) continue;
    if (!isCrawlable(normalized, origin) || !allowed(normalized)) continue;
    enqueued.add(normalized);
    queue.push({ url: normalized, depth: 1 });
  }

  const pages: DiscoveredPage[] = [];
  const usedSlugs = new Set<string>();

  // Fetched in batches rather than one at a time: measured against a real
  // eight-page site, sequential fetching took 27s because each request waits
  // out the last one's latency. The batch size is the concurrency bound, and
  // results are consumed in queue order so the page list stays deterministic.
  const BATCH_SIZE = 6;

  while (queue.length > 0 && pages.length < options.maxPages) {
    const remaining = options.maxPages - pages.length;
    const batch = queue
      .splice(0, Math.min(BATCH_SIZE, Math.max(remaining, 1)))
      .filter((entry) => allowed(entry.url));
    if (batch.length === 0) continue;

    const fetched = await Promise.all(
      batch.map(async (entry) => ({ entry, html: await fetchText(entry.url) })),
    );

    for (const { entry, html } of fetched) {
      if (pages.length >= options.maxPages) break;
      const { url, depth } = entry;

      if (html === null) {
        logger.warn(`Skipped ${url} — could not be fetched.`);
        continue;
      }
      // A page that is really a file (served as PDF, say) has no markup to map.
      if (!/<html|<body|<!doctype/i.test(html)) {
        logger.warn(`Skipped ${url} — not an HTML page.`);
        continue;
      }

      const $ = cheerio.load(html);
      const title = ($("title").first().text() || "").trim() ||
        ($("h1").first().text() || "").trim() ||
        url;

      const isFront = pages.length === 0;
      let slug = isFront ? "home" : slugForUrl(url);
      if (usedSlugs.has(slug)) slug = `${slug}-${pages.length + 1}`;
      usedSlugs.add(slug);

      pages.push({
        url,
        slug,
        title: title.slice(0, 180),
        depth,
        isFrontPage: isFront,
      });

      for (const link of linksFrom(html, url, origin)) {
        if (enqueued.has(link)) continue;
        enqueued.add(link);
        queue.push({ url: link, depth: depth + 1 });
      }
    }
  }

  if (pages.length === 0) {
    throw new Error(
      `Found no crawlable pages at ${sourceUrl}. ` +
        `Check the URL loads in a browser, and that robots.txt does not block it.`,
    );
  }

  logger.success(
    `Found ${pages.length} page(s)` +
      (queue.length > 0 ? ` (stopped at the ${options.maxPages}-page cap).` : "."),
  );
  return pages;
}
