/**
 * Prepares the source site's CSS for life inside WordPress.
 *
 * Two problems have to be solved before cloned CSS can be enqueued.
 *
 * Scoping. The source's rules are written for a page where it owns `body`,
 * `*` and every class name. Dropped into WordPress unchanged they would
 * restyle the admin bar, the theme and the Elementor editor. Every selector is
 * therefore confined beneath a wrapper class, and `html`/`body` selectors are
 * rewritten to target that wrapper so page-level background and typography
 * still land somewhere.
 *
 * Rewriting. `url()` references point at the source host. Each one is
 * redirected to the localized copy, so a clone keeps working if the original
 * goes away.
 *
 * Scoping rather than inlining computed styles is a deliberate trade: inlining
 * is simpler but loses media queries and pseudo-elements, which is most of
 * what makes a page look finished.
 */
import postcss, { type Root, type Rule, type AtRule, type Declaration } from "postcss";
import selectorParser from "postcss-selector-parser";

/** The class the clone's content is wrapped in. */
export const SCOPE_CLASS = "wpc-clone";

/**
 * Selectors that mean "the page itself" and should become the wrapper.
 *
 * `:root` is included deliberately, so custom properties declared on it are
 * scoped to the clone instead of overriding the theme's own variables
 * globally. The consequence is a requirement: every piece of cloned markup —
 * the child theme's header and footer included — must sit inside an element
 * carrying SCOPE_CLASS, or it loses access to these variables.
 */
const PAGE_LEVEL = new Set(["html", "body", ":root", ":where(html)", ":where(body)"]);

/** At-rules whose children are selectors needing the same treatment. */
const NESTS_RULES = new Set(["media", "supports", "layer", "container", "scope", "starting-style"]);

/**
 * Remove `@layer` entirely, hoisting its rules into the surrounding scope.
 *
 * Cascade layers lose to unlayered rules no matter how specific they are, and
 * WordPress, Hello Elementor and Elementor all ship unlayered CSS. A Tailwind
 * v4 source — where *everything* lives in `@layer theme/base/utilities` — is
 * therefore outranked wholesale: measured on the test site, `img { height:auto }`
 * from hello-elementor beat `.wpc-clone .h-14`, rendering a 56px logo at 1254px.
 *
 * Flattening costs the source's own layer ordering. That matters far less than
 * it sounds: layer order only decides between rules that would otherwise be
 * ties, source order already encodes most of it, and the alternative is a
 * stylesheet that loses every such tie to the theme instead.
 */
function flattenLayers(container: Root | AtRule): void {
  container.each((node) => {
    if (node.type !== "atrule") return;
    const name = node.name.toLowerCase();
    if (name !== "layer") {
      if (NESTS_RULES.has(name.replace(/^-\w+-/, ""))) flattenLayers(node);
      return;
    }
    // `@layer a, b;` only declares an order — with no blocks left it is noise.
    if (!node.nodes) {
      node.remove();
      return;
    }
    flattenLayers(node);
    node.replaceWith(node.nodes);
  });
}

/** At-rules whose contents must never be touched. */
const OPAQUE = new Set(["keyframes", "-webkit-keyframes", "font-face", "counter-style", "property"]);

/**
 * Confine one selector beneath the scope class.
 *
 * `body .card` becomes `.wpc-clone .card` rather than
 * `.wpc-clone body .card`, which would never match.
 */
export function scopeSelector(selector: string, scope = SCOPE_CLASS): string {
  const scopeSelectorText = `.${scope}`;
  try {
    return selectorParser((root) => {
      root.each((sel) => {
        const first = sel.first;
        if (!first) return;
        // In a list like `h1, h2` the second selector carries the leading
        // space, which would otherwise double up once we prepend the scope.
        first.spaces.before = "";

        // Already scoped: leave it alone so repeated passes are safe.
        if (
          first.type === "class" &&
          "value" in first &&
          first.value === scope
        ) {
          return;
        }

        const firstText = String(first).trim();
        if (PAGE_LEVEL.has(firstText.toLowerCase())) {
          // Replace the page-level part with the wrapper itself.
          first.replaceWith(selectorParser.className({ value: scope }));
          return;
        }

        sel.prepend(selectorParser.combinator({ value: " " }));
        sel.prepend(selectorParser.className({ value: scope }));
      });
    }).processSync(selector);
  } catch {
    // An exotic selector postcss-selector-parser cannot read is better left
    // scoped crudely than dropped entirely.
    return `${scopeSelectorText} ${selector}`;
  }
}

export type UrlRewriter = (url: string) => string | null;

/** Rewrite every url() in a declaration value through the rewriter. */
function rewriteUrls(value: string, rewrite: UrlRewriter): string {
  return value.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (whole, quote: string, url: string) => {
      const trimmed = url.trim();
      if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("#")) {
        return whole;
      }
      const replacement = rewrite(trimmed);
      return replacement ? `url(${quote}${replacement}${quote})` : whole;
    },
  );
}

