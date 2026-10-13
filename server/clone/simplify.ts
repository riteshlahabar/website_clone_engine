/**
 * Collapses a raw DOM style tree into something shaped like an Elementor
 * document.
 *
 * Measured on a real page: 53% of nodes are pure wrappers — a single child,
 * no text, no background, existing only to carry a class or a max-width.
 * Elementor has no equivalent and mapping them 1:1 produces an unusable
 * 25-level nest, so they are folded into their child, carrying their spacing
 * and layout intent with them.
 */
import type { StyleNode } from "./extract.ts";

export type SimpleNode = StyleNode & {
  /** Set when a collapsed ancestor was a centred fixed-width wrapper. */
  boxedWidth?: number;
  /** How many wrappers were folded into this node. Diagnostic only. */
  collapsed?: number;
};

const TRANSPARENT = /^(rgba\(0,\s*0,\s*0,\s*0\)|transparent)$/;

function paints(node: StyleNode): boolean {
  const style = node.styles;
  const background = style["background-color"];
  if (background && !TRANSPARENT.test(background)) return true;
  if (style["background-image"] && style["background-image"] !== "none") return true;
  if (style["border-top-width"] && parseFloat(style["border-top-width"]) > 0) return true;
  if (style["box-shadow"] && style["box-shadow"] !== "none") return true;
  if (style["border-radius"] && parseFloat(style["border-radius"]) > 0) return true;
  return false;
}

