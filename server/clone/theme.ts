/**
 * Generates a Hello Elementor child theme carrying the clone's chrome and CSS.
 *
 * WHY A THEME AND NOT ELEMENTOR
 * -----------------------------
 * Elementor's Theme Builder — the thing that would let a header and footer be
 * edited as Elementor templates — is Pro only, and so is the `nav-menu`
 * widget. On free Elementor the only place a site-wide header and footer can
 * live is the theme, so that is where they go. Page bodies remain fully
 * Elementor-editable; the chrome is edited as theme files or, for the menu,
 * under Appearance → Menus.
 *
 * Two details that are easy to get wrong:
 *
 * - Everything cloned is wrapped in SCOPE_CLASS. The cloned stylesheet is
 *   scoped to that class (see css.ts), so markup outside it gets no styling
 *   and loses the `:root` custom properties the source relied on.
 * - The source's own nav `<ul>` is swapped for `wp_nav_menu()` while keeping
 *   its original classes, so the menu is editable in WordPress and the
 *   source's CSS still matches it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import type { CapturedSection, CapturedShell } from "./capture.ts";
import { SCOPE_CLASS } from "./css.ts";
import { sanitizeHtml, type SanitizeOptions } from "./hybrid.ts";

/** The menu location the generated theme registers. */
export const MENU_LOCATION = "wpc-primary";

/**
 * Site chrome. Both are lists because a footer is routinely more than one
 * band — measured on the test site, the footer is a link-column band followed
 * by a separate copyright bar, and taking only one leaves the other stranded
 * at the bottom of every page.
 */
export type Chrome = {
  header: CapturedSection[];
  footer: CapturedSection[];
};

function countMatches(html: string, pattern: RegExp): number {
  return (html.match(pattern) ?? []).length;
}

const LINK_PATTERN = /<a[\s>]/gi;

/** Class or id text suggesting chrome, for sites that name things plainly. */
const HEADER_HINT = /\b(site-)?(header|navbar|topbar|masthead|main-nav|site-head)\b/i;
const FOOTER_HINT = /\b(site-)?(footer|colophon|site-foot)\b/i;

/**
 * A header band is at the very top, short, and link-dense. Thresholds are
 * drawn from the measured test page, where the nav band is y=0, 87px tall and
 * carries 53 links, while the shortest content band is 200px.
 */
const HEADER_MAX_Y = 150;
const HEADER_MAX_HEIGHT = 250;
const HEADER_MIN_LINKS = 3;

/** Footer bands are at the end, not tall, and carry links. */
const FOOTER_MAX_HEIGHT = 450;
const FOOTER_MIN_LINKS = 2;
const FOOTER_MAX_BANDS = 3;

/**
 * Split the captured bands into site chrome and page body.
 *
 * Two strategies, in order of trustworthiness:
 *
 * 1. Semantic `<header>`/`<footer>` tags, or those roles from segmentation.
 * 2. Position and structure. This exists because a WordPress site built with
 *    Elementor — the single most likely thing anyone points this tool at —
 *    emits every band as `<section class="elementor-section …">` with no
 *    semantic landmarks and no meaningful class names at all. The test site
 *    has zero `<nav>`, `<header>` and `<footer>` tags on the entire page, so
 *    strategy 1 finds nothing there.
 *
 * Anything less than certain stays in the page body: wrongly promoting a
 * content band to site-wide chrome repeats it on every cloned page, which is
 * a worse outcome than leaving the chrome inline on one.
 */
export function detectChrome(sections: CapturedSection[]): {
  chrome: Chrome;
  body: CapturedSection[];
} {
  const used = new Set<CapturedSection>();
  const header: CapturedSection[] = [];
  const footer: CapturedSection[] = [];

  // --- Header ---
  const semanticHeader = sections.find(
    (section) => section.role === "header" || /<header[\s>]/i.test(section.html),
  );
  if (semanticHeader) {
    header.push(semanticHeader);
  } else {
    const first = sections[0];
    if (
      first &&
      first.rect.y <= HEADER_MAX_Y &&
      first.rect.height <= HEADER_MAX_HEIGHT &&
      (countMatches(first.html, LINK_PATTERN) >= HEADER_MIN_LINKS ||
        HEADER_HINT.test(first.html.slice(0, 400)))
    ) {
      header.push(first);
    }
  }
  for (const section of header) used.add(section);

  // --- Footer ---
  const semanticFooter = sections.find(
    (section) =>
      !used.has(section) &&
      (section.role === "footer" || /<footer[\s>]/i.test(section.html)),
  );
  if (semanticFooter) {
    footer.push(semanticFooter);
  } else {
    // Walk backwards while bands still look like footer material.
    for (let index = sections.length - 1; index >= 0; index -= 1) {
      const section = sections[index]!;
      if (used.has(section) || footer.length >= FOOTER_MAX_BANDS) break;
      const qualifies =
        section.rect.height <= FOOTER_MAX_HEIGHT &&
        (countMatches(section.html, LINK_PATTERN) >= FOOTER_MIN_LINKS ||
          FOOTER_HINT.test(section.html.slice(0, 400)));
      if (!qualifies) break;
      footer.unshift(section);
    }
    // A "footer" that swallowed the whole page is a mis-read, not a footer.
    if (footer.length >= sections.length) footer.length = 0;
  }
  for (const section of footer) used.add(section);

  return {
    chrome: { header, footer },
    body: sections.filter((section) => !used.has(section)),
  };
}

