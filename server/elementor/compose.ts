/**
 * Turns a page's chosen blocks into a complete Elementor document.
 *
 * Two jobs: substitute {{tokens}} with the brief's content, and stamp every
 * element with a fresh unique id. Elementor identifies elements by a 7-character
 * lowercase hex id; duplicates make the editor drop or merge elements.
 */
import { randomBytes } from "node:crypto";
import { getBlock, type Block, type BlockParam } from "./registry.ts";
import type { Brief, Page } from "../shared/brief.ts";

/** A node in the Elementor document tree. */
export type ElementorNode = {
  id: string;
  elType: string;
  widgetType?: string;
  isInner?: boolean;
  settings: Record<string, unknown>;
  elements: ElementorNode[];
};

const TOKEN = /\{\{(\w+)\}\}/g;

/** Elementor element ids are 7 lowercase hex characters. */
function makeIdFactory() {
  const used = new Set<string>();
  return function nextId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = randomBytes(4).toString("hex").slice(0, 7);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error("Could not generate a unique Elementor element id.");
  };
}

/** Map a block's brand-linked params onto the brief's palette. */
function brandValue(param: BlockParam, brief: Brief): string | undefined {
  switch (param.brand) {
    case "primary":
      return brief.brand.colors.primary;
    case "secondary":
      return brief.brand.colors.secondary;
    case "accent":
      return brief.brand.colors.accent;
    case "text":
      return brief.brand.colors.text;
    // `surface` has no brand slot; the block's own default is the right tone.
    default:
      return undefined;
  }
}

/**
 * Resolve each token once, in priority order: author-supplied content, then the
 * brand palette, then the block's own default.
 */
function resolveValues(
  block: Block,
  content: Record<string, unknown>,
  brief: Brief,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const param of block.params) {
    const supplied = content[param.key];
    if (typeof supplied === "string" && supplied.trim() !== "") {
      values[param.key] = supplied;
      continue;
    }
    values[param.key] = brandValue(param, brief) ?? param.default;
  }
  return values;
}

function substitute(value: string, values: Record<string, string>): string {
  return value.replace(TOKEN, (match, key: string) =>
    key in values ? values[key]! : match,
  );
}

/**
 * Deep-clone the template, filling tokens and assigning ids as we go.
 * Unknown keys are preserved untouched so block authors can use any Elementor
 * setting without the composer needing to know about it.
 */
function instantiate(
  node: unknown,
  values: Record<string, string>,
  nextId: () => string,
): unknown {
  if (typeof node === "string") return substitute(node, values);
  if (Array.isArray(node)) {
    return node.map((child) => instantiate(child, values, nextId));
  }
  if (node === null || typeof node !== "object") return node;

  const source = node as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  // An element is anything declaring elType; only those get ids.
  if (typeof source.elType === "string") output.id = nextId();

  for (const [key, value] of Object.entries(source)) {
    if (key === "id") continue; // always regenerated
    output[key] = instantiate(value, values, nextId);
  }

  // Elementor expects every element to carry an `elements` array, even leaves.
  if (typeof source.elType === "string" && !Array.isArray(output.elements)) {
    output.elements = [];
  }
  return output;
}

/** Build the full element tree for one page. */
export async function composePage(
  page: Page,
  brief: Brief,
): Promise<ElementorNode[]> {
  const nextId = makeIdFactory();
  const elements: ElementorNode[] = [];

  for (const section of page.sections) {
    const block = await getBlock(section.block);
    const values = resolveValues(block, section.content, brief);
    elements.push(instantiate(block.template, values, nextId) as ElementorNode);
  }

  return elements;
}

/**
 * Structural check before anything is written to WordPress. A malformed
 * document shows up as a blank page much later, so fail here instead.
 */
export function validateDocument(elements: ElementorNode[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  const walk = (node: ElementorNode, trail: string) => {
    if (!node.id || !/^[0-9a-f]{7}$/.test(node.id)) {
      problems.push(`${trail}: id "${node.id}" is not 7 hex characters.`);
    } else if (seen.has(node.id)) {
      problems.push(`${trail}: duplicate element id "${node.id}".`);
    } else {
      seen.add(node.id);
    }

    if (!node.elType) problems.push(`${trail}: missing elType.`);
    if (node.elType === "widget" && !node.widgetType) {
      problems.push(`${trail}: widget is missing widgetType.`);
    }
    if (!Array.isArray(node.elements)) {
      problems.push(`${trail}: missing elements array.`);
      return;
    }
    node.elements.forEach((child, index) =>
      walk(child, `${trail} > ${child.widgetType ?? child.elType}[${index}]`),
    );
  };

  elements.forEach((node, index) => walk(node, `element[${index}]`));

  const leftoverTokens = JSON.stringify(elements).match(TOKEN);
  if (leftoverTokens) {
    problems.push(
      `Unsubstituted placeholders remain: ${[...new Set(leftoverTokens)].join(", ")}`,
    );
  }

  return problems;
}
