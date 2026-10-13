/**
 * The clone pipeline: a URL in, a working local WordPress site out.
 *
 * Ordering is the whole design here, and most of it is forced:
 *
 *   target+db checks  cheap, and the only failures that can destroy data
 *   discover          what pages exist
 *   provision         WordPress must exist before anything can be imported
 *   capture           one browser, every page, one visit each
 *   assets            CSS discovers fonts, so bundling runs twice
 *   theme             needs the bundled CSS and the detected chrome
 *   pages             needs the theme active and the images imported
 *   verify            needs the site serving
 *
 * The checks come first deliberately: a run that is going to fail because the
 * database already has tables should fail before it spends two minutes
 * downloading WordPress and rendering twenty pages.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyImageMap, downloadAssets, importImages } from "./assets.ts";
import { openCaptureSession, type CapturedPage } from "./capture.ts";
import {
  cloneScreenshotPath,
  compareToSource,
  describeComparison,
  diffScreenshotPath,
  type VisualComparison,
} from "./compare.ts";
import { bundleCss, SCOPE_CLASS } from "./css.ts";
import { discoverPages } from "./discover.ts";
import { mapSectionsHybrid, summarizeDecisions, type SectionDecision } from "./hybrid.ts";
import { toHex } from "./map.ts";
import {
  detectChrome,
  writeChildTheme,
  writeFidelityPlugin,
  MENU_LOCATION,
  type MenuItem,
} from "./theme.ts";
import { upsertPage, writeElementorDocument } from "../lib/apply.ts";
import { requireEmptyDatabase } from "../lib/db.ts";
import { PATHS } from "../lib/env.ts";
import type { JobLogger } from "../lib/jobs.ts";
import { provision } from "../lib/provision.ts";
import { resolveCloneTarget, slugFromPath } from "../lib/target.ts";
import { wp } from "../lib/wpcli.ts";
import { validateDocument } from "../elementor/compose.ts";
import { applyBrandKit } from "../elementor/kit.ts";
import { parseBrief, type Brief } from "../shared/brief.ts";
import type { CloneSpec, DiscoveredPage } from "../shared/clone.ts";

export type ClonedPage = {
  title: string;
  slug: string;
  sourceUrl: string;
  url: string;
  editUrl: string;
  postId: number;
  isFrontPage: boolean;
  decisions: SectionDecision[];
  summary: string;
  /** Absent when the visual check could not run for this page. */
  visual?: VisualComparison;
  visualSummary?: string;
};

export type CloneResult = {
  siteUrl: string;
  adminUrl: string;
  adminUser: string;
  adminPassword: string;
  sitePath: string;
  dbName: string;
  themeSlug: string;
  pages: ClonedPage[];
  stats: {
    imagesImported: number;
    assetsLocalized: number;
    cssBytes: number;
    menuItems: number;
    hasHeader: boolean;
    hasFooter: boolean;
  };
};

/** Run a WP-CLI command, echoing it into the job log. */
async function run(
  logger: JobLogger,
  args: string[],
  options: { sitePath: string; allowFailure?: boolean },
) {
  logger.command(`wp ${args.join(" ")}`);
  return wp(args, {
    sitePath: options.sitePath,
    throwOnError: !options.allowFailure,
    onLine: (line) => {
      if (line.trim()) logger.log(line.trimEnd());
    },
  });
}

/** How far a colour is from grey, 0..1. Used to find a brand colour. */
function saturation(hex: string): number {
  const value = hex.replace("#", "");
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  return max === 0 ? 0 : (max - min) / max;
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  return (
    (0.2126 * parseInt(value.slice(0, 2), 16) +
      0.7152 * parseInt(value.slice(2, 4), 16) +
      0.0722 * parseInt(value.slice(4, 6), 16)) /
    255
  );
}

/**
 * Turn the measured palette into the four brand colours the kit expects.
 *
 * The palette arrives ranked by how much of the page each colour covers, so
 * the most-used saturated colour is the brand colour and the darkest is the
 * text colour. Defaults match the brief schema so a greyscale site still
 * produces a valid kit.
 */