export type MenuItem = { title: string; url: string };

/**
 * Pull the navigation out of the header markup and replace it with a
 * `wp_nav_menu()` call that keeps the original `<ul>`'s classes.
 *
 * Returns the menu items found, so the pipeline can create the real WordPress
 * menu. When no nav is found the markup is returned untouched — a frozen but
 * correct header beats a broken one.
 */
export function extractMenu(headerHtml: string): {
  html: string;
  items: MenuItem[];
} {
  const $ = cheerio.load(headerHtml, null, false);

  // The nav list with the most direct links is the primary menu.
  let bestElement: Parameters<typeof $>[0] | null = null;
  let bestCount = 0;
  let childSelector = "> li > a[href]";
  $("ul").each((_, element) => {
    const count = $(element).find("> li > a[href]").length;
    if (count >= 2 && count > bestCount) {
      bestElement = element;
      bestCount = count;
    }
  });

  // No list? Plenty of sites — the test site included — build a nav out of bare
  // anchors in a flex row. Those are *read* so the clone still gets a real
  // WordPress menu, but the markup is left alone: `wp_nav_menu()` emits
  // `<ul><li><a>`, and substituting that for a flex row of anchors carrying
  // icons would replace a nav that renders perfectly with one that does not.
  let swappable = true;
  if (bestElement === null) {
    swappable = false;
    $("nav, div, header").each((_, element) => {
      const count = $(element).find("> a[href]").length;
      if (count >= 2 && count > bestCount) {
        bestElement = element;
        bestCount = count;
        childSelector = "> a[href]";
      }
    });
  }

  if (bestElement === null) return { html: headerHtml, items: [] };
  const node = $(bestElement);

  const items: MenuItem[] = [];
  node.find(childSelector).each((_, anchor) => {
    const title = $(anchor).text().replace(/\s+/g, " ").trim();
    const url = $(anchor).attr("href") ?? "";
    if (title && url) items.push({ title, url });
  });

  if (!swappable) return { html: headerHtml, items };

  const classes = (node.attr("class") ?? "").trim();
  const id = (node.attr("id") ?? "").trim();

  // A placeholder swapped for PHP after serialisation: cheerio would escape
  // the PHP tags if they were inserted as markup here.
  const token = "___WPC_NAV_MENU___";
  node.replaceWith(token);

  const php =
    `<?php wp_nav_menu( array( ` +
    `'theme_location' => '${MENU_LOCATION}', ` +
    `'container' => false, ` +
    `'menu_class' => '${classes.replace(/'/g, "")}', ` +
    (id ? `'menu_id' => '${id.replace(/'/g, "")}', ` : "") +
    `'fallback_cb' => false ` +
    `) ); ?>`;

  return { html: $.html().replace(token, php), items };
}

/** PHP opening tags inside cloned markup would be executed; neuter them. */
function neutralizePhp(html: string): string {
  return html.replace(/<\?/g, "&lt;?");
}

/**
 * Install the must-use plugin that keeps WordPress from editing cloned assets.
 *
 * A must-use plugin, not the theme: WordPress re-encodes a JPEG while it is
 * being *imported*, and the import runs before the generated theme exists —
 * the theme's filters would be registered an hour too late. Must-use plugins
 * load on every request regardless of the active theme, which is exactly the
 * window this needs to cover.
 */