export type PreparedCss = {
  css: string;
  /** Absolute URLs referenced by url() that were not localized. */
  unresolved: string[];
  /** Every @font-face src URL seen, for the asset phase. */
  fontUrls: string[];
  rulesScoped: number;
};

/**
 * Scope a stylesheet and redirect its asset references.
 *
 * `baseUrl` resolves relative url() references, which are relative to the
 * stylesheet they appear in, not to the page.
 */
export function prepareCss(
  css: string,
  options: {
    baseUrl?: string;
    rewrite?: UrlRewriter;
    scope?: string;
  } = {},
): PreparedCss {
  const scope = options.scope ?? SCOPE_CLASS;
  const unresolved = new Set<string>();
  const fontUrls = new Set<string>();
  let rulesScoped = 0;

  const absolute = (url: string): string | null => {
    if (!options.baseUrl) return null;
    try {
      return new URL(url, options.baseUrl).toString();
    } catch {
      return null;
    }
  };

  const rewriter: UrlRewriter = (url) => {
    const resolved = absolute(url) ?? url;
    const replacement = options.rewrite?.(resolved);
    if (replacement) return replacement;
    if (/^https?:/i.test(resolved)) unresolved.add(resolved);
    // With no local copy, keep pointing at the source so the page still works.
    return /^https?:/i.test(resolved) ? resolved : null;
  };

  let root: Root;
  try {
    root = postcss.parse(css);
  } catch {
    // A sheet we cannot parse is dropped rather than emitted broken.
    return { css: "", unresolved: [], fontUrls: [], rulesScoped: 0 };
  }

  const scopeRule = (rule: Rule): void => {
    rule.selectors = rule.selectors.map((selector) => scopeSelector(selector, scope));
    rulesScoped += 1;
  };

  const walk = (container: Root | AtRule, insideOpaque: boolean): void => {
    container.each((node) => {
      if (node.type === "rule") {
        if (!insideOpaque) scopeRule(node);
        node.walkDecls((declaration: Declaration) => {
          declaration.value = rewriteUrls(declaration.value, rewriter);
        });
        return;
      }
      if (node.type === "atrule") {
        const name = node.name.toLowerCase().replace(/^-\w+-/, "");
        if (OPAQUE.has(name) || OPAQUE.has(node.name.toLowerCase())) {
          if (name === "font-face") {
            node.walkDecls((declaration: Declaration) => {
              if (declaration.prop.toLowerCase() === "src") {
                for (const match of declaration.value.matchAll(
                  /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi,
                )) {
                  const url = match[1]?.trim();
                  if (url && !url.startsWith("data:")) {
                    fontUrls.add(absolute(url) ?? url);
                  }
                }
                declaration.value = rewriteUrls(declaration.value, rewriter);
              }
            });
          }
          return;
        }
        if (NESTS_RULES.has(name)) {
          walk(node, insideOpaque);
          return;
        }
        // @import cannot be followed here; the browser already inlined what it
        // could, and a remaining one would load unscoped CSS.
        if (name === "import") {
          node.remove();
          return;
        }
        node.walkDecls((declaration: Declaration) => {
          declaration.value = rewriteUrls(declaration.value, rewriter);
        });
      }
    });
  };

  // Before scoping: a flattened tree has no `@layer` wrappers left to walk,
  // and every rule inside one becomes a plain rule needing the scope prefix.
  flattenLayers(root);
  walk(root, false);

  return {
    css: root.toString(),
    unresolved: [...unresolved],
    fontUrls: [...fontUrls],
    rulesScoped,
  };
}

/** Join prepared stylesheets into one bundle, in cascade order. */
export function bundleCss(
  sheets: Array<{ href: string | null; css: string }>,
  rewrite: UrlRewriter,
  scope = SCOPE_CLASS,
): PreparedCss {
  const parts: string[] = [];
  const unresolved = new Set<string>();
  const fontUrls = new Set<string>();
  let rulesScoped = 0;

  for (const sheet of sheets) {
    const prepared = prepareCss(sheet.css, {
      baseUrl: sheet.href ?? undefined,
      rewrite,
      scope,
    });
    if (!prepared.css.trim()) continue;
    parts.push(
      `/* ---- ${sheet.href ?? "inline <style>"} ---- */\n${prepared.css}`,
    );
    for (const url of prepared.unresolved) unresolved.add(url);
    for (const url of prepared.fontUrls) fontUrls.add(url);
    rulesScoped += prepared.rulesScoped;
  }

  return {
    css: parts.join("\n\n"),
    unresolved: [...unresolved],
    fontUrls: [...fontUrls],
    rulesScoped,
  };
}
