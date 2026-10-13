/**
 * The translation table: simplified DOM nodes → Elementor containers and widgets.
 *
 * This is the one place allowed to emit Elementor schema, and every key it
 * writes is one verified against a real Elementor document. Nothing here is
 * inferred at runtime and no model generates any of it — that distinction is
 * what keeps output renderable, because invalid Elementor JSON fails silently
 * as a blank page.
 *
 * CLAUDE.md Rule 2 forbids authoring schema in the brief-based builder, where
 * layouts come only from the block library. The exception is scoped to this
 * directory and granted because the library is fixed-arity — three features,
 * four stats, no repeaters — so it cannot express a page it has never seen.
 * The rule still holds everywhere else.
 *
 * Only free-tier widgets are used: heading, text-editor, image and button.
 * Pro widgets register as upgrade stubs and would render a prompt instead of
 * content.
 */
import { randomBytes } from "node:crypto";
import type { ElementorNode } from "../elementor/compose.ts";
import type { SimpleNode } from "./simplify.ts";

export type MapResult = {
  elements: ElementorNode[];
  /** Nodes the mapper could not express, for the fidelity report. */
  unmapped: Array<{ tag: string; reason: string; text?: string }>;
  /** Source image URLs encountered, in the order they appear. */
  images: string[];
};

function makeId(): string {
  return randomBytes(4).toString("hex").slice(0, 7);
}