export async function writeFidelityPlugin(sitePath: string): Promise<string> {
  const dir = path.join(sitePath, "wp-content", "mu-plugins");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "wpc-clone-fidelity.php");
  await writeFile(
    file,
    `<?php
/**
 * Plugin Name: Clone fidelity
 * Description: Stops WordPress editing assets that were cloned from another site.
 *
 * Generated by WP Site Builder. Safe to delete if you would rather have
 * WordPress's usual image optimisation than byte-faithful copies.
 */

// WordPress re-encodes uploaded JPEGs at 82% quality. On a clone that is a
// visible edit to the source's own artwork.
add_filter( 'jpeg_quality', function () { return 100; } );
add_filter( 'wp_editor_set_quality', function () { return 100; } );

// And it shrinks anything wider than 2560px, renaming it "-scaled".
add_filter( 'big_image_size_threshold', '__return_false' );
`,
    "utf8",
  );
  return file;
}

export type ChildThemeOptions = {
  sitePath: string;
  /** Theme folder name, also its text domain. */
  slug: string;
  /** Human-readable theme name. */
  name: string;
  sourceUrl: string;
  /** The scoped, bundled stylesheet. */
  css: string;
  chrome: Chrome;
  /** The source's wrapper chain, reproduced around the cloned content. */
  shell?: CapturedShell;
  sanitize?: SanitizeOptions;
};

/**
 * CSS that makes WordPress get out of the way.
 *
 * Everything cloned is reproduced inside a stack of boxes the source never
 * had: Hello Elementor's content wrapper, then Elementor's own container and
 * widget divs. Each one is a block box that can constrain width, add padding
 * or — the one that actually bites — break a parent/child relationship the
 * source's CSS depends on, so `.flex > *` and `.space-y-6 > * + *` stop
 * matching across them.
 *
 * `display: contents` removes a box from the layout tree while leaving its
 * children and inherited values alone, which is exactly the "pretend I am not
 * here" these wrappers need. Custom properties still inherit through, so the
 * scope class keeps working.
 */
const PASSTHROUGH_CSS = `
/* ---- generated: let the cloned markup lay itself out ---- */
.${SCOPE_CLASS}-header,
.${SCOPE_CLASS}-footer,
.${SCOPE_CLASS}-main,
.${SCOPE_CLASS}-page .site-main,
.${SCOPE_CLASS}-page .page-content,
.${SCOPE_CLASS}-page .entry-content,
.${SCOPE_CLASS}-main .elementor,
.${SCOPE_CLASS}-main .elementor-section-wrap,
.${SCOPE_CLASS}-main .elementor > .e-con,
.${SCOPE_CLASS}-main .e-con > .e-con-inner,
.${SCOPE_CLASS}-main .elementor-widget-html,
.${SCOPE_CLASS}-main .elementor-widget-html > .elementor-widget-container,
.${SCOPE_CLASS}-main .elementor-widget-html > .elementor-widget-container > .${SCOPE_CLASS} {
	display: contents;
}

/* Hello Elementor still boxes anything that escapes the rule above. */
.${SCOPE_CLASS}-page .site-main,
.${SCOPE_CLASS}-page .page-content {
	max-width: none;
	margin: 0;
	padding: 0;
}

/* Belt and braces for the theme's own page title, in case the filter moves. */
.${SCOPE_CLASS}-page > .page-header,
.${SCOPE_CLASS}-page .page-header > .entry-title {
	display: none;
}

/* The admin bar is fixed and would sit on top of a cloned fixed header. */
body.admin-bar .${SCOPE_CLASS}-page [class*="fixed"] {
	margin-top: 32px;
}
`;

export type ChildThemeResult = {
  themeDir: string;
  slug: string;
  menuItems: MenuItem[];
  hasHeader: boolean;
  hasFooter: boolean;
  cssBytes: number;
};

/**
 * Write the child theme. Returns what the pipeline still has to do in
 * WordPress: activate it, and build the menu from `menuItems`.
 */