function px(value: string | undefined): number {
  const parsed = parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A flex row with more than one child is real layout; one child is centring. */
function isMeaningfulLayout(node: StyleNode): boolean {
  const display = node.styles["display"] ?? "";
  if (display.includes("grid")) return true;
  if (display.includes("flex")) {
    const direction = node.styles["flex-direction"] ?? "row";
    return node.children.length > 1 && direction.startsWith("row");
  }
  return false;
}

/** The classic centred container: a max-width with auto side margins. */
function boxedWidthOf(node: StyleNode): number | undefined {
  const maxWidth = px(node.styles["max-width"]);
  if (maxWidth > 200 && maxWidth < 2000) return Math.round(maxWidth);
  return undefined;
}

/**
 * Fold a wrapper's spacing into the child it is being replaced by. Padding
 * adds, because the browser applied both.
 */
function fold(wrapper: StyleNode, child: SimpleNode): SimpleNode {
  const sides = ["top", "right", "bottom", "left"] as const;
  const styles = { ...child.styles };

  for (const side of sides) {
    const key = `padding-${side}`;
    styles[key] = `${px(wrapper.styles[key]) + px(child.styles[key])}px`;
  }

  // The child keeps its own paint; the wrapper had none by definition.
  for (const key of ["text-align", "font-family", "color"] as const) {
    if (!styles[key] && wrapper.styles[key]) styles[key] = wrapper.styles[key];
  }

  return {
    ...child,
    styles,
    boxedWidth: child.boxedWidth ?? boxedWidthOf(wrapper),
    collapsed: (child.collapsed ?? 0) + 1,
  };
}

function isEmpty(node: StyleNode): boolean {
  return !node.text && !node.src && node.children.length === 0 && !paints(node);
}

/**
 * Tags that name a region of the page. Folding one away destroys the only
 * reliable evidence of where a band starts and ends — and that is exactly what
 * used to happen: the test site's `<section>` wrappers each held a single
 * child, so every one was folded into it, and band detection then descended
 * into the hero and emitted its `<h1>` and `<p>` as two separate full-width
 * bands. They are kept whatever else they look like.
 */
const LANDMARK_TAGS = new Set([
  "section", "header", "footer", "nav", "main", "article", "aside",
  "form", "figure", "ul", "ol", "table",
]);

/**
 * A wrapper is removable when it adds no visual and no layout — it exists
 * only to nest. Its single child takes its place.
 */
function isRemovableWrapper(node: StyleNode): boolean {
  if (node.children.length !== 1) return false;
  if (node.text || node.src) return false;
  if (node.tag === "a") return false; // a link is semantic, never scaffolding
  if (LANDMARK_TAGS.has(node.tag)) return false;
  if (paints(node)) return false;
  if (isMeaningfulLayout(node)) return false;
  // A positioned or sticky wrapper is doing layout work even with one child:
  // the source's fixed navbar is exactly this shape.
  const position = node.styles["position"] ?? "static";
  if (position !== "static" && position !== "relative") return false;
  if (px(node.styles["min-height"]) > 0) return false;
  return true;
}

export function simplify(node: StyleNode): SimpleNode | null {
  const children = node.children
    .map(simplify)
    .filter((child): child is SimpleNode => child !== null);

  let current: SimpleNode = { ...node, children };

  // Collapse chains of scaffolding, not just one level.
  while (isRemovableWrapper(current) && current.children.length === 1) {
    current = fold(current, current.children[0]!);
  }

  if (isEmpty(current)) return null;
  return current;
}

export type Section = SimpleNode & { role: "header" | "footer" | "section" };

/**
 * Tags that are inline content, never a page-level band. Landing on one means
 * the descent went too deep: the prototype emitted bare `<a>` and `<span>`
 * nodes as sections, which produced a document of orphaned links.
 */
const INLINE_TAGS = new Set([
  "a", "span", "button", "strong", "em", "small", "label",
  "b", "i", "u", "code", "abbr", "time", "img",
]);

/** A band has to carry something: children, real text, or a visible surface. */
function isBandLike(node: SimpleNode): boolean {
  if (node.children.length > 0) return true;
  if (node.text && node.text.trim().length >= 2) return true;
  return paints(node);
}

/** Landmarks that are a band in their own right the moment they are found. */
const BAND_TAGS = new Set(["section", "header", "footer", "nav", "article"]);

/**
 * Split the page into the horizontal bands a person would call sections.
 *
 * Elementor documents are a flat list of full-width containers, so this is the
 * step that turns a nested tree into that shape. The descent walks down through
 * scaffolding — a node whose children are stacked full-width rows is not itself
 * a band, its children are — and stops at the first level that looks like
 * content.
 *
 * The rule that matters most is the one about *not* descending. A row of three
 * cards is one band, not three: its children sit side by side, each a third of
 * the width. The earlier version descended into them anyway and then dropped
 * each card for being too narrow, which silently deleted a whole section of the
 * test page. So the descent now requires children to be **stacked** (vertically
 * separated, each spanning most of the parent) before it will treat them as
 * bands, and nothing is discarded for being narrow — a node too narrow to be a
 * band means the *parent* was the band.
 */
export function findSections(root: SimpleNode): Section[] {
  const picked: Section[] = [];
  // Identity, not `ref`: `resolve` can climb to an ancestor already picked,
  // and identity holds even for a tree assembled without refs (a test fixture).
  const seen = new Set<SimpleNode>();

  const roleOf = (node: SimpleNode): Section["role"] =>
    node.tag === "header" || node.tag === "nav"
      ? "header"
      : node.tag === "footer"
        ? "footer"
        : "section";

  /** Climb out of inline content to the nearest block-level ancestor. */
  const resolve = (node: SimpleNode, ancestors: SimpleNode[]): SimpleNode => {
    if (!INLINE_TAGS.has(node.tag)) return node;
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      const ancestor = ancestors[index]!;
      if (!INLINE_TAGS.has(ancestor.tag)) return ancestor;
    }
    return node;
  };

  const push = (node: SimpleNode, ancestors: SimpleNode[], role?: Section["role"]): void => {
    const resolved = resolve(node, ancestors);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    picked.push({ ...resolved, role: role ?? roleOf(resolved) });
  };

  /**
   * Are these children stacked bands, or a row of columns?
   *
   * Stacked means each child spans most of the parent and they do not overlap
   * vertically. A grid or flex row fails both tests, and a row is content
   * inside one band rather than several bands.
   */
  const areStackedBands = (parent: SimpleNode, children: SimpleNode[]): boolean => {
    if (children.length < 2) return false;
    const display = parent.styles["display"] ?? "";
    if (display.includes("grid")) return false;
    if (display.includes("flex") && (parent.styles["flex-direction"] ?? "row").startsWith("row")) {
      return false;
    }
    const width = parent.rect.width || 0;
    if (width <= 0) return false;

    const sorted = [...children].sort((a, b) => a.rect.y - b.rect.y);
    let previous: SimpleNode | null = null;
    for (const child of sorted) {
      if (child.rect.width < width * 0.75) return false;
      if (previous) {
        // Stacked means each band starts below the one before it. They may
        // still *overlap*: pulling a band up over the one above with a negative
        // margin is a common device, and the test page does it with `-mt-16`.
        // Overlapping more than half of the previous band is not stacking
        // though — that is a layer, like an overlay or an absolutely
        // positioned decoration.
        if (child.rect.y <= previous.rect.y) return false;
        const overlap = previous.rect.y + previous.rect.height - child.rect.y;
        if (overlap > previous.rect.height * 0.5) return false;
      }
      previous = child;
    }
    return true;
  };

  const descend = (node: SimpleNode, depth: number, ancestors: SimpleNode[]): void => {
    // Semantic landmarks are bands by definition — but `main` and `body` are
    // containers *of* bands, so they are walked through rather than emitted.
    if (BAND_TAGS.has(node.tag)) {
      push(node, ancestors, roleOf(node));
      return;
    }

    const substantial = node.children.filter((child) => child.rect.height > 40);
    const trail = [...ancestors, node];

    if (depth < 8 && areStackedBands(node, substantial)) {
      for (const child of substantial) descend(child, depth + 1, trail);
      return;
    }

    // A lone substantial child is scaffolding around the real thing.
    if (substantial.length === 1 && depth < 12) {
      descend(substantial[0]!, depth + 1, trail);
      return;
    }

    if (node.rect.height > 24) push(node, ancestors);
  };

  descend(root, 0, []);

  // Decorative slivers only — a band is never dropped for being narrow, since
  // the descent above never settles on something narrower than its parent.
  return picked.filter((section) => section.rect.height >= 16 && isBandLike(section));
}

/** Diagnostics for the report. */
export function treeStats(node: SimpleNode): {
  nodes: number;
  depth: number;
  collapsed: number;
} {
  let nodes = 0;
  let collapsed = 0;
  const walk = (current: SimpleNode, level: number): number => {
    nodes += 1;
    collapsed += current.collapsed ?? 0;
    if (current.children.length === 0) return level;
    return Math.max(
      ...current.children.map((child) => walk(child as SimpleNode, level + 1)),
    );
  };
  const depth = walk(node, 1);
  return { nodes, depth, collapsed };
}