export function paletteToBrand(
  palette: Array<{ color: string; weight: number }>,
  fonts: Array<{ family: string; weight: number }>,
): Brief["brand"] {
  const hexes = palette
    .map((entry) => toHex(entry.color))
    .filter((value): value is string => value !== undefined && /^#[0-9A-F]{6}$/i.test(value));

  const saturated = hexes.filter((hex) => saturation(hex) > 0.25);
  const sortedByDark = [...hexes].sort((a, b) => luminance(a) - luminance(b));

  const primary = saturated[0] ?? "#0F766E";
  const secondary = saturated[1] ?? sortedByDark[0] ?? "#134E4A";
  const accent = [...saturated].sort((a, b) => saturation(b) - saturation(a))[0] ?? "#F59E0B";
  const text = sortedByDark[0] ?? "#1F2937";

  // Font families arrive lowercase from computed styles on some sites; the kit
  // passes them to Google Fonts, which is case-insensitive, so they are used
  // as measured rather than guessed at.
  const families = fonts.map((font) => font.family).filter(Boolean);

  return {
    colors: { primary, secondary, text, accent },
    fonts: {
      heading: families[0] ?? "Poppins",
      body: families[1] ?? families[0] ?? "Inter",
    },
  };
}

/**
 * A Brief standing in for the clone, so provisioning and the brand kit — both
 * written against briefs — work unchanged. Its `pages` are placeholders: the
 * clone writes Elementor documents itself rather than composing from blocks.
 */
function syntheticBrief(
  spec: CloneSpec,
  slug: string,
  title: string,
  brand: Brief["brand"],
  pages: DiscoveredPage[],
): Brief {
  const parsed = parseBrief({
    site: {
      name: title,
      slug,
      tagline: "",
      adminUser: spec.site.adminUser,
      adminEmail: spec.site.adminEmail,
      ...(spec.site.adminPassword ? { adminPassword: spec.site.adminPassword } : {}),
      logoUrl: "",
    },
    brand,
    theme: "hello-elementor",
    plugins: { free: ["elementor"], premium: [] },
    pages: pages.map((page) => ({
      title: page.title || page.slug,
      slug: page.slug,
      isFrontPage: page.isFrontPage,
      sections: [],
    })),
    menu: { name: "Primary", location: MENU_LOCATION },
  });
  if (!parsed.ok) {
    throw new Error(`Could not build an internal brief: ${parsed.errors.join("; ")}`);
  }
  return parsed.brief;
}

/** Create the WordPress menu the generated header renders. */
async function applyClonedMenu(
  items: MenuItem[],
  pages: ClonedPage[],
  sitePath: string,
  logger: JobLogger,
): Promise<number> {
  if (items.length === 0) return 0;

  logger.step(`Building the primary menu (${items.length} item(s))…`);
  const menuName = "Primary";
  await run(logger, ["menu", "create", menuName], { sitePath, allowFailure: true });

  let added = 0;
  for (const item of items) {
    // A menu entry pointing at a cloned page should link to the page, so the
    // menu keeps working inside WordPress rather than leaving the site.
    const match = pages.find((page) => page.url === item.url || page.sourceUrl === item.url);
    const result = match
      ? await run(
          logger,
          ["menu", "item", "add-post", menuName, String(match.postId), `--title=${item.title}`],
          { sitePath, allowFailure: true },
        )
      : await run(
          logger,
          ["menu", "item", "add-custom", menuName, item.title, item.url],
          { sitePath, allowFailure: true },
        );
    if (result.exitCode === 0) added += 1;
  }

  await run(logger, ["menu", "location", "assign", menuName, MENU_LOCATION], {
    sitePath,
    allowFailure: true,
  });
  logger.log(`${added}/${items.length} menu item(s) added.`);
  return added;
}

/** Delete the stock content WordPress ships with. */
async function removeDefaultContent(sitePath: string, logger: JobLogger): Promise<void> {
  const ids = await wp(
    ["post", "list", "--post_type=page,post", "--name=sample-page,hello-world,privacy-policy", "--field=ID", "--format=ids"],
    { sitePath, throwOnError: false },
  );
  const list = ids.stdout.trim().split(/\s+/).filter((value) => /^\d+$/.test(value));
  if (list.length === 0) return;
  await run(logger, ["post", "delete", ...list, "--force"], { sitePath, allowFailure: true });
}

export type CloneOptions = {
  /** Pages to clone. When omitted, discovery runs. */
  pages?: DiscoveredPage[];
};

export async function runClone(
  spec: CloneSpec,
  logger: JobLogger,
  options: CloneOptions = {},
): Promise<CloneResult> {
  // ---- 1. Checks that could destroy data, before any real work ----
  logger.step("Checking the target folder and database…");
  const target = await resolveCloneTarget(spec);
  await requireEmptyDatabase(spec.dbName, {
    user: spec.dbUser,
    password: spec.dbPassword,
  });
  const slug = slugFromPath(target.sitePath);
  logger.success(
    `Target ready: ${target.sitePath} → ${target.siteUrl}, database "${spec.dbName}".`,
  );

  // ---- 2. Which pages ----
  const pages =
    options.pages && options.pages.length > 0
      ? options.pages
      : await discoverPages(
          spec.sourceUrl,
          { maxPages: spec.crawl.maxPages, respectRobots: spec.crawl.respectRobots },
          logger,
        );

  const frontPage = pages.find((page) => page.isFrontPage) ?? pages[0]!;
  const siteTitle = spec.site.title || frontPage.title || slug;

  // ---- 3. Capture every page in one browser ----
  logger.step(`Capturing ${pages.length} page(s) from ${spec.sourceUrl}…`);
  const captured: CapturedPage[] = [];
  const session = await openCaptureSession(
    {
      width: spec.fidelity.viewportWidth,
      height: spec.fidelity.viewportHeight,
    },
    logger,
  );
  try {
    for (const page of pages) {
      logger.log(`Capturing ${page.url}`);
      try {
        captured.push(await session.capture(page.url, page.slug));
      } catch (error) {
        logger.warn(
          `Could not capture ${page.url}: ${error instanceof Error ? error.message : error}. Skipping it.`,
        );
      }
    }
  } finally {
    await session.close();
  }
  if (captured.length === 0) {
    throw new Error("No pages could be captured, so there is nothing to build.");
  }
  logger.success(`Captured ${captured.length} page(s).`);

  const front = captured.find((page) => page.url === frontPage.url) ?? captured[0]!;
  const brand = paletteToBrand(front.palette, front.fonts);
  logger.log(
    `Palette: ${brand.colors.primary} / ${brand.colors.secondary} / ${brand.colors.accent}; ` +
      `fonts: ${brand.fonts.heading}, ${brand.fonts.body}.`,
  );

  // ---- 4. Provision WordPress ----
  const brief = syntheticBrief(spec, slug, siteTitle, brand, pages);
  const provisioned = await provision(brief, logger, {
    target,
    requireEmptyDatabase: false, // already checked above; the DB now has WP tables
  });

  // ---- 5. Assets. Bundling twice: the first pass discovers @font-face URLs
  //         and other url() references, the second rewrites them to local copies.
  logger.step("Collecting stylesheets and assets…");
  const allSheets = captured.flatMap((page) => page.stylesheets);
  const firstPass = bundleCss(allSheets, () => null);
  logger.log(
    `${allSheets.length} stylesheet(s), ${firstPass.rulesScoped} rule(s) scoped to .${SCOPE_CLASS}.`,
  );

  const themeSlug = `${slug}-clone`;
  const themeAssetDir = path.join(
    target.sitePath,
    "wp-content",
    "themes",
    themeSlug,
    "assets",
  );
  await mkdir(themeAssetDir, { recursive: true });

  // Video and audio go beside the fonts rather than into the media library:
  // they are referenced straight from cloned markup, and WordPress would only
  // add an attachment record nothing reads.
  const mediaUrls = captured.flatMap((page) => page.media);
  const cssAssets = await downloadAssets(
    [...firstPass.fontUrls, ...firstPass.unresolved, ...mediaUrls],
    {
      destDir: themeAssetDir,
      publicPrefix: "assets",
      logger,
    },
  );
  const bundle = bundleCss(allSheets, (url) => cssAssets.get(url) ?? null);

  // ---- 6. Images into the media library ----
  // The fidelity plugin goes in first: WordPress re-encodes a JPEG as it is
  // imported, so registering those filters afterwards would be too late.
  await writeFidelityPlugin(target.sitePath);

  const imageUrls = new Set<string>();
  for (const page of captured) for (const url of page.images) imageUrls.add(url);
  const media = await importImages(imageUrls, target.sitePath, logger);
  const imagesImported = [...media.values()].filter((entry) => entry.id).length;

  // Markup and CSS should point at the imported copies too.
  const rewriteAsset = (url: string): string | null =>
    media.get(url)?.url ?? cssAssets.get(url) ?? null;

  // ---- 7. Child theme with the chrome and the bundled CSS ----
  const { chrome } = detectChrome(front.sections);
  logger.step("Writing the child theme…");
  const theme = await writeChildTheme({
    sitePath: target.sitePath,
    slug: themeSlug,
    name: `${siteTitle} (clone)`,
    sourceUrl: spec.sourceUrl,
    css: bundle.css,
    chrome,
    shell: front.shell,
    sanitize: { baseUrl: front.url, rewriteAsset },
  });
  logger.success(
    `Theme ${themeSlug}: header ${theme.hasHeader ? "cloned" : "not found"}, ` +
      `footer ${theme.hasFooter ? "cloned" : "not found"}, ` +
      `${(theme.cssBytes / 1024).toFixed(0)} KB of CSS.`,
  );
  await run(logger, ["theme", "activate", themeSlug], { sitePath: target.sitePath });

  // ---- 8. Pages ----
  // Internal links are rewritten to the cloned equivalents, so navigating the
  // clone stays inside the clone.
  const linkMap = new Map<string, string>();
  for (const page of pages) {
    linkMap.set(
      page.url,
      page.isFrontPage ? `${target.siteUrl}/` : `${target.siteUrl}/${page.slug}/`,
    );
  }
  const rewriteLink = (url: string): string | null => linkMap.get(url) ?? null;

  const cloned: ClonedPage[] = [];
  for (const page of captured) {
    const descriptor = pages.find((entry) => entry.url === page.url);
    const pageSlug = descriptor?.slug ?? page.slug;
    const isFront = descriptor?.isFrontPage ?? page.url === front.url;
    const title = descriptor?.title || page.title || pageSlug;

    // The chrome lives in the theme now, so it must not also be in the page.
    const { body } = detectChrome(page.sections);

    const mapped = mapSectionsHybrid(body, {
      mode: spec.fidelity.mode,
      threshold: spec.fidelity.htmlFallbackThreshold,
      sanitize: { baseUrl: page.url, rewriteAsset, rewriteLink },
    });
    const swapped = applyImageMap(mapped.elements, media);

    // validateDocument also flags leftover {{tokens}}, which is a brief-only
    // concern — a cloned page may legitimately contain that text — so that one
    // problem is demoted to a warning rather than failing the page.
    const problems = validateDocument(mapped.elements);
    const fatal = problems.filter(
      (problem) => !problem.startsWith("Unsubstituted placeholders"),
    );
    if (fatal.length > 0) {
      throw new Error(`Cloned layout for “${title}” is invalid:\n  ${fatal.join("\n  ")}`);
    }
    if (problems.length > fatal.length) {
      logger.warn(`“${title}” contains {{...}} text from the source; left as-is.`);
    }

    const postId = await upsertPage({ title, slug: pageSlug }, target.sitePath, logger);
    await writeElementorDocument({
      postId,
      payloadName: `${slug}-${pageSlug}`,
      label: title,
      elements: mapped.elements,
      sitePath: target.sitePath,
      logger,
    });

    const summary = summarizeDecisions(mapped.decisions);
    logger.success(`“${title}”: ${summary}, ${swapped} image reference(s) localized.`);

    cloned.push({
      title,
      slug: pageSlug,
      sourceUrl: page.url,
      url: isFront ? `${target.siteUrl}/` : `${target.siteUrl}/${pageSlug}/`,
      editUrl: `${target.siteUrl}/wp-admin/post.php?post=${postId}&action=elementor`,
      postId,
      isFrontPage: isFront,
      decisions: mapped.decisions,
      summary,
    });
  }

  // ---- 9. Front page, menu, kit, cleanup ----
  const frontCloned = cloned.find((page) => page.isFrontPage);
  if (frontCloned) {
    logger.step(`Setting “${frontCloned.title}” as the front page…`);
    await run(logger, ["option", "update", "show_on_front", "page"], {
      sitePath: target.sitePath,
    });
    await run(logger, ["option", "update", "page_on_front", String(frontCloned.postId)], {
      sitePath: target.sitePath,
    });
  }

  const menuItems = await applyClonedMenu(
    theme.menuItems,
    cloned,
    target.sitePath,
    logger,
  );
  await applyBrandKit(brief, target.sitePath, logger);

  // Elementor enqueues the kit's font families from Google Fonts. On a clone
  // that is an injection, not a reproduction: the source decides its own
  // typography, and an added webfont silently changes text metrics. Measured on
  // the test site — which ships no `@font-face` at all and asks for a locally
  // installed Inter — Elementor's Google-hosted Inter was 7% wider, which
  // reflowed the footer paragraph onto a fourth line and made every band below
  // it 23px lower. The kit's colours are still worth having for anything the
  // user adds later; only the font enqueue is turned off.
  logger.step("Turning off Elementor's Google Fonts (the source supplies its own)…");
  await run(logger, ["option", "update", "elementor_google_font", "0"], {
    sitePath: target.sitePath,
    allowFailure: true,
  });

  await removeDefaultContent(target.sitePath, logger);

  logger.step("Regenerating Elementor CSS…");
  await run(logger, ["elementor", "flush-css", "--regenerate"], {
    sitePath: target.sitePath,
    allowFailure: true,
  });

  // ---- 10. Does it actually look like the original? ----
  // Last, because it has to photograph the finished site. A failure here never
  // fails the run: the clone exists and the user can see it, and a number they
  // can act on beats an exception that hides it.
  logger.step("Comparing the clone with the source…");
  for (const page of cloned) {
    const source = captured.find((entry) => entry.url === page.sourceUrl);
    if (!source) continue;
    try {
      const visual = await compareToSource(
        {
          sourceUrl: page.sourceUrl,
          sourceScreenshotPath: source.screenshotPath,
          cloneUrl: page.url,
          cloneScreenshotPath: cloneScreenshotPath(PATHS.screenshots, page.slug),
          diffPath: diffScreenshotPath(PATHS.screenshots, page.slug),
          width: spec.fidelity.viewportWidth,
          height: spec.fidelity.viewportHeight,
        },
        logger,
      );
      page.visual = visual;
      page.visualSummary = describeComparison(visual);
      logger.log(`“${page.title}”: ${page.visualSummary}`);
    } catch (error) {
      logger.warn(
        `Could not compare “${page.title}” with its source: ` +
          `${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // A record of the run, next to the payloads, for debugging a bad clone.
  await writeFile(
    path.join(PATHS.out, `${slug}-clone-report.json`),
    JSON.stringify(
      {
        sourceUrl: spec.sourceUrl,
        capturedAt: new Date().toISOString(),
        mode: spec.fidelity.mode,
        pages: cloned.map((page) => ({
          slug: page.slug,
          sourceUrl: page.sourceUrl,
          summary: page.summary,
          visual: page.visual,
          visualSummary: page.visualSummary,
          decisions: page.decisions,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  logger.success(`Clone complete: ${target.siteUrl}`);

  return {
    siteUrl: target.siteUrl,
    adminUrl: provisioned.adminUrl,
    adminUser: provisioned.adminUser,
    adminPassword: provisioned.adminPassword,
    sitePath: target.sitePath,
    dbName: spec.dbName,
    themeSlug,
    pages: cloned,
    stats: {
      imagesImported,
      assetsLocalized: cssAssets.size,
      cssBytes: theme.cssBytes,
      menuItems,
      hasHeader: theme.hasHeader,
      hasFooter: theme.hasFooter,
    },
  };
}