export async function writeChildTheme(
  options: ChildThemeOptions,
): Promise<ChildThemeResult> {
  const themeDir = path.join(options.sitePath, "wp-content", "themes", options.slug);
  await mkdir(path.join(themeDir, "assets"), { recursive: true });

  // 1. style.css — the header comment is what makes WordPress see a theme.
  const styleHeader = [
    "/*",
    `Theme Name: ${options.name}`,
    "Template: hello-elementor",
    `Description: Cloned from ${options.sourceUrl} by WP Site Builder.`,
    "Version: 1.0.0",
    `Text Domain: ${options.slug}`,
    "*/",
    "",
  ].join("\n");
  await writeFile(path.join(themeDir, "style.css"), styleHeader, "utf8");

  // 2. The cloned CSS, kept in its own file so style.css stays readable and
  //    the bundle can be regenerated without touching the theme header. The
  //    pass-through rules go last so they win against anything above them.
  const cloneCss = `${options.css}\n${PASSTHROUGH_CSS}`;
  await writeFile(path.join(themeDir, "assets", "clone.css"), cloneCss, "utf8");

  // 3. Chrome. The menu swap applies only to the first header band, which is
  //    where a nav lives; a second band would be a utility bar.
  let headerInner = "";
  let menuItems: MenuItem[] = [];
  const headerParts: string[] = [];
  for (const [index, band] of options.chrome.header.entries()) {
    const sanitized = sanitizeHtml(band.html, options.sanitize);
    if (index === 0) {
      const extracted = extractMenu(sanitized);
      menuItems = extracted.items;
      headerParts.push(neutralizePhp(extracted.html));
    } else {
      headerParts.push(neutralizePhp(sanitized));
    }
  }
  headerInner = headerParts.join("\n");

  const footerInner = options.chrome.footer
    .map((band) => neutralizePhp(sanitizeHtml(band.html, options.sanitize)))
    .join("\n");

  // 4. functions.php — enqueue order matters: parent, child, then the clone.
  const functions = `<?php
/**
 * ${options.name}
 *
 * Generated by WP Site Builder from ${options.sourceUrl}.
 * Edit freely; re-running the clone will overwrite this folder.
 */

add_action( 'wp_enqueue_scripts', function () {
	wp_enqueue_style( 'hello-elementor', get_template_directory_uri() . '/style.css', array(), null );
	wp_enqueue_style( '${options.slug}', get_stylesheet_uri(), array( 'hello-elementor' ), '1.0.0' );
	wp_enqueue_style(
		'${options.slug}-clone',
		get_stylesheet_directory_uri() . '/assets/clone.css',
		array( '${options.slug}' ),
		filemtime( get_stylesheet_directory() . '/assets/clone.css' )
	);
}, 20 );

add_action( 'after_setup_theme', function () {
	register_nav_menus( array(
		'${MENU_LOCATION}' => 'Cloned primary menu',
	) );
} );

/**
 * Hello Elementor prints the page title above the content. The cloned page has
 * its own heading, so the theme's is a duplicate — and it was showing up as a
 * stray word above the hero.
 */
add_filter( 'hello_elementor_page_title', '__return_false' );

/**
 * WordPress swaps emoji characters in post content for <img> tags from its own
 * CDN. In cloned markup that is a visible edit to the source: the footer's
 * "Crafted with ♥" came out as a 16px image with different metrics. A clone
 * reproduces what the source rendered, so the filter is removed.
 */
remove_action( 'wp_head', 'print_emoji_detection_script', 7 );
remove_action( 'wp_print_styles', 'print_emoji_styles' );
remove_filter( 'the_content_feed', 'wp_staticize_emoji' );
add_filter( 'emoji_svg_url', '__return_false' );
`;
  await writeFile(path.join(themeDir, "functions.php"), functions, "utf8");

  // 5. header.php / footer.php. Both wrap cloned markup in the scope class,
  //    which the cloned stylesheet is keyed to, and reproduce the source's own
  //    wrapper chain around it so ancestor-dependent CSS still matches.
  const shell = options.shell ?? { page: { open: [], close: [] }, main: { open: [], close: [] } };
  const indent = (lines: string[]) => lines.join("\n");

  const headerPhp = `<?php
/**
 * Header — cloned from ${options.sourceUrl}.
 */
?><!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<div class="${SCOPE_CLASS} ${SCOPE_CLASS}-page">
${indent(shell.page.open)}
${headerInner ? `<div class="${SCOPE_CLASS}-header">\n${headerInner}\n</div>` : ""}
<div class="${SCOPE_CLASS}-main">
${indent(shell.main.open)}
`;
  await writeFile(path.join(themeDir, "header.php"), headerPhp, "utf8");

  const footerPhp = `<?php
/**
 * Footer — cloned from ${options.sourceUrl}.
 */
?>
${indent(shell.main.close)}
</div>
${footerInner ? `<div class="${SCOPE_CLASS}-footer">\n${footerInner}\n</div>` : ""}
${indent(shell.page.close)}
</div>
<?php wp_footer(); ?>
</body>
</html>
`;
  await writeFile(path.join(themeDir, "footer.php"), footerPhp, "utf8");

  return {
    themeDir,
    slug: options.slug,
    menuItems,
    hasHeader: Boolean(headerInner),
    hasFooter: Boolean(footerInner),
    cssBytes: options.css.length,
  };
}