function px(value: string | undefined): number {
  const parsed = parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

/** Elementor stores colours as hex; the DOM reports rgb()/rgba(). */
export function toHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(value);
  if (!match) return /^#[0-9a-f]{3,8}$/i.test(value) ? value : undefined;
  const alpha = match[4] === undefined ? 1 : parseFloat(match[4]);
  if (alpha === 0) return undefined; // fully transparent is "no colour"
  const hex = [match[1], match[2], match[3]]
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex.toUpperCase()}`;
}

function spacing(node: SimpleNode, kind: "padding" | "margin") {
  return {
    unit: "px",
    top: String(px(node.styles[`${kind}-top`])),
    right: String(px(node.styles[`${kind}-right`])),
    bottom: String(px(node.styles[`${kind}-bottom`])),
    left: String(px(node.styles[`${kind}-left`])),
    isLinked: false,
  };
}

/** Typography settings shared by heading and text widgets. */
function typography(node: SimpleNode, prefix = ""): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  const size = px(node.styles["font-size"]);
  const weight = node.styles["font-weight"];
  const family = (node.styles["font-family"] ?? "").split(",")[0]?.replace(/["']/g, "").trim();
  const align = node.styles["text-align"];

  if (size || weight || family) {
    settings[`${prefix}typography_typography`] = "custom";
    if (size) settings[`${prefix}typography_font_size`] = { unit: "px", size, sizes: [] };
    if (weight && weight !== "normal") settings[`${prefix}typography_font_weight`] = weight;
    if (family) settings[`${prefix}typography_font_family`] = family;
    const lineHeight = parseFloat(node.styles["line-height"] ?? "");
    if (Number.isFinite(lineHeight) && size > 0) {
      settings[`${prefix}typography_line_height`] = {
        unit: "em",
        size: Math.round((lineHeight / size) * 100) / 100,
        sizes: [],
      };
    }
  }
  if (align && align !== "start" && align !== "left") {
    settings.align = align === "end" ? "right" : align;
  }
  return settings;
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const TEXT_TAGS = new Set(["p", "span", "li", "blockquote", "figcaption", "small", "strong", "em", "label", "td", "th"]);

/**
 * Which heading level a node represents, or null if it is body copy.
 * Real heading tags win; otherwise large bold text is treated as a heading,
 * with the level taken from its size so the hierarchy survives.
 */
function inferHeadingLevel(node: SimpleNode): string | null {
  if (HEADING_TAGS.has(node.tag)) return node.tag;
  if (!node.text || node.children.length > 0) return null;
  // Long passages are paragraphs however they are styled.
  if (node.text.length > 120) return null;

  const size = px(node.styles["font-size"]);
  const weight = parseInt(node.styles["font-weight"] ?? "400", 10);
  const bold = weight >= 600 || node.styles["font-weight"] === "bold";
  if (size < 20 || !bold) return null;

  if (size >= 40) return "h1";
  if (size >= 32) return "h2";
  if (size >= 26) return "h3";
  return "h4";
}

/** A link styled as a block with padding and a background is a button. */
function looksLikeButton(node: SimpleNode): boolean {
  if (node.tag === "button") return true;
  if (node.tag !== "a" || !node.text) return false;
  const background = toHex(node.styles["background-color"]);
  const padded = px(node.styles["padding-top"]) >= 6 && px(node.styles["padding-left"]) >= 10;
  const rounded = px(node.styles["border-radius"]) > 0;
  return Boolean(background) && (padded || rounded);
}

function widgetFor(node: SimpleNode): ElementorNode | null {
  // Image
  if (node.tag === "img" && node.src) {
    return {
      id: makeId(),
      elType: "widget",
      widgetType: "image",
      settings: {
        image: { url: node.src, id: "", alt: node.alt ?? "" },
        image_size: "full",
        ...(px(node.styles["border-radius"]) > 0
          ? {
              image_border_radius: {
                unit: "px",
                top: String(px(node.styles["border-radius"])),
                right: String(px(node.styles["border-radius"])),
                bottom: String(px(node.styles["border-radius"])),
                left: String(px(node.styles["border-radius"])),
                isLinked: true,
              },
            }
          : {}),
      },
      elements: [],
    };
  }

  // Button
  if (looksLikeButton(node) && node.text) {
    const background = toHex(node.styles["background-color"]);
    return {
      id: makeId(),
      elType: "widget",
      widgetType: "button",
      settings: {
        text: node.text,
        link: { url: node.href ?? "#", is_external: "", nofollow: "" },
        size: "md",
        ...(background ? { background_color: background } : {}),
        ...(toHex(node.styles["color"]) ? { button_text_color: toHex(node.styles["color"]) } : {}),
        ...(px(node.styles["border-radius"]) > 0
          ? {
              border_radius: {
                unit: "px",
                top: String(px(node.styles["border-radius"])),
                right: String(px(node.styles["border-radius"])),
                bottom: String(px(node.styles["border-radius"])),
                left: String(px(node.styles["border-radius"])),
                isLinked: true,
              },
            }
          : {}),
      },
      elements: [],
    };
  }

  // Heading — real heading tags, plus text styled as one. Sites routinely put
  // headings in bare divs, and treating those as body copy loses the hierarchy
  // that makes a page readable.
  const headingLevel = inferHeadingLevel(node);
  if (headingLevel && node.text) {
    const color = toHex(node.styles["color"]);
    return {
      id: makeId(),
      elType: "widget",
      widgetType: "heading",
      settings: {
        title: node.text,
        header_size: headingLevel,
        ...(color ? { title_color: color } : {}),
        ...typography(node),
      },
      elements: [],
    };
  }

  // Text. Any leaf carrying text is content, whatever its tag — sites put
  // copy in bare divs constantly, and dropping it silently loses real content.
  const isTextLeaf = node.text && node.children.length === 0;
  if ((TEXT_TAGS.has(node.tag) || node.tag === "a" || isTextLeaf) && node.text) {
    const color = toHex(node.styles["color"]);
    const text =
      node.tag === "a" && node.href
        ? `<a href="${node.href}">${escapeHtml(node.text)}</a>`
        : escapeHtml(node.text);
    return {
      id: makeId(),
      elType: "widget",
      widgetType: "text-editor",
      settings: {
        editor: `<p>${text}</p>`,
        ...(color ? { text_color: color } : {}),
        ...typography(node),
      },
      elements: [],
    };
  }

  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Does this node lay its children out side by side?
 *
 * CSS grid counts, and used not to. A grid was reported as `display: grid` with
 * no `flex-direction`, so the old code defaulted it to a column and every
 * three-across card row on the test page became three full-width rows stacked —
 * the single biggest reason a cloned page came out three times too tall.
 * Elementor containers have no grid mode on the free tier, so a grid is
 * reproduced as a wrapping flex row and the column widths carry the shape.
 */
function isRowLayout(node: SimpleNode): boolean {
  const display = node.styles["display"] ?? "";
  if (display.includes("grid")) {
    const template = node.styles["grid-template-columns"] ?? "";
    // A single-column grid really is a stack.
    return template.trim().split(/\s+/).filter(Boolean).length > 1;
  }
  if (display.includes("flex")) {
    return (node.styles["flex-direction"] ?? "row").startsWith("row");
  }
  return false;
}

/**
 * A child's share of its parent's width, as a percentage.
 *
 * This used to be written as a literal `size: 0`, which told Elementor every
 * column was 0% wide. Elementor clamps that to its minimum, so side-by-side
 * columns came out as slivers.
 */
function widthShare(node: SimpleNode, parentWidth: number): number | null {
  if (parentWidth <= 0 || node.rect.width <= 0) return null;
  const share = (node.rect.width / parentWidth) * 100;
  if (!Number.isFinite(share) || share <= 0) return null;
  return Math.min(100, Math.round(share * 10) / 10);
}

function containerFor(
  node: SimpleNode,
  isInner: boolean,
  parentWidth: number,
  parentIsRow: boolean,
  unmapped: MapResult["unmapped"],
): ElementorNode {
  const isRow = isRowLayout(node);
  const gap = px(node.styles["gap"]) || px(node.styles["column-gap"]);
  const rowGap = px(node.styles["row-gap"]) || gap;
  const background = toHex(node.styles["background-color"]);
  const backgroundImage = node.styles["background-image"];

  const settings: Record<string, unknown> = {
    content_width: isInner ? "full" : node.boxedWidth ? "boxed" : "full",
    flex_direction: isRow ? "row" : "column",
    padding: spacing(node, "padding"),
    margin: spacing(node, "margin"),
  };

  if (node.boxedWidth && !isInner) {
    settings.boxed_width = { unit: "px", size: node.boxedWidth, sizes: [] };
  }
  if (isRow || (node.styles["display"] ?? "").includes("flex")) {
    if (gap || rowGap) {
      settings.flex_gap = {
        unit: "px",
        size: gap,
        column: String(gap),
        row: String(rowGap),
        isLinked: gap === rowGap,
      };
    }
    const justify = node.styles["justify-content"];
    const align = node.styles["align-items"];
    if (justify && justify !== "normal") settings.flex_justify_content = justify;
    if (align && align !== "normal") settings.flex_align_items = align;
    // A grid wraps by definition; a flex row only when it says so. Without this
    // a four-across row is forced onto one line and every card is squeezed.
    if (isRow && ((node.styles["flex-wrap"] ?? "").includes("wrap") ||
      (node.styles["display"] ?? "").includes("grid"))) {
      settings.flex_wrap = "wrap";
    }
  }
  if (background) {
    settings.background_background = "classic";
    settings.background_color = background;
  }
  // Both, not either: a background image over a background colour is how
  // overlays and tinted heroes are built, and dropping the image whenever a
  // colour was present lost every hero background on the test page.
  if (backgroundImage && backgroundImage !== "none") {
    const match = /url\(["']?(.*?)["']?\)/.exec(backgroundImage);
    if (match?.[1] && !match[1].startsWith("data:")) {
      settings.background_background = "classic";
      settings.background_image = { url: match[1], id: "" };
      settings.background_size = "cover";
      settings.background_position = "center center";
      settings.background_repeat = "no-repeat";
    } else if (/gradient\(/i.test(backgroundImage)) {
      // Elementor's free tier has no field for an arbitrary gradient, so this
      // one is genuinely lost. `unmapped` records it, which pushes the section
      // towards the markup path where it survives intact.
      unmapped.push({ tag: node.tag, reason: "css gradient background" });
    }
  }
  if (px(node.styles["border-radius"]) > 0) {
    const radius = String(px(node.styles["border-radius"]));
    settings.border_radius = {
      unit: "px", top: radius, right: radius, bottom: radius, left: radius, isLinked: true,
    };
  }
  const minHeight = px(node.styles["min-height"]);
  if (minHeight > 0) {
    settings.min_height = { unit: "px", size: minHeight, sizes: [] };
  }
  // A row child's share of the width, so columns keep their proportions.
  if (isInner && parentIsRow) {
    const share = widthShare(node, parentWidth);
    if (share !== null) settings.width = { unit: "%", size: share, sizes: [] };
  }

  return {
    id: makeId(),
    elType: "container",
    ...(isInner ? { isInner: true } : {}),
    settings,
    elements: [],
  };
}

export type MapOptions = {
  /** Stop descending past this depth; deeper nesting is rarely meaningful. */
  maxDepth?: number;
};

/** Convert one simplified section into an Elementor container tree. */
export function mapSection(node: SimpleNode, options: MapOptions = {}): MapResult {
  const unmapped: MapResult["unmapped"] = [];
  const images: string[] = [];
  const maxDepth = options.maxDepth ?? 12;

  const convert = (
    current: SimpleNode,
    depth: number,
    isInner: boolean,
    parentWidth: number,
    parentIsRow: boolean,
  ): ElementorNode | null => {
    // A node that is itself content becomes a widget, regardless of children.
    const widget = widgetFor(current);
    if (widget) {
      if (current.src) images.push(current.src);
      return widget;
    }

    if (depth >= maxDepth) {
      if (current.text) {
        unmapped.push({ tag: current.tag, reason: "max depth", text: current.text.slice(0, 60) });
      }
      return null;
    }

    const container = containerFor(current, isInner, parentWidth, parentIsRow, unmapped);
    const isRow = container.settings.flex_direction === "row";

    for (const child of current.children) {
      const mapped = convert(child as SimpleNode, depth + 1, true, current.rect.width, isRow);
      if (mapped) container.elements.push(mapped);
    }

    // Text sitting directly on a container that also has element children
    // would be lost, so give it its own widget.
    if (current.text && current.children.length > 0) {
      const inline = widgetFor({ ...current, children: [], tag: "p" } as SimpleNode);
      if (inline) container.elements.unshift(inline);
    }

    if (container.elements.length === 0) {
      const paints = container.settings.background_background !== undefined;
      if (!paints) {
        if (current.text) {
          unmapped.push({ tag: current.tag, reason: "empty container", text: current.text.slice(0, 60) });
        }
        return null;
      }
    }

    return container;
  };

  const root = convert(node, 0, false, node.rect.width, false);
  return { elements: root ? [root] : [], unmapped, images };
}

/** Count the widgets in a mapped tree, for the fidelity report. */
export function countWidgets(elements: ElementorNode[]): number {
  let total = 0;
  const walk = (node: ElementorNode): void => {
    if (node.elType === "widget") total += 1;
    for (const child of node.elements) walk(child);
  };
  for (const node of elements) walk(node);
  return total;
}
